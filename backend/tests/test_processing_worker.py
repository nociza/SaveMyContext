from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import DEFAULT_OPENROUTER_MODEL, get_settings
from app.models import ChatMessage, ChatSession
from app.models.base import Base
from app.models.enums import BuiltInPileSlug, MessageRole, ProviderName
from app.schemas.ingest import IngestDiffRequest, IngestMessage
from app.services.ingest import IngestService
from app.services.idea_projects import IdeaProjectService
from app.services.processing_worker import (
    ExtensionBrowserProcessingService,
    PendingProcessingTask,
    ProcessingTaskConflictError,
    immediate_processing_model,
    processing_source_revision,
)
from app.services.todo import TodoListConflictError, TodoListService


def _source_revision_map(*sessions: ChatSession) -> dict[str, str]:
    return {
        session.id: processing_source_revision(list(session.messages))
        for session in sessions
    }


def _task_source_revision_map(task) -> dict[str, str]:  # type: ignore[no-untyped-def]
    return {item.session_id: item.source_revision for item in task.tasks}


async def _create_pending_session(session, *, external_id: str, captured_at: datetime) -> ChatSession:
    stored = ChatSession(
        provider=ProviderName.GEMINI,
        external_session_id=external_id,
        title=external_id,
        last_captured_at=captured_at,
        processing_pending=True,
    )
    stored.messages.append(
        ChatMessage(
            external_message_id=f"message-{external_id}",
            role=MessageRole.USER,
            content=f"Please update the list for {external_id}.",
            sequence_index=1,
        )
    )
    session.add(stored)
    await session.commit()
    await session.refresh(stored)
    return stored


@pytest.mark.asyncio
async def test_processing_worker_complete_applies_pipeline_result_batch_and_writes_markdown(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-processing-worker.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "browser_proxy")
    monkeypatch.setenv("SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION", "true")
    get_settings.cache_clear()

    try:
        async with session_factory() as session:
            ingest = IngestService(session)
            ingest.exporter.base_dir = tmp_path / "markdown"
            first_session, _ = await ingest.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="processing-session-1",
                    sync_mode="full_snapshot",
                    title="Processing Session 1",
                    source_url="https://gemini.google.com/app/processing-session-1",
                    captured_at=datetime(2026, 4, 2, 13, 0, tzinfo=timezone.utc),
                    messages=[
                        IngestMessage(
                            external_message_id="msg-1",
                            role=MessageRole.USER,
                            content="I need to plan tomorrow and review today's work.",
                        )
                    ],
                    raw_capture={"source": "test"},
                )
            )
            second_session, _ = await ingest.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="processing-session-2",
                    sync_mode="full_snapshot",
                    title="Processing Session 2",
                    source_url="https://gemini.google.com/app/processing-session-2",
                    captured_at=datetime(2026, 4, 2, 13, 5, tzinfo=timezone.utc),
                    messages=[
                        IngestMessage(
                            external_message_id="msg-2",
                            role=MessageRole.USER,
                            content="Explain how FastAPI uses uvloop.",
                        )
                    ],
                    raw_capture={"source": "test"},
                )
            )

            worker = ExtensionBrowserProcessingService(session)
            result = await worker.complete_task(
                [first_session.id, second_session.id],
                (
                    '{"results":['
                    '{"session_id":"%s","pile":"journal","classification_reason":"Personal planning.","journal":{"entry":"Planned the next day.","action_items":["Review the release checklist"]},"factual_triplets":[],"idea":null},'
                    '{"session_id":"%s","pile":"factual","classification_reason":"Technical explanation.","journal":null,"factual_triplets":[{"subject":"FastAPI","predicate":"uses","object":"uvloop","confidence":0.92}],"idea":null}'
                    "]}"
                )
                % (first_session.id, second_session.id),
                source_revisions=_source_revision_map(first_session, second_session),
            )

            refreshed_first = await session.get(ChatSession, first_session.id)
            refreshed_second = await session.get(ChatSession, second_session.id)

            assert result.processed_count == 2
            assert [item.session_id for item in result.results] == [first_session.id, second_session.id]
            assert refreshed_first is not None
            assert refreshed_second is not None
            assert refreshed_first.built_in_pile.value == "journal"
            assert "Planned the next day." in (refreshed_first.journal_entry or "")
            assert refreshed_first.markdown_path is not None
            assert refreshed_second.built_in_pile.value == "factual"
            assert refreshed_second.markdown_path is not None
    finally:
        get_settings.cache_clear()

    await engine.dispose()


def test_immediate_processing_model_uses_resolved_openrouter_default(monkeypatch) -> None:
    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "auto")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-or-v1-test-secret")
    get_settings.cache_clear()

    try:
        assert immediate_processing_model() == DEFAULT_OPENROUTER_MODEL
    finally:
        get_settings.cache_clear()


