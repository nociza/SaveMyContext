from __future__ import annotations

import sqlite3
import time
from datetime import datetime, timezone

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.config import get_settings
from app.db.engine import create_configured_async_engine
from app.db.migrations import apply_schema_migrations
from app.models.base import Base
from app.workspace import api
from app.workspace.migrate import import_nexus
from app.workspace.models import Event, Job, Memory, Source, Task
from app.workspace.processor import extract, jev_decisions
from app.workspace.schemas import MemoryPatch, TaskInput
from app.workspace.store import (
    Conflict,
    create_task,
    enqueue_source,
    notifications,
    search,
    set_settings,
    update_task,
)
from app.workspace.worker import run_one


@pytest.fixture
async def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("SAVEMYCONTEXT_WORKSPACE_ENABLED", "true")
    monkeypatch.setenv("SAVEMYCONTEXT_WORKSPACE_EXTERNAL_PROCESSING", "false")
    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "vault"))
    get_settings.cache_clear()
    engine = create_configured_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'workspace.sqlite'}"
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.run_sync(apply_schema_migrations)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    yield sessions
    await engine.dispose()


async def capture(sessions, body="I need to call the dentist."):
    async with sessions() as db:
        source = await enqueue_source(
            db,
            source_id="test:one",
            title="A thought",
            body=body,
            kind="conversation",
            provider="test",
        )
        await db.commit()
        return source.revision


async def test_capture_replay_is_one_job_and_search_is_local(workspace):
    await capture(workspace)
    await capture(workspace)
    async with workspace() as db:
        assert len((await db.scalars(select(Job))).all()) == 1
        results = await search(db, "dentist")
        assert results[0]["id"] == "test:one"


async def test_worker_creates_suggestions_not_tasks_and_keeps_completed_state(
    workspace,
):
    await capture(workspace)
    assert await run_one(workspace)
    async with workspace() as db:
        memory = await db.scalar(select(Memory))
        assert memory.kind == "task" and memory.status == "suggested"
        assert not (await db.scalars(select(Task))).all()
        context = api.AuthContext(None, "test", "owner", frozenset({"*"}))
        await api.edit_memory(
            memory.id, MemoryPatch(status="accepted", expected_version=1), context, db
        )
        task = await db.scalar(select(Task))
        assert task.title == "call the dentist."
        await update_task(
            db, task.id, {"status": "done", "expected_version": 1}, actor="test"
        )
        await db.commit()
    await capture(
        workspace, "I need to call the dentist.\nMy idea is a quieter garden."
    )
    await run_one(workspace)
    async with workspace() as db:
        tasks = (await db.scalars(select(Task))).all()
        assert len(tasks) == 1 and tasks[0].status == "done"
        assert len((await db.scalars(select(Event))).all()) >= 3


async def test_capture_rollback_rolls_back_job_and_fts(workspace):
    async with workspace() as db:
        await enqueue_source(
            db,
            source_id="rollback",
            title="test",
            body="unsaved",
            kind="note",
            provider="test",
        )
        await db.rollback()
    async with workspace() as db:
        assert await db.get(Source, "rollback") is None
        assert not (await db.scalars(select(Job))).all()
        assert await search(db, "unsaved") == []


async def test_old_worker_cannot_apply_after_new_capture(workspace):
    await capture(workspace)

    async def intervening(body, messages):
        await capture(workspace, "A newer thought.")
        return [{"kind": "task", "title": "old", "body": body, "evidence": body}], {
            "model": "test"
        }

    await run_one(workspace, extractor=intervening)
    async with workspace() as db:
        assert not (await db.scalars(select(Memory))).all()
        assert "superseded" in (await db.scalars(select(Job.state))).all()


async def test_worker_failures_are_retryable_and_do_not_lose_source(workspace):
    await capture(workspace)

    async def failure(*args):
        raise RuntimeError("secret source must not become error text")

    await run_one(workspace, extractor=failure)
    async with workspace() as db:
        assert await db.get(Source, "test:one")
        job = await db.scalar(select(Job))
        assert job.state == "pending" and job.attempts == 1
        assert job.error == "RuntimeError" and job.available_at > time.time()


