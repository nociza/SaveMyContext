from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.routes_ingest import router as ingest_router
from app.api.routes_piles import router as piles_router
from app.core.config import get_settings
from app.db.migrations import apply_schema_migrations
from app.db.session import get_db_session
from app.models import ChatMessage, ChatSession, Pile
from app.models.base import Base
from app.models.enums import MessageRole, PileKind, ProviderName
from app.services.orchestrator import ProcessingOrchestrator
from app.services.processing import SessionProcessor
from app.services.restructure import PileRestructureService


def _build_app(session_factory) -> FastAPI:
    app = FastAPI()
    app.include_router(ingest_router, prefix="/api/v1/ingest")
    app.include_router(piles_router, prefix="/api/v1")

    async def override_db_session():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_db_session] = override_db_session
    return app


@pytest.mark.asyncio
@pytest.mark.parametrize(("manual_assignment", "expected_locked"), [(True, True), (False, False)])
async def test_processing_claim_serializes_source_changes_before_clearing_pending(
    tmp_path,
    manual_assignment: bool,
    expected_locked: bool,
) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / f'source-claim-{manual_assignment}.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as setup:
        target = Pile(
            slug="research",
            name="Research",
            kind=PileKind.USER_DEFINED,
            folder_label="Research",
            attributes=["summary"],
            pipeline_config={},
            is_active=True,
            is_visible_on_dashboard=True,
            sort_order=10,
        )
        stored = ChatSession(
            provider=ProviderName.GEMINI,
            external_session_id=f"source-claim-{manual_assignment}",
            processing_pending=True,
            pile_assignment_locked=False,
            custom_tags=[],
        )
        stored.messages.append(
            ChatMessage(
                external_message_id="message-1",
                role=MessageRole.USER,
                content="Original source",
                sequence_index=1,
            )
        )
        setup.add_all([target, stored])
        await setup.commit()
        session_id = stored.id

    processing_started = asyncio.Event()
    release_processing = asyncio.Event()
    source_committed = asyncio.Event()

    async def run_processing() -> None:
        async with session_factory() as db:
            processor = SessionProcessor(db)
            target = await processor.piles.require_by_slug("research")

            if manual_assignment:
                async def slow_outputs(*args, **kwargs):  # type: ignore[no-untyped-def]
                    processing_started.set()
                    await release_processing.wait()
                    return {"summary": "Processed original source"}

                processor.orchestrator.pile_outputs = AsyncMock(side_effect=slow_outputs)
                await processor.reassign_to_pile(session_id, target.slug)
            else:
                async def slow_decision(*args, **kwargs):  # type: ignore[no-untyped-def]
                    processing_started.set()
                    await release_processing.wait()
                    return target, "Automatic restructure"

                processor._classify_into_user_pile = AsyncMock(side_effect=slow_decision)  # type: ignore[method-assign]
                processor.orchestrator.pile_outputs = AsyncMock(
                    return_value={"summary": "Processed original source"}
                )
                await processor.process(session_id)
            await db.commit()

    async def commit_new_source() -> None:
        async with session_factory() as db:
            stored = await db.get(ChatSession, session_id)
            assert stored is not None
            db.add(
                ChatMessage(
                    session_id=session_id,
                    external_message_id="message-2",
                    role=MessageRole.ASSISTANT,
                    content="New source committed during processing",
                    sequence_index=2,
                )
            )
            stored.processing_pending = True
            stored.projection_pending = True
            await db.flush()
            await db.execute(
                update(ChatSession)
                .where(ChatSession.id == session_id)
                .values(processing_pending=True, projection_pending=True)
                .execution_options(synchronize_session=False)
            )
            await db.commit()
            source_committed.set()

    processing_task = asyncio.create_task(run_processing())
    await asyncio.wait_for(processing_started.wait(), timeout=1)
    source_task = asyncio.create_task(commit_new_source())
    await asyncio.sleep(0.1)
    assert source_committed.is_set() is False

    release_processing.set()
    await asyncio.wait_for(asyncio.gather(processing_task, source_task), timeout=3)

    async with session_factory() as verify:
        current = await verify.get(ChatSession, session_id)
        assert current is not None
        assert current.pile_assignment_locked is expected_locked
        assert current.processing_pending is True
        assert current.projection_pending is True
        assert await verify.scalar(
            select(func.count(ChatMessage.id)).where(ChatMessage.session_id == session_id)
        ) == 2

    await engine.dispose()