@pytest.mark.asyncio
async def test_processing_worker_prompt_includes_active_idea_projects(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-processing-worker-projects.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "browser_proxy")
    monkeypatch.setenv("SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION", "true")
    get_settings.cache_clear()

    try:
        async with session_factory() as session:
            await IdeaProjectService(session).create_project(
                name="Agent Workflow Surfaces",
                description="Badges, capability pages, and workflow graph ideas.",
            )
            worker = ExtensionBrowserProcessingService(session)
            prompt = await worker._build_prompt(
                [
                    PendingProcessingTask(
                        task_key="task_1",
                        session_id="session-1",
                        source_revision="0" * 64,
                        source_provider="gemini",
                        source_session_id="source-1",
                        title="Workflow badge",
                        transcript="USER: Brainstorm workflow badges.",
                    )
                ],
                current_todo_markdown="# To-Do List\n",
            )

            assert "Active idea projects" in prompt
            assert "agent-workflow-surfaces" in prompt
            assert "Badges, capability pages" in prompt
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_processing_worker_complete_rejects_invalid_json_with_clear_error(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-processing-worker-invalid.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "browser_proxy")
    monkeypatch.setenv("SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION", "true")
    get_settings.cache_clear()

    try:
        async with session_factory() as session:
            ingest = IngestService(session)
            ingest.exporter.base_dir = tmp_path / "markdown"
            stored_session, _ = await ingest.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="processing-invalid-session",
                    sync_mode="full_snapshot",
                    title="Processing Invalid Session",
                    source_url="https://gemini.google.com/app/processing-invalid-session",
                    captured_at=datetime(2026, 4, 3, 10, 0, tzinfo=timezone.utc),
                    messages=[
                        IngestMessage(
                            external_message_id="msg-1",
                            role=MessageRole.USER,
                            content="Summarize this as a journal entry.",
                        )
                    ],
                    raw_capture={"source": "test"},
                )
            )

            worker = ExtensionBrowserProcessingService(session)
            with pytest.raises(ValueError, match="Could not parse the processing response as valid JSON"):
                await worker.complete_task(
                    [stored_session.id],
                    '{"pile":"journal","classification_reason":"broken \\q"}',
                    source_revisions=_source_revision_map(stored_session),
                )
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_processing_worker_complete_accepts_task_key_reply_and_maps_to_expected_session(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-processing-worker-task-key.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "browser_proxy")
    monkeypatch.setenv("SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION", "true")
    get_settings.cache_clear()

    try:
        async with session_factory() as session:
            ingest = IngestService(session)
            ingest.exporter.base_dir = tmp_path / "markdown"
            stored_session, _ = await ingest.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="processing-task-key-session",
                    sync_mode="full_snapshot",
                    title="Processing Task Key Session",
                    source_url="https://gemini.google.com/app/processing-task-key-session",
                    captured_at=datetime(2026, 4, 3, 10, 0, tzinfo=timezone.utc),
                    messages=[
                        IngestMessage(
                            external_message_id="msg-1",
                            role=MessageRole.USER,
                            content="Summarize this as a journal entry.",
                        )
                    ],
                    raw_capture={"source": "test"},
                )
            )

            worker = ExtensionBrowserProcessingService(session)
            result = await worker.complete_task(
                [stored_session.id],
                '{"results":[{"task_key":"task_1","pile":"journal","classification_reason":"ok","journal":{"entry":"hello","action_items":[]},"factual_triplets":[],"idea":null}]}',
                source_revisions=_source_revision_map(stored_session),
            )

            assert result.processed_count == 1
            assert result.results[0].session_id == stored_session.id
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_processing_worker_complete_accepts_single_result_with_wrong_session_id_for_single_batch(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-processing-worker-single-fallback.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "browser_proxy")
    monkeypatch.setenv("SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION", "true")
    get_settings.cache_clear()

    try:
        async with session_factory() as session:
            ingest = IngestService(session)
            ingest.exporter.base_dir = tmp_path / "markdown"
            stored_session, _ = await ingest.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="processing-single-fallback-session",
                    sync_mode="full_snapshot",
                    title="Processing Single Fallback Session",
                    source_url="https://gemini.google.com/app/processing-single-fallback-session",
                    captured_at=datetime(2026, 4, 3, 10, 0, tzinfo=timezone.utc),
                    messages=[
                        IngestMessage(
                            external_message_id="msg-1",
                            role=MessageRole.USER,
                            content="Summarize this as a journal entry.",
                        )
                    ],
                    raw_capture={"source": "test"},
                )
            )

            worker = ExtensionBrowserProcessingService(session)
            result = await worker.complete_task(
                [stored_session.id],
                '{"results":[{"session_id":"made-up-id","pile":"journal","classification_reason":"ok","journal":{"entry":"hello","action_items":[]},"factual_triplets":[],"idea":null}]}',
                source_revisions=_source_revision_map(stored_session),
            )

            assert result.processed_count == 1
            assert result.results[0].session_id == stored_session.id
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_processing_worker_rejects_stale_todo_revision(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-processing-worker-todo-stale.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "browser_proxy")
    monkeypatch.setenv("SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION", "true")
    monkeypatch.setenv("SAVEMYCONTEXT_GIT_VERSIONING_ENABLED", "false")
    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    get_settings.cache_clear()
    try:
        async with session_factory() as session:
            stored = await _create_pending_session(
                session,
                external_id="todo-stale",
                captured_at=datetime(2026, 7, 11, 10, 0, tzinfo=timezone.utc),
            )
            worker = ExtensionBrowserProcessingService(session)
            task = await worker.next_task()
            assert task.todo_source_revision is not None

            todo_service = TodoListService(base_dir=worker.exporter.base_dir)
            todo_service.write_markdown("# To-Do List\n\n## Active\n- [ ] Manual edit\n\n## Done\n")
            response_text = json.dumps(
                {
                    "results": [
                        {
                            "task_key": "task_1",
                            "pile": "todo",
                            "classification_reason": "Explicit task.",
                            "todo": {
                                "summary": "Stale update",
                                "updated_markdown": "# To-Do List\n\n## Active\n- [ ] Stale AI edit\n\n## Done\n",
                                "items": [],
                            },
                        }
                    ]
                }
            )

            with pytest.raises(TodoListConflictError, match="changed"):
                await worker.complete_task(
                    [stored.id],
                    response_text,
                    todo_source_revision=task.todo_source_revision,
                    source_revisions=_task_source_revision_map(task),
                )

            assert "Manual edit" in todo_service.read_markdown()
            assert "Stale AI edit" not in todo_service.read_markdown()
    finally:
        get_settings.cache_clear()
    await engine.dispose()


