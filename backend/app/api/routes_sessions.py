from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.dependencies import AuthContext, require_scope
from app.db.session import get_db_session
from app.models import ChatSession, Pile, ProviderName, BuiltInPileSlug
from app.schemas.explorer import SessionNoteRead
from app.schemas.session import (
    SessionListItem,
    SessionRead,
    SessionExtraPilesUpdate,
    ExtraPileSummary,
    build_session_list_item,
    build_session_read,
)
from app.services.explorer import read_session_markdown, session_related_entities, session_word_count
from app.services.extra_piles import has_extra_pile, merge_extra_piles, summarize_extra_piles
from app.services.piles import category_for_pile_slug


router = APIRouter()


async def _load_session(db: AsyncSession, session_id: str) -> ChatSession | None:
    statement = (
        select(ChatSession)
        .options(
            selectinload(ChatSession.messages),
            selectinload(ChatSession.triplets),
        )
        .where(ChatSession.id == session_id)
    )
    result = await db.execute(statement)
    return result.scalar_one_or_none()


@router.get("/sessions", response_model=list[SessionListItem])
async def list_sessions(
    provider: ProviderName | None = Query(default=None),
    pile: str | None = Query(default=None),
    category: BuiltInPileSlug | None = Query(default=None, include_in_schema=False),
    extra_pile: str | None = Query(default=None),
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> list[SessionListItem]:
    statement = select(ChatSession).order_by(ChatSession.updated_at.desc())
    if provider:
        statement = statement.where(ChatSession.provider == provider)
    target_pile = pile.strip() if pile else category.value if category else None
    if target_pile:
        fallback_pile = category_for_pile_slug(target_pile)
        statement = statement.where(
            or_(
                ChatSession.pile.has(Pile.slug == target_pile),
                and_(ChatSession.pile_id.is_(None), ChatSession.built_in_pile == fallback_pile),
            )
        )
    result = await db.execute(statement)
    sessions = result.scalars().all()
    if extra_pile:
        sessions = [session for session in sessions if has_extra_pile(session.custom_tags, extra_pile)]
    return [build_session_list_item(session) for session in sessions]


@router.get("/sessions/{session_id}", response_model=SessionRead)
async def get_session(
    session_id: str,
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> SessionRead:
    session = await _load_session(db, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    return build_session_read(session)


@router.get("/notes/{session_id}", response_model=SessionNoteRead)
async def get_session_note(
    session_id: str,
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> SessionNoteRead:
    session = await _load_session(db, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    raw_markdown = read_session_markdown(session)
    return SessionNoteRead(
        **build_session_read(session).model_dump(),
        raw_markdown=raw_markdown,
        related_entities=session_related_entities(session),
        word_count=session_word_count(session, raw_markdown),
    )


@router.get("/extra-piles", response_model=list[ExtraPileSummary])
@router.get("/user-categories", response_model=list[ExtraPileSummary], include_in_schema=False)
async def list_extra_piles(
    provider: ProviderName | None = Query(default=None),
    pile: str | None = Query(default=None),
    category: BuiltInPileSlug | None = Query(default=None, include_in_schema=False),
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> list[ExtraPileSummary]:
    statement = select(ChatSession.custom_tags).order_by(ChatSession.updated_at.desc())
    if provider:
        statement = statement.where(ChatSession.provider == provider)
    target_pile = pile.strip() if pile else category.value if category else None
    if target_pile:
        fallback_pile = category_for_pile_slug(target_pile)
        statement = statement.where(
            or_(
                ChatSession.pile.has(Pile.slug == target_pile),
                and_(ChatSession.pile_id.is_(None), ChatSession.built_in_pile == fallback_pile),
            )
        )
    tag_sets = list((await db.execute(statement)).scalars().all())
    return [ExtraPileSummary(name=name, count=count) for name, count in summarize_extra_piles(tag_sets)]


@router.put("/sessions/{session_id}/extra-piles", response_model=SessionListItem)
@router.put("/sessions/{session_id}/user-categories", response_model=SessionListItem, include_in_schema=False)
async def update_session_extra_piles(
    session_id: str,
    payload: SessionExtraPilesUpdate,
    _: AuthContext = Depends(require_scope("ingest")),
    db: AsyncSession = Depends(get_db_session),
) -> SessionListItem:
    session = await _load_session(db, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    session.custom_tags = merge_extra_piles(session.custom_tags, payload.extra_piles)
    await db.commit()
    refreshed = await _load_session(db, session_id)
    if refreshed is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    return build_session_list_item(refreshed)


@router.get("/views/journal", response_model=list[SessionListItem])
async def journal_view(
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> list[SessionListItem]:
    result = await db.execute(
        select(ChatSession)
        .where(ChatSession.built_in_pile == BuiltInPileSlug.JOURNAL)
        .order_by(ChatSession.updated_at.desc())
    )
    return [build_session_list_item(session) for session in result.scalars().all()]


@router.get("/views/factual", response_model=list[SessionListItem])
async def factual_view(
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> list[SessionListItem]:
    result = await db.execute(
        select(ChatSession)
        .where(ChatSession.built_in_pile == BuiltInPileSlug.FACTUAL)
        .order_by(ChatSession.updated_at.desc())
    )
    return [build_session_list_item(session) for session in result.scalars().all()]


@router.get("/views/ideas", response_model=list[SessionListItem])
async def ideas_view(
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> list[SessionListItem]:
    result = await db.execute(
        select(ChatSession)
        .where(ChatSession.built_in_pile == BuiltInPileSlug.IDEAS)
        .order_by(ChatSession.updated_at.desc())
    )
    return [build_session_list_item(session) for session in result.scalars().all()]


@router.get("/views/todo", response_model=list[SessionListItem])
async def todo_view(
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> list[SessionListItem]:
    result = await db.execute(
        select(ChatSession)
        .where(ChatSession.built_in_pile == BuiltInPileSlug.TODO)
        .order_by(ChatSession.updated_at.desc())
    )
    return [build_session_list_item(session) for session in result.scalars().all()]
