"""Bounded, resumable SQLite-to-archive transfer. No automatic VACUUM or deletion.

The inline raw columns form a transactional durable queue. Network work occurs
outside write transactions. A compare-and-swap retires only the exact payload
that was verified, leaving concurrent ingestion untouched.
"""
from __future__ import annotations

import argparse
import asyncio
from contextlib import closing
import json
import logging
from pathlib import Path
import sqlite3

from sqlalchemy import text

from app.core.config import get_settings
from app.evidence.store import Archive, EvidenceUnavailable, canonical, digest

TABLES = (("sync_events", "raw_capture"), ("chat_messages", "raw_payload"))
PENDING_SQL = " + ".join(
    f"(SELECT coalesce(sum(length(cast({column} AS BLOB))),0) FROM {table} "
    f"WHERE {column} IS NOT NULL AND {column} != 'null')" for table, column in TABLES
)
QUARANTINE_SQL = "(SELECT coalesce(sum(length(cast(payload AS BLOB))),0) FROM workspace_capture_quarantine)"


class EvidenceQueueFull(RuntimeError):
    def __init__(self):
        super().__init__("Evidence queue is full. Capture was not accepted; retry when the archive is available.")


async def enforce_queue_limit(db):
    settings = get_settings()
    if settings.evidence_config:
        await db.flush()
        size = await db.scalar(text("SELECT " + PENDING_SQL + " + " + QUARANTINE_SQL))
        if size > settings.evidence_queue_bytes:
            await db.rollback()
            raise EvidenceQueueFull()


def database_path() -> Path:
    url = get_settings().resolved_database_url
    if not url.startswith("sqlite+aiosqlite:///"):
        raise ValueError("Evidence archiving currently requires local SQLite")
    return Path(url.removeprefix("sqlite+aiosqlite:///"))


def transfer_batch(path: Path, archive: Archive, *, batch_size=128, byte_limit=4 * 1024 * 1024) -> dict:
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=rw", uri=True, timeout=30)) as db:
        db.row_factory = sqlite3.Row
        rows, objects, existing, total = [], {}, {}, 0
        # Interleave tables so a large capture backlog cannot starve messages.
        for table, column in TABLES:
            for row in db.execute(
                f"SELECT id,session_id,created_at,{column} AS raw FROM {table} "
                f"WHERE {column} IS NOT NULL AND {column} != 'null' ORDER BY id LIMIT ?",
                (max(1, batch_size // len(TABLES)),),
            ):
                value = json.loads(row["raw"])
                plain = canonical(value)
                if rows and total + len(plain) > byte_limit:
                    break
                key = digest(plain)
                known = db.execute("SELECT pack_hash FROM evidence_objects WHERE digest=?", (key,)).fetchone()
                if known:
                    existing[key] = known[0]
                else:
                    objects[key] = value
                rows.append((table, column, dict(row), key, len(plain)))
                total += len(plain)
        if not rows:
            return {"archived": 0, "pending_bytes": db.execute("SELECT " + PENDING_SQL).fetchone()[0]}
        # Verify deduplicated objects too; an old catalog receipt is not enough.
        cache = {}
        for key, pack_key in existing.items():
            if pack_key not in cache:
                cache[pack_key] = archive.read_pack(pack_key)
            if key not in cache[pack_key]["objects"]:
                raise EvidenceUnavailable()
        pack_key = None
        if objects:
            pack_key = archive.write_pack({
                "version": 1, "objects": objects,
                "records": [{"table": t, "id": r["id"], "session_id": r["session_id"],
                             "created_at": r["created_at"], "digest": key}
                            for t, _, r, key, _ in rows],
            })
        count = 0
        with db:
            for table, column, row, key, size in rows:
                db.execute(
                    "INSERT OR IGNORE INTO evidence_objects "
                    "(digest,pack_hash,plaintext_bytes,created_at,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
                    (key, existing.get(key, pack_key), size),
                )
                count += db.execute(
                    f"UPDATE {table} SET {column}=NULL,evidence_ref=? WHERE id=? AND {column}=?",
                    (key, row["id"], row["raw"]),
                ).rowcount
        return {"archived": count, "pending_bytes": db.execute("SELECT " + PENDING_SQL).fetchone()[0]}


async def run_archive(stop: asyncio.Event):
    archive = Archive(get_settings().evidence_config)
    path = database_path()
    while not stop.is_set():
        try:
            result = await asyncio.to_thread(transfer_batch, path, archive)
            delay = 1 if result["archived"] else 60
        except Exception:
            # Never log provider data, paths, keys, or subprocess stderr.
            logging.getLogger(__name__).warning("Evidence transfer failed; inline queue retained; retry in 60 seconds")
            delay = 60
        try:
            await asyncio.wait_for(stop.wait(), timeout=delay)
        except TimeoutError:
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batches", type=int, default=1)
    args = parser.parse_args()
    archive = Archive(get_settings().evidence_config)
    for _ in range(args.batches):
        result = transfer_batch(database_path(), archive)
        print(json.dumps(result), flush=True)
        if not result["archived"]:
            break


if __name__ == "__main__":
    main()