@pytest.mark.asyncio
async def test_processing_worker_chains_revision_across_multiple_todo_results(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-processing-worker-todo-batch.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "browser_proxy")
    monkeypatch.setenv("SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION", "true")
    monkeypatch.setenv("SAVEMYCONTEXT_GIT_VERSIONING_ENABLED", "false")
    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    monkeypatch.setenv("SAVEMYCONTEXT_PROCESSING_BATCH_SIZE", "2")
    get_settings.cache_clear()
    try:
        async with session_factory() as session:
            await _create_pending_session(
                session,
                external_id="todo-first",
                captured_at=datetime(2026, 7, 11, 10, 0, tzinfo=timezone.utc),
            )
            await _create_pending_session(
                session,
                external_id="todo-second",
                captured_at=datetime(2026, 7, 11, 10, 5, tzinfo=timezone.utc),
            )
            worker = ExtensionBrowserProcessingService(session)
            task = await worker.next_task()
            assert task.todo_source_revision is not None
            assert len(task.tasks) == 2

            first_markdown = "# To-Do List\n\n## Active\n- [ ] First cumulative task\n\n## Done\n"
            final_markdown = (
                "# To-Do List\n\n## Active\n- [ ] First cumulative task\n- [ ] Second cumulative task\n\n## Done\n"
            )
            response_text = json.dumps(
                {
                    "results": [
                        {
                            "task_key": "task_1",
                            "pile": "todo",
                            "classification_reason": "First explicit task.",
                            "todo": {"summary": "First", "updated_markdown": first_markdown, "items": []},
                        },
                        {
                            "task_key": "task_2",
                            "pile": "todo",
                            "classification_reason": "Second explicit task.",
                            "todo": {"summary": "Second", "updated_markdown": final_markdown, "items": []},
                        },
                    ]
                }
            )

            result = await worker.complete_task(
                [item.session_id for item in task.tasks],
                response_text,
                todo_source_revision=task.todo_source_revision,
                source_revisions=_task_source_revision_map(task),
            )

            assert result.processed_count == 2
            stored_markdown = TodoListService(base_dir=worker.exporter.base_dir).read_markdown()
            assert "First cumulative task" in stored_markdown
            assert "Second cumulative task" in stored_markdown
    finally:
        get_settings.cache_clear()
    await engine.dispose()


