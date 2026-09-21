"""Explicit, repeatable migration helpers; input databases are opened read-only."""

from __future__ import annotations

import argparse
import asyncio
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.db.session import SessionLocal, init_db
from app.models import ChatSession, SourceCapture
from app.workspace.models import Preference, Source, Task
from app.workspace.schemas import SettingsInput, TaskInput
from app.workspace.store import (
    audit,
    digest,
    enqueue_capture,
    enqueue_session,
    index_document,
)


async def backfill(sessions=SessionLocal):
    async with sessions() as db:
        if await db.get(Preference, "source-backfill-v1"):
            return
    for model, prefix, enqueue in [
        (ChatSession, "session:", enqueue_session),
        (SourceCapture, "capture:", enqueue_capture),
    ]:
        offset = 0
        while True:
            async with sessions() as db:
                query = select(model).order_by(model.id).offset(offset).limit(100)
                if model is ChatSession:
                    query = query.options(selectinload(ChatSession.messages))
                rows = list((await db.scalars(query)).all())
                for row in rows:
                    if await db.get(Source, prefix + row.id) is None:
                        await enqueue(db, row)
                await db.commit()
                if len(rows) < 100:
                    break
                offset += 100
    async with sessions() as db:
        db.add(Preference(key="source-backfill-v1", value={"complete": True}))
        await db.commit()


def read_nexus(path: Path) -> tuple[list[dict], dict]:
    # sqlite online-backup snapshots are preferred; URI mode prevents source writes.
    with sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise ValueError("Source SQLite integrity check failed")
        tasks = [dict(row) for row in db.execute("SELECT * FROM tasks ORDER BY id")]
        settings = {
            row["key"]: row["value"] == "true"
            if row["key"].endswith("_enabled")
            else row["value"]
            for row in db.execute("SELECT * FROM settings")
        }
    return tasks, settings


def timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


async def import_nexus(path: Path, sessions=SessionLocal) -> dict:
    tasks, settings = read_nexus(path)
    fingerprint = digest({"tasks": tasks, "settings": settings})
    async with sessions() as db:
        previous = await db.get(Preference, "nexus-import-v1")
        if previous:
            if previous.value["digest"] != fingerprint:
                raise ValueError(
                    "This workspace already imported a different Nexus snapshot"
                )
            return {"imported": len(tasks), "already_imported": True}
        if await db.scalar(select(func.count()).select_from(Task)):
            raise ValueError("Task store is not empty; refusing an ambiguous merge")
        for row in tasks:
            values = TaskInput(
                title=row["title"],
                notes=row["notes"],
                list_name=row["list_name"],
                tags=json.loads(row["tags_json"]),
                priority=row["priority"],
                status=row["status"],
                due_on=row["due_on"],
                remind_at=row["remind_at"],
                notify=bool(row["notify"]),
            )
            imported = values.model_dump()
            imported["remind_at"] = row[
                "remind_at"
            ]  # Exact existing reminder event keys survive cutover.
            task = Task(
                id=row["id"],
                **imported,
                completed_at=row["completed_at"],
                created_at=timestamp(row["created_at"]),
                updated_at=timestamp(row["updated_at"]),
            )
            db.add(task)
            await index_document(db, f"task:{task.id}", task.title, task.notes or "")
            await audit(
                db,
                f"task:{task.id}",
                "imported",
                "migration",
                {"origin": "nexus-todos", "id": task.id},
            )
        db.add(
            Preference(
                key="notifications", value=SettingsInput(**settings).model_dump()
            )
        )
        db.add(
            Preference(
                key="nexus-import-v1",
                value={"digest": fingerprint, "count": len(tasks)},
            )
        )
        await db.commit()
    return {"imported": len(tasks), "already_imported": False}


async def main_async():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nexus-snapshot", type=Path)
    parser.add_argument("--backfill", action="store_true")
    args = parser.parse_args()
    await init_db()
    if args.nexus_snapshot:
        print(json.dumps(await import_nexus(args.nexus_snapshot)))
    if args.backfill:
        await backfill()
        print(json.dumps({"backfill": "complete"}))


if __name__ == "__main__":
    asyncio.run(main_async())
