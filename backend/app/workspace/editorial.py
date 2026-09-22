"""Owner-managed organization and private writing, shared by web and agents.

No endpoint accepts remote credentials, executes Markdown, or pushes a website.
Only an approved, hash-bound public payload can cross the export boundary.
"""

from __future__ import annotations

import re
from typing import Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Query
from pydantic import Field, field_validator
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import AuthContext, require_scope
from app.db.session import get_db_session
from app.workspace.models import (
    Draft,
    DraftRevision,
    Memory,
    Organization,
    Publication,
    Source,
    TopicLink,
)
from app.workspace.schemas import Input
from app.workspace.store import Conflict, audit, digest, project_exists, record

router = APIRouter()
read = require_scope("read")
write = require_scope("workspace:write")


class Facets(Input):
    expected_version: int = Field(ge=0)
    category: Literal[
        "note", "reflection", "reference", "idea", "decision", "question"
    ] = "note"
    area: str = Field(default="", max_length=120)
    topics: list[str] = Field(default_factory=list, max_length=12)

    @field_validator("topics")
    @classmethod
    def normalize_topics(cls, values):
        normalized = [" ".join(v.casefold().split()) for v in values]
        if any(not v or len(v) > 60 for v in normalized):
            raise ValueError("Topics must contain 1–60 characters")
        return list(dict.fromkeys(normalized))


class DraftInput(Input):
    title: str = Field(min_length=1, max_length=240)
    slug: str = Field(
        min_length=1, max_length=160, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$"
    )
    body: str = Field(default="", max_length=100_000)
    brief: str = Field(default="", max_length=8000)
    project_id: str | None = None
    source_ids: list[str] = Field(default_factory=list, max_length=30)
    destination: str = Field(
        default="markdown-export",
        min_length=1,
        max_length=120,
        pattern=r"^[a-z0-9][a-z0-9._-]*$",
    )


class DraftEdit(DraftInput):
    expected_version: int = Field(ge=1)


class Approval(Input):
    expected_version: int = Field(ge=1)
    content_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    destination: str
    confirm_public: Literal[True]


class ExportInput(Input):
    expected_version: int = Field(ge=1)
    content_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


async def commit(db):
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise Conflict("Concurrent change; refresh and retry") from exc


async def subject(db, key):
    kind, _, identity = key.partition(":")
    model = {"source": Source, "memory": Memory}.get(kind)
    row = await db.get(model, identity) if model else None
    if not row:
        raise LookupError("Organization subject not found")
    return row


@router.get("/organization/{key}")
async def facets(
    key: str, _: AuthContext = Depends(read), db: AsyncSession = Depends(get_db_session)
):
    item = await subject(db, key)
    row = await db.get(Organization, key)
    return (
        record(row)
        if row
        else {
            "key": key,
            "version": 0,
            "category": item.kind
            if isinstance(item, Memory) and item.kind in {"idea", "decision"}
            else "note",
            "area": "",
            "topics": [],
        }
    )


@router.patch("/organization/{key}")
async def organize(
    key: str,
    payload: Facets,
    context: AuthContext = Depends(write),
    db: AsyncSession = Depends(get_db_session),
):
    await subject(db, key)
    values = payload.model_dump(exclude={"expected_version"})
    if payload.expected_version == 0:
        if await db.get(Organization, key):
            raise Conflict("Organization changed; refresh first")
        db.add(Organization(key=key, **values))
        try:
            await db.flush()
        except IntegrityError as exc:
            await db.rollback()
            raise Conflict("Organization changed; refresh first") from exc
    else:
        result = await db.execute(
            update(Organization)
            .where(
                Organization.key == key,
                Organization.version == payload.expected_version,
            )
            .values(**values, version=Organization.version + 1)
        )
        if result.rowcount != 1:
            raise Conflict("Organization changed; refresh first")
    await db.execute(delete(TopicLink).where(TopicLink.key == key))
    db.add_all(TopicLink(key=key, topic=t) for t in values["topics"])
    await audit(db, key, "organized", context.token_name or "local-owner", values)
    await commit(db)
    return await facets(key, context, db)


@router.get("/topics")
async def topics(
    _: AuthContext = Depends(read), db: AsyncSession = Depends(get_db_session)
):
    return {
        "items": list(
            (
                await db.scalars(
                    select(TopicLink.topic).distinct().order_by(TopicLink.topic)
                )
            ).all()
        )
    }


def public_payload(draft):
    # Explicit allowlist: brief, evidence, account IDs and source URLs never export.
    return {
        "format": "smc-article-v1",
        "title": draft.title,
        "slug": draft.slug,
        "body": draft.body,
    }