@pytest.mark.asyncio
async def test_processing_worker_rejects_completion_after_manual_pile_lock(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-processing-worker-lock.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "browser_proxy")
    monkeypatch.setenv("SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION", "true")
    monkeypatch.setenv("SAVEMYCONTEXT_GIT_VERSIONING_ENABLED", "false")
    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    get_settings.cache_clear()
    try:
        async with session_factory() as session:
            stored = await _create_pending_session(
                session,
                external_id="manual-lock",
                captured_at=datetime(2026, 7, 11, 10, 0, tzinfo=timezone.utc),
            )
            worker = ExtensionBrowserProcessingService(session)
            task = await worker.next_task()
            assert [item.session_id for item in task.tasks] == [stored.id]

            stored.built_in_pile = BuiltInPileSlug.FACTUAL
            stored.pile_assignment_locked = True
            await session.commit()
            response_text = json.dumps(
                {
                    "results": [
                        {
                            "task_key": "task_1",
                            "pile": "journal",
                            "classification_reason": "Stale automatic result.",
                            "journal": {"entry": "Should not apply", "action_items": []},
                        }
                    ]
                }
            )

            with pytest.raises(ProcessingTaskConflictError, match="manually assigned"):
                await worker.complete_task(
                    [stored.id],
                    response_text,
                    source_revisions=_task_source_revision_map(task),
                )

            await session.refresh(stored)
            assert stored.pile_assignment_locked is True
            assert stored.built_in_pile == BuiltInPileSlug.FACTUAL
            assert stored.last_processed_at is None
            assert stored.journal_entry is None
    finally:
        get_settings.cache_clear()
    await engine.dispose()


@pytest.mark.asyncio
async def test_processing_worker_rejects_completion_after_source_changes(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-processing-worker-source-race.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "browser_proxy")
    monkeypatch.setenv("SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION", "true")
    monkeypatch.setenv("SAVEMYCONTEXT_GIT_VERSIONING_ENABLED", "false")
    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    get_settings.cache_clear()
    try:
        async with session_factory() as session:
            stored = await _create_pending_session(
                session,
                external_id="source-race",
                captured_at=datetime(2026, 7, 11, 10, 0, tzinfo=timezone.utc),
            )
            worker = ExtensionBrowserProcessingService(session)
            task = await worker.next_task()
            assert [item.session_id for item in task.tasks] == [stored.id]

            session.add(
                ChatMessage(
                    session_id=stored.id,
                    external_message_id="message-arrived-later",
                    role=MessageRole.ASSISTANT,
                    content="This arrived while the browser worker was running.",
                    sequence_index=2,
                )
            )
            stored.last_captured_at = datetime(2026, 7, 11, 10, 5, tzinfo=timezone.utc)
            await session.commit()

            response_text = json.dumps(
                {
                    "results": [
                        {
                            "task_key": "task_1",
                            "pile": "journal",
                            "classification_reason": "Stale automatic result.",
                            "journal": {"entry": "Should not apply", "action_items": []},
                        }
                    ]
                }
            )
            with pytest.raises(ProcessingTaskConflictError, match="source conversation changed"):
                await worker.complete_task(
                    [stored.id],
                    response_text,
                    source_revisions=_task_source_revision_map(task),
                )

            await session.refresh(stored)
            assert stored.last_processed_at is None
            assert stored.journal_entry is None
    finally:
        get_settings.cache_clear()
    await engine.dispose()


@pytest.mark.asyncio
async def test_processing_worker_rejects_replayed_completion(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-processing-worker-replay.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "browser_proxy")
    monkeypatch.setenv("SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION", "true")
    monkeypatch.setenv("SAVEMYCONTEXT_GIT_VERSIONING_ENABLED", "false")
    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    get_settings.cache_clear()
    try:
        async with session_factory() as session:
            stored = await _create_pending_session(
                session,
                external_id="completion-replay",
                captured_at=datetime(2099, 7, 11, 10, 0, tzinfo=timezone.utc),
            )
            worker = ExtensionBrowserProcessingService(session)
            task = await worker.next_task()
            response_text = json.dumps(
                {
                    "results": [
                        {
                            "task_key": "task_1",
                            "pile": "journal",
                            "classification_reason": "Journal entry.",
                            "journal": {"entry": "Applied exactly once", "action_items": []},
                        }
                    ]
                }
            )
            source_revisions = _task_source_revision_map(task)

            first = await worker.complete_task(
                [stored.id],
                response_text,
                source_revisions=source_revisions,
            )
            assert first.processed_count == 1
            assert await worker.pending_count() == 0

            with pytest.raises(ProcessingTaskConflictError, match="already completed"):
                await worker.complete_task(
                    [stored.id],
                    response_text,
                    source_revisions=source_revisions,
                )
    finally:
        get_settings.cache_clear()
    await engine.dispose()
