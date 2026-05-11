from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import ChatSession, Pile
from app.models.base import utcnow
from app.schemas.pile import PileRestructureDueResponse, PileRestructureResult
from app.services.markdown import MarkdownExporter
from app.services.pile_service import PileService
from app.services.piles import (
    BUILT_IN_SLUG_TO_CATEGORY,
    CATEGORY_TO_BUILT_IN_SLUG,
    restructure_config_from_pipeline_config,
    restructure_llm_model_from_config,
)
from app.services.processing import SessionProcessor


class PileRestructureService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.piles = PileService(db)
        self.exporter = MarkdownExporter(db)

    async def restructure_pile(
        self,
        slug: str,
        *,
        model: str | None = None,
        limit: int = 25,
        include_discarded: bool = False,
        update_last_run: bool = True,
    ) -> PileRestructureResult:
        pile = await self.piles.require_by_slug(slug)
        sessions = await self._sessions_for_pile(pile, limit=limit, include_discarded=include_discarded)
        result = await self._reprocess_sessions(
            sessions,
            scope=f"pile:{pile.slug}",
            pile=pile,
            model=model or restructure_llm_model_from_config(pile.pipeline_config),
        )
        if update_last_run:
            self._mark_restructure_run(pile, result.completed_at, result.model)
        await self.db.commit()
        return result

    async def restructure_all(
        self,
        *,
        model: str | None = None,
        limit: int = 25,
        include_discarded: bool = False,
    ) -> PileRestructureResult:
        sessions = await self._sessions_for_all(limit=limit, include_discarded=include_discarded)
        result = await self._reprocess_sessions(
            sessions,
            scope="all",
            pile=None,
            model=model,
        )
        await self.db.commit()
        return result

    async def restructure_due(
        self,
        *,
        limit_per_pile: int = 10,
        include_discarded: bool = False,
    ) -> PileRestructureDueResponse:
        piles = await self.piles.list_piles()
        results: list[PileRestructureResult] = []
        due_count = 0
        for pile in piles:
            if not self._is_due(pile):
                continue
            due_count += 1
            result = await self.restructure_pile(
                pile.slug,
                model=restructure_llm_model_from_config(pile.pipeline_config),
                limit=limit_per_pile,
                include_discarded=include_discarded,
                update_last_run=True,
            )
            results.append(result)

        return PileRestructureDueResponse(
            checked_count=len(piles),
            due_count=due_count,
            processed_count=sum(result.processed_count for result in results),
            results=results,
        )

    async def _sessions_for_pile(
        self,
        pile: Pile,
        *,
        limit: int,
        include_discarded: bool,
    ) -> list[ChatSession]:
        category = BUILT_IN_SLUG_TO_CATEGORY.get(pile.slug)
        condition = ChatSession.pile_id == pile.id
        if category is not None:
            condition = or_(condition, ChatSession.built_in_pile == category)
        statement = (
            select(ChatSession)
            .options(
                selectinload(ChatSession.messages),
                selectinload(ChatSession.triplets),
                selectinload(ChatSession.pile),
            )
            .where(condition)
            .where(ChatSession.messages.any())
            .order_by(ChatSession.last_processed_at.asc().nulls_first(), ChatSession.updated_at.asc())
            .limit(max(1, min(limit, 500)))
        )
        if not include_discarded and pile.slug != "discarded":
            statement = statement.where(ChatSession.is_discarded.is_(False))
        result = await self.db.execute(statement)
        return list(result.scalars().all())

    async def _sessions_for_all(self, *, limit: int, include_discarded: bool) -> list[ChatSession]:
        statement = (
            select(ChatSession)
            .options(
                selectinload(ChatSession.messages),
                selectinload(ChatSession.triplets),
                selectinload(ChatSession.pile),
            )
            .where(ChatSession.messages.any())
            .order_by(ChatSession.last_processed_at.asc().nulls_first(), ChatSession.updated_at.asc())
            .limit(max(1, min(limit, 500)))
        )
        if not include_discarded:
            statement = statement.where(ChatSession.is_discarded.is_(False))
        result = await self.db.execute(statement)
        return list(result.scalars().all())

    async def _reprocess_sessions(
        self,
        sessions: list[ChatSession],
        *,
        scope: str,
        pile: Pile | None,
        model: str | None,
    ) -> PileRestructureResult:
        started_at = utcnow()
        effective_model = model.strip() if isinstance(model, str) and model.strip() else None
        processor = SessionProcessor(self.db, llm_model=effective_model)
        processor.base_dir = self.exporter.base_dir
        moved_count = 0
        processed_ids: list[str] = []

        for session in sessions:
            before_slug = await self._session_pile_slug(session)
            processed = await processor.process(session.id)
            markdown_path = await self.exporter.write_session(processed)
            processed.markdown_path = str(markdown_path)
            after_slug = await self._session_pile_slug(processed)
            if before_slug != after_slug:
                moved_count += 1
            processed_ids.append(session.id)

        completed_at = utcnow()
        return PileRestructureResult(
            scope=scope,
            pile_slug=pile.slug if pile else None,
            pile_name=pile.name if pile else None,
            model=effective_model,
            processed_count=len(processed_ids),
            moved_count=moved_count,
            session_ids=processed_ids,
            started_at=started_at,
            completed_at=completed_at,
        )

    def _mark_restructure_run(self, pile: Pile, completed_at: datetime, model: str | None) -> None:
        config = dict(pile.pipeline_config or {})
        restructure = dict(restructure_config_from_pipeline_config(config))
        restructure["last_run_at"] = completed_at.isoformat()
        if model:
            restructure["last_model"] = model
        config["restructure"] = restructure
        pile.pipeline_config = config
        pile.updated_at = completed_at

    def _is_due(self, pile: Pile) -> bool:
        restructure = restructure_config_from_pipeline_config(pile.pipeline_config)
        if not bool(restructure.get("enabled")):
            return False
        interval_days = self._interval_days(restructure)
        last_run_at = self._parse_datetime(restructure.get("last_run_at"))
        if last_run_at is None:
            return True
        return utcnow() - last_run_at >= timedelta(days=interval_days)

    @staticmethod
    def _interval_days(restructure: dict[str, Any]) -> int:
        value = restructure.get("interval_days")
        if isinstance(value, int):
            return max(1, min(value, 365))
        if isinstance(value, str) and value.isdigit():
            return max(1, min(int(value), 365))
        return 30

    @staticmethod
    def _parse_datetime(value: Any) -> datetime | None:
        if not isinstance(value, str) or not value.strip():
            return None
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed

    async def _session_pile_slug(self, session: ChatSession) -> str | None:
        if session.built_in_pile is not None:
            return CATEGORY_TO_BUILT_IN_SLUG.get(session.built_in_pile)
        if session.pile is not None and session.pile.id == session.pile_id:
            return session.pile.slug
        if session.pile_id:
            pile = await self.piles.get_by_id(session.pile_id)
            return pile.slug if pile else None
        return None
