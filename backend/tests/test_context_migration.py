from __future__ import annotations

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.routes_context import router as context_router
from app.core.config import get_settings
from app.db.session import get_db_session
from app.models.base import Base


@pytest.mark.asyncio
async def test_context_import_and_export_preserves_codex_handoff(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-context.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    get_settings.cache_clear()
    try:
        app = FastAPI()
        app.include_router(context_router, prefix="/api/v1")

        async def override_db_session():
            async with session_factory() as session:
                yield session

        app.dependency_overrides[get_db_session] = override_db_session

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
            import_response = await client.post(
                "/api/v1/context/import",
                json={
                    "provider": "codex",
                    "external_session_id": "codex-session-1",
                    "source_interface": "codex-cli",
                    "account_key": "codex:cli",
                    "account_label": "Codex CLI",
                    "title": "Add Codex support",
                    "source_url": "codex://codex-session-1",
                    "captured_at": "2026-05-24T12:00:00Z",
                    "custom_tags": ["agent-context"],
                    "metadata": {
                        "cwd": "/work/project",
                        "model": "gpt-5.3-codex",
                        "permission_mode": "default",
                    },
                    "artifacts": [
                        {
                            "kind": "transcript",
                            "name": "codex-session-1.jsonl",
                            "uri": "/tmp/codex-session-1.jsonl",
                            "content_type": "application/jsonl",
                        }
                    ],
                    "handoff_markdown": "# Agent-Created Handoff\n\nCodex authored this markdown.",
                    "messages": [
                        {
                            "id": "turn-1-user",
                            "role": "user",
                            "content": "Add Codex support and make context migration complete.",
                            "occurred_at": "2026-05-24T12:00:00Z",
                        },
                        {
                            "id": "turn-1-assistant",
                            "parent_id": "turn-1-user",
                            "role": "assistant",
                            "content": "Implemented provider support and context export.",
                            "occurred_at": "2026-05-24T12:01:00Z",
                            "metadata": {"turn_id": "turn-1"},
                        },
                    ],
                    "raw_transcript": [{"type": "fixture"}],
                },
            )

            assert import_response.status_code == 202
            imported = import_response.json()
            assert imported["new_message_count"] == 2
            assert imported["bundle"]["provider"] == "codex"
            assert imported["bundle"]["source_interface"] == "codex-cli"
            assert imported["bundle"]["metadata"]["cwd"] == "/work/project"
            assert imported["bundle"]["artifacts"][0]["name"] == "codex-session-1.jsonl"
            assert imported["bundle"]["handoff_markdown"] == "# Agent-Created Handoff\n\nCodex authored this markdown."

            export_response = await client.get(f"/api/v1/context/export/{imported['session_id']}")

        assert export_response.status_code == 200
        exported = export_response.json()
        assert exported["schema_version"] == "savemycontext.context.v1"
        assert exported["provider"] == "codex"
        assert [message["id"] for message in exported["messages"]] == ["turn-1-user", "turn-1-assistant"]
        assert exported["sync_events"][0]["raw_capture"]["source"] == "savemycontext-context-migration"
        assert exported["sync_events"][0]["raw_capture"]["handoff_markdown"] == "# Agent-Created Handoff\n\nCodex authored this markdown."
        assert exported["handoff_markdown"] == "# Agent-Created Handoff\n\nCodex authored this markdown."
    finally:
        get_settings.cache_clear()
        await engine.dispose()