def publication_hash(draft):
    return digest([draft.destination, public_payload(draft)])


def privacy_findings(payload):
    text = payload["title"] + "\n" + payload["body"]
    checks = [
        (
            r"(?i)(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{15,}|-----BEGIN .*PRIVATE KEY-----)",
            "credential-like text",
        ),
        (
            r"(?i)(?:bearer\s+[a-z0-9._-]{12,}|(?:api[_ -]?key|password|secret)\s*[:=]\s*\S+)",
            "possible credential assignment",
        ),
        (
            r"(?i)(?:/Users/|/Volumes/|/private/|/home/|file://|smc_key|session:[a-z0-9-]+)",
            "private path or evidence identifier",
        ),
        (
            r"(?i)(?:<\s*/?\s*[a-z!]|javascript:|data:|^\s*(?:import|export)\s)",
            "HTML, executable content, or embedded data",
        ),
        (
            r"[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}",
            "email address requires removal from public copy",
        ),
    ]
    result = [
        message for pattern, message in checks if re.search(pattern, text, re.MULTILINE)
    ]
    for raw in re.findall(r"https?://[^\s)\]>]+", text):
        parsed = urlsplit(raw)
        host = parsed.hostname or ""
        if (
            parsed.username
            or parsed.password
            or host == "localhost"
            or host.startswith(("dash.", "admin.", "memory."))
            or host.endswith((".local", ".internal", ".ts.net"))
            or "." not in host
            or re.fullmatch(r"[\d.]+", host)
            or ":" in host
            or parsed.query
            or parsed.fragment
            or host in {"chatgpt.com", "claude.ai", "gemini.google.com", "grok.com"}
        ):
            result.append("private, credential-bearing, or session link")
    return list(dict.fromkeys(result))


async def get_draft(db, identity):
    draft = await db.get(Draft, identity)
    if not draft:
        raise LookupError("Draft not found")
    return draft


async def source_refs(db, ids):
    result = []
    for identity in dict.fromkeys(ids):
        source = await db.get(Source, identity)
        if not source or source.archived:
            raise ValueError("Draft sources must be existing, active sources")
        result.append({"id": source.id, "revision": source.revision})
    return result


async def save_revision(db, draft):
    db.add(
        DraftRevision(draft_id=draft.id, version=draft.version, payload=record(draft))
    )


@router.get("/drafts")
async def drafts(
    project_id: str | None = None,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    _: AuthContext = Depends(read),
    db: AsyncSession = Depends(get_db_session),
):
    query = select(Draft)
    if project_id:
        query = query.where(Draft.project_id == project_id)
    rows = (
        await db.scalars(
            query.order_by(Draft.updated_at.desc()).offset(offset).limit(limit)
        )
    ).all()
    return {
        "items": [
            {
                k: v
                for k, v in record(r).items()
                if k not in {"body", "brief", "sources"}
            }
            for r in rows
        ]
    }


@router.post("/drafts", status_code=201)
async def create_draft(
    payload: DraftInput,
    context: AuthContext = Depends(write),
    db: AsyncSession = Depends(get_db_session),
):
    await project_exists(db, payload.project_id)
    row = Draft(
        **payload.model_dump(exclude={"source_ids"}),
        sources=await source_refs(db, payload.source_ids),
    )
    db.add(row)
    await db.flush()
    await save_revision(db, row)
    await audit(
        db,
        f"draft:{row.id}",
        "created",
        context.token_name or "local-owner",
        {"version": row.version},
    )
    await commit(db)
    return record(row)


@router.get("/drafts/{identity}")
async def draft_detail(
    identity: str,
    _: AuthContext = Depends(read),
    db: AsyncSession = Depends(get_db_session),
):
    row = await get_draft(db, identity)
    stale = []
    for ref in row.sources:
        source = await db.get(Source, ref["id"])
        if not source or source.archived or source.revision != ref["revision"]:
            stale.append(ref["id"])
    return {
        **record(row),
        "stale_sources": stale,
        "content_hash": publication_hash(row),
    }


