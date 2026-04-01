from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import ChatSession, FactTriplet, SessionCategory
from app.models.base import utcnow
from app.schemas.processing import TripletResult
from app.services.orchestrator import ProcessingOrchestrator


class SessionProcessor:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.orchestrator = ProcessingOrchestrator()

    async def process(self, session_id: str) -> ChatSession:
        session = await self._load_session(session_id)
        if not session.messages:
            return session

        classification = await self.orchestrator.classify(session.messages)
        session.category = classification.category
        session.classification_reason = classification.reason
        session.journal_entry = None
        session.idea_summary = None
        session.share_post = None

        if classification.category == SessionCategory.JOURNAL:
            result = await self.orchestrator.journal(session.messages)
            action_lines = [f"- {item}" for item in result.action_items]
            if action_lines:
                session.journal_entry = f"{result.entry}\n\nAction Items:\n" + "\n".join(action_lines)
            else:
                session.journal_entry = result.entry
            await self._replace_triplets(session, [])

        elif classification.category == SessionCategory.FACTUAL:
            triplets = await self.orchestrator.factual_triplets(session.messages)
            await self._replace_triplets(session, triplets)

        elif classification.category == SessionCategory.IDEAS:
            result = await self.orchestrator.ideas(session.messages)
            session.idea_summary = result.model_dump(exclude={"share_post"})
            session.share_post = result.share_post
            await self._replace_triplets(session, [])

        session.last_processed_at = utcnow()
        await self.db.flush()
        return session

    async def _replace_triplets(self, session: ChatSession, triplets: list[TripletResult]) -> None:
        await self.db.execute(delete(FactTriplet).where(FactTriplet.session_id == session.id))
        session.triplets.clear()
        for triplet in triplets:
            self.db.add(
                FactTriplet(
                    session_id=session.id,
                    subject=triplet.subject,
                    predicate=triplet.predicate,
                    object=triplet.object,
                    confidence=triplet.confidence,
                )
            )
        await self.db.flush()

    async def _load_session(self, session_id: str) -> ChatSession:
        statement = (
            select(ChatSession)
            .options(
                selectinload(ChatSession.messages),
                selectinload(ChatSession.triplets),
            )
            .where(ChatSession.id == session_id)
        )
        result = await self.db.execute(statement)
        session = result.scalar_one()
        return session

