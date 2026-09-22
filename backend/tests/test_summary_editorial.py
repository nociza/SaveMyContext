# ruff: noqa: F811
import json

import pytest
from pydantic import ValidationError
from sqlalchemy import select

from app.core.config import get_settings
from app.workspace import api, editorial, processor
from app.workspace.models import (
    Draft,
    DraftRevision,
    Job,
    Memory,
    Publication,
    SourceSummary,
    Task,
)
from app.workspace.schemas import ReprocessInput
from app.workspace.store import Conflict, enqueue_source
from app.workspace.summarizer import (
    Cache,
    Passage,
    Selection,
    resolve,
    source_spans,
    summarize,
)
from app.workspace.worker import run_one
from test_workspace import workspace  # noqa: F401

OWNER = api.AuthContext(None, "test", "owner", frozenset({"*"}))


class Selector:
    def __init__(self):
        self.calls = []
        self.last_metadata = {"model": "returned-model", "usage": {"total_tokens": 100}}

    async def generate_json(self, **kwargs):
        data = json.loads(kwargs["user_prompt"])
        self.calls.append(data)
        if isinstance(data, dict):
            return Selection(
                passages=[
                    Passage(**{k: p[k] for k in ("span_id", "start", "end", "section")})
                    for p in data["passages"][-24:]
                ]
            )
        return Selection(
            passages=[
                Passage(
                    span_id=s["span_id"],
                    start=0,
                    end=min(1200, len(s["text"])),
                    section="findings",
                )
                for s in data
            ]
        )


def transcript(turns):
    return "\n\n".join(f"{t['role'].upper()}: {t['content']}" for t in turns)


async def test_every_character_and_role_is_available_including_long_code_quotes():
    turns = [
        {
            "id": "u",
            "role": "user",
            "content": "> quoted\n```\n" + "long passage " * 1500 + "\n```",
        },
        {
            "id": "a",
            "role": "assistant",
            "content": "SQLite is a useful single-writer database.",
        },
        {"id": "u2", "role": "user", "content": "Yes, use that approach."},
    ]
    spans = source_spans(transcript(turns), turns)
    assert "".join(s["text"] for s in spans) == "".join(t["content"] for t in turns)
    assert all(
        transcript(turns)[s["body_start"] : s["body_start"] + len(s["text"])]
        == s["text"]
        for s in spans
    )
    client = Selector()
    result = await summarize(
        transcript(turns), turns, client, model="test", max_chars=120_000
    )
    assert result["coverage"]["processed_chunks"] == result["coverage"]["chunks"] > 1
    assert any(
        p["role"] == "assistant" and "SQLite" in p["quote"] for p in result["passages"]
    )
    assert client.calls[-1]["latest_turns"][-1]["text"] == "Yes, use that approach."


def test_generated_claims_and_invented_coordinates_cannot_be_saved():
    with pytest.raises(ValidationError):
        Selection.model_validate({"passages": [], "body": "All restore tests passed."})
    spans = source_spans("We are comparing backups.", [])
    selected = Selection(
        passages=[
            Passage(span_id="invented", start=0, end=10, section="decisions"),
            Passage(
                span_id=spans[0]["span_id"], start=0, end=99999, section="findings"
            ),
        ]
    )
    assert resolve(selected, spans) == ([], 2)


def test_citations_preserve_original_whitespace_and_dates():
    text = "We chose SQLite. It has one writer.\n\nTomorrow is relative to this old message."
    turns = [
        {
            "role": "user",
            "id": "u",
            "content": text,
            "occurred_at": "2024-01-01T12:00:00+00:00",
        }
    ]
    body = transcript(turns)
    spans = source_spans(body, turns)
    result, rejected = resolve(
        Selection(
            passages=[
                Passage(
                    span_id=spans[0]["span_id"],
                    start=0,
                    end=len(text),
                    section="history",
                )
            ]
        ),
        spans,
    )
    p = result[0]
    assert p["quote"] == text == body[p["body_start"] : p["body_end"]]
    assert p["occurred_at"].startswith("2024") and rejected == 0


