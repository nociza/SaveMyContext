from __future__ import annotations

import asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
import pytest
from unittest.mock import AsyncMock
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.routes_capture import router as capture_router
from app.api.routes_dashboard import router as dashboard_router
from app.core.config import get_settings
from app.db.session import get_db_session
from app.models import SourceCapture
from app.models.base import Base
from app.models.enums import BuiltInPileSlug
from app.schemas.source_capture import SourceCaptureRequest
from app.services.source_capture import (
    SourceCaptureEnrichment,
    SourceCapturePhaseTwoError,
    SourceCaptureProcessor,
    SourceCaptureService,
)


@pytest.mark.asyncio
async def test_capture_route_saves_raw_selection_and_exposes_it_to_search(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-capture-route.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    get_settings.cache_clear()
    try:
        app = FastAPI()
        app.include_router(capture_router, prefix="/api/v1")
        app.include_router(dashboard_router, prefix="/api/v1")

        async def override_db_session():
            async with session_factory() as session:
                yield session

        app.dependency_overrides[get_db_session] = override_db_session

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
            response = await client.post(
                "/api/v1/capture/source",
                json={
                    "capture_kind": "selection",
                    "save_mode": "raw",
                    "page_title": "Rust article",
                    "source_url": "https://example.com/rust",
                    "selection_text": "Rust uses ownership to manage memory safely.",
                    "source_text": "Rust uses ownership to manage memory safely.",
                    "source_markdown": "Rust uses ownership to manage memory safely."
                },
            )

            assert response.status_code == 202
            payload = response.json()
            assert payload["processed"] is False
            assert payload["capture_kind"] == "selection"
            assert payload["save_mode"] == "raw"
            assert payload["markdown_path"].endswith(".md")
            assert payload["raw_source_path"].endswith("--source.md")

            search_response = await client.get("/api/v1/search", params={"q": "ownership"})

        assert search_response.status_code == 200
        search_payload = search_response.json()
        assert any(result["kind"] == "source_capture" for result in search_payload["results"])
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_source_capture_survives_projection_failure(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-capture-boundary.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        service = SourceCaptureService(session)
        service.exporter.write_source_capture = AsyncMock(
            side_effect=[
                OSError("disk unavailable"),
                (tmp_path / "capture.md", tmp_path / "capture--source.md"),
            ]
        )
        payload = SourceCaptureRequest(
            capture_key="smc_capture_projection-retry",
            capture_kind="page",
            save_mode="raw",
            source_url="https://example.com/preserved",
            source_text="This source must remain in the database.",
            raw_payload={"revision": 1},
        )

        with pytest.raises(SourceCapturePhaseTwoError, match="source capture was preserved"):
            await service.capture(payload)

        stored = await session.scalar(
            select(SourceCapture).where(
                SourceCapture.capture_key == "smc_capture_projection-retry"
            )
        )
        assert stored is not None
        assert stored.source_text == "This source must remain in the database."
        assert stored.raw_payload == {"revision": 1}
        assert stored.markdown_path is None
        assert stored.raw_source_path is None

        repaired = await service.capture(payload)
        assert repaired.source_id == stored.id
        assert repaired.markdown_path == str(tmp_path / "capture.md")
        assert repaired.raw_source_path == str(tmp_path / "capture--source.md")
        assert len((await session.scalars(select(SourceCapture))).all()) == 1
        assert service.exporter.write_source_capture.await_count == 2

    await engine.dispose()


@pytest.mark.asyncio
async def test_source_capture_exact_retry_returns_stored_result_without_reprocessing(tmp_path) -> None:
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-capture-idempotency.db'}"
    )
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        service = SourceCaptureService(session)
        service.processor.enrich = AsyncMock(
            return_value=SourceCaptureEnrichment(
                title="Stable enriched title",
                pile=BuiltInPileSlug.IDEAS,
                classification_reason="A reusable design idea.",
                summary="A concise captured idea.",
                cleaned_markdown="# Stable enriched title\n\nCaptured once.",
            )
        )
        service.exporter.write_source_capture = AsyncMock(
            return_value=(tmp_path / "capture.md", tmp_path / "capture--source.md")
        )
        payload = SourceCaptureRequest(
            capture_key="smc_capture_retry-1",
            capture_kind="page",
            save_mode="ai",
            page_title="Original page title",
            source_url="https://example.com/idempotent",
            source_text="This source should only be processed once.",
            raw_payload={"revision": 1},
        )

        original = await service.capture(payload)
        replay = await service.capture(payload)

        stored = (await session.scalars(select(SourceCapture))).all()
        assert replay == original
        assert replay.capture_key == "smc_capture_retry-1"
        assert replay.processed is True
        assert len(stored) == 1
        service.processor.enrich.assert_awaited_once_with(payload)
        service.exporter.write_source_capture.assert_awaited_once()

        repeated_action = await service.capture(
            payload.model_copy(update={"capture_key": "smc_capture_retry-2"})
        )
        assert repeated_action.source_id != original.source_id
        assert len((await session.scalars(select(SourceCapture))).all()) == 2

    await engine.dispose()


@pytest.mark.asyncio
async def test_concurrent_source_capture_retries_share_one_row_and_projection(tmp_path) -> None:
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-capture-concurrent.db'}"
    )
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    payload = SourceCaptureRequest(
        capture_key="smc_capture_concurrent-1",
        capture_kind="page",
        save_mode="raw",
        source_url="https://example.com/concurrent",
        source_text="Store one canonical source capture.",
    )
    exporters: list[AsyncMock] = []

    async def capture_once():  # type: ignore[no-untyped-def]
        async with session_factory() as session:
            service = SourceCaptureService(session)
            service.exporter.write_source_capture = AsyncMock(
                return_value=(tmp_path / "capture.md", tmp_path / "capture--source.md")
            )
            exporters.append(service.exporter.write_source_capture)
            return await service.capture(payload)

    first, second = await asyncio.gather(capture_once(), capture_once())

    assert first.source_id == second.source_id
    assert sum(exporter.await_count for exporter in exporters) == 1
    async with session_factory() as session:
        assert len((await session.scalars(select(SourceCapture))).all()) == 1
    await engine.dispose()


