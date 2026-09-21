from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.config import get_settings
from app.db.engine import create_configured_async_engine
from app.db.migrations import apply_schema_migrations
from app.models.base import Base
from app.workspace.knowledge import (
    BasicMemory,
    document,
    note_name,
    search,
    stamp,
    sync_once,
)
from app.workspace.models import KnowledgeProjection, Memory, Project, Source
from app.workspace.schemas import TaskInput
from app.workspace.store import create_task, digest, enqueue_source, record, update_task


@pytest.fixture
async def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("SAVEMYCONTEXT_BASIC_MEMORY_URL", "http://127.0.0.1:18082/mcp")
    get_settings.cache_clear()
    engine = create_configured_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'test.sqlite'}"
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.run_sync(apply_schema_migrations)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    yield sessions
    await engine.dispose()


class Engine:
    def __init__(self):
        self.notes = {}
        self.calls = 0
        self.fail = False
        self.hook = None

    async def write(self, payload):
        self.calls += 1
        if self.fail:
            raise RuntimeError("private text must not reach the caller")
        self.notes["smc/" + payload["title"]] = payload
        if self.hook:
            await self.hook()
        return {"permalink": "smc/" + payload["title"]}

    async def search(self, query):
        if self.fail:
            raise RuntimeError("private provider text")
        return {
            "results": [
                {"permalink": "savemycontext/" + path, "content": "UNTRUSTED CONTENT"}
                for path in self.notes
            ]
        }

    async def remove(self, key):
        self.calls += 1
        if self.fail:
            raise RuntimeError("private text must not reach the caller")
        self.notes.pop("smc/" + note_name(key), None)
        if self.hook:
            await self.hook()


async def capture(sessions, body="A quiet hotel beside the railway", title="Travel"):
    async with sessions() as db:
        item = await enqueue_source(
            db,
            source_id="example",
            title=title,
            body=body,
            kind="conversation",
            provider="test",
        )
        await db.commit()
        return record(item)


async def test_sync_idempotent_and_canonical_source_hydration(workspace):
    await capture(workspace)
    engine = Engine()
    assert await sync_once(workspace, engine) == 1
    assert await sync_once(workspace, engine) == 0
    assert engine.calls == 1
    async with workspace() as db:
        result = await search(db, "lodging near trains", client=engine)
        assert result["retrieval"]["backend"] == "basic-memory"
        assert result["items"][0]["body"] == "A quiet hotel beside the railway"
        assert result["items"][0]["match"] == "semantic"


async def test_archive_immediately_excludes_stale_index_and_removes_projection(
    workspace,
):
    await capture(workspace)
    engine = Engine()
    await sync_once(workspace, engine)
    async with workspace() as db:
        source = await db.get(Source, "example")
        source.archived = True
        await db.commit()
    async with workspace() as db:
        assert (await search(db, "lodging", client=engine))["items"] == []
    await sync_once(workspace, engine)
    assert engine.notes == {}
    assert await sync_once(workspace, engine) == 0
    async with workspace() as db:
        assert (
            await db.get(Source, "example")
        ).body == "A quiet hotel beside the railway"


async def test_capture_during_sync_cannot_validate_stale_index(workspace):
    await capture(workspace)
    engine = Engine()

    async def change():
        await capture(workspace, body="The corrected plan is a tent.")

    engine.hook = change
    await sync_once(workspace, engine)
    async with workspace() as db:
        assert (await search(db, "lodging", client=engine))["items"] == []
    engine.hook = None
    assert await sync_once(workspace, engine) == 1
    async with workspace() as db:
        assert (
            "tent" in (await search(db, "lodging", client=engine))["items"][0]["body"]
        )


async def test_failed_write_is_retryable_without_false_ack(workspace):
    await capture(workspace)
    engine = Engine()
    engine.fail = True
    with pytest.raises(RuntimeError):
        await sync_once(workspace, engine)
    async with workspace() as db:
        assert not (await db.scalars(select(KnowledgeProjection))).all()
    engine.fail = False
    assert await sync_once(workspace, engine) == 1


