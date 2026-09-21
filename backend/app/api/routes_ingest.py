from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import AuthContext, require_scope
from app.db.session import get_db_session
from app.schemas.ingest import IngestDiffRequest, IngestResponse
from app.services.ingest import CaptureQuarantined, IngestPhaseTwoError, IngestService


router = APIRouter()


@router.post("/diff", response_model=IngestResponse, status_code=status.HTTP_202_ACCEPTED)
async def ingest_diff(
    payload: IngestDiffRequest,
    _: AuthContext = Depends(require_scope("ingest")),
    db: AsyncSession = Depends(get_db_session),
) -> IngestResponse:
    if not payload.messages:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No messages supplied.")

    try:
        session, new_message_count = await IngestService(db).ingest(payload)
    except CaptureQuarantined as exc:
        return IngestResponse(
            disposition="quarantined", receipt_id=exc.receipt_id,
            quality=exc.quality, new_message_count=0,
        )
    except IngestPhaseTwoError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
            headers={"Retry-After": "5"},
        ) from exc
    return IngestResponse(
        session_id=session.id,
        pile_slug=session.pile.slug if session.pile else session.built_in_pile.value if session.built_in_pile else None,
        is_discarded=session.is_discarded,
        new_message_count=new_message_count,
        markdown_path=session.markdown_path,
        processed=IngestService.processing_is_current(session),
    )