@pytest.mark.asyncio
async def test_capture_route_rejects_capture_key_reused_for_different_payload(
    tmp_path,
    monkeypatch,
) -> None:
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-capture-conflict.db'}"
    )
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    get_settings.cache_clear()
    try:
        app = FastAPI()
        app.include_router(capture_router, prefix="/api/v1")

        async def override_db_session():
            async with session_factory() as session:
                yield session

        app.dependency_overrides[get_db_session] = override_db_session
        request = {
            "capture_key": "smc_capture_conflict-1",
            "capture_kind": "selection",
            "save_mode": "raw",
            "source_url": "https://example.com/conflict",
            "selection_text": "The original selection.",
            "source_text": "The original selection.",
        }

        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://127.0.0.1:18888",
        ) as client:
            accepted = await client.post("/api/v1/capture/source", json=request)
            conflict = await client.post(
                "/api/v1/capture/source",
                json={
                    **request,
                    "selection_text": "A different selection.",
                    "source_text": "A different selection.",
                },
            )

        assert accepted.status_code == 202
        assert accepted.json()["capture_key"] == "smc_capture_conflict-1"
        assert conflict.status_code == 409
        assert "already used" in conflict.json()["detail"]

        async with session_factory() as session:
            assert len((await session.scalars(select(SourceCapture))).all()) == 1
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_capture_route_marks_post_commit_projection_failure_as_retryable(
    tmp_path,
    monkeypatch,
) -> None:
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-capture-retryable.db'}"
    )
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async def fail_projection(self, source_capture):  # type: ignore[no-untyped-def]
        raise OSError("temporary storage outage")

    monkeypatch.setattr(
        "app.services.source_capture.MarkdownExporter.write_source_capture",
        fail_projection,
    )
    app = FastAPI()
    app.include_router(capture_router, prefix="/api/v1")

    async def override_db_session():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_db_session] = override_db_session
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://127.0.0.1:18888",
    ) as client:
        response = await client.post(
            "/api/v1/capture/source",
            json={
                "capture_key": "smc_capture_retryable-1",
                "capture_kind": "page",
                "save_mode": "raw",
                "source_url": "https://example.com/retryable",
                "source_text": "Preserve this before reporting the projection failure.",
            },
        )

    assert response.status_code == 503
    assert response.headers["Retry-After"] == "5"
    assert "was preserved" in response.json()["detail"]
    async with session_factory() as session:
        stored = await session.scalar(
            select(SourceCapture).where(
                SourceCapture.capture_key == "smc_capture_retryable-1"
            )
        )
        assert stored is not None
        assert stored.source_text == "Preserve this before reporting the projection failure."

    await engine.dispose()


@pytest.mark.asyncio
async def test_capture_route_saves_ai_enriched_page_capture(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-capture-ai-route.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    get_settings.cache_clear()

    async def fake_enrich(self, payload):  # type: ignore[no-untyped-def]
        return SourceCaptureEnrichment(
            title="Reference architecture note",
            pile=BuiltInPileSlug.FACTUAL,
            classification_reason="A factual reference page about distributed systems.",
            summary="Captures the main architecture constraints and design choices.",
            cleaned_markdown="# Reference architecture\n\n- Durable queues\n- Backpressure\n- Idempotent workers",
        )

    monkeypatch.setattr(SourceCaptureProcessor, "enrich", fake_enrich)

    try:
        app = FastAPI()
        app.include_router(capture_router, prefix="/api/v1")

        async def override_db_session():
            async with session_factory() as session:
                yield session

        app.dependency_overrides[get_db_session] = override_db_session

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
            response = await client.post(
                "/api/v1/capture/source",
                json={
                    "capture_kind": "page",
                    "save_mode": "ai",
                    "page_title": "Distributed systems reference",
                    "source_url": "https://example.com/reference",
                    "source_text": "Durable queues, backpressure, and idempotent workers are important.",
                    "source_markdown": "# Distributed systems reference\n\nDurable queues.\n\nBackpressure.\n\nIdempotent workers."
                },
            )

        assert response.status_code == 202
        payload = response.json()
        assert payload["processed"] is True
        assert payload["pile_slug"] == "factual"
        markdown_path = tmp_path / "markdown" / "SaveMyContext" / "Captures"
        assert any(markdown_path.glob("page--reference-architecture-note-*.md"))
        note_path = next(markdown_path.glob("page--reference-architecture-note-*.md"))
        note_markdown = note_path.read_text(encoding="utf-8")
        assert "Reference architecture note" in note_markdown
        assert "Durable queues" in note_markdown
    finally:
        get_settings.cache_clear()

    await engine.dispose()