@pytest.mark.asyncio
async def test_restructure_queries_skip_manually_locked_sessions(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'restructure-manual-lock.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        locked = ChatSession(
            provider=ProviderName.GEMINI,
            external_session_id="locked-restructure-session",
            pile_assignment_locked=True,
            custom_tags=[],
        )
        unlocked = ChatSession(
            provider=ProviderName.GEMINI,
            external_session_id="unlocked-restructure-session",
            pile_assignment_locked=False,
            custom_tags=[],
        )
        locked.messages.append(
            ChatMessage(
                external_message_id="locked-message",
                role=MessageRole.USER,
                content="Keep my manual pile.",
                sequence_index=1,
            )
        )
        unlocked.messages.append(
            ChatMessage(
                external_message_id="unlocked-message",
                role=MessageRole.USER,
                content="This one may be restructured.",
                sequence_index=1,
            )
        )
        session.add_all([locked, unlocked])
        await session.commit()

        selected = await PileRestructureService(session)._sessions_for_all(
            limit=25,
            include_discarded=False,
        )

        assert [item.id for item in selected] == [unlocked.id]

    await engine.dispose()


@pytest.mark.asyncio
async def test_assign_session_to_user_pile_runs_attribute_pipeline(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'user-pile-assign.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.run_sync(apply_schema_migrations)

    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "heuristic")
    get_settings.cache_clear()

    try:
        app = _build_app(session_factory)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
            create = await client.post(
                "/api/v1/piles",
                json={
                    "slug": "research",
                    "name": "Research",
                    "description": "Long-form research notes.",
                    "folder_label": "Research Archive",
                    "attributes": ["alternate_phrasings", "importance", "completion"],
                },
            )
            assert create.status_code == 201, create.text

            ingest = await client.post(
                "/api/v1/ingest/diff",
                json={
                    "provider": ProviderName.GEMINI.value,
                    "external_session_id": "user-pile-1",
                    "sync_mode": "full_snapshot",
                    "title": "user-pile-1",
                    "source_url": "https://gemini.google.com/app/user-pile-1",
                    "captured_at": datetime(2026, 4, 18, 12, 0, tzinfo=timezone.utc).isoformat(),
                    "messages": [
                        {
                            "external_message_id": "m-1",
                            "role": MessageRole.USER.value,
                            "content": "Brainstorm: low-friction onboarding for self-hosters.",
                        }
                    ],
                    "raw_capture": {"source": "test"},
                },
            )
            assert ingest.status_code == 202, ingest.text
            session_id = ingest.json()["session_id"]
            initial_pile_slug = ingest.json()["pile_slug"]
            assert initial_pile_slug in {"factual", "ideas", "journal", "todo"}

            assign = await client.post(f"/api/v1/piles/research/sessions/{session_id}/assign")
            assert assign.status_code == 200, assign.text
            payload = assign.json()
            assert payload["pile_slug"] == "research"
            assert payload["pile_assignment_locked"] is True
            assert payload["is_discarded"] is False
            assert payload["pile_outputs"] is not None
            outputs = payload["pile_outputs"]
            # Heuristic fallback fills these:
            assert "alternate_phrasings" in outputs or "summary" in outputs
            assert outputs.get("importance") == 3
            assert outputs.get("completion") == "open"
            markdown_path = Path(payload["markdown_path"])
            assert markdown_path.parent.name == "Research Archive"
            rendered = markdown_path.read_text(encoding="utf-8")
            assert 'pile: "research"' in rendered
            assert "- Pile: `research` (Research)" in rendered
            assert "unclassified" not in rendered
    finally:
        get_settings.cache_clear()
    await engine.dispose()


