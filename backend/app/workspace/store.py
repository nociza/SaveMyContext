from __future__ import annotations

import hashlib
import json
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.base import utcnow
from app.workspace.models import (
    Command,
    Event,
    Job,
    Memory,
    Preference,
    Project,
    Revision,
    Source,
    Task,
)
from app.workspace.schemas import SettingsInput, TaskInput


class Conflict(ValueError):
    pass


def digest(value) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def record(value) -> dict:
    return {
        column.key: (item.isoformat() if isinstance(item, datetime) else item)
        for column in value.__table__.columns
        for item in [getattr(value, column.key)]
    }


async def enqueue_source(
    db: AsyncSession,
    *,
    source_id: str,
    title: str,
    body: str,
    kind: str,
    provider: str,
    url: str | None = None,
    messages: list | None = None,
    archived: bool = False,
) -> Source:
    """Called inside the capture transaction; never calls a provider or commits."""
    revision = digest({"body": body, "messages": messages or []})
    source = await db.get(Source, source_id)
    if source is None:
        source = Source(
            id=source_id,
            title=title,
            body=body,
            kind=kind,
            provider=provider,
            url=url,
            revision=revision,
            archived=archived,
        )
        db.add(source)
        await db.flush()
    else:
        source.title, source.url = title, url
        source.body, source.revision = body, revision
        # A user's archive decision cannot be undone by a later capture.
        source.archived = source.archived or archived
    previous = await db.scalar(
        select(Revision).where(
            Revision.source_id == source_id, Revision.digest == revision
        )
    )
    if previous is None:
        db.add(
            Revision(
                source_id=source_id, digest=revision, body=body, messages=messages or []
            )
        )
        db.add(Job(source_id=source_id, revision=revision))
        for memory in (
            await db.scalars(
                select(Memory).where(
                    Memory.source_id == source_id,
                    Memory.status == "suggested",
                    Memory.source_revision != revision,
                )
            )
        ).all():
            if not memory.provenance.get("user_edited"):
                memory.status = "superseded"
                memory.version += 1
    await db.flush()
    await index_document(db, f"source:{source_id}", title, body)
    await ensure_source_chunks(db, source)
    return source


async def ensure_source_chunks(db, source):
    from sqlalchemy import delete
    from app.workspace.models import SourceIndexChunk

    await db.execute(
        delete(SourceIndexChunk).where(
            SourceIndexChunk.source_id == source.id,
            SourceIndexChunk.revision != source.revision,
        )
    )
    if len(source.body) > 48_000:
        existing = set(
            (
                await db.scalars(
                    select(SourceIndexChunk.id).where(
                        SourceIndexChunk.source_id == source.id
                    )
                )
            ).all()
        )
        for start in range(0, len(source.body), 12000):
            identity = digest([source.id, source.revision, start])
            if identity not in existing:
                db.add(
                    SourceIndexChunk(
                        id=identity,
                        source_id=source.id,
                        revision=source.revision,
                        start=start,
                        end=min(start + 12000, len(source.body)),
                    )
                )


async def enqueue_session(db, session) -> Source:
    messages = [
        {
            "id": m.external_message_id,
            "role": m.role.value,
            "content": m.content,
            "occurred_at": m.occurred_at.isoformat() if m.occurred_at else None,
        }
        for m in session.messages
    ]
    return await enqueue_source(
        db,
        source_id=f"session:{session.id}",
        kind="conversation",
        provider=session.provider.value,
        title=session.title or "Untitled conversation",
        url=session.source_url,
        body="\n\n".join(f"{m['role'].upper()}: {m['content']}" for m in messages),
        messages=messages,
        archived=session.is_discarded,
    )


async def enqueue_capture(db, capture) -> Source:
    return await enqueue_source(
        db,
        source_id=f"capture:{capture.id}",
        kind=capture.capture_kind,
        provider="browser",
        title=capture.title or "Saved source",
        url=capture.source_url,
        body=capture.source_text,
        archived=capture.is_discarded,
    )