async def test_cache_keeps_actual_model_and_large_budget_abstains(workspace):
    client = Selector()
    first = await summarize(
        "A useful note.",
        [],
        client,
        model="requested",
        max_chars=12000,
        cache=Cache(workspace),
    )
    second = await summarize(
        "A useful note.",
        [],
        client,
        model="requested",
        max_chars=12000,
        cache=Cache(workspace),
    )
    assert len(client.calls) == 1 and second["cache_hits"] == 1
    assert (
        first["models"][0]["model"] == second["models"][0]["model"] == "returned-model"
    )
    result = await summarize(
        "x" * 12001, [], client, model="requested", max_chars=12000
    )
    assert result["status"] == "needs_budget" and len(client.calls) == 1


async def test_action_classification_sees_later_cancellation(workspace, monkeypatch):
    monkeypatch.setenv("SAVEMYCONTEXT_WORKSPACE_EXTERNAL_PROCESSING", "true")
    monkeypatch.setenv("SAVEMYCONTEXT_WORKSPACE_GENERATE", "false")
    get_settings.cache_clear()
    seen = []

    async def decisions(excerpts, *, context):
        seen.append((excerpts, context))
        return {}

    monkeypatch.setattr(processor, "jev_decisions", decisions)
    turns = [
        {
            "role": "user",
            "content": "I will publish tomorrow.\n"
            + "Some context.\n" * 12
            + "Cancel that plan.",
        }
    ]
    result, _ = await processor.extract(transcript(turns), turns)
    assert result == [] and len(seen) == 1
    assert "Cancel that plan." in seen[0][1][0]["content"]
    assert any(
        "before publication" in s
        for s in processor.candidates(
            [{"role": "user", "content": "long text " * 400 + "before publication"}], ""
        )
    )


async def test_worker_persists_summary_separately_from_memories_and_tasks(
    workspace, monkeypatch
):
    monkeypatch.setenv("SAVEMYCONTEXT_WORKSPACE_EXTERNAL_PROCESSING", "true")
    monkeypatch.setenv("SAVEMYCONTEXT_WORKSPACE_GENERATE", "true")
    monkeypatch.setenv("SAVEMYCONTEXT_WORKSPACE_SUMMARY_MODEL", "explicit-test-model")
    monkeypatch.setenv("SAVEMYCONTEXT_JEV_API_KEY", "")
    get_settings.cache_clear()
    client = Selector()
    monkeypatch.setattr(
        "app.services.llm.openai_client.OpenAIClient", lambda **kwargs: client
    )
    async with workspace() as db:
        await enqueue_source(
            db,
            source_id="s",
            title="Research",
            body="We are comparing two backup approaches.",
            kind="selection",
            provider="test",
        )
        await db.commit()
    await run_one(workspace)
    async with workspace() as db:
        summary = await db.scalar(select(SourceSummary))
        assert summary.payload["status"] == "ready"
        assert not (await db.scalars(select(Memory))).all()
        assert not (await db.scalars(select(Task))).all()
        assert (await db.scalar(select(Job))).state == "done"


async def test_generation_requires_explicit_model_without_paid_fallback(
    workspace, monkeypatch
):
    monkeypatch.setenv("SAVEMYCONTEXT_WORKSPACE_EXTERNAL_PROCESSING", "true")
    monkeypatch.setenv("SAVEMYCONTEXT_WORKSPACE_GENERATE", "true")
    monkeypatch.delenv("SAVEMYCONTEXT_WORKSPACE_SUMMARY_MODEL", raising=False)
    monkeypatch.setenv("SAVEMYCONTEXT_JEV_API_KEY", "")
    get_settings.cache_clear()
    items, provenance = await processor.extract("Do not publish the draft.", [])
    assert items == [] and provenance["summary"]["status"] == "unavailable"


async def seed_source(db):
    source = await enqueue_source(
        db,
        source_id="test:source",
        title="Private research",
        body="Private evidence",
        kind="note",
        provider="test",
    )
    await db.commit()
    return source


async def test_organization_is_independent_normalized_and_versioned(workspace):
    async with workspace() as db:
        source = await seed_source(db)
        key = "source:" + source.id
        first = await editorial.organize(
            key,
            editorial.Facets(
                expected_version=0,
                category="reference",
                topics=["SQLite", "sqlite", " Backups  "],
            ),
            OWNER,
            db,
        )
        assert first["topics"] == ["sqlite", "backups"]
        assert (await editorial.topics(OWNER, db))["items"] == ["backups", "sqlite"]
        with pytest.raises(Conflict):
            await editorial.organize(
                key, editorial.Facets(expected_version=0), OWNER, db
            )
        found = await api.sources(
            limit=50, offset=0, db=db, category="reference", topic="SQLite"
        )
        assert len(found["items"]) == 1
        assert source.body == "Private evidence"