@router.patch("/drafts/{identity}")
async def edit_draft(
    identity: str,
    payload: DraftEdit,
    context: AuthContext = Depends(write),
    db: AsyncSession = Depends(get_db_session),
):
    row = await get_draft(db, identity)
    await project_exists(db, payload.project_id)
    refs = await source_refs(db, payload.source_ids)
    # Preserve evidence revision when the owner edits prose; accepting new evidence
    # requires removing/re-adding that source, rather than hiding a stale warning.
    previous = {r["id"]: r for r in row.sources}
    refs = [previous.get(r["id"], r) for r in refs]
    result = await db.execute(
        update(Draft)
        .where(Draft.id == identity, Draft.version == payload.expected_version)
        .values(
            **payload.model_dump(exclude={"expected_version", "source_ids"}),
            sources=refs,
            version=Draft.version + 1,
            status="draft",
            approval_hash=None,
        )
    )
    if result.rowcount != 1:
        raise Conflict("Draft changed; refresh before saving")
    await db.refresh(row)
    await save_revision(db, row)
    await audit(
        db,
        f"draft:{identity}",
        "edited",
        context.token_name or "local-owner",
        {"version": row.version},
    )
    await commit(db)
    return record(row)


@router.get("/drafts/{identity}/preview")
async def preview(
    identity: str,
    context: AuthContext = Depends(read),
    db: AsyncSession = Depends(get_db_session),
):
    row = await get_draft(db, identity)
    detail = await draft_detail(identity, context, db)
    return {
        "payload": public_payload(row),
        "content_hash": publication_hash(row),
        "version": row.version,
        "destination": row.destination,
        "findings": privacy_findings(public_payload(row)),
        "stale_sources": detail["stale_sources"],
        "notice": "Review every word. Automated checks cannot prove this is safe or factually correct.",
    }


@router.post("/drafts/{identity}/approve")
async def approve(
    identity: str,
    payload: Approval,
    context: AuthContext = Depends(write),
    db: AsyncSession = Depends(get_db_session),
):
    row = await get_draft(db, identity)
    if not row.body.strip() or privacy_findings(public_payload(row)):
        raise ValueError("Resolve empty copy or privacy findings before approving")
    if (await draft_detail(identity, context, db))["stale_sources"]:
        raise Conflict(
            "Supporting evidence changed; review and refresh source references first"
        )
    if (
        payload.content_hash != publication_hash(row)
        or payload.destination != row.destination
    ):
        raise Conflict("Preview or destination changed; review again")
    result = await db.execute(
        update(Draft)
        .where(Draft.id == identity, Draft.version == payload.expected_version)
        .values(
            approval_hash=payload.content_hash,
            status="approved",
            version=Draft.version + 1,
        )
    )
    if result.rowcount != 1:
        raise Conflict("Draft changed; review again")
    await db.refresh(row)
    await save_revision(db, row)
    await audit(
        db,
        f"draft:{identity}",
        "approved",
        context.token_name or "local-owner",
        {"hash": payload.content_hash, "destination": row.destination},
    )
    await commit(db)
    return record(row)


@router.post("/drafts/{identity}/export")
async def export_draft(
    identity: str,
    payload: ExportInput,
    context: AuthContext = Depends(write),
    db: AsyncSession = Depends(get_db_session),
):
    row = await get_draft(db, identity)
    if (
        row.status != "approved"
        or row.approval_hash != payload.content_hash
        or publication_hash(row) != payload.content_hash
    ):
        raise Conflict("An exact-revision approval is required")
    # CAS acquires the writer boundary before making an export receipt.
    result = await db.execute(
        update(Draft)
        .where(
            Draft.id == identity,
            Draft.version == payload.expected_version,
            Draft.approval_hash == payload.content_hash,
        )
        .values(status=Draft.status)
    )
    if result.rowcount != 1:
        raise Conflict("Draft changed; refresh before exporting")
    if (await draft_detail(identity, context, db))["stale_sources"]:
        raise Conflict("Supporting evidence changed; review again")
    if privacy_findings(public_payload(row)):
        raise ValueError("Resolve privacy findings before exporting")
    identity_hash = digest([identity, row.destination, payload.content_hash])
    receipt = await db.get(Publication, identity_hash)
    if not receipt:
        receipt = Publication(
            id=identity_hash,
            draft_id=identity,
            content_hash=payload.content_hash,
            destination=row.destination,
            payload=public_payload(row),
        )
        db.add(receipt)
        await audit(
            db,
            f"draft:{identity}",
            "exported",
            context.token_name or "local-owner",
            {"receipt": identity_hash},
        )
    await commit(db)
    return record(receipt)


@router.get("/drafts/{identity}/history")
async def revisions(
    identity: str,
    _: AuthContext = Depends(read),
    db: AsyncSession = Depends(get_db_session),
):
    await get_draft(db, identity)
    return {
        "items": [
            record(r)
            for r in (
                await db.scalars(
                    select(DraftRevision)
                    .where(DraftRevision.draft_id == identity)
                    .order_by(DraftRevision.version.desc())
                    .limit(100)
                )
            ).all()
        ]
    }
