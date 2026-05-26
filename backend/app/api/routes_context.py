from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import AuthContext, require_scope
from app.db.session import get_db_session
from app.schemas.context import (
    ContextMigrationBundle,
    ContextMigrationImportRequest,
    ContextMigrationImportResponse,
)
from app.services.context_migration import ContextMigrationService


router = APIRouter()


@router.post("/context/import", response_model=ContextMigrationImportResponse, status_code=status.HTTP_202_ACCEPTED)
async def import_context(
    payload: ContextMigrationImportRequest,
    _: AuthContext = Depends(require_scope("ingest")),
    db: AsyncSession = Depends(get_db_session),
) -> ContextMigrationImportResponse:
    if not payload.messages:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No messages supplied.")

    service = ContextMigrationService(db)
    session, new_message_count = await service.import_context(payload)
    bundle = service.build_bundle(session)
    return ContextMigrationImportResponse(
        session_id=session.id,
        pile_slug=session.pile.slug if session.pile else session.built_in_pile.value if session.built_in_pile else None,
        is_discarded=session.is_discarded,
        new_message_count=new_message_count,
        markdown_path=session.markdown_path,
        processed=session.last_processed_at is not None,
        bundle=bundle,
    )


@router.get("/context/export/{session_id}", response_model=ContextMigrationBundle)
async def export_context(
    session_id: str,
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> ContextMigrationBundle:
    bundle = await ContextMigrationService(db).export_session(session_id)
    if bundle is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    return bundle
