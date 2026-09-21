"""Read-only repair preview. Emits hashes/counts, never conversation text.

Run against an online-backup snapshot, not a changing live SQLite file:
  python -m app.workspace.capture_preview SNAPSHOT --parser replay.mjs
The parser is the bundled extension/scripts/preview-captures.ts.
There is deliberately no apply flag. A reparse may select a different branch,
and a missing prompt cannot be invented. Both require review before adoption.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess

from app.workspace.quality import assess
from app.workspace.store import digest


def preview(path: Path, parser: Path) -> dict:
    with path.open("rb") as stream:
        before = hashlib.file_digest(stream, "sha256").hexdigest()
    with sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise ValueError("Archive integrity check failed")
        sessions = list(db.execute("SELECT id,provider FROM chat_sessions ORDER BY id"))
        captures = defaultdict(list)
        for row in db.execute(
            "SELECT session_id,raw_capture FROM sync_events ORDER BY created_at"
        ):
            raw = json.loads(row["raw_capture"]) if row["raw_capture"] else None
            if isinstance(raw, dict):
                captures[row["session_id"]].append(raw)
        request = "\n".join(
            json.dumps({"id": row["id"], "captures": captures[row["id"]]})
            for row in sessions
        )
        process = subprocess.run(
            ["node", str(parser.resolve())],
            input=request + "\n",
            text=True,
            capture_output=True,
            timeout=120,
        )
        if process.returncode:
            raise RuntimeError("Offline parser replay failed; raw stderr withheld")
        results = {
            row["id"]: row for row in map(json.loads, process.stdout.splitlines())
        }
        items, counts = [], defaultdict(Counter)
        for session in sessions:
            original = [
                dict(row)
                for row in db.execute(
                    "SELECT external_message_id AS id,role,content FROM chat_messages WHERE session_id=? ORDER BY sequence_index",
                    (session["id"],),
                )
            ]
            replay = results[session["id"]]
            snapshot = replay["snapshot"]
            proposed = (
                [
                    {k: m[k] for k in ("id", "role", "content")}
                    for m in snapshot["messages"]
                ]
                if snapshot
                else []
            )
            quality = assess(proposed)
            if snapshot and snapshot.get("extractionMethod") == "heuristic":
                quality["status"] = "needs_repair"
                quality["reasons"].append("unverified_text_extraction")
            disposition = (
                "unparsed"
                if not snapshot
                else "recapture_or_manual_review"
                if quality["status"] == "needs_repair"
                else "unchanged"
                if original == proposed
                else "reviewable_reparse"
            )
            counts[session["provider"]][disposition] += 1
            items.append(
                {
                    "source_key": digest(session["id"]),
                    "provider": session["provider"],
                    "before_digest": digest(original),
                    "proposed_digest": digest(proposed),
                    "before_messages": len(original),
                    "proposed_messages": len(proposed),
                    "missing_old_ids": len(
                        {m["id"] for m in original} - {m["id"] for m in proposed}
                    ),
                    "before_quality": assess(original),
                    "proposed_quality": quality,
                    "disposition": disposition,
                    "parse_errors": replay["errors"],
                    "completeness": snapshot.get("completeness", "partial")
                    if snapshot
                    else "unknown",
                }
            )
    with path.open("rb") as stream:
        after = hashlib.file_digest(stream, "sha256").hexdigest()
    if before != after:
        raise RuntimeError("Input changed during preview; discard this report")
    return {
        "archive_sha256": before,
        "read_only": True,
        "applied": False,
        "counts": {k: dict(v) for k, v in counts.items()},
        "items": items,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--parser", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(preview(args.snapshot, args.parser), indent=2))


if __name__ == "__main__":
    main()
