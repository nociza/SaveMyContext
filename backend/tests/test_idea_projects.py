from __future__ import annotations

from datetime import datetime, timezone

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.routes_idea_projects import router as idea_projects_router
from app.db.session import get_db_session
from app.models import ChatMessage, ChatSession, MessageRole, ProviderName
from app.models.base import Base
from app.models.enums import BuiltInPileSlug
from app.schemas.processing import IdeaResult
from app.schemas.processing_worker import SessionPipelineResult
from app.services.explorer import ExplorerService
from app.services.idea_projects import IdeaProjectService
from app.services.processing import SessionProcessor


def _build_app(session_factory) -> FastAPI:  # type: ignore[no-untyped-def]
    app = FastAPI()
    app.include_router(idea_projects_router, prefix="/api/v1")

    async def override_db_session():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_db_session] = override_db_session
    return app


@pytest.mark.asyncio
async def test_idea_project_routes_create_list_update_and_deactivate(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'idea-project-routes.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    app = _build_app(session_factory)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
        created = await client.post(
            "/api/v1/idea-projects",
            json={
                "name": "Agent Workflow Surfaces",
                "description": "Badges, capability pages, and workflow graph ideas.",
            },
        )
        assert created.status_code == 201, created.text
        payload = created.json()
        assert payload["slug"] == "agent-workflow-surfaces"
        assert payload["is_active"] is True

        listed = await client.get("/api/v1/idea-projects")
        assert listed.status_code == 200
        assert [item["slug"] for item in listed.json()] == ["agent-workflow-surfaces"]

        updated = await client.patch(
            "/api/v1/idea-projects/agent-workflow-surfaces",
            json={"description": "Workflow badges and capability maps."},
        )
        assert updated.status_code == 200
        assert updated.json()["description"] == "Workflow badges and capability maps."

        deleted = await client.delete("/api/v1/idea-projects/agent-workflow-surfaces")
        assert deleted.status_code == 204

        active_only = await client.get("/api/v1/idea-projects")
        assert active_only.status_code == 200
        assert active_only.json() == []

        include_inactive = await client.get("/api/v1/idea-projects", params={"include_inactive": "true"})
        assert include_inactive.status_code == 200
        assert include_inactive.json()[0]["is_active"] is False

    await engine.dispose()


@pytest.mark.asyncio
async def test_session_processor_assigns_matching_project_to_idea_result(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'idea-project-assignment.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        await IdeaProjectService(session).create_project(
            name="Agent Workflow Surfaces",
            description="Workflow badges, capability pages, and graph surfaces.",
        )
        chat_session = ChatSession(
            provider=ProviderName.GEMINI,
            external_session_id="idea-project-assignment",
            title="Workflow badge brainstorm",
            built_in_pile=None,
            source_url="https://gemini.google.com/app/idea-project-assignment",
            last_captured_at=datetime(2026, 4, 20, 12, 0, tzinfo=timezone.utc),
        )
        session.add(chat_session)
        await session.flush()
        session.add(
            ChatMessage(
                session_id=chat_session.id,
                external_message_id="msg-1",
                role=MessageRole.USER,
                content="Brainstorm a workflow badge that connects capability pages to the graph surface.",
                sequence_index=1,
            )
        )
        await session.commit()

        processor = SessionProcessor(session)
        result = await processor.apply_pipeline_result(
            chat_session.id,
            SessionPipelineResult(
                pile=BuiltInPileSlug.IDEAS,
                classification_reason="Ideation.",
                idea=IdeaResult(
                    core_idea="A workflow badge can connect capability pages to a graph surface.",
                    share_post="A workflow badge could make capability surfaces easier to navigate.",
                    thread_hint="Workflow surfaces",
                ),
            ),
        )

        assert result.idea_summary is not None
        assert result.idea_summary["project_slug"] == "agent-workflow-surfaces"
        assert result.idea_summary["project_name"] == "Agent Workflow Surfaces"

    await engine.dispose()


@pytest.mark.asyncio
async def test_idea_workspace_infers_projects_for_existing_idea_summaries(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'idea-project-existing-views.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        await IdeaProjectService(session).create_project(
            name="Agent Workflow Surfaces",
            description="Workflow badges, capability pages, and graph surfaces.",
        )
        chat_session = ChatSession(
            provider=ProviderName.GEMINI,
            external_session_id="idea-project-existing",
            title="Existing workflow idea",
            built_in_pile=BuiltInPileSlug.IDEAS,
            source_url="https://gemini.google.com/app/idea-project-existing",
            idea_summary={
                "core_idea": "Use workflow badges to connect capability pages to graph surfaces.",
                "thread_hint": "Workflow surfaces",
                "reasoning_steps": ["Capability pages need a persistent workflow signal."],
            },
            last_captured_at=datetime(2026, 4, 21, 12, 0, tzinfo=timezone.utc),
        )
        session.add(chat_session)
        await session.commit()

        views = await ExplorerService(session).category_views(BuiltInPileSlug.IDEAS)

        assert views.ideas is not None
        assert views.ideas.nodes[0].project_slug == "agent-workflow-surfaces"
        assert views.ideas.projects[0].label == "Agent Workflow Surfaces"

    await engine.dispose()