async def test_draft_approval_export_retry_and_edits_invalidate_approval(workspace):
    async with workspace() as db:
        source = await seed_source(db)
        payload = editorial.DraftInput(
            title="Small databases",
            slug="small-databases",
            body="SQLite suits small single-writer applications.",
            brief="PRIVATE ROUGH NOTES",
            source_ids=[source.id],
        )
        draft = await editorial.create_draft(payload, OWNER, db)
        p = await editorial.preview(draft["id"], OWNER, db)
        assert (
            "PRIVATE" not in json.dumps(p["payload"]) and "source" not in p["payload"]
        )
        with pytest.raises(Conflict):
            await editorial.export_draft(
                draft["id"],
                editorial.ExportInput(
                    expected_version=1, content_hash=p["content_hash"]
                ),
                OWNER,
                db,
            )
        approved = await editorial.approve(
            draft["id"],
            editorial.Approval(
                expected_version=1,
                content_hash=p["content_hash"],
                destination=p["destination"],
                confirm_public=True,
            ),
            OWNER,
            db,
        )
        args = editorial.ExportInput(
            expected_version=approved["version"], content_hash=p["content_hash"]
        )
        first = await editorial.export_draft(draft["id"], args, OWNER, db)
        second = await editorial.export_draft(draft["id"], args, OWNER, db)
        assert first["id"] == second["id"] and first["status"] == "exported"
        edited = await editorial.edit_draft(
            draft["id"],
            editorial.DraftEdit(
                **{**payload.model_dump(), "destination": "different-site"},
                expected_version=2,
            ),
            OWNER,
            db,
        )
        assert edited["approval_hash"] is None and edited["status"] == "draft"
        with pytest.raises(Conflict):
            await editorial.export_draft(draft["id"], args, OWNER, db)
        assert len((await db.scalars(select(Publication))).all()) == 1
        assert len((await db.scalars(select(DraftRevision))).all()) == 3


@pytest.mark.parametrize(
    "body",
    [
        "password=supersecret",
        "https://dash.berkeleycs.org/memory",
        "<script>alert(1)</script>",
        "https://example.com/?token=secret",
        "email me at person@example.com",
        "/Users/person/private.txt",
    ],
)
async def test_private_or_executable_content_blocks_approval(workspace, body):
    async with workspace() as db:
        draft = await editorial.create_draft(
            editorial.DraftInput(title="Draft", slug="draft", body=body), OWNER, db
        )
        p = await editorial.preview(draft["id"], OWNER, db)
        assert p["findings"]
        with pytest.raises(ValueError):
            await editorial.approve(
                draft["id"],
                editorial.Approval(
                    expected_version=1,
                    content_hash=p["content_hash"],
                    destination=p["destination"],
                    confirm_public=True,
                ),
                OWNER,
                db,
            )


async def test_stale_evidence_and_stale_draft_version_block_approval(workspace):
    async with workspace() as db:
        source = await seed_source(db)
        d = await editorial.create_draft(
            editorial.DraftInput(
                title="Article",
                slug="article",
                body="Public text.",
                source_ids=[source.id],
            ),
            OWNER,
            db,
        )
        p = await editorial.preview(d["id"], OWNER, db)
        await enqueue_source(
            db,
            source_id=source.id,
            title="Changed",
            body="New evidence",
            kind="note",
            provider="test",
        )
        await db.commit()
        with pytest.raises(Conflict):
            await editorial.approve(
                d["id"],
                editorial.Approval(
                    expected_version=1,
                    content_hash=p["content_hash"],
                    destination=p["destination"],
                    confirm_public=True,
                ),
                OWNER,
                db,
            )
        assert (await db.get(Draft, d["id"])).status == "draft"


async def test_reprocess_is_explicit_bounded_and_preserves_revision(workspace):
    async with workspace() as db:
        source = await seed_source(db)
        original = source.revision
        preview = await api.reprocess(
            source.id, ReprocessInput(expected_revision=original), OWNER, db
        )
        assert not preview["writes"]
        one = await api.reprocess(
            source.id,
            ReprocessInput(expected_revision=original, dry_run=False),
            OWNER,
            db,
        )
        two = await api.reprocess(
            source.id,
            ReprocessInput(expected_revision=original, dry_run=False),
            OWNER,
            db,
        )
        assert one["id"] == two["id"] and source.revision == original