@pytest.mark.asyncio
async def test_assign_session_to_built_in_pile_does_not_reclassify(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'built-in-pile-assign.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.run_sync(apply_schema_migrations)

    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "heuristic")
    get_settings.cache_clear()

    try:
        app = _build_app(session_factory)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
            ingest = await client.post(
                "/api/v1/ingest/diff",
                json={
                    "provider": ProviderName.GEMINI.value,
                    "external_session_id": "built-in-pile-1",
                    "sync_mode": "full_snapshot",
                    "title": "built-in-pile-1",
                    "source_url": "https://gemini.google.com/app/built-in-pile-1",
                    "captured_at": datetime(2026, 4, 18, 12, 0, tzinfo=timezone.utc).isoformat(),
                    "messages": [
                        {
                            "external_message_id": "m-1",
                            "role": MessageRole.USER.value,
                            "content": "A factual note about FastAPI request handling.",
                        }
                    ],
                    "raw_capture": {"source": "test"},
                },
            )
            assert ingest.status_code == 202, ingest.text
            session_id = ingest.json()["session_id"]

            async def fail_classifier(*args, **kwargs):
                raise AssertionError("Manual built-in assignment must not invoke classification.")

            monkeypatch.setattr(ProcessingOrchestrator, "classify", fail_classifier, raising=True)
            monkeypatch.setattr(ProcessingOrchestrator, "classify_segments", fail_classifier, raising=True)
            monkeypatch.setattr(ProcessingOrchestrator, "classify_pile", fail_classifier, raising=True)

            assign = await client.post(f"/api/v1/piles/factual/sessions/{session_id}/assign")
            assert assign.status_code == 200, assign.text
            payload = assign.json()
            assert payload["pile_slug"] == "factual"
            assert payload["pile_assignment_locked"] is True
            assert payload["classification_reason"] == "Manually assigned to pile 'factual'."
            assert payload["pile_outputs"] is not None
            assert "factual" in payload["pile_outputs"]
            assert payload["last_processed_at"] is not None
            assert Path(payload["markdown_path"]).parent.name == "Factual"
    finally:
        get_settings.cache_clear()
    await engine.dispose()


