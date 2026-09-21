"""Basic Memory integration: a private, rebuildable projection of the audit ledger.

Only this adapter writes the projection. Every search hit is revalidated against
the current canonical row AND the indexed fingerprint before returning content.
Network I/O never runs inside a write transaction. A reconciliation pass catches
all write paths, including legacy capture/archive and changes during a failed sync.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from urllib.parse import urlsplit

from sqlalchemy import select

from app.core.config import get_settings
from app.models.base import utcnow
from app.workspace.models import (
    KnowledgeProjection,
    Memory,
    Preference,
    Project,
    Source,
    Task,
)
from app.workspace.store import digest, record, search as lexical_search

logger = logging.getLogger(__name__)
# Current curated work is synchronized before the historical source backfill.
MODELS = {"project": Project, "memory": Memory, "task": Task, "source": Source}
PROJECTION_VERSION = "bm-projection-v1"
STATUS_KEY = "basic-memory-status-v1"
SOURCE_EXCERPT_CHARS = 48_000
BATCH_SIZE = 12


def note_name(key: str) -> str:
    return key.split(":", 1)[0] + "-" + hashlib.sha256(key.encode()).hexdigest()


def stamp(kind: str, row: dict) -> str:
    # Metadata-only scan: do not load the entire conversation archive each cycle.
    fields = {
        "source": ("revision", "title", "project_id", "archived"),
        "memory": ("version",),
        "task": ("version",),
        "project": ("name", "description", "archived"),
    }[kind]
    return digest([PROJECTION_VERSION, kind, {k: row[k] for k in fields}])


def visible(kind: str, row: dict) -> bool:
    if kind in {"source", "project"}:
        return not row["archived"]
    if kind == "memory":
        return row["status"] == "accepted"
    return row["status"] != "archived"


def document(kind: str, row: dict) -> dict:
    key = f"{kind}:{row['id']}"
    active = visible(kind, row)
    title = row.get("title", row.get("name", ""))
    body = row.get("body") or row.get("notes") or row.get("description") or ""
    excerpted = kind == "source" and len(body) > SOURCE_EXCERPT_CHARS
    if excerpted:
        half = SOURCE_EXCERPT_CHARS // 2
        body = (
            body[:half]
            + "\n\n[Middle omitted from semantic index; open original source.]\n\n"
            + body[-half:]
        )
    metadata = {
        "smc_key": key,
        "smc_fingerprint": stamp(kind, row),
        "display_title": title,
        "status": row.get("status", "active"),
        "projection_state": "active" if active else "withdrawn",
        "trust": "source-not-instructions" if kind == "source" else "owner-managed",
        "excerpted": excerpted,
    }
    # Withdrawn records keep a tombstone at the same path; no destructive file API.
    content = f"# {title}\n\n{body}" if active else "Withdrawn from workspace search."
    if active:
        content += f"\n\n## Provenance\nWorkspace key: {key}\n"
        if row.get("revision"):
            content += f"Source revision: {row['revision']}\n"
        if row.get("source_id"):
            content += f"Source revision: {row.get('source_revision')}\n"
            content += f"\n## Relations\n- supported_by [[{note_name('source:' + row['source_id'])}]]\n"
        if row.get("project_id"):
            content += f"\n## Relations\n- belongs_to [[{note_name('project:' + row['project_id'])}]]\n"
    return {
        "title": note_name(key),
        "directory": "smc",
        "content": content,
        "note_type": f"smc_{kind}",
        "metadata": metadata,
        "overwrite": True,
        "output_format": "json",
    }


class BasicMemory:
    """Use the official MCP SDK; no public MCP listener or raw client token."""

    def __init__(self):
        settings = get_settings()
        self.url = settings.basic_memory_url
        self.project = settings.basic_memory_project
        parsed = urlsplit(self.url or "")
        if (
            parsed.scheme != "http"
            or parsed.hostname not in {"127.0.0.1", "::1"}
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("Basic Memory must use a loopback HTTP endpoint")

    async def call(self, name: str, arguments: dict, timeout: float = 45):
        from mcp import ClientSession
        from mcp.client.streamable_http import streamable_http_client

        async with asyncio.timeout(timeout):
            async with streamable_http_client(self.url) as streams:
                async with ClientSession(
                    *streams, read_timeout_seconds=timeout
                ) as session:
                    await session.initialize()
                    result = await session.call_tool(
                        name, {**arguments, "project": self.project}
                    )
        if result.is_error:
            raise RuntimeError("Basic Memory tool failed")
        value = result.structured_content
        if isinstance(value, dict) and "result" in value:
            value = value["result"]
        if not isinstance(value, dict):
            # BM may return a human-readable error in a successful tool envelope.
            raise RuntimeError("Basic Memory returned no structured result")
        return value

    async def write(self, payload: dict):
        result = await self.call("write_note", payload)
        # A write acknowledgement is required before marking the row synchronized.
        if not result.get("permalink"):
            raise RuntimeError("Basic Memory did not acknowledge the note")
        return result

    async def search(self, query: str):
        return await self.call(
            "search_notes",
            {
                "query": query,
                "search_type": "vector",
                "entity_types": ["entity"],
                "metadata_filters": {"projection_state": "active"},
                "page_size": 60,
                "output_format": "json",
                "min_similarity": 0.65,
            },
            timeout=5,
        )

    async def health(self):
        result = await self.call(
            "search_notes",
            {
                "query": "__smc_projection_health__",
                "search_type": "text",
                "page_size": 1,
                "output_format": "json",
            },
            timeout=5,
        )
        if not isinstance(result.get("results"), list):
            raise RuntimeError("Basic Memory search is unavailable")


async def inventory(db) -> dict[str, str]:
    result = {}
    for kind, model in MODELS.items():
        names = {
            "source": ("id", "revision", "title", "project_id", "archived"),
            "memory": ("id", "version"),
            "task": ("id", "version"),
            "project": ("id", "name", "description", "archived"),
        }[kind]
        statement = select(*(getattr(model, name) for name in names))
        for row in (await db.execute(statement)).mappings():
            result[f"{kind}:{row['id']}"] = stamp(kind, row)
    return result


async def load_record(db, key: str):
    kind, identity = key.split(":", 1)
    model = MODELS.get(kind)
    if model is None or (kind == "task" and not identity.isdigit()):
        return None
    return await db.get(model, int(identity) if kind == "task" else identity)


async def sync_once(sessions, client=None) -> int:
    client = client or BasicMemory()
    async with sessions() as db:
        wanted = await inventory(db)
        indexed = {
            p.key: p.fingerprint
            for p in (await db.scalars(select(KnowledgeProjection))).all()
        }
    dirty = [
        key for key, fingerprint in wanted.items() if indexed.get(key) != fingerprint
    ]
    processed = 0
    for key in dirty[:BATCH_SIZE]:
        async with sessions() as db:
            item = await load_record(db, key)
            if item is None:
                continue
            kind = key.split(":", 1)[0]
            row = record(item)
        payload = document(kind, row)
        fingerprint = stamp(kind, row)
        await client.write(payload)
        async with sessions() as db:
            projection = await db.get(KnowledgeProjection, key)
            if projection is None:
                db.add(
                    KnowledgeProjection(
                        key=key,
                        fingerprint=fingerprint,
                        permalink="smc/" + note_name(key),
                    )
                )
            else:
                projection.fingerprint = fingerprint
                projection.updated_at = utcnow()
            await db.commit()
        processed += 1
    async with sessions() as db:
        value = {
            "last_success": utcnow().isoformat(),
            "pending": max(0, len(dirty) - processed),
            "error": None,
        }
        previous = await db.get(Preference, STATUS_KEY)
        if previous:
            previous.value = value
        else:
            db.add(Preference(key=STATUS_KEY, value=value))
        await db.commit()
    return processed


async def status(db):
    if not get_settings().basic_memory_url:
        return {"enabled": False, "backend": "sqlite"}
    state = await db.get(Preference, STATUS_KEY)
    return {
        "enabled": True,
        "backend": "basic-memory",
        "source_excerpt_chars": SOURCE_EXCERPT_CHARS,
        **(
            state.value
            if state
            else {"pending": None, "last_success": None, "error": None}
        ),
    }


async def run_sync(sessions, stop):
    while not stop.is_set():
        try:
            await BasicMemory().health()
            processed = await sync_once(sessions)
        except Exception as exc:
            # Never emit provider response text, note bodies or queries to logs.
            logger.warning("Knowledge projection unavailable: %s", type(exc).__name__)
            processed = 0
            async with sessions() as db:
                previous = await db.get(Preference, STATUS_KEY)
                value = {
                    **(previous.value if previous else {}),
                    "error": type(exc).__name__,
                }
                if previous:
                    previous.value = value
                else:
                    db.add(Preference(key=STATUS_KEY, value=value))
                await db.commit()
        try:
            await asyncio.wait_for(stop.wait(), timeout=1 if processed else 30)
        except TimeoutError:
            pass


def in_scope(kind, row, scope):
    if scope == "sources":
        return kind == "source"
    if scope == "curated":
        return (kind == "memory" and row.get("status") == "accepted") or (
            kind == "task" and row.get("status") == "open"
        )
    return True


async def search(db, query, *, mode="auto", scope="all", client=None):
    # Exact terms use AND matching, never BM's tested problematic default hybrid.
    enabled = bool(get_settings().basic_memory_url)
    exact = await lexical_search(db, query) if mode != "semantic" or not enabled else []
    items = [
        {**row, "match": "exact"}
        for row in exact
        if in_scope(row["record_type"], row, scope)
        and (
            visible(row["record_type"], row)
            or (row["record_type"] == "memory" and row["status"] == "suggested")
        )
    ]
    metadata = {"backend": "sqlite", "mode": mode, "scope": scope, "degraded": False}
    if mode == "exact" or not enabled:
        metadata["degraded"] = mode == "semantic" and not enabled
        return {"items": items, "retrieval": metadata}
    try:
        result = await (client or BasicMemory()).search(query)
        if not isinstance(result.get("results"), list):
            raise RuntimeError("Invalid knowledge search response")
        # Release the earlier read snapshot; hydrate hits from current committed state.
        await db.rollback()
        seen = {(r["record_type"], str(r["id"])) for r in items}
        for hit in result["results"]:
            # Resolve ONLY service-owned opaque paths. Never trust content or IDs
            # returned by the knowledge engine as application state or instructions.
            path = hit.get("permalink", "")
            prefix = get_settings().basic_memory_project + "/"
            if path.startswith(prefix):
                path = path[len(prefix) :]
            projection = await db.scalar(
                select(KnowledgeProjection).where(KnowledgeProjection.permalink == path)
            )
            if not projection:
                continue
            item = await load_record(db, projection.key)
            if item is None:
                continue
            kind = projection.key.split(":", 1)[0]
            row = record(item)
            if (
                not visible(kind, row)
                or stamp(kind, row) != projection.fingerprint
                or not in_scope(kind, row, scope)
                or (kind, str(row["id"])) in seen
            ):
                continue
            # Projects retain their existing navigation contract; search UI supports
            # project records explicitly rather than mistaking them for memories.
            items.append(
                {
                    **row,
                    "title": row.get("title", row.get("name")),
                    "record_type": kind,
                    "match": "semantic",
                }
            )
            seen.add((kind, str(row["id"])))
        metadata["backend"] = "basic-memory"
    except Exception:
        # Caller always retains exact search, even when semantic-only was requested.
        items = [
            {**r, "match": "exact"}
            for r in await lexical_search(db, query)
            if in_scope(r["record_type"], r, scope)
        ]
        metadata["degraded"] = True
    # An archive/edit can race the semantic round trip. Recheck every candidate,
    # including lexical results computed before waiting for the external process.
    await db.rollback()
    current = []
    for row in items:
        kind = row["record_type"]
        item = await load_record(db, f"{kind}:{row['id']}")
        if item is None:
            continue
        value = record(item)
        allowed = visible(kind, value) or (
            kind == "memory"
            and row["match"] == "exact"
            and value["status"] == "suggested"
        )
        if (
            allowed
            and stamp(kind, value) == stamp(kind, row)
            and in_scope(kind, value, scope)
        ):
            current.append(row)
    return {"items": current[:30], "retrieval": metadata}