async def test_task_commands_idempotency_conflicts_and_manual_cas(workspace):
    async with workspace() as db:
        first = await create_task(
            db, TaskInput(title="Buy tea"), actor="test", key="request1"
        )
        await db.commit()
        assert (
            await create_task(
                db, TaskInput(title="Buy tea"), actor="test", key="request1"
            )
            == first
        )
        with pytest.raises(Conflict):
            await create_task(
                db, TaskInput(title="Buy coffee"), actor="test", key="request1"
            )
        await update_task(
            db,
            first["id"],
            {"title": "Buy green tea", "expected_version": 1},
            actor="test",
        )
        await db.commit()
        with pytest.raises(Conflict):
            await update_task(
                db, first["id"], {"title": "stale", "expected_version": 1}, actor="test"
            )


async def test_reminders_require_both_consent_and_task_request(workspace):
    now = datetime(2026, 9, 20, 20, 0, tzinfo=timezone.utc)
    async with workspace() as db:
        await create_task(
            db, TaskInput(title="Not opted in", due_on="2026-09-19"), actor="test"
        )
        task = await create_task(
            db,
            TaskInput(title="Requested", due_on="2026-09-19", notify=True),
            actor="test",
        )
        assert (await notifications(db, now))["events"] == []
        await set_settings(db, {"notifications_enabled": True}, actor="test")
        events = (await notifications(db, now))["events"]
        assert (
            len(events) == 1
            and events[0]["event_key"] == f"task:{task['id']}:due:2026-09-19"
        )


async def test_assistant_text_quotes_and_negations_do_not_create_local_tasks(workspace):
    items, _ = await extract(
        "full transcript",
        [
            {"role": "assistant", "content": "I need to call the dentist."},
            {
                "role": "user",
                "content": "> I need to call the dentist.\nI don't need to buy coffee.\nI need to buy tea.",
            },
        ],
    )
    assert len(items) == 1 and items[0]["title"] == "buy tea."