@pytest.mark.asyncio
async def test_classifier_routes_into_user_defined_pile(tmp_path, monkeypatch) -> None:
    """When user-defined piles exist, the LLM should be able to pick one."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'classify-user-pile.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.run_sync(apply_schema_migrations)

    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "openai")
    monkeypatch.setenv("SAVEMYCONTEXT_OPENAI_API_KEY", "test-key")
    get_settings.cache_clear()

    from app.services.llm.openai_client import OpenAIClient
    from app.schemas.processing import PileClassificationResult

    async def fake_generate_json(self, *, system_prompt, user_prompt, schema):
        if schema is PileClassificationResult:
            # We expect 'research' to appear in the prompt because the user
            # created it; route there.
            assert "research" in user_prompt
            return PileClassificationResult(pile_slug="research", reason="long-form research note")
        # Generic pile_outputs invocation: return empty dict so heuristic kicks in.
        return schema()

    monkeypatch.setattr(OpenAIClient, "generate_json", fake_generate_json, raising=True)

    try:
        app = _build_app(session_factory)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
            create = await client.post(
                "/api/v1/piles",
                json={
                    "slug": "research",
                    "name": "Research",
                    "description": "Long-form research notes that I want to share later.",
                    "attributes": ["alternate_phrasings", "share_post"],
                },
            )
            assert create.status_code == 201, create.text

            ingest = await client.post(
                "/api/v1/ingest/diff",
                json={
                    "provider": ProviderName.GEMINI.value,
                    "external_session_id": "research-route-1",
                    "sync_mode": "full_snapshot",
                    "title": "research-route-1",
                    "source_url": "https://gemini.google.com/app/research-route-1",
                    "captured_at": datetime(2026, 4, 18, 12, 0, tzinfo=timezone.utc).isoformat(),
                    "messages": [
                        {
                            "external_message_id": "m-1",
                            "role": MessageRole.USER.value,
                            "content": "Research note: how does FastAPI handle backpressure under uvloop?",
                        }
                    ],
                    "raw_capture": {"source": "test"},
                },
            )
            assert ingest.status_code == 202, ingest.text
            payload = ingest.json()
            assert payload["pile_slug"] == "research"
            assert payload["is_discarded"] is False
            assert set(payload) >= {"session_id", "pile_slug", "is_discarded", "new_message_count", "processed"}
    finally:
        get_settings.cache_clear()
    await engine.dispose()


@pytest.mark.asyncio
async def test_auto_discard_categories_route_session_to_discarded_via_classifier(tmp_path, monkeypatch) -> None:
    """When the discarded pile has auto_discard_categories configured and the
    classifier identifies a match, the session should be routed to discarded.
    The heuristic classifier doesn't match descriptions, so we mock the LLM
    client.
    """
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'auto-discard.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.run_sync(apply_schema_migrations)

    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "openai")
    monkeypatch.setenv("SAVEMYCONTEXT_OPENAI_API_KEY", "test-key")
    get_settings.cache_clear()

    # Patch the OpenAI client's generate_json to claim the session is "small talk".
    from app.services.llm.openai_client import OpenAIClient

    async def fake_generate_json(self, system_prompt, user_prompt, schema):  # type: ignore[no-untyped-def]
        from app.schemas.processing import ClassificationResult
        from app.models.enums import BuiltInPileSlug as _SC

        if "classify transcripts" in system_prompt.lower() or "classify" in system_prompt.lower():
            return ClassificationResult(pile=_SC.DISCARDED, reason="matched 'small talk'")
        # Fallback for any other LLM calls — should not be hit when discarding.
        raise RuntimeError("unexpected LLM call after discard")

    monkeypatch.setattr(OpenAIClient, "generate_json", fake_generate_json, raising=True)

    try:
        # Configure the discarded pile's auto_discard_categories.
        async with session_factory() as session:
            discarded = (await session.execute(select(Pile).where(Pile.slug == "discarded"))).scalar_one()
            discarded.pipeline_config = {
                "auto_discard_categories": ["small talk", "test sessions"],
                "custom_prompt_addendum": None,
            }
            await session.commit()

        app = _build_app(session_factory)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
            ingest = await client.post(
                "/api/v1/ingest/diff",
                json={
                    "provider": ProviderName.GEMINI.value,
                    "external_session_id": "auto-discard-1",
                    "sync_mode": "full_snapshot",
                    "title": "auto-discard-1",
                    "source_url": "https://gemini.google.com/app/auto-discard-1",
                    "captured_at": datetime(2026, 4, 18, 12, 0, tzinfo=timezone.utc).isoformat(),
                    "messages": [
                        {
                            "external_message_id": "m-1",
                            "role": MessageRole.USER.value,
                            "content": "hey what's up",
                        }
                    ],
                    "raw_capture": {"source": "test"},
                },
            )
            assert ingest.status_code == 202, ingest.text
            assert ingest.json()["is_discarded"] is True
            assert ingest.json()["pile_slug"] == "discarded"

        async with session_factory() as session:
            row = (await session.execute(select(ChatSession).where(ChatSession.external_session_id == "auto-discard-1"))).scalar_one()
            assert row.is_discarded is True
            assert "small talk" in (row.discarded_reason or "")
    finally:
        get_settings.cache_clear()
    await engine.dispose()
