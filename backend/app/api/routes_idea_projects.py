from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import AuthContext, require_scope
from app.db.session import get_db_session
from app.schemas.idea_project import IdeaProjectCreate, IdeaProjectRead, IdeaProjectUpdate
from app.services.idea_projects import IdeaProjectNotFoundError, IdeaProjectService


router = APIRouter(prefix="/idea-projects")


def _serialize(project) -> IdeaProjectRead:  # type: ignore[no-untyped-def]
    return IdeaProjectRead.model_validate(project)


@router.get("", response_model=list[IdeaProjectRead])
async def list_idea_projects(
    include_inactive: bool = Query(default=False),
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> list[IdeaProjectRead]:
    projects = await IdeaProjectService(db).list_projects(active_only=not include_inactive)
    return [_serialize(project) for project in projects]


@router.post("", response_model=IdeaProjectRead, status_code=status.HTTP_201_CREATED)
async def create_idea_project(
    payload: IdeaProjectCreate,
    _: AuthContext = Depends(require_scope("ingest")),
    db: AsyncSession = Depends(get_db_session),
) -> IdeaProjectRead:
    project = await IdeaProjectService(db).create_project(
        name=payload.name,
        description=payload.description,
        sort_order=payload.sort_order,
    )
    return _serialize(project)


@router.patch("/{slug}", response_model=IdeaProjectRead)
async def update_idea_project(
    slug: str,
    payload: IdeaProjectUpdate,
    _: AuthContext = Depends(require_scope("ingest")),
    db: AsyncSession = Depends(get_db_session),
) -> IdeaProjectRead:
    try:
        project = await IdeaProjectService(db).update_project(
            slug,
            name=payload.name,
            description=payload.description,
            is_active=payload.is_active,
            sort_order=payload.sort_order,
        )
    except IdeaProjectNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return _serialize(project)


@router.delete("/{slug}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_idea_project(
    slug: str,
    _: AuthContext = Depends(require_scope("ingest")),
    db: AsyncSession = Depends(get_db_session),
) -> None:
    try:
        await IdeaProjectService(db).deactivate_project(slug)
    except IdeaProjectNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
