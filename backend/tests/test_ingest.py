from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
import shutil
import subprocess
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import ChatMessage, ChatSession, SyncEvent
from app.models.base import Base
from app.models.enums import MessageRole, ProviderName, BuiltInPileSlug
from app.schemas.ingest import IngestDiffRequest, IngestMessage
from app.schemas.processing_worker import SessionPipelineResult
from app.core.config import get_settings
from app.services.ingest import IngestPhaseTwoError, IngestService
from app.services.processing import ManualPileAssignmentConflictError, SessionProcessor
from app.services.processing_worker import ExtensionBrowserProcessingService
from app.services.todo import TodoListService


def test_ingest_rejects_capture_timestamp_far_in_the_future() -> None:
    with pytest.raises(ValueError, match="more than 24 hours in the future"):
        IngestDiffRequest(
            provider=ProviderName.GEMINI,
            external_session_id="future-clock-poison",
            captured_at=datetime.now(timezone.utc) + timedelta(days=2),
        )


@pytest.mark.asyncio
async def test_concurrent_same_session_ingests_are_serialized_on_sqlite(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'concurrent-ingest.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "browser_proxy")
    monkeypatch.setenv("SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION", "true")
    monkeypatch.setenv("SAVEMYCONTEXT_GIT_VERSIONING_ENABLED", "false")
    get_settings.cache_clear()

    async def capture(message_id: str, minute: int) -> None:
        async with session_factory() as session:
            service = IngestService(session)
            service.exporter.base_dir = tmp_path / "markdown"
            await service.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="concurrent-session",
                    sync_mode="incremental",
                    captured_at=datetime(2026, 7, 11, 12, minute, tzinfo=timezone.utc),
                    messages=[
                        IngestMessage(
                            external_message_id=message_id,
                            role=MessageRole.USER,
                            content=f"Concurrent message {message_id}",
                        )
                    ],
                    raw_capture={"message_id": message_id},
                )
            )

    try:
        await asyncio.gather(capture("message-1", 0), capture("message-2", 1))
        async with session_factory() as session:
            stored = await IngestService(session)._load_session(
                str(await session.scalar(select(ChatSession.id)))
            )
            assert {message.external_message_id for message in stored.messages} == {
                "message-1",
                "message-2",
            }
            assert [message.sequence_index for message in stored.messages] == [1, 2]
            assert stored.processing_pending is True
            assert await session.scalar(select(func.count(ChatSession.id))) == 1
            assert await session.scalar(select(func.count(SyncEvent.id))) == 2
    finally:
        get_settings.cache_clear()
        await engine.dispose()


