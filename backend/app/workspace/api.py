from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Header, Query
from fastapi.responses import PlainTextResponse
from sqlalchemy import and_, func, literal, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import AuthContext, require_scope
from app.core.config import get_settings
from app.db.session import get_db_session
from app.workspace.models import (
    CaptureQuarantine,
    Event,
    Job,
    Memory,
    Organization,
    Project,
    Revision,
    Source,
    SourceSummary,
    Task,
    TopicLink,
)
from app.workspace.editorial import router as editorial_router
from app.workspace.processor import PROCESSOR_VERSION
from app.workspace.quality import source_quality
from app.workspace import knowledge
from app.workspace.schemas import (
    CaptureInput,
    MemoryPatch,
    ProjectInput,
    ReprocessInput,
    SourcePatch,
    TaskInput,
    TaskPatch,
)
from app.workspace.store import (
    Conflict,
    audit,
    create_task,
    enqueue_source,
    get_settings as preferences,
    index_document,
    notifications,
    project_exists,
    record,
    set_settings,
    task_dashboard,
    update_task,
)

router = APIRouter(prefix="/workspace")
router.include_router(editorial_router)
compat_router = APIRouter(prefix="/v1")
read = require_scope("read")
write = require_scope("workspace:write")


def actor(context: AuthContext) -> str:
    return context.token_name or "local-owner"


async def commit(db):
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise Conflict(
            "Conflicting update; refresh and retry with the same request key"
        ) from exc


@router.get("/overview")
async def overview(
    _: AuthContext = Depends(read), db: AsyncSession = Depends(get_db_session)
):
    counts = {}
    for label, model, condition in [
        ("sources", Source, Source.archived.is_(False)),
        ("inbox", Memory, Memory.status == "suggested"),
        ("memory", Memory, Memory.status == "accepted"),
        ("tasks", Task, Task.status == "open"),
        ("projects", Project, Project.archived.is_(False)),
        ("pending_jobs", Job, Job.state.in_(["pending", "running"])),
        ("failed_jobs", Job, Job.state == "failed"),
        ("quarantined_captures", CaptureQuarantine, True),
    ]:
        counts[label] = await db.scalar(
            select(func.count()).select_from(model).where(condition)
        )
    settings = get_settings()
    return {
        "counts": counts,
        "processing": {
            "external_enabled": settings.workspace_external_processing,
            "decision_model": settings.jev_model
            if settings.workspace_external_processing and settings.jev_api_key
            else "local-source-index-v2",
            "generation_enabled": settings.workspace_external_processing
            and settings.workspace_generate,
            "summary_model": settings.workspace_summary_model,
            "summary_mode": "source-backed digest; separate from action suggestions",
            "paid_fallback_enabled": settings.allow_paid_fallback,
        },
        "settings": await preferences(db),
        "retrieval": await knowledge.status(db),
    }


@router.get("/sources")
async def sources(
    project_id: str | None = None,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    _: AuthContext = Depends(read),
    db: AsyncSession = Depends(get_db_session),
    category: str | None = None,
    topic: str | None = None,
):
    statement = select(Source).where(Source.archived.is_(False))
    statement = filter_facets(statement, Source, "source", category, topic)
    if project_id:
        statement = statement.where(Source.project_id == project_id)
    rows = (
        await db.scalars(
            statement.order_by(Source.updated_at.desc()).offset(offset).limit(limit)
        )
    ).all()
    return {
        "items": [
            {
                **{k: v for k, v in record(row).items() if k != "body"},
                "excerpt": row.body[:260],
                "quality": await source_quality(db, row),
            }
            for row in rows
        ]
    }


@router.get("/sources/{source_id}")
async def source_detail(
    source_id: str,
    revision: str | None = None,
    _: AuthContext = Depends(read),
    db: AsyncSession = Depends(get_db_session),
):
    source = await db.get(Source, source_id)
    if not source:
        raise LookupError("Source not found")
    result = record(source)
    snapshot = None
    if revision:
        snapshot = await db.scalar(
            select(Revision).where(
                Revision.source_id == source_id, Revision.digest == revision
            )
        )
        if not snapshot:
            raise LookupError("Revision not found")
        result.update(body=snapshot.body, revision=snapshot.digest)
    result["quality"] = await source_quality(db, source, snapshot)
    summary = await db.scalar(
        select(SourceSummary)
        .where(
            SourceSummary.source_id == source_id,
            SourceSummary.revision == result["revision"],
        )
        .order_by(SourceSummary.updated_at.desc())
        .limit(1)
    )
    result["summary"] = record(summary) if summary else None
    result["is_current"] = result["revision"] == source.revision
    result["memories"] = [
        record(row)
        for row in (
            await db.scalars(
                select(Memory).where(
                    Memory.source_id == source_id,
                    Memory.status.notin_(["rejected", "superseded"]),
                )
            )
        ).all()
    ]
    return result