async def index_document(db, key: str, title: str, body: str) -> None:
    if db.bind.dialect.name != "sqlite":
        return
    from sqlalchemy import text

    await db.execute(text("DELETE FROM workspace_fts WHERE key = :key"), {"key": key})
    await db.execute(
        text("INSERT INTO workspace_fts(key,title,body) VALUES (:key,:title,:body)"),
        {"key": key, "title": title, "body": body},
    )


async def project_exists(db, project_id) -> None:
    if project_id and await db.get(Project, project_id) is None:
        raise ValueError("Project not found")


async def audit(db, object_id, action, actor, payload) -> None:
    db.add(Event(object_id=object_id, action=action, actor=actor, payload=payload))


async def create_task(
    db,
    payload: TaskInput,
    *,
    actor: str,
    key: str | None = None,
    memory_id: str | None = None,
) -> dict:
    values = payload.model_dump()
    fingerprint = digest({"task": values, "memory": memory_id})
    if key:
        command = await db.get(Command, key)
        if command:
            if command.digest != fingerprint:
                raise Conflict("Idempotency key already used for a different task")
            return command.result
    await project_exists(db, payload.project_id)
    task = Task(
        **values,
        memory_id=memory_id,
        completed_at=utcnow().isoformat() if payload.status == "done" else None,
    )
    db.add(task)
    await db.flush()
    result = record(task)
    await audit(db, f"task:{task.id}", "created", actor, result)
    await index_document(db, f"task:{task.id}", task.title, task.notes or "")
    if key:
        db.add(Command(key=key, digest=fingerprint, result=result))
    return result


async def update_task(db, task_id: int, changes: dict, *, actor: str) -> dict:
    task = await db.get(Task, task_id)
    if task is None:
        raise LookupError("Task not found")
    expected = changes.pop("expected_version", None)
    if expected is not None and task.version != expected:
        raise Conflict("This task changed. Refresh before saving.")
    before = record(task)
    values = {name: getattr(task, name) for name in TaskInput.model_fields}
    values.update(changes)
    validated = TaskInput(**values)
    await project_exists(db, validated.project_id)
    values = validated.model_dump()
    if (
        task.remind_at
        and validated.remind_at
        and datetime.fromisoformat(task.remind_at.replace("Z", "+00:00"))
        == datetime.fromisoformat(validated.remind_at)
    ):
        values["remind_at"] = task.remind_at  # Preserve notification delivery identity.
    values["completed_at"] = (
        (task.completed_at or utcnow().isoformat())
        if validated.status == "done"
        else None
    )
    values["version"] = task.version + 1
    changed = await db.execute(
        update(Task)
        .where(Task.id == task_id, Task.version == task.version)
        .values(**values)
    )
    if changed.rowcount != 1:
        raise Conflict("This task changed. Refresh before saving.")
    await db.refresh(task)
    await audit(
        db,
        f"task:{task_id}",
        "updated",
        actor,
        {"before": before, "after": record(task)},
    )
    await index_document(db, f"task:{task.id}", task.title, task.notes or "")
    return record(task)


async def get_settings(db) -> dict:
    preference = await db.get(Preference, "notifications")
    return SettingsInput(**(preference.value if preference else {})).model_dump()


async def set_settings(db, changes: dict, *, actor: str) -> dict:
    old = await get_settings(db)
    values = SettingsInput(**{**old, **changes}).model_dump()
    preference = await db.get(Preference, "notifications")
    if preference:
        preference.value = values
    else:
        db.add(Preference(key="notifications", value=values))
    await audit(db, "settings", "updated", actor, {"before": old, "after": values})
    return values


async def task_dashboard(db) -> dict:
    settings = await get_settings(db)
    today = datetime.now(ZoneInfo(settings["timezone"])).date().isoformat()
    tasks = list(
        (
            await db.scalars(
                select(Task).where(Task.status == "open").order_by(Task.id.desc())
            )
        ).all()
    )
    completed = list(
        (
            await db.scalars(
                select(Task)
                .where(Task.status == "done")
                .order_by(Task.updated_at.desc())
                .limit(50)
            )
        ).all()
    )
    return {
        "as_of": utcnow().isoformat(),
        "settings": settings,
        "summary": {
            "open": len(tasks),
            "due_today": sum(t.due_on == today for t in tasks),
            "overdue": sum(bool(t.due_on and t.due_on < today) for t in tasks),
            "completed": await db.scalar(
                select(func.count()).select_from(Task).where(Task.status == "done")
            ),
        },
        "tasks": [record(t) for t in tasks + completed],
    }