async def test_jev_typed_endpoint_and_explicit_opt_in(workspace, monkeypatch):
    called = []

    def handler(request):
        called.append(request)
        assert request.url.path == "/api/alpha/decisions"
        return httpx.Response(
            200,
            json={
                "answers": {
                    f"0_{kind}": {
                        "type": "noul",
                        "noul": 0.98 if kind == "task" else 0.02,
                    }
                    for kind in ("task", "idea", "decision")
                }
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        assert await jev_decisions(["I need to buy tea"], client) == {}
        monkeypatch.setenv("SAVEMYCONTEXT_WORKSPACE_EXTERNAL_PROCESSING", "true")
        monkeypatch.setenv("SAVEMYCONTEXT_JEV_API_KEY", "test-not-a-real-key")
        get_settings.cache_clear()
        result = await jev_decisions(["I need to buy tea"], client)
        assert result["0_task"]["noul"] == 0.98 and len(called) == 1


async def test_nexus_import_preserves_ids_settings_and_rejects_different_snapshot(
    workspace, tmp_path
):
    path = tmp_path / "nexus.sqlite"
    with sqlite3.connect(path) as db:
        db.executescript("""
          CREATE TABLE tasks(id INTEGER,title TEXT,notes TEXT,list_name TEXT,tags_json TEXT,priority TEXT,status TEXT,due_on TEXT,remind_at TEXT,notify INTEGER,completed_at TEXT,created_at TEXT,updated_at TEXT);
          CREATE TABLE settings(key TEXT,value TEXT);
          INSERT INTO tasks VALUES(47,'Existing task','context','Home','["tea"]','high','done',NULL,NULL,0,'2026-09-01T00:00:00Z','2026-08-01 00:00:00','2026-09-01 00:00:00');
          INSERT INTO settings VALUES('notifications_enabled','false');
        """)
    assert (await import_nexus(path, workspace))["imported"] == 1
    assert (await import_nexus(path, workspace))["already_imported"]
    async with workspace() as db:
        task = await db.get(Task, 47)
        assert task.status == "done" and task.tags == ["tea"]
        new = await create_task(db, TaskInput(title="Next"), actor="test")
        assert new["id"] > 47
    with sqlite3.connect(path) as db:
        db.execute("UPDATE tasks SET title='changed'")
    with pytest.raises(ValueError, match="different"):
        await import_nexus(path, workspace)


async def test_manual_memory_edit_survives_new_source_and_reprocessing(workspace):
    await capture(workspace)
    await run_one(workspace)
    async with workspace() as db:
        memory = await db.scalar(select(Memory))
        context = api.AuthContext(None, "test", "owner", frozenset({"*"}))
        await api.edit_memory(
            memory.id, MemoryPatch(title="My wording", expected_version=1), context, db
        )
    await capture(workspace, "I need to call the dentist.\nA new detail.")
    await run_one(workspace)
    async with workspace() as db:
        memory = await db.scalar(select(Memory))
        assert memory.title == "My wording" and memory.status == "suggested"


async def test_expired_crash_leases_eventually_fail(workspace):
    await capture(workspace)
    async with workspace() as db:
        job = await db.scalar(select(Job))
        job.state, job.attempts, job.available_at = "running", 5, 0
        await db.commit()
    await run_one(workspace)
    async with workspace() as db:
        job = await db.scalar(select(Job))
        assert job.state == "failed" and job.error == "LeaseExpired"


async def test_workspace_startup_does_not_write_legacy_browser_directories(
    workspace, monkeypatch
):
    from pathlib import Path
    from unittest.mock import AsyncMock
    from app import main
    from app.workspace import migrate

    monkeypatch.setenv("SAVEMYCONTEXT_WORKSPACE_WORKER", "false")
    monkeypatch.setenv("SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION", "false")
    get_settings.cache_clear()
    monkeypatch.setattr(main, "init_db", AsyncMock())
    monkeypatch.setattr(migrate, "backfill", AsyncMock())
    created = []
    original = Path.mkdir

    def track(path, *args, **kwargs):
        created.append(path)
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "mkdir", track)
    async with main.lifespan(main.app):
        assert get_settings().resolved_browser_profile_dir not in created
        assert get_settings().resolved_browser_llm_state_path.parent not in created


async def test_real_api_service_auth_capture_queue_and_legacy_protection(
    workspace, tmp_path, monkeypatch
):
    from app.main import app
    from app.db.session import get_db_session

    tokens = tmp_path / "tokens"
    tokens.mkdir()
    owner, capture_only = (
        "owner-test-credential-not-real",
        "capture-test-credential-not-real",
    )
    (tokens / "owner").write_text(owner)
    (tokens / "capture-test").write_text(capture_only)
    monkeypatch.setenv("SAVEMYCONTEXT_WORKSPACE_TOKEN_DIR", str(tokens))
    get_settings.cache_clear()

    async def database():
        async with workspace() as db:
            yield db

    app.dependency_overrides[get_db_session] = database
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1"
        ) as client:
            assert (await client.get("/api/v1/workspace/overview")).status_code == 401
            client.headers["authorization"] = f"Bearer {capture_only}"
            assert (
                await client.post("/api/v1/workspace/tasks", json={"title": "Denied"})
            ).status_code == 403
            result = await client.post(
                "/api/v1/capture/source",
                json={
                    "capture_key": "smc_capture_workspace",
                    "capture_kind": "selection",
                    "save_mode": "ai",
                    "source_text": "I need to protect the originals.",
                },
            )
            assert result.status_code == 202, result.text
            assert (await client.get("/api/v1/workspace/overview")).status_code == 403
            client.headers["authorization"] = f"Bearer {owner}"
            assert (await client.get("/api/v1/workspace/overview")).json()["counts"][
                "pending_jobs"
            ] == 1
            assert (await client.post("/api/v1/todo", json={})).status_code == 409
            created = await client.post("/v1/tasks", json={"title": "Shared ledger"})
            assert created.status_code == 201
            assert (await client.get("/api/v1/workspace/tasks")).json()["tasks"][0][
                "title"
            ] == "Shared ledger"
            assert (
                await client.post("/api/v1/workspace/projects", json={"name": "Test"})
            ).status_code == 201
            assert (
                await client.post("/api/v1/workspace/projects", json={"name": "Test"})
            ).status_code == 409
    finally:
        app.dependency_overrides.pop(get_db_session, None)


async def test_conversation_ingest_queues_without_calling_legacy_inference(workspace):
    from unittest.mock import AsyncMock
    from app.services.ingest import IngestService
    from app.schemas.ingest import IngestDiffRequest, IngestMessage
    from app.models.enums import MessageRole, ProviderName
    from app.models import ChatMessage

    async with workspace() as db:
        service = IngestService(db)
        service.processor.process_session = AsyncMock(
            side_effect=AssertionError("legacy pipeline invoked")
        )
        result = await service.ingest(
            IngestDiffRequest(
                provider=ProviderName.GEMINI,
                external_session_id="workspace-chat",
                messages=[
                    IngestMessage(
                        external_message_id="one",
                        role=MessageRole.USER,
                        content="We decided to preserve this source.",
                    )
                ],
            )
        )
        captured_session, message_count = result
        assert message_count == 1 and captured_session.processing_pending
        assert len((await db.scalars(select(ChatMessage))).all()) == 1
        assert len((await db.scalars(select(Job))).all()) == 1
        assert await db.get(Source, f"session:{captured_session.id}")
