"""Synthetic end-to-end adapter smoke test against a DISPOSABLE Basic Memory project.

Set SAVEMYCONTEXT_BASIC_MEMORY_URL and SAVEMYCONTEXT_BASIC_MEMORY_PROJECT.
Never use a real project: this creates/updates synthetic Markdown notes there.
"""

import asyncio
import json
import tempfile
from pathlib import Path

from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.config import get_settings
from app.db.engine import create_configured_async_engine
from app.db.migrations import apply_schema_migrations
from app.models.base import Base
from app.workspace.knowledge import BasicMemory, search, sync_once
from app.workspace.schemas import TaskInput
from app.workspace.store import create_task, enqueue_source, update_task


async def main():
    if not get_settings().basic_memory_project.startswith("evaluation"):
        raise SystemExit("Use a disposable project named evaluation*")
    with tempfile.TemporaryDirectory(prefix="smc-bm-smoke-") as folder:
        engine = create_configured_async_engine(
            f"sqlite+aiosqlite:///{Path(folder) / 'workspace.sqlite'}"
        )
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            await conn.run_sync(apply_schema_migrations)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with sessions() as db:
            await enqueue_source(
                db,
                source_id="smoke-travel",
                title="Travel preference",
                body="I prefer quiet lodging within walking distance of a railway station. Avoid noisy nightlife districts when booking accommodation.",
                kind="conversation",
                provider="synthetic",
            )
            task = await create_task(
                db,
                TaskInput(
                    title="Restore rehearsal",
                    notes="Verify encrypted backups can be recovered on another computer.",
                ),
                actor="smoke",
            )
            await db.commit()
        assert await sync_once(sessions) == 2
        assert await sync_once(sessions) == 0
        # BM can queue embeddings after writes; exercise its actual vector endpoint.
        for _ in range(30):
            async with sessions() as db:
                result = await search(
                    db,
                    "Where should I stay near train transport away from loud bars?",
                    mode="semantic",
                )
            if any(row["id"] == "smoke-travel" for row in result["items"]):
                break
            await asyncio.sleep(1)
        assert not result["retrieval"]["degraded"], result["retrieval"]
        assert any(row["id"] == "smoke-travel" for row in result["items"]), (
            "No semantic source match"
        )
        async with sessions() as db:
            await update_task(
                db, task["id"], {"status": "done", "expected_version": 1}, actor="smoke"
            )
            await db.commit()
        assert await sync_once(sessions) == 1
        async with sessions() as db:
            result = await search(db, "recover backups", scope="curated")
            assert not any(row["record_type"] == "task" for row in result["items"])
        # Confirm the real endpoint gives structured output, not a silent text error.
        response = await BasicMemory().search("railway lodging")
        assert isinstance(response["results"], list)
        await engine.dispose()
        print(
            json.dumps(
                {
                    "sync": "passed",
                    "semantic": "passed",
                    "completed_task_filter": "passed",
                }
            )
        )


asyncio.run(main())
