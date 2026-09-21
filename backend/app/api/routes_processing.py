from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import AuthContext, require_scope
from app.db.session import get_db_session
from app.core.config import get_settings
from app.workspace.models import Job
from sqlalchemy import select, func
from app.schemas.llm import LLMOptionsResponse
from app.schemas.processing_worker import (
    ProcessingCompleteRequest,
    ProcessingCompleteResponse,
    ProcessingStatusResponse,
    ProcessingTaskResponse,
)
from app.services.llm.options import LLMOptionsService
from app.services.processing_worker import (
    ExtensionBrowserProcessingService,
    ProcessingTaskConflictError,
)
from app.services.todo import TodoListConflictError


router = APIRouter(prefix="/processing")


@router.get("/llms", response_model=LLMOptionsResponse)
async def processing_llms(
    include_catalog: bool = Query(default=False),
    limit: int = Query(default=200, ge=1, le=1000),
    _: AuthContext = Depends(require_scope("read")),
) -> LLMOptionsResponse:
    return await LLMOptionsService().options(
        include_openrouter_catalog=include_catalog, limit=limit
    )


@router.get("/status", response_model=ProcessingStatusResponse)
async def processing_status(
    _: AuthContext = Depends(require_scope("ingest")),
    db: AsyncSession = Depends(get_db_session),
) -> ProcessingStatusResponse:
    if get_settings().workspace_enabled:
        pending = await db.scalar(
            select(func.count())
            .select_from(Job)
            .where(Job.state.in_(["pending", "running"]))
        )
        return ProcessingStatusResponse(
            enabled=False, mode="workspace", pending_count=pending or 0
        )
    return await ExtensionBrowserProcessingService(db).status()


@router.post("/next", response_model=ProcessingTaskResponse)
async def next_processing_task(
    _: AuthContext = Depends(require_scope("ingest")),
    db: AsyncSession = Depends(get_db_session),
) -> ProcessingTaskResponse:
    return await ExtensionBrowserProcessingService(db).next_task()


@router.post("/complete", response_model=ProcessingCompleteResponse)
async def complete_processing_task(
    payload: ProcessingCompleteRequest,
    _: AuthContext = Depends(require_scope("ingest")),
    db: AsyncSession = Depends(get_db_session),
) -> ProcessingCompleteResponse:
    try:
        return await ExtensionBrowserProcessingService(db).complete_task(
            session_ids=payload.resolved_session_ids,
            response_text=payload.response_text,
            todo_source_revision=payload.todo_source_revision,
            source_revisions=payload.source_revisions,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (ProcessingTaskConflictError, TodoListConflictError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
