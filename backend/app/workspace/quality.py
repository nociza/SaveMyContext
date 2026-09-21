"""Deterministic capture checks. Findings are warnings, never inferred repairs."""

from __future__ import annotations

import re

VERSION = "capture-quality-v1"
ARTIFACT = re.compile(
    r"^(?:r_[a-f0-9]{8,}|model_editable_context|reasoning_recap|thoughts|text)$", re.I
)


def assess(messages: list[dict], *, require_user: bool = True) -> dict:
    reasons: set[str] = set()
    roles = {message.get("role") for message in messages}
    if not messages:
        reasons.add("empty_transcript")
    if require_user and "user" not in roles:
        reasons.add("missing_user_turns")
    if roles - {"user", "assistant"}:
        reasons.add("non_conversation_roles")
    seen: set[str] = set()
    ids = {m.get("id", m.get("external_message_id")) for m in messages}
    for message in messages:
        content = str(message.get("content", "")).strip()
        if not content:
            reasons.add("empty_message")
        if message.get("role") != "user" and ARTIFACT.fullmatch(content):
            reasons.add("possible_parser_artifact")
        identity = message.get("id", message.get("external_message_id"))
        if identity in seen:
            reasons.add("duplicate_message_ids")
        parent = message.get("parentId", message.get("parent_external_message_id"))
        if parent in ids and parent not in seen:
            reasons.add("parent_after_child")
        seen.add(identity)
    return {
        "version": VERSION,
        "status": "needs_repair" if reasons else "no_known_issues",
        "reasons": sorted(reasons),
    }


def payload_quality(payload) -> dict:
    quality = assess(
        [m.model_dump(mode="json") for m in payload.messages],
        require_user=payload.sync_mode == "full_snapshot",
    )
    if payload.extraction_method == "heuristic":
        quality["reasons"].append("unverified_text_extraction")
        quality["status"] = "needs_repair"
    return quality


async def source_quality(db, source, revision=None) -> dict:
    from sqlalchemy import select
    from app.workspace.models import Revision

    if source.kind != "conversation":
        return {"status": "not_applicable", "reasons": []}
    snapshot = revision or await db.scalar(
        select(Revision).where(
            Revision.source_id == source.id, Revision.digest == source.revision
        )
    )
    return assess(snapshot.messages if snapshot else [])
