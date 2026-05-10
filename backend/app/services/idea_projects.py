from __future__ import annotations

import json
import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import IdeaProject
from app.models.base import utcnow
from app.schemas.processing import IdeaResult


PROJECT_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify_project_name(name: str) -> str:
    cleaned = PROJECT_SLUG_RE.sub("-", name.casefold()).strip("-")
    return (cleaned or "project")[:64].strip("-") or "project"


class IdeaProjectNotFoundError(LookupError):
    def __init__(self, slug: str) -> None:
        super().__init__(f"Idea project not found: {slug}")
        self.slug = slug


class IdeaProjectService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def list_projects(self, *, active_only: bool = True) -> list[IdeaProject]:
        statement = select(IdeaProject)
        if active_only:
            statement = statement.where(IdeaProject.is_active.is_(True))
        statement = statement.order_by(IdeaProject.sort_order.asc(), IdeaProject.name.asc())
        result = await self.db.execute(statement)
        return list(result.scalars().all())

    async def get_by_slug(self, slug: str) -> IdeaProject | None:
        if not slug:
            return None
        result = await self.db.execute(select(IdeaProject).where(IdeaProject.slug == slug))
        return result.scalar_one_or_none()

    async def require_by_slug(self, slug: str) -> IdeaProject:
        project = await self.get_by_slug(slug)
        if project is None:
            raise IdeaProjectNotFoundError(slug)
        return project

    async def create_project(self, *, name: str, description: str | None, sort_order: int = 100) -> IdeaProject:
        cleaned_name = name.strip()
        slug = await self._unique_slug(slugify_project_name(cleaned_name))
        project = IdeaProject(
            slug=slug,
            name=cleaned_name,
            description=(description or "").strip() or None,
            is_active=True,
            sort_order=sort_order,
        )
        self.db.add(project)
        await self.db.commit()
        await self.db.refresh(project)
        return project

    async def update_project(
        self,
        slug: str,
        *,
        name: str | None = None,
        description: str | None = None,
        is_active: bool | None = None,
        sort_order: int | None = None,
    ) -> IdeaProject:
        project = await self.require_by_slug(slug)
        if name is not None:
            project.name = name.strip()
        if description is not None:
            project.description = description.strip() or None
        if is_active is not None:
            project.is_active = is_active
        if sort_order is not None:
            project.sort_order = sort_order
        project.updated_at = utcnow()
        await self.db.commit()
        await self.db.refresh(project)
        return project

    async def deactivate_project(self, slug: str) -> None:
        project = await self.require_by_slug(slug)
        project.is_active = False
        project.updated_at = utcnow()
        await self.db.commit()

    async def prompt_context_json(self) -> str:
        projects = await self.list_projects()
        rows = [
            {
                "slug": project.slug,
                "name": project.name,
                "description": project.description or "",
            }
            for project in projects
        ]
        return json.dumps(rows, ensure_ascii=True, separators=(",", ":"))

    async def assign_project(self, idea: IdeaResult, *, evidence_text: str = "") -> IdeaResult:
        projects = await self.list_projects()
        if not projects:
            idea.project_slug = None
            idea.project_name = None
            return idea

        project_by_slug = {project.slug: project for project in projects}
        requested_slug = (idea.project_slug or "").strip()
        if requested_slug in project_by_slug:
            project = project_by_slug[requested_slug]
            idea.project_slug = project.slug
            idea.project_name = project.name
            return idea

        matched = best_project_match_for_text(
            projects,
            core_idea=idea.core_idea,
            thread_hint=idea.thread_hint,
            related_facts=idea.related_facts,
            reasoning_steps=idea.reasoning_steps,
            evidence_text=evidence_text,
        )
        if matched is None:
            idea.project_slug = None
            idea.project_name = None
            return idea

        idea.project_slug = matched.slug
        idea.project_name = matched.name
        return idea

    async def _unique_slug(self, base_slug: str) -> str:
        existing = await self.get_by_slug(base_slug)
        if existing is None:
            return base_slug

        stem = base_slug[:56].strip("-") or "project"
        for index in range(2, 1000):
            candidate = f"{stem}-{index}"
            if await self.get_by_slug(candidate) is None:
                return candidate
        raise RuntimeError("Could not allocate a unique idea project slug.")


def _project_terms(project: IdeaProject) -> set[str]:
    text = f"{project.name} {project.description or ''}".casefold()
    terms = {project.name.casefold().strip(), project.slug.replace("-", " ")}
    terms.update(token for token in re.findall(r"[a-z0-9][a-z0-9_-]{2,}", text) if len(token) >= 3)
    return {term for term in terms if term}


def best_project_match_for_text(
    projects: list[IdeaProject],
    *,
    core_idea: str,
    thread_hint: str | None = None,
    related_facts: list[str] | None = None,
    reasoning_steps: list[str] | None = None,
    evidence_text: str = "",
) -> IdeaProject | None:
    haystack = " ".join(
        [
            core_idea,
            thread_hint or "",
            " ".join(related_facts or []),
            " ".join(reasoning_steps or []),
            evidence_text,
        ]
    ).casefold()
    if not haystack.strip():
        return None

    best: tuple[int, IdeaProject] | None = None
    for project in projects:
        project_terms = _project_terms(project)
        if not project_terms:
            continue
        score = sum(3 if term == project.name.casefold() else 1 for term in project_terms if term in haystack)
        if score <= 0:
            continue
        if best is None or score > best[0]:
            best = (score, project)

    return best[1] if best and best[0] >= 2 else None