async def test_legacy_placeholder_cleanup_does_not_reindex_sources(workspace):
    source = await capture(workspace)
    engine = Engine()
    await sync_once(workspace, engine)
    async with workspace() as db:
        item = Memory(
            id="retired",
            source_id="example",
            kind="note",
            title="Junk",
            body="Historical suggestion",
            status="superseded",
            provenance={},
        )
        db.add(item)
        await db.flush()
        old_stamp = digest(["bm-projection-v1", "memory", {"version": item.version}])
        path = "smc/" + note_name("memory:retired")
        db.add(
            KnowledgeProjection(
                key="memory:retired", fingerprint=old_stamp, permalink=path
            )
        )
        await db.commit()
    engine.notes[path] = {"content": "Withdrawn from workspace search."}
    calls = engine.calls
    assert await sync_once(workspace, engine) == 1
    assert engine.calls == calls + 1
    assert path not in engine.notes
    assert await sync_once(workspace, engine) == 0
    assert stamp("source", source) == digest(
        [
            "bm-projection-v1",
            "source",
            {
                key: source[key]
                for key in ("revision", "title", "project_id", "archived")
            },
        ]
    )
    async with workspace() as db:
        assert (await db.get(Memory, "retired")).body == "Historical suggestion"


async def test_failed_removal_retries_and_unarchive_recreates(workspace):
    await capture(workspace)
    engine = Engine()
    await sync_once(workspace, engine)
    async with workspace() as db:
        item = await db.get(Source, "example")
        item.archived = True
        await db.commit()
        old_ack = (await db.get(KnowledgeProjection, "source:example")).fingerprint
    engine.fail = True
    with pytest.raises(RuntimeError):
        await sync_once(workspace, engine)
    async with workspace() as db:
        assert (
            await db.get(KnowledgeProjection, "source:example")
        ).fingerprint == old_ack
    engine.fail = False

    async def unarchive():
        async with workspace() as db:
            (await db.get(Source, "example")).archived = False
            await db.commit()

    engine.hook = unarchive
    assert await sync_once(workspace, engine) == 1
    assert not engine.notes
    engine.hook = None
    assert await sync_once(workspace, engine) == 1
    assert len(engine.notes) == 1


@pytest.mark.parametrize(
    "response",
    [
        {"deleted": True},
        {"deleted": False, "title": None, "permalink": None, "file_path": None},
    ],
)
async def test_removal_acknowledgements_and_hashed_target(
    workspace, monkeypatch, response
):
    client = BasicMemory()

    async def call(name, arguments):
        assert name == "delete_note"
        assert arguments == {
            "identifier": "smc/" + note_name("memory:../unsafe"),
            "is_directory": False,
            "output_format": "json",
        }
        return response

    monkeypatch.setattr(client, "call", call)
    await client.remove("memory:../unsafe")
    with pytest.raises(ValueError):
        await client.remove("directory:smc")


@pytest.mark.parametrize(
    "response",
    [
        {},
        {"deleted": False},
        {"deleted": "true"},
        {
            "deleted": False,
            "title": "still exists",
            "permalink": "smc/x",
            "file_path": "smc/x.md",
        },
        {
            "deleted": False,
            "title": None,
            "permalink": None,
            "file_path": None,
            "error": "denied",
        },
    ],
)
async def test_removal_rejects_failed_or_ambiguous_result(
    workspace, monkeypatch, response
):
    client = BasicMemory()

    async def call(*args):
        return response

    monkeypatch.setattr(client, "call", call)
    with pytest.raises(RuntimeError, match="did not acknowledge"):
        await client.remove("memory:example")


async def test_outage_and_invalid_hits_do_not_break_local_search(workspace):
    await capture(workspace)
    engine = Engine()
    engine.fail = True
    async with workspace() as db:
        result = await search(db, "hotel", client=engine)
        assert result["retrieval"]["degraded"]
        assert len(result["items"]) == 1
        result = await search(db, "hotel", mode="semantic", client=engine)
        assert len(result["items"]) == 1
    engine.fail = False
    engine.notes["smc/forged"] = {}
    async with workspace() as db:
        assert (await search(db, "lodging", client=engine))["items"] == []