@router.get("/capture-quarantine")
async def capture_quarantine(
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    _: AuthContext = Depends(read),
    db: AsyncSession = Depends(get_db_session),
):
    rows = (
        await db.scalars(
            select(CaptureQuarantine)
            .order_by(CaptureQuarantine.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
    ).all()
    # Raw requests remain private evidence, never rendered as HTML or logged.
    return {
        "items": [
            {k: v for k, v in record(row).items() if k != "payload"} for row in rows
        ]
    }


@router.post("/captures", status_code=201)
async def capture(
    payload: CaptureInput,
    context: AuthContext = Depends(require_scope("ingest")),
    db: AsyncSession = Depends(get_db_session),
):
    source_id = f"note:{payload.key}"
    existing = await db.get(Source, source_id)
    if existing:
        if (
            existing.body != payload.body
            or existing.title != payload.title
            or existing.project_id != payload.project_id
        ):
            raise Conflict("Capture key already used for different content")
        return record(existing)
    await project_exists(db, payload.project_id)
    source = await enqueue_source(
        db,
        source_id=source_id,
        title=payload.title,
        body=payload.body,
        kind="note",
        provider=payload.interface,
    )
    source.project_id = payload.project_id
    await audit(
        db, source_id, "captured", actor(context), {"revision": source.revision}
    )
    await commit(db)
    return record(source)


@router.patch("/sources/{source_id}")
async def edit_source(
    source_id: str,
    payload: SourcePatch,
    context: AuthContext = Depends(write),
    db: AsyncSession = Depends(get_db_session),
):
    source = await db.get(Source, source_id)
    if not source:
        raise LookupError("Source not found")
    changes = payload.model_dump(exclude_unset=True, exclude={"expected_revision"})
    await project_exists(db, changes.get("project_id"))
    result = await db.execute(
        update(Source)
        .where(Source.id == source_id, Source.revision == payload.expected_revision)
        .values(**changes)
    )
    if result.rowcount != 1:
        raise Conflict("Source changed. Refresh before editing.")
    if "project_id" in changes:
        from app.workspace.provider_projects import lock_manual_project

        await lock_manual_project(db, source_id)
        await db.execute(
            update(Memory)
            .where(Memory.source_id == source_id, Memory.status == "suggested")
            .values(project_id=changes["project_id"], version=Memory.version + 1)
        )
    if changes.get("archived"):
        await db.execute(
            update(Memory)
            .where(Memory.source_id == source_id, Memory.status == "suggested")
            .values(status="rejected", version=Memory.version + 1)
        )
    await audit(db, source_id, "updated", actor(context), changes)
    await commit(db)
    await db.refresh(source)
    return record(source)


@router.get("/memories/{memory_id}")
async def memory_detail(
    memory_id: str,
    _: AuthContext = Depends(read),
    db: AsyncSession = Depends(get_db_session),
):
    memory = await db.get(Memory, memory_id)
    if not memory:
        raise LookupError("Memory not found")
    return record(memory)


@router.get("/memories")
async def memories(
    status: Literal["suggested", "accepted", "rejected"] = "accepted",
    kind: Literal["task", "note", "idea", "decision"] | None = None,
    project_id: str | None = None,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    _: AuthContext = Depends(read),
    db: AsyncSession = Depends(get_db_session),
    category: str | None = None,
    topic: str | None = None,
):
    statement = select(Memory).where(Memory.status == status)
    statement = filter_facets(statement, Memory, "memory", category, topic)
    if kind:
        statement = statement.where(Memory.kind == kind)
    if project_id:
        statement = statement.where(Memory.project_id == project_id)
    return {
        "items": [
            record(m)
            for m in (
                await db.scalars(
                    statement.order_by(Memory.created_at.desc())
                    .offset(offset)
                    .limit(limit)
                )
            ).all()
        ]
    }


def filter_facets(statement, model, kind, category, topic):
    key = literal(kind + ":") + model.id
    if category:
        assigned = select(Organization.key).where(Organization.key == key).exists()
        fallback = (
            (model.kind == category) if model is Memory else literal(category == "note")
        )
        statement = statement.where(
            or_(
                and_(~assigned, fallback),
                select(Organization.key)
                .where(Organization.key == key, Organization.category == category)
                .exists(),
            )
        )
    if topic:
        statement = statement.where(
            select(TopicLink.key)
            .where(
                TopicLink.key == key,
                TopicLink.topic == " ".join(topic.casefold().split()),
            )
            .exists()
        )
    return statement


@router.patch("/memories/{memory_id}")
async def edit_memory(
    memory_id: str,
    payload: MemoryPatch,
    context: AuthContext = Depends(write),
    db: AsyncSession = Depends(get_db_session),
):
    memory = await db.get(Memory, memory_id)
    if not memory:
        raise LookupError("Memory not found")
    changes = payload.model_dump(exclude_unset=True, exclude={"expected_version"})
    await project_exists(db, changes.get("project_id"))
    if changes.get("status") == "accepted" and memory.status == "superseded":
        raise Conflict("Source changed; review the latest suggestion")
    before = record(memory)
    if any(key in changes for key in ("title", "body", "project_id")):
        changes["provenance"] = {**memory.provenance, "user_edited": True}
    changed = await db.execute(
        update(Memory)
        .where(Memory.id == memory_id, Memory.version == payload.expected_version)
        .values(**changes, version=Memory.version + 1)
    )
    if changed.rowcount != 1:
        raise Conflict("This memory changed. Refresh before saving.")
    await db.refresh(memory)
    if memory.status == "accepted" and memory.kind == "task":
        existing = await db.scalar(select(Task).where(Task.memory_id == memory.id))
        if not existing:
            await create_task(
                db,
                TaskInput(
                    title=memory.title[:240],
                    notes=memory.body[:4000],
                    project_id=memory.project_id,
                ),
                actor=actor(context),
                memory_id=memory.id,
            )
    await index_document(db, f"memory:{memory.id}", memory.title, memory.body)
    await audit(
        db,
        f"memory:{memory.id}",
        "updated",
        actor(context),
        {"before": before, "after": record(memory)},
    )
    await commit(db)
    return record(memory)


@router.get("/projects")
async def projects(
    _: AuthContext = Depends(read), db: AsyncSession = Depends(get_db_session)
):
    from app.workspace.provider_projects import project_records

    rows = (
        await db.scalars(
            select(Project).where(Project.archived.is_(False)).order_by(Project.name)
        )
    ).all()
    return {"items": await project_records(db, rows)}


@router.post("/projects", status_code=201)
async def add_project(
    payload: ProjectInput,
    context: AuthContext = Depends(write),
    db: AsyncSession = Depends(get_db_session),
):
    project = Project(**payload.model_dump())
    db.add(project)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise Conflict("A project with that name already exists") from exc
    await audit(db, f"project:{project.id}", "created", actor(context), record(project))
    await commit(db)
    return record(project)


@router.get("/search")
async def search_workspace(
    q: str = Query(min_length=1, max_length=500),
    mode: Literal["auto", "exact", "semantic"] = "auto",
    scope: Literal["all", "curated", "sources"] = "all",
    _: AuthContext = Depends(read),
    db: AsyncSession = Depends(get_db_session),
):
    return await knowledge.search(db, q, mode=mode, scope=scope)


@router.get("/tasks")
@compat_router.get("/tasks")
async def tasks(
    status: Literal["open", "done", "archived", "all"] = "open",
    limit: int = Query(500, ge=1, le=2000),
    offset: int = Query(0, ge=0),
    project_id: str | None = None,
    _: AuthContext = Depends(read),
    db: AsyncSession = Depends(get_db_session),
):
    statement = select(Task)
    if status != "all":
        statement = statement.where(Task.status == status)
    if project_id:
        statement = statement.where(Task.project_id == project_id)
    rows = (
        await db.scalars(statement.order_by(Task.id.desc()).offset(offset).limit(limit))
    ).all()
    return {"tasks": [record(t) for t in rows]}


@router.post("/tasks", status_code=201)
@compat_router.post("/tasks", status_code=201)
async def add_task(
    payload: TaskInput,
    context: AuthContext = Depends(write),
    idempotency_key: str | None = Header(default=None, max_length=128),
    db: AsyncSession = Depends(get_db_session),
):
    key = (
        f"{context.token_id or 'local'}:{idempotency_key}" if idempotency_key else None
    )
    result = await create_task(db, payload, actor=actor(context), key=key)
    await commit(db)
    return {"task": result}


@router.patch("/tasks/{task_id}")
@compat_router.patch("/tasks/{task_id}")
async def edit_task(
    task_id: int,
    payload: TaskPatch,
    context: AuthContext = Depends(write),
    db: AsyncSession = Depends(get_db_session),
):
    result = await update_task(
        db, task_id, payload.model_dump(exclude_unset=True), actor=actor(context)
    )
    await commit(db)
    return {"task": result}


@router.get("/settings")
async def settings(
    _: AuthContext = Depends(read), db: AsyncSession = Depends(get_db_session)
):
    return {"settings": await preferences(db)}


@router.patch("/settings")
@compat_router.patch("/settings")
async def edit_settings(
    payload: dict,
    context: AuthContext = Depends(write),
    db: AsyncSession = Depends(get_db_session),
):
    result = await set_settings(db, payload, actor=actor(context))
    await commit(db)
    return {"settings": result}


@compat_router.get("/dashboard")
async def dashboard(
    _: AuthContext = Depends(read), db: AsyncSession = Depends(get_db_session)
):
    return await task_dashboard(db)


@compat_router.get("/notifications/pending")
async def pending(
    now: str | None = None,
    _: AuthContext = Depends(read),
    db: AsyncSession = Depends(get_db_session),
):
    return await notifications(
        db, datetime.fromisoformat(now.replace("Z", "+00:00")) if now else None
    )


@router.get("/jobs")
async def jobs(
    _: AuthContext = Depends(read), db: AsyncSession = Depends(get_db_session)
):
    rows = (
        await db.scalars(select(Job).order_by(Job.updated_at.desc()).limit(50))
    ).all()
    return {"items": [record(j) for j in rows]}


@router.post("/sources/{source_id}/reprocess")
async def reprocess(
    source_id: str,
    payload: ReprocessInput,
    context: AuthContext = Depends(write),
    db: AsyncSession = Depends(get_db_session),
):
    source = await db.get(Source, source_id)
    if not source or source.archived:
        raise LookupError("Active source not found")
    if source.revision != payload.expected_revision:
        raise Conflict("Source changed; refresh first")
    settings = get_settings()
    if payload.dry_run:
        return {
            "source_id": source_id,
            "revision": source.revision,
            "processor": PROCESSOR_VERSION,
            "characters": len(source.body),
            "external_enabled": settings.workspace_external_processing,
            "summary_model": settings.workspace_summary_model,
            "writes": False,
        }
    from app.workspace.store import ensure_source_chunks

    changed = await db.execute(
        update(Source)
        .where(
            Source.id == source_id,
            Source.revision == payload.expected_revision,
            Source.archived.is_(False),
        )
        .values(updated_at=Source.updated_at)
    )
    if changed.rowcount != 1:
        raise Conflict("Source changed; refresh first")
    await ensure_source_chunks(db, source)
    job = await db.scalar(
        select(Job).where(
            Job.source_id == source_id,
            Job.revision == source.revision,
            Job.processor == PROCESSOR_VERSION,
        )
    )
    if job and job.state in {"running", "pending"}:
        await commit(db)
        return record(job)
    if job:
        job.state, job.attempts, job.available_at, job.error = "pending", 0, 0.0, None
    else:
        job = Job(
            source_id=source_id, revision=source.revision, processor=PROCESSOR_VERSION
        )
        db.add(job)
    await audit(
        db,
        source_id,
        "reprocess_requested",
        actor(context),
        {"revision": source.revision, "processor": PROCESSOR_VERSION},
    )
    await commit(db)
    return record(job)


@router.post("/jobs/{job_id}/retry")
async def retry(
    job_id: str,
    _: AuthContext = Depends(write),
    db: AsyncSession = Depends(get_db_session),
):
    job = await db.get(Job, job_id)
    if not job:
        raise LookupError("Job not found")
    if job.state != "failed":
        raise Conflict("Only failed jobs can be retried")
    job.state, job.attempts, job.available_at, job.error = "pending", 0, 0.0, None
    await commit(db)
    return record(job)


@router.get("/history/{object_id}")
async def history(
    object_id: str,
    _: AuthContext = Depends(read),
    db: AsyncSession = Depends(get_db_session),
):
    return {
        "items": [
            record(e)
            for e in (
                await db.scalars(
                    select(Event)
                    .where(Event.object_id == object_id)
                    .order_by(Event.created_at.desc())
                    .limit(100)
                )
            ).all()
        ]
    }


@router.get("/export", response_class=PlainTextResponse)
async def export(
    _: AuthContext = Depends(read), db: AsyncSession = Depends(get_db_session)
):
    lines = ["# SaveMyContext", "", "## Tasks", ""]
    for task in (
        await db.scalars(
            select(Task).where(Task.status != "archived").order_by(Task.id)
        )
    ).all():
        lines.append(
            f"- [{'x' if task.status == 'done' else ' '}] {task.title}"
            + (f" (due {task.due_on})" if task.due_on else "")
        )
    lines.extend(["", "## Memory", ""])
    for memory in (
        await db.scalars(select(Memory).where(Memory.status == "accepted"))
    ).all():
        lines.extend(
            [
                f"### {memory.title}",
                memory.body,
                f"Source: {memory.source_id} · revision {memory.source_revision}",
                "",
            ]
        )
    return "\n".join(lines)
