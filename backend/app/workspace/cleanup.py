"""Explicit, reversible retirement of unreviewed local-excerpts-v1 suggestions.

Preview is read-only. Apply requires the exact preview fingerprint; originals,
accepted/dismissed/edited memories, and anything linked to a task are untouched.
Only counts and a fingerprint are printed. The before-image stays in private
workspace history, never in logs or a repository.
"""

from __future__ import annotations

import argparse
import asyncio
import json

from sqlalchemy import select, update

from app.db.session import SessionLocal
from app.workspace.models import Memory, Task
from app.workspace.store import Conflict, audit, digest, record

REASON = "Unreviewed keyword extraction lacks reliable attribution, context, and current intent."


async def retire_legacy(sessions=SessionLocal, *, expected_fingerprint=None):
    async with sessions() as db:
        rows = list(
            (
                await db.scalars(
                    select(Memory)
                    .where(
                        Memory.status == "suggested",
                        ~select(Task.id).where(Task.memory_id == Memory.id).exists(),
                    )
                    .order_by(Memory.id)
                )
            ).all()
        )
        rows = [
            row
            for row in rows
            if row.provenance.get("model") == "local-excerpts-v1"
            and row.provenance.get("processor") == "workspace-v1"
            and not row.provenance.get("external")
            and not row.provenance.get("user_edited")
            and not row.provenance.get("retired")
        ]
        fingerprint = digest([[row.id, row.version] for row in rows])
        result = {"eligible": len(rows), "fingerprint": fingerprint, "applied": False}
        if expected_fingerprint is None:
            return result
        if expected_fingerprint != fingerprint:
            raise Conflict(
                "Suggestions changed since preview; inspect again before applying"
            )
        for row in rows:
            before = record(row)
            changed = await db.execute(
                update(Memory)
                .where(
                    Memory.id == row.id,
                    Memory.version == row.version,
                    Memory.status == "suggested",
                )
                .values(
                    status="superseded",
                    version=row.version + 1,
                    provenance={
                        **row.provenance,
                        "retired": "local-excerpts-v1",
                        "retirement_reason": REASON,
                    },
                )
                .execution_options(synchronize_session=False)
            )
            if changed.rowcount != 1:
                raise Conflict(
                    "Suggestion changed during cleanup; transaction rolled back"
                )
            await audit(
                db,
                f"memory:{row.id}",
                "retired",
                "maintenance:local-excerpts-v1",
                {
                    "reason": REASON,
                    "before": before,
                    "after_version": before["version"] + 1,
                },
            )
        await db.commit()
        return {**result, "applied": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", metavar="PREVIEW_FINGERPRINT")
    args = parser.parse_args()
    print(json.dumps(asyncio.run(retire_legacy(expected_fingerprint=args.apply))))


if __name__ == "__main__":
    main()