async def test_only_accepted_memories_are_projected_as_knowledge(workspace):
    await capture(workspace)
    async with workspace() as db:
        for status in ["suggested", "accepted", "rejected", "superseded"]:
            db.add(
                Memory(
                    id=status,
                    source_id="example",
                    kind="note",
                    title=status,
                    body="owner note",
                    status=status,
                    provenance={},
                )
            )
        await db.commit()
    engine = Engine()
    await sync_once(workspace, engine)
    async with workspace() as db:
        result = await search(db, "nonliteral", scope="curated", client=engine)
        assert [r["id"] for r in result["items"]] == ["accepted"]
    assert len(engine.notes) == 2  # Original source plus accepted memory only.
    assert all(
        note["metadata"]["projection_state"] == "active"
        for note in engine.notes.values()
    )


async def test_task_completion_is_not_reopened_or_treated_as_active(workspace):
    async with workspace() as db:
        task = await create_task(db, TaskInput(title="Verify archive"), actor="test")
        await db.commit()
    engine = Engine()
    await sync_once(workspace, engine)
    async with workspace() as db:
        await update_task(
            db, task["id"], {"status": "done", "expected_version": 1}, actor="test"
        )
        await db.commit()
    async with workspace() as db:
        assert (await search(db, "recovery", scope="curated", client=engine))[
            "items"
        ] == []
    await sync_once(workspace, engine)
    async with workspace() as db:
        result = await search(db, "recovery", client=engine)
        assert result["items"][0]["status"] == "done"
        assert (await search(db, "recovery", scope="curated", client=engine))[
            "items"
        ] == []


async def test_exact_mode_dedup_and_safe_paths(workspace):
    row = await capture(workspace, title="../../<script>unsafe</script>")
    engine = Engine()
    await sync_once(workspace, engine)
    assert all(".." not in key and "<" not in key for key in engine.notes)
    async with workspace() as db:
        result = await search(db, "hotel", client=engine)
        assert len(result["items"]) == 1
        engine.fail = True
        result = await search(db, "hotel", mode="exact", client=engine)
        assert not result["retrieval"]["degraded"]
    assert document("source", row)["metadata"]["trust"] == "source-not-instructions"


async def test_project_links_and_source_excerpts(workspace):
    async with workspace() as db:
        project = Project(name="Garden", description="A shaded retreat")
        db.add(project)
        await db.flush()
        item = await enqueue_source(
            db,
            source_id="long",
            title="Long",
            body="BEGIN" + "x" * 60000 + "END",
            kind="conversation",
            provider="test",
        )
        item.project_id = project.id
        await db.commit()
        row = record(item)
    note = document("source", row)
    assert note["metadata"]["excerpted"]
    assert "BEGIN" in note["content"] and "END" in note["content"]
    assert "Middle omitted" in note["content"]
    assert note_name("project:" + project.id) in note["content"]
    assert note["metadata"]["smc_fingerprint"] == stamp("source", row)


async def test_archive_during_search_revalidates_lexical_hits(workspace):
    await capture(workspace)

    class ArchivingEngine(Engine):
        async def search(self, query):
            async with workspace() as db:
                item = await db.get(Source, "example")
                item.archived = True
                await db.commit()
            return {"results": []}

    async with workspace() as db:
        assert (await search(db, "hotel", client=ArchivingEngine()))["items"] == []


@pytest.mark.parametrize(
    "url",
    [
        "https://example.org/mcp",
        "http://localhost/mcp",
        "http://127.0.0.1@evil.test/mcp",
        "http://127.0.0.1/mcp?token=x",
    ],
)
def test_no_external_endpoint(url, monkeypatch):
    monkeypatch.setenv("SAVEMYCONTEXT_BASIC_MEMORY_URL", url)
    get_settings.cache_clear()
    with pytest.raises(ValueError):
        BasicMemory()