async def notifications(db, now: datetime | None = None) -> dict:
    settings = await get_settings(db)
    now = now or utcnow()
    if now.tzinfo is None:
        raise ValueError("now requires a timezone")
    result = {
        "enabled": settings["notifications_enabled"],
        "as_of": now.isoformat(),
        "events": [],
    }
    if not result["enabled"]:
        return result
    clock = now.astimezone(ZoneInfo(settings["timezone"]))
    today, time = clock.date().isoformat(), clock.strftime("%H:%M")
    tasks = list(
        (
            await db.scalars(
                select(Task).where(Task.status == "open").order_by(Task.id)
            )
        ).all()
    )
    if settings["due_reminders_enabled"]:
        for task in tasks:
            if not task.notify:
                continue
            kind, suffix = None, None
            if (
                task.remind_at
                and datetime.fromisoformat(task.remind_at.replace("Z", "+00:00")) <= now
            ):
                kind, suffix = "remind", task.remind_at
            elif (
                not task.remind_at
                and task.due_on
                and task.due_on <= today
                and time >= "09:00"
            ):
                kind, suffix = "due", task.due_on
            if kind:
                result["events"].append(
                    {
                        "event_key": f"task:{task.id}:{kind}:{suffix}",
                        "type": "reminder" if kind == "remind" else "due",
                        "title": task.title,
                        "detail": f"Due {task.due_on}"
                        if task.due_on
                        else "Reminder due",
                        "task": record(task),
                    }
                )
    if settings["daily_digest_enabled"] and time >= settings["digest_time"] and tasks:
        result["events"].append(
            {
                "event_key": f"digest:{today}",
                "type": "digest",
                "title": f"{len(tasks)} open tasks",
                "detail": "Your task digest",
                "tasks": [record(t) for t in tasks[:12]],
            }
        )
    result["events"] = result["events"][:50]
    return result


async def search(db, query: str, limit: int = 30) -> list[dict]:
    """Indexed local retrieval. Model configuration never changes this boundary."""
    from sqlalchemy import text

    words = query.split()[:16]
    if not words:
        return []
    if db.bind.dialect.name == "sqlite":
        expression = " AND ".join('"' + word.replace('"', '""') + '"' for word in words)
        keys = list(
            (
                await db.execute(
                    text(
                        "SELECT key FROM workspace_fts WHERE workspace_fts MATCH :q ORDER BY rank LIMIT :n"
                    ),
                    {"q": expression, "n": limit * 3},
                )
            ).scalars()
        )
        found = []
        for key in keys:
            kind, identity = key.split(":", 1)
            model = {"source": Source, "memory": Memory, "task": Task}.get(kind)
            item = (
                await db.get(model, int(identity) if kind == "task" else identity)
                if model
                else None
            )
            if item is None or (isinstance(item, Source) and item.archived):
                continue
            if isinstance(item, Memory) and item.status in {"rejected", "superseded"}:
                continue
            found.append({**record(item), "record_type": kind})
            if len(found) >= limit:
                break
        return found
    # PostgreSQL remains compatible; a corpus-scale PG deployment should add tsvector indexes.
    found = []
    for kind, model, body in [
        ("source", Source, Source.body),
        ("memory", Memory, Memory.body),
        ("task", Task, Task.notes),
    ]:
        statement = select(model).where(
            or_(model.title.ilike(f"%{query}%"), body.ilike(f"%{query}%"))
        )
        if model is Source:
            statement = statement.where(Source.archived.is_(False))
        if model is Memory:
            statement = statement.where(
                Memory.status.notin_(["rejected", "superseded"])
            )
        found.extend(
            {**record(item), "record_type": kind}
            for item in (await db.scalars(statement.limit(limit))).all()
        )
    return found[:limit]