@pytest.mark.asyncio
async def test_full_snapshot_updates_existing_messages(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-test.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        service = IngestService(session)
        service.exporter.base_dir = tmp_path / "markdown"

        first_payload = IngestDiffRequest(
            provider=ProviderName.GEMINI,
            external_session_id="session-1",
            sync_mode="full_snapshot",
            source_url="https://gemini.google.com/app/session-1",
            captured_at=datetime(2026, 4, 1, 12, 0, tzinfo=timezone.utc),
            messages=[
                IngestMessage(
                    external_message_id="msg-1",
                    role=MessageRole.USER,
                    content="Original prompt",
                )
            ],
            raw_capture={"source": "test"},
        )
        await service.ingest(first_payload)

        second_payload = IngestDiffRequest(
            provider=ProviderName.GEMINI,
            external_session_id="session-1",
            sync_mode="full_snapshot",
            source_url="https://gemini.google.com/app/session-1",
            captured_at=datetime(2026, 4, 1, 12, 5, tzinfo=timezone.utc),
            messages=[
                IngestMessage(
                    external_message_id="msg-1",
                    role=MessageRole.USER,
                    content="Updated prompt text",
                ),
                IngestMessage(
                    external_message_id="msg-2",
                    parent_external_message_id="msg-1",
                    role=MessageRole.ASSISTANT,
                    content="Fresh assistant reply",
                ),
            ],
            raw_capture={"source": "test"},
        )
        await service.ingest(second_payload)

        result = await session.execute(select(ChatMessage).order_by(ChatMessage.sequence_index))
        messages = result.scalars().all()

        assert [message.external_message_id for message in messages] == ["msg-1", "msg-2"]
        assert messages[0].content == "Updated prompt text"
        assert messages[1].content == "Fresh assistant reply"

    await engine.dispose()


@pytest.mark.asyncio
async def test_full_snapshot_removes_messages_missing_from_the_latest_provider_snapshot(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-full-snapshot-reconcile.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        service = IngestService(session)
        service.exporter.base_dir = tmp_path / "markdown"

        await service.ingest(
            IngestDiffRequest(
                provider=ProviderName.GEMINI,
                external_session_id="session-reconcile",
                sync_mode="full_snapshot",
                source_url="https://gemini.google.com/app/session-reconcile",
                captured_at=datetime(2026, 4, 1, 12, 0, tzinfo=timezone.utc),
                messages=[
                    IngestMessage(external_message_id="msg-1", role=MessageRole.USER, content="First prompt"),
                    IngestMessage(external_message_id="msg-2", role=MessageRole.ASSISTANT, content="First reply"),
                    IngestMessage(external_message_id="msg-3", role=MessageRole.USER, content="Second prompt"),
                ],
                raw_capture={"source": "test"},
            )
        )

        await service.ingest(
            IngestDiffRequest(
                provider=ProviderName.GEMINI,
                external_session_id="session-reconcile",
                sync_mode="full_snapshot",
                source_url="https://gemini.google.com/app/session-reconcile",
                captured_at=datetime(2026, 4, 1, 12, 5, tzinfo=timezone.utc),
                messages=[
                    IngestMessage(external_message_id="msg-1", role=MessageRole.USER, content="First prompt, edited"),
                    IngestMessage(external_message_id="msg-3", role=MessageRole.USER, content="Second prompt"),
                ],
                raw_capture={"source": "test"},
            )
        )

        result = await session.execute(select(ChatMessage).order_by(ChatMessage.sequence_index))
        messages = result.scalars().all()

        assert [message.external_message_id for message in messages] == ["msg-1", "msg-3"]
        assert [message.sequence_index for message in messages] == [1, 2]
        assert messages[0].content == "First prompt, edited"

    await engine.dispose()


@pytest.mark.asyncio
async def test_stale_full_snapshot_cannot_delete_newer_messages(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-stale-snapshot.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        service = IngestService(session)
        service.exporter.base_dir = tmp_path / "markdown"
        newer_at = datetime(2026, 4, 1, 12, 5, tzinfo=timezone.utc)
        older_at = datetime(2026, 4, 1, 12, 0, tzinfo=timezone.utc)

        await service.ingest(
            IngestDiffRequest(
                provider=ProviderName.GEMINI,
                external_session_id="stale-snapshot-session",
                sync_mode="full_snapshot",
                captured_at=newer_at,
                messages=[
                    IngestMessage(external_message_id="msg-1", role=MessageRole.USER, content="First"),
                    IngestMessage(external_message_id="msg-2", role=MessageRole.ASSISTANT, content="Second"),
                    IngestMessage(external_message_id="msg-3", role=MessageRole.USER, content="Newest"),
                ],
                raw_capture={"revision": "newer"},
            )
        )

        stored, new_message_count = await service.ingest(
            IngestDiffRequest(
                provider=ProviderName.GEMINI,
                external_session_id="stale-snapshot-session",
                sync_mode="full_snapshot",
                captured_at=older_at,
                messages=[
                    IngestMessage(external_message_id="msg-1", role=MessageRole.USER, content="First"),
                    IngestMessage(external_message_id="msg-2", role=MessageRole.ASSISTANT, content="Second"),
                ],
                raw_capture={"revision": "older"},
            )
        )

        assert new_message_count == 0
        assert [message.external_message_id for message in stored.messages] == ["msg-1", "msg-2", "msg-3"]
        assert service._aware_utc(stored.last_snapshot_at) == newer_at
        assert service._aware_utc(stored.last_captured_at) == newer_at
        events = (await session.execute(select(SyncEvent).order_by(SyncEvent.created_at))).scalars().all()
        assert [event.raw_capture for event in events] == [
            {"revision": "newer"},
            {"revision": "older"},
        ]
        assert all(event.capture_hash for event in events)

    await engine.dispose()


@pytest.mark.asyncio
async def test_delayed_full_snapshot_cannot_delete_newer_incremental_messages(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-mixed-watermark.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        service = IngestService(session)
        service.exporter.base_dir = tmp_path / "markdown"
        first_at = datetime(2026, 4, 1, 12, 0, tzinfo=timezone.utc)
        delayed_at = datetime(2026, 4, 1, 12, 5, tzinfo=timezone.utc)
        incremental_at = datetime(2026, 4, 1, 12, 10, tzinfo=timezone.utc)

        await service.ingest(
            IngestDiffRequest(
                provider=ProviderName.GEMINI,
                external_session_id="mixed-watermark-session",
                sync_mode="full_snapshot",
                captured_at=first_at,
                messages=[IngestMessage(external_message_id="msg-1", role=MessageRole.USER, content="First")],
                raw_capture={"revision": "first-full"},
            )
        )
        await service.ingest(
            IngestDiffRequest(
                provider=ProviderName.GEMINI,
                external_session_id="mixed-watermark-session",
                sync_mode="incremental",
                captured_at=incremental_at,
                messages=[IngestMessage(external_message_id="msg-2", role=MessageRole.ASSISTANT, content="Newest")],
                raw_capture={"revision": "incremental"},
            )
        )

        stored, new_message_count = await service.ingest(
            IngestDiffRequest(
                provider=ProviderName.GEMINI,
                external_session_id="mixed-watermark-session",
                sync_mode="full_snapshot",
                captured_at=delayed_at,
                messages=[IngestMessage(external_message_id="msg-1", role=MessageRole.USER, content="First")],
                raw_capture={"revision": "delayed-full"},
            )
        )

        assert new_message_count == 0
        assert [message.external_message_id for message in stored.messages] == ["msg-1", "msg-2"]
        assert service._aware_utc(stored.last_snapshot_at) == incremental_at
        assert service._aware_utc(stored.last_captured_at) == incremental_at
        assert await session.scalar(select(func.count(SyncEvent.id))) == 3

    await engine.dispose()


@pytest.mark.asyncio
async def test_equal_watermark_full_snapshot_only_appends_unseen_messages(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-equal-watermark.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        service = IngestService(session)
        service.exporter.base_dir = tmp_path / "markdown"
        captured_at = datetime(2026, 4, 1, 12, 0, tzinfo=timezone.utc)
        await service.ingest(
            IngestDiffRequest(
                provider=ProviderName.GEMINI,
                external_session_id="equal-watermark-session",
                sync_mode="full_snapshot",
                title="Current title",
                captured_at=captured_at,
                messages=[
                    IngestMessage(external_message_id="msg-1", role=MessageRole.USER, content="Original"),
                    IngestMessage(external_message_id="msg-2", role=MessageRole.ASSISTANT, content="Keep me"),
                ],
                raw_capture={"revision": 1},
            )
        )

        stored, _ = await service.ingest(
            IngestDiffRequest(
                provider=ProviderName.GEMINI,
                external_session_id="equal-watermark-session",
                sync_mode="full_snapshot",
                title="Delayed title",
                captured_at=captured_at,
                messages=[
                    IngestMessage(external_message_id="msg-1", role=MessageRole.USER, content="Edited safely")
                ],
                raw_capture=None,
            )
        )

        assert [message.external_message_id for message in stored.messages] == ["msg-1", "msg-2"]
        assert stored.messages[0].content == "Original"
        assert stored.messages[1].content == "Keep me"
        assert stored.title == "Current title"
        events = (await session.execute(select(SyncEvent).order_by(SyncEvent.created_at))).scalars().all()
        assert len(events) == 1

    await engine.dispose()


@pytest.mark.asyncio
async def test_undated_full_snapshot_only_appends_unseen_messages(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-undated-full.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        service = IngestService(session)
        service.exporter.base_dir = tmp_path / "markdown"
        await service.ingest(
            IngestDiffRequest(
                provider=ProviderName.GEMINI,
                external_session_id="undated-full-session",
                sync_mode="full_snapshot",
                captured_at=datetime(2026, 4, 1, 12, 0, tzinfo=timezone.utc),
                messages=[
                    IngestMessage(external_message_id="msg-1", role=MessageRole.USER, content="Original"),
                    IngestMessage(external_message_id="msg-2", role=MessageRole.ASSISTANT, content="Keep me"),
                ],
                raw_capture={"revision": 1},
            )
        )

        stored, new_message_count = await service.ingest(
            IngestDiffRequest(
                provider=ProviderName.GEMINI,
                external_session_id="undated-full-session",
                sync_mode="full_snapshot",
                messages=[
                    IngestMessage(external_message_id="msg-1", role=MessageRole.USER, content="Edited safely"),
                    IngestMessage(external_message_id="msg-3", role=MessageRole.ASSISTANT, content="New message"),
                ],
                raw_capture={"revision": 2},
            )
        )

        assert new_message_count == 1
        assert [message.external_message_id for message in stored.messages] == ["msg-1", "msg-2", "msg-3"]
        assert stored.messages[0].content == "Original"
        assert stored.messages[1].content == "Keep me"
        assert stored.messages[2].content == "New message"

    await engine.dispose()


@pytest.mark.asyncio
async def test_identical_full_snapshot_only_advances_snapshot_watermark(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-idempotent-snapshot.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        service = IngestService(session)
        service.exporter.base_dir = tmp_path / "markdown"
        first_at = datetime(2026, 4, 1, 12, 0, tzinfo=timezone.utc)
        second_at = datetime(2026, 4, 1, 12, 5, tzinfo=timezone.utc)
        messages = [IngestMessage(external_message_id="msg-1", role=MessageRole.USER, content="Unchanged")]

        await service.ingest(
            IngestDiffRequest(
                provider=ProviderName.GEMINI,
                external_session_id="idempotent-snapshot-session",
                sync_mode="full_snapshot",
                captured_at=first_at,
                messages=messages,
                raw_capture={"metadata": {"a": 1, "b": 2}, "revision": 1},
            )
        )

        service.processor.process = AsyncMock(side_effect=AssertionError("unchanged snapshot was reprocessed"))
        service.exporter.write_session = AsyncMock(side_effect=AssertionError("unchanged snapshot was re-exported"))
        stored, new_message_count = await service.ingest(
            IngestDiffRequest(
                provider=ProviderName.GEMINI,
                external_session_id="idempotent-snapshot-session",
                sync_mode="full_snapshot",
                captured_at=second_at,
                messages=messages,
                raw_capture={"revision": 1, "metadata": {"b": 2, "a": 1}},
            )
        )

        assert new_message_count == 0
        assert service._aware_utc(stored.last_snapshot_at) == second_at
        assert service._aware_utc(stored.last_captured_at) == first_at
        assert await session.scalar(select(func.count(SyncEvent.id))) == 1
        service.processor.process.assert_not_awaited()
        service.exporter.write_session.assert_not_awaited()

    await engine.dispose()


@pytest.mark.asyncio
async def test_changed_raw_capture_is_preserved_without_reprocessing(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-distinct-raw.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        service = IngestService(session)
        service.exporter.base_dir = tmp_path / "markdown"
        first_at = datetime(2026, 4, 1, 12, 0, tzinfo=timezone.utc)
        second_at = datetime(2026, 4, 1, 12, 5, tzinfo=timezone.utc)
        messages = [IngestMessage(external_message_id="msg-1", role=MessageRole.USER, content="Unchanged")]

        stored, _ = await service.ingest(
            IngestDiffRequest(
                provider=ProviderName.GEMINI,
                external_session_id="distinct-raw-session",
                sync_mode="full_snapshot",
                captured_at=first_at,
                messages=messages,
                raw_capture={"revision": 1},
            )
        )

        service.processor.process = AsyncMock(side_effect=AssertionError("raw-only change was reprocessed"))
        service.exporter.write_session = AsyncMock(return_value=Path(stored.markdown_path or "session.md"))
        updated, new_message_count = await service.ingest(
            IngestDiffRequest(
                provider=ProviderName.GEMINI,
                external_session_id="distinct-raw-session",
                sync_mode="full_snapshot",
                captured_at=second_at,
                messages=messages,
                raw_capture={"revision": 2},
            )
        )

        events = (await session.execute(select(SyncEvent).order_by(SyncEvent.created_at))).scalars().all()
        assert new_message_count == 0
        assert service._aware_utc(updated.last_snapshot_at) == second_at
        assert [event.raw_capture for event in events] == [{"revision": 1}, {"revision": 2}]
        assert events[1].message_count == 0
        service.processor.process.assert_not_awaited()
        service.exporter.write_session.assert_awaited_once()

    await engine.dispose()


@pytest.mark.asyncio
async def test_identical_discard_replay_does_not_reprocess_or_export(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-discard-replay.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        service = IngestService(session)
        service.exporter.base_dir = tmp_path / "markdown"
        payload = IngestDiffRequest(
            provider=ProviderName.GEMINI,
            external_session_id="discard-replay-session",
            sync_mode="full_snapshot",
            captured_at=datetime(2026, 4, 1, 12, 0, tzinfo=timezone.utc),
            route_to_discard=True,
            discard_word_match="temporary",
            messages=[IngestMessage(external_message_id="msg-1", role=MessageRole.USER, content="Temporary chat")],
            raw_capture={"revision": 1},
        )
        stored, _ = await service.ingest(payload)
        processed_at = stored.last_processed_at

        service.processor.route_to_discard = AsyncMock(
            side_effect=AssertionError("identical discard replay was reprocessed")
        )
        service.exporter.write_session = AsyncMock(
            side_effect=AssertionError("identical discard replay was re-exported")
        )
        replayed, new_message_count = await service.ingest(payload)

        assert new_message_count == 0
        assert replayed.is_discarded is True
        assert replayed.last_processed_at == processed_at
        assert await session.scalar(select(func.count(SyncEvent.id))) == 1
        service.processor.route_to_discard.assert_not_awaited()
        service.exporter.write_session.assert_not_awaited()

    await engine.dispose()


def test_ingest_payload_rejects_duplicate_external_message_ids() -> None:
    with pytest.raises(ValueError, match="Duplicate external_message_id values are not allowed"):
        IngestDiffRequest(
            provider=ProviderName.GEMINI,
            external_session_id="duplicate-session",
            sync_mode="full_snapshot",
            source_url="https://gemini.google.com/app/duplicate-session",
            captured_at=datetime(2026, 4, 1, 12, 0, tzinfo=timezone.utc),
            messages=[
                IngestMessage(external_message_id="msg-1", role=MessageRole.USER, content="One"),
                IngestMessage(external_message_id="msg-1", role=MessageRole.ASSISTANT, content="Two"),
            ],
            raw_capture={"source": "test"},
        )


@pytest.mark.asyncio
async def test_ingest_accepts_long_titles(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-long-title.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        service = IngestService(session)
        service.exporter.base_dir = tmp_path / "markdown"

        long_title = "Generate keyframes for me using the style of hand drawn stick figures on white background. " * 12
        payload = IngestDiffRequest(
            provider=ProviderName.GEMINI,
            external_session_id="long-title-session",
            sync_mode="full_snapshot",
            title=long_title,
            source_url="https://gemini.google.com/app/long-title-session",
            captured_at=datetime(2026, 4, 1, 12, 0, tzinfo=timezone.utc),
            messages=[
                IngestMessage(
                    external_message_id="msg-1",
                    role=MessageRole.USER,
                    content="Test content",
                )
            ],
            raw_capture={"source": "test"},
        )

        stored_session, _ = await service.ingest(payload)
        assert stored_session.title == long_title

    await engine.dispose()


@pytest.mark.asyncio
async def test_ingest_writes_markdown_when_related_sessions_have_mixed_datetime_timezones(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-ingest-timezones.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "openai")
    get_settings.cache_clear()
    try:
        async with session_factory() as session:
            service = IngestService(session)
            service.exporter.base_dir = tmp_path / "markdown"

            first_payload = IngestDiffRequest(
                provider=ProviderName.GEMINI,
                external_session_id="facts-1",
                sync_mode="full_snapshot",
                title="Facts 1",
                source_url="https://gemini.google.com/app/facts-1",
                captured_at=datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc),
                messages=[
                    IngestMessage(
                        external_message_id="msg-1",
                        role=MessageRole.USER,
                        content="FastAPI uses uvloop.",
                    )
                ],
                raw_capture={"source": "test"},
            )
            await service.ingest(first_payload)

            first_session = await session.scalar(
                select(ChatSession).where(ChatSession.external_session_id == "facts-1")
            )
            assert first_session is not None
            first_session.updated_at = datetime(2026, 4, 2, 12, 5)
            await session.flush()

            second_payload = IngestDiffRequest(
                provider=ProviderName.GEMINI,
                external_session_id="facts-2",
                sync_mode="full_snapshot",
                title="Facts 2",
                source_url="https://gemini.google.com/app/facts-2",
                captured_at=datetime(2026, 4, 2, 12, 10, tzinfo=timezone.utc),
                messages=[
                    IngestMessage(
                        external_message_id="msg-2",
                        role=MessageRole.USER,
                        content="FastAPI supports ASGI.",
                    )
                ],
                raw_capture={"source": "test"},
            )
            stored_session, _ = await service.ingest(second_payload)

            assert stored_session.markdown_path is not None
            entity_notes = sorted((service.exporter.vault_root / "Graph" / "Entities").glob("fastapi--*.md"))
            assert len(entity_notes) == 1
            entity_markdown = entity_notes[0].read_text(encoding="utf-8")
            assert "Facts 1" in entity_markdown
            assert "Facts 2" in entity_markdown
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_ingest_writes_fact_triplets_into_session_markdown(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-ingest-factual-markdown.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "heuristic")
    get_settings.cache_clear()
    try:
        async with session_factory() as session:
            service = IngestService(session)
            service.exporter.base_dir = tmp_path / "markdown"

            stored_session, _ = await service.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="facts-triplet-session",
                    sync_mode="full_snapshot",
                    title="Facts Triplet Session",
                    source_url="https://gemini.google.com/app/facts-triplet-session",
                    captured_at=datetime(2026, 4, 14, 12, 0, tzinfo=timezone.utc),
                    messages=[
                        IngestMessage(
                            external_message_id="msg-1",
                            role=MessageRole.USER,
                            content="FastAPI uses uvloop.",
                        )
                    ],
                    raw_capture={"source": "test"},
                )
            )

            markdown_path = Path(stored_session.markdown_path or "")
            markdown = markdown_path.read_text(encoding="utf-8")

            assert stored_session.built_in_pile == BuiltInPileSlug.FACTUAL
            assert any(triplet.subject == "FastAPI" and triplet.predicate == "uses" for triplet in stored_session.triplets)
            assert "## Fact Triplets" in markdown
            assert "- FastAPI | uses | uvloop" in markdown
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_ingest_writes_source_document_with_raw_capture_and_message_payloads(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-ingest-source-markdown.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "heuristic")
    get_settings.cache_clear()
    try:
        async with session_factory() as session:
            service = IngestService(session)
            service.exporter.base_dir = tmp_path / "markdown"

            stored_session, _ = await service.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="source-doc-session",
                    sync_mode="full_snapshot",
                    title="Source Doc Session",
                    source_url="https://gemini.google.com/app/source-doc-session",
                    captured_at=datetime(2026, 4, 14, 12, 0, tzinfo=timezone.utc),
                    messages=[
                        IngestMessage(
                            external_message_id="msg-1",
                            role=MessageRole.USER,
                            content="Explain how FastAPI uses uvloop.",
                            raw_payload={"messageId": "msg-1", "role": "user"},
                        )
                    ],
                    raw_capture={"provider": "gemini", "snapshot": {"messageCount": 1}},
                )
            )

            markdown_path = Path(stored_session.markdown_path or "")
            source_path = service.exporter._source_note_path(stored_session)
            markdown = markdown_path.read_text(encoding="utf-8")
            source_markdown = source_path.read_text(encoding="utf-8")

            assert source_path.exists()
            assert "Source Document" in markdown
            assert f"[[Sources/{source_path.stem}|Source Document]]" in markdown
            assert "## Raw Sync Captures" in source_markdown
            assert "\"messageCount\": 1" in source_markdown
            assert "\"messageId\": \"msg-1\"" in source_markdown
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_processing_failure_cannot_roll_back_accepted_source_capture(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-capture-boundary.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "heuristic")
    get_settings.cache_clear()
    try:
        async with session_factory() as session:
            service = IngestService(session)
            service.exporter.base_dir = tmp_path / "markdown"
            service.processor.process = AsyncMock(side_effect=RuntimeError("provider unavailable"))
            payload = IngestDiffRequest(
                provider=ProviderName.GEMINI,
                external_session_id="capture-boundary-session",
                sync_mode="full_snapshot",
                captured_at=datetime(2026, 4, 20, 12, 0, tzinfo=timezone.utc),
                messages=[
                    IngestMessage(
                        external_message_id="msg-1",
                        role=MessageRole.USER,
                        content="Preserve this even if enrichment fails.",
                    )
                ],
                raw_capture={"revision": 1},
            )
            with pytest.raises(IngestPhaseTwoError, match="source capture was preserved"):
                await service.ingest(payload)

            stored = await service._load_session(
                str(
                    await session.scalar(
                        select(ChatSession.id).where(
                            ChatSession.external_session_id == "capture-boundary-session"
                        )
                    )
                )
            )
            new_message_count = len(stored.messages)

            assert new_message_count == 1
            assert [message.content for message in stored.messages] == [
                "Preserve this even if enrichment fails."
            ]
            assert stored.last_processed_at is None
            assert stored.processing_pending is True
            assert stored.projection_pending is True
            assert await session.scalar(select(func.count(SyncEvent.id))) == 1
            stored_id = stored.id

            with pytest.raises(IngestPhaseTwoError):
                await service.ingest(payload)
            replayed = await service._load_session(stored_id)
            assert replayed.last_processed_at is None
            assert replayed.processing_pending is True
            assert replayed.projection_pending is True
            assert service.processor.process.await_count == 2
            assert await session.scalar(select(func.count(SyncEvent.id))) == 1
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_browser_processing_does_not_replace_a_locked_manual_pile(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-manual-pile-lock.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "browser_proxy")
    monkeypatch.setenv("SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION", "true")
    get_settings.cache_clear()
    try:
        async with session_factory() as session:
            service = IngestService(session)
            service.exporter.base_dir = tmp_path / "markdown"
            first_at = datetime(2026, 4, 20, 12, 0, tzinfo=timezone.utc)
            stored, _ = await service.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="manual-pile-lock-session",
                    sync_mode="full_snapshot",
                    captured_at=first_at,
                    messages=[
                        IngestMessage(
                            external_message_id="msg-1",
                            role=MessageRole.USER,
                            content="Initial fact.",
                        )
                    ],
                    raw_capture={"revision": 1},
                )
            )
            stored.built_in_pile = BuiltInPileSlug.FACTUAL
            stored.pile_assignment_locked = True
            stored.classification_reason = "Manually assigned to pile 'factual'."
            stored.last_processed_at = first_at
            await session.commit()

            updated, _ = await service.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="manual-pile-lock-session",
                    sync_mode="incremental",
                    captured_at=datetime(2026, 4, 20, 12, 5, tzinfo=timezone.utc),
                    messages=[
                        IngestMessage(
                            external_message_id="msg-2",
                            role=MessageRole.ASSISTANT,
                            content="Additional fact.",
                        )
                    ],
                    raw_capture={"revision": 2},
                    route_to_discard=True,
                    discard_word_match="discard-me",
                )
            )

            assert updated.built_in_pile == BuiltInPileSlug.FACTUAL
            assert updated.pile_assignment_locked is True
            assert updated.is_discarded is False
            assert IngestService.processing_is_current(updated) is False
            worker = ExtensionBrowserProcessingService(session)
            assert await worker.pending_count() == 0
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_automatic_result_cannot_overwrite_a_newer_manual_pile_lock(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'manual-pile-cas.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    try:
        async with session_factory() as setup:
            stored = ChatSession(
                provider=ProviderName.GEMINI,
                external_session_id="manual-pile-cas",
                pile_assignment_locked=False,
                processing_pending=True,
            )
            setup.add(stored)
            await setup.commit()
            session_id = stored.id

        # Model the ordering of a slow automatic pipeline: it started while
        # unlocked, but a user committed a manual choice before its result was
        # ready to apply.
        async with session_factory() as manual:
            current = await manual.get(ChatSession, session_id)
            assert current is not None
            current.built_in_pile = BuiltInPileSlug.JOURNAL
            current.pile_assignment_locked = True
            current.classification_reason = "Manual choice"
            await manual.commit()

        async with session_factory() as automatic:
            processor = SessionProcessor(automatic)
            with pytest.raises(ManualPileAssignmentConflictError):
                await processor.apply_pipeline_result(
                    session_id,
                    SessionPipelineResult(
                        pile=BuiltInPileSlug.FACTUAL,
                        classification_reason="Stale automatic choice",
                    ),
                )
            await automatic.rollback()

        async with session_factory() as verify:
            current = await verify.get(ChatSession, session_id)
            assert current is not None
            assert current.built_in_pile == BuiltInPileSlug.JOURNAL
            assert current.pile_assignment_locked is True
            assert current.classification_reason == "Manual choice"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_ingest_auto_processes_immediately_without_browser_automation(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-browser-llm.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "auto")
    get_settings.cache_clear()

    try:
        async with session_factory() as session:
            service = IngestService(session)
            service.exporter.base_dir = tmp_path / "markdown"

            first_session, _ = await service.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="source-session-1",
                    sync_mode="full_snapshot",
                    title="Original Session 1",
                    source_url="https://gemini.google.com/app/source-session-1",
                    captured_at=datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc),
                    messages=[
                        IngestMessage(
                            external_message_id="msg-1",
                            role=MessageRole.USER,
                            content="Plan tomorrow and reflect on today.",
                        )
                    ],
                    raw_capture={"source": "test"},
                )
            )
            second_session, _ = await service.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="source-session-2",
                    sync_mode="full_snapshot",
                    title="Original Session 2",
                    source_url="https://gemini.google.com/app/source-session-2",
                    captured_at=datetime(2026, 4, 2, 12, 5, tzinfo=timezone.utc),
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

            processing = ExtensionBrowserProcessingService(session)
            next_task = await processing.next_task()

            assert first_session.last_processed_at is not None
            assert second_session.last_processed_at is not None
            assert next_task.available is False
            assert next_task.task_count == 0
            assert next_task.prompt is None
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_ingest_browser_proxy_batches_when_experimental_browser_automation_is_enabled(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-browser-llm-experimental.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "browser_proxy")
    monkeypatch.setenv("SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION", "true")
    monkeypatch.setenv("SAVEMYCONTEXT_BROWSER_LLM_MODEL", "browser-gemini")
    monkeypatch.setenv("SAVEMYCONTEXT_BROWSER_LLM_STATE_PATH", str(tmp_path / "browser-llm-state.json"))
    get_settings.cache_clear()

    try:
        async with session_factory() as session:
            service = IngestService(session)
            service.exporter.base_dir = tmp_path / "markdown"

            first_session, _ = await service.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="source-session-1",
                    sync_mode="full_snapshot",
                    title="Original Session 1",
                    source_url="https://gemini.google.com/app/source-session-1",
                    captured_at=datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc),
                    messages=[
                        IngestMessage(
                            external_message_id="msg-1",
                            role=MessageRole.USER,
                            content="Plan tomorrow and reflect on today.",
                        )
                    ],
                    raw_capture={"source": "test"},
                )
            )
            second_session, _ = await service.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="source-session-2",
                    sync_mode="full_snapshot",
                    title="Original Session 2",
                    source_url="https://gemini.google.com/app/source-session-2",
                    captured_at=datetime(2026, 4, 2, 12, 5, tzinfo=timezone.utc),
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

            processing = ExtensionBrowserProcessingService(session)
            next_task = await processing.next_task()

            assert first_session.built_in_pile is None
            assert first_session.last_processed_at is None
            assert second_session.built_in_pile is None
            assert second_session.last_processed_at is None
            assert next_task.available is True
            assert next_task.task_count == 2
            assert [task.session_id for task in next_task.tasks] == [second_session.id, first_session.id]
            assert next_task.worker_model == "browser-gemini"
            assert "Use fast mode." in (next_task.prompt or "")
            assert '"task_key":"task_1"' in (next_task.prompt or "")
            assert '"task_key":"task_2"' in (next_task.prompt or "")
            assert '"source_session_id":"source-session-1"' in (next_task.prompt or "")
            assert '"source_session_id":"source-session-2"' in (next_task.prompt or "")
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_ingest_updates_shared_todo_list_and_versions_vault(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-todo-ingest.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "heuristic")
    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    get_settings.cache_clear()

    try:
        async with session_factory() as session:
            service = IngestService(session)
            service.exporter.base_dir = tmp_path / "markdown"
            TodoListService(base_dir=service.exporter.base_dir).write_markdown(
                "# To-Do List\n\n## Active\n- [ ] File taxes\n\n## Done\n"
            )

            stored_session, _ = await service.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="todo-session-1",
                    sync_mode="full_snapshot",
                    title="Update to-do list",
                    source_url="https://gemini.google.com/app/todo-session-1",
                    captured_at=datetime(2026, 4, 14, 12, 0, tzinfo=timezone.utc),
                    messages=[
                        IngestMessage(
                            external_message_id="msg-1",
                            role=MessageRole.USER,
                            content="Add buy milk to my to-do list and mark file taxes as done.",
                        )
                    ],
                    raw_capture={"source": "test"},
                )
            )

            todo_path = TodoListService(base_dir=service.exporter.base_dir).path
            todo_markdown = todo_path.read_text(encoding="utf-8")

            assert stored_session.built_in_pile == BuiltInPileSlug.TODO
            assert stored_session.todo_summary is not None
            assert "buy milk" in stored_session.todo_summary.lower()
            assert "- [ ] buy milk" in todo_markdown
            assert "- [x] File taxes" in todo_markdown
            assert (service.exporter.vault_root / ".git").exists()

            if shutil.which("git"):
                log = subprocess.run(
                    ["git", "log", "--oneline", "-1"],
                    cwd=service.exporter.vault_root,
                    check=True,
                    capture_output=True,
                    text=True,
                )
                assert "Update to-do list from gemini:todo-session-1" in log.stdout
    finally:
        get_settings.cache_clear()

    await engine.dispose()
