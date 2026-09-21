from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select

from app.api.routes_ingest import ingest_diff
from app.models import ChatSession
from app.schemas.ingest import IngestDiffRequest
from app.services.ingest import IngestService
from app.workspace import api
from app.workspace.models import CaptureQuarantine, Revision, Memory
from app.workspace.quality import assess
from app.workspace.worker import run_one
from test_workspace import workspace as workspace_fixture

# Reuse the isolated database fixture without importing a shadowed test argument.
workspace = workspace_fixture


def payload(*, minute=0, messages=None, **values):
    return IngestDiffRequest(
        provider="chatgpt",
        external_session_id="quality-test",
        captured_at=datetime(2026, 6, 1, tzinfo=timezone.utc)
        + timedelta(minutes=minute),
        messages=messages
        or [
            {
                "external_message_id": "z-user",
                "role": "user",
                "content": "Keep formatting:\n\n    code()",
            },
            {
                "external_message_id": "a-assistant",
                "role": "assistant",
                "content": "A useful reply.",
            },
        ],
        **values,
    )


def test_quality_never_labels_a_user_saying_text_as_a_parser_artifact():
    assert (
        assess([{"id": "u", "role": "user", "content": "text"}])["status"]
        == "no_known_issues"
    )
    quality = assess([{"id": "a", "role": "assistant", "content": "r_123456abcdef"}])
    assert quality["reasons"] == ["missing_user_turns", "possible_parser_artifact"]


async def test_quarantine_is_durable_idempotent_and_never_creates_a_source(workspace):
    bad = payload(
        sync_mode="full_snapshot",
        messages=[
            {
                "external_message_id": "a",
                "role": "assistant",
                "content": "r_123456abcdef",
            }
        ],
    )
    async with workspace() as db:
        first = await ingest_diff(bad, None, db)
        second = await ingest_diff(bad, None, db)
        assert (
            first.disposition == "quarantined" and first.receipt_id == second.receipt_id
        )
        assert first.session_id is None
        assert await db.scalar(select(func.count()).select_from(CaptureQuarantine)) == 1
        assert await db.scalar(select(func.count()).select_from(ChatSession)) == 0
        original = await db.get(CaptureQuarantine, first.receipt_id)
        assert original.payload["messages"][0]["content"] == "r_123456abcdef"


async def test_partial_does_not_prune_and_edits_make_immutable_revisions(workspace):
    async with workspace() as db:
        service = IngestService(db)
        session, _ = await service.ingest(
            payload(sync_mode="full_snapshot", capture_completeness="complete")
        )
        assert [m.external_message_id for m in session.messages] == [
            "z-user",
            "a-assistant",
        ]
        edited = [
            {
                "external_message_id": "z-user",
                "role": "user",
                "content": "Updated\n\n    code()",
            }
        ]
        session, count = await service.ingest(
            payload(
                minute=1,
                sync_mode="full_snapshot",
                capture_completeness="partial",
                messages=edited,
            )
        )
        assert count == 0 and len(session.messages) == 2
        assert session.messages[0].content == edited[0]["content"]
        assert await db.scalar(select(func.count()).select_from(Revision)) == 2
        session, _ = await service.ingest(
            payload()
        )  # stale incremental edit must not roll back content
        assert session.messages[0].content == edited[0]["content"]
        session, _ = await service.ingest(
            payload(minute=2, sync_mode="full_snapshot", messages=edited)
        )
        assert (
            len(session.messages) == 2
        )  # Unknown/old clients cannot claim completeness.
        session, _ = await service.ingest(
            payload(
                minute=3,
                sync_mode="full_snapshot",
                capture_completeness="complete",
                messages=edited,
            )
        )
        assert len(session.messages) == 1


async def test_bad_new_capture_cannot_replace_a_good_transcript(workspace):
    async with workspace() as db:
        session, _ = await IngestService(db).ingest(payload())
        before = [m.content for m in session.messages]
        response = await ingest_diff(
            payload(
                minute=1,
                sync_mode="full_snapshot",
                messages=[
                    {
                        "external_message_id": "bad",
                        "role": "assistant",
                        "content": "text",
                    }
                ],
            ),
            None,
            db,
        )
        assert response.disposition == "quarantined"
        session = await IngestService(db)._load_session(session.id)
        assert [m.content for m in session.messages] == before


async def test_assistant_only_increment_is_archived_but_never_inferred(workspace):
    async with workspace() as db:
        session, _ = await IngestService(db).ingest(
            payload(
                messages=[
                    {
                        "external_message_id": "a",
                        "role": "assistant",
                        "content": "An answer without its question.",
                    }
                ]
            )
        )
        detail = await api.source_detail(f"session:{session.id}", None, None, db)
        assert detail["quality"]["status"] == "needs_repair"

    async def forbidden(*args, **kwargs):
        pytest.fail("Malformed transcripts must not reach any inference provider")

    assert await run_one(workspace, extractor=forbidden)
    async with workspace() as db:
        assert await db.scalar(select(func.count()).select_from(Memory)) == 0


async def test_heuristic_extraction_requires_review_even_when_text_looks_valid(
    workspace,
):
    async with workspace() as db:
        response = await ingest_diff(payload(extraction_method="heuristic"), None, db)
        assert response.disposition == "quarantined"
        assert "unverified_text_extraction" in response.quality["reasons"]
