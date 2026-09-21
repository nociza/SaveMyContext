from __future__ import annotations

import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock

from sqlalchemy import func, select, text

from app.db.session import SessionLocal, engine, init_db
from app.models import ChatSession
from app.models.enums import BuiltInPileSlug, MessageRole, ProviderName
from app.schemas.ingest import IngestDiffRequest, IngestMessage
from app.services.ingest import IngestService


async def create_same_session() -> bool:
    payload = IngestDiffRequest(
        provider=ProviderName.GEMINI,
        external_session_id="postgres-concurrent-first-capture",
        sync_mode="incremental",
        messages=[
            IngestMessage(
                external_message_id="message-1",
                role=MessageRole.USER,
                content="Verify concurrent session creation.",
            )
        ],
    )
    async with SessionLocal() as session:
        _, created = await IngestService(session)._get_or_create_session(payload)
        await session.commit()
        return created


async def ingest_without_process_local_lock(export_dir: Path, processing_calls: list[str]) -> None:
    payload = IngestDiffRequest(
        provider=ProviderName.GEMINI,
        external_session_id="postgres-concurrent-phase-two",
        sync_mode="incremental",
        messages=[
            IngestMessage(
                external_message_id="message-1",
                role=MessageRole.USER,
                content="Verify cross-process phase-two serialization.",
            )
        ],
        raw_capture={"smoke": "phase-two"},
    )
    async with SessionLocal() as session:
        service = IngestService(session)
        service.exporter.base_dir = export_dir

        async def process_once(session_id: str):
            processing_calls.append(session_id)
            await asyncio.sleep(0.1)
            stored = await service._load_session(session_id)
            stored.built_in_pile = BuiltInPileSlug.FACTUAL
            stored.processing_pending = False
            await session.flush()
            return stored

        service.processor.process = AsyncMock(side_effect=process_once)
        # Deliberately bypass the process-local identity lock so this smoke
        # test proves PostgreSQL row serialization is independently effective.
        await service._ingest_locked(payload)


async def main() -> None:
    await init_db()
    await init_db()
    creation_results = await asyncio.gather(create_same_session(), create_same_session())
    assert sum(creation_results) == 1
    processing_calls: list[str] = []
    with TemporaryDirectory(prefix="savemycontext-postgres-smoke-") as temp_dir:
        await asyncio.gather(
            ingest_without_process_local_lock(Path(temp_dir), processing_calls),
            ingest_without_process_local_lock(Path(temp_dir), processing_calls),
        )
    assert len(processing_calls) == 1
    async with SessionLocal() as session:
        assert await session.scalar(text("SELECT 1")) == 1
        assert await session.scalar(
            select(func.count(ChatSession.id)).where(
                ChatSession.external_session_id == "postgres-concurrent-first-capture"
            )
        ) == 1
        phase_two_session = await session.scalar(
            select(ChatSession).where(
                ChatSession.external_session_id == "postgres-concurrent-phase-two"
            )
        )
        assert phase_two_session is not None
        assert phase_two_session.processing_pending is False
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
