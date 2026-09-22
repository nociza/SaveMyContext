from __future__ import annotations

import asyncio
import logging
import time
from uuid import uuid4

from sqlalchemy import select, update

from app.core.config import get_settings
from app.models import ChatSession
from app.models.base import utcnow
from app.services.files import atomic_write_text
from app.workspace.models import Job, Memory, Revision, Source, SourceSummary
from app.workspace.processor import extract
from app.workspace.quality import assess
from app.workspace.store import digest, index_document

logger = logging.getLogger(__name__)
LEASE_SECONDS = 600
MAX_ATTEMPTS = 5


async def run_one(sessions, *, extractor=extract) -> bool:
    lease = str(uuid4())
    async with sessions() as db:
        job = await db.scalar(
            select(Job)
            .where(
                Job.state.in_(["pending", "running"]), Job.available_at <= time.time()
            )
            .order_by(Job.created_at)
            .limit(1)
        )
        if job is None:
            return False
        if job.attempts >= MAX_ATTEMPTS:
            job.state, job.lease, job.error = "failed", None, "LeaseExpired"
            await db.commit()
            return True
        claim = await db.execute(
            update(Job)
            .where(
                Job.id == job.id,
                Job.state.in_(["pending", "running"]),
                Job.available_at <= time.time(),
            )
            .values(
                state="running",
                lease=lease,
                attempts=Job.attempts + 1,
                available_at=time.time() + LEASE_SECONDS,
            )
        )
        if claim.rowcount != 1:
            await db.rollback()
            return True
        await db.refresh(job)
        identity, source_id, revision, attempts = (
            job.id,
            job.source_id,
            job.revision,
            job.attempts,
        )
        source = await db.get(Source, source_id)
        snapshot = await db.scalar(
            select(Revision).where(
                Revision.source_id == source_id, Revision.digest == revision
            )
        )
        if (
            source is None
            or source.archived
            or source.revision != revision
            or snapshot is None
        ):
            job.state = "superseded"
            job.lease = None
            await db.commit()
            return True
        body, messages, title, kind = (
            snapshot.body,
            snapshot.messages,
            source.title,
            source.kind,
        )
        await db.commit()

    try:
        # Bound inference to the lease lifetime. No DB transaction held across network I/O.
        quality = assess(messages) if kind == "conversation" else None
        if quality and quality["status"] == "needs_repair":
            items, provenance = [], {"model": "quality-gate", "quality": quality}
        else:
            from app.workspace.summarizer import Cache

            extra = {"cache": Cache(sessions)} if extractor is extract else {}
            items, provenance = await asyncio.wait_for(
                extractor(
                    body, messages, source_kind=kind, source_title=title, **extra
                ),
                timeout=LEASE_SECONDS - 30,
            )
        async with sessions() as db:
            current = await db.get(Source, source_id)
            job = await db.get(Job, identity)
            if job.lease != lease:
                return True
            if current is None or current.archived or current.revision != revision:
                job.state, job.lease = "superseded", None
                await db.commit()
                return True
            claim = await db.execute(
                update(Source)
                .where(
                    Source.id == source_id,
                    Source.revision == revision,
                    Source.archived.is_(False),
                )
                .values(updated_at=Source.updated_at)
            )
            if claim.rowcount != 1:
                job.state, job.lease = "superseded", None
                await db.commit()
                return True
            provenance = dict(provenance)
            summary = provenance.pop("summary", None)
            if summary is not None:
                summary_processor = provenance.get("processor", job.processor)
                summary_id = digest([source_id, revision, summary_processor])
                saved_summary = await db.get(SourceSummary, summary_id)
                if saved_summary:
                    saved_summary.payload = summary
                else:
                    db.add(
                        SourceSummary(
                            id=summary_id,
                            source_id=source_id,
                            revision=revision,
                            processor=summary_processor,
                            payload=summary,
                        )
                    )
            rejected_items = 0
            for item in items:
                if (
                    item["kind"] not in {"task", "note", "idea", "decision"}
                    or item["evidence"] not in body
                ):
                    rejected_items += 1
                    continue
                memory_id = digest([source_id, item["kind"], item["evidence"]])
                memory = await db.get(Memory, memory_id)
                if memory is not None and (
                    memory.status in {"accepted", "rejected"}
                    or memory.provenance.get("user_edited")
                    or memory.provenance.get("retired")
                ):
                    continue
                values = dict(
                    source_id=source_id,
                    source_revision=revision,
                    kind=item["kind"],
                    title=item["title"],
                    body=item["body"],
                    evidence=item["evidence"],
                    provenance={**provenance, "confidence": item.get("confidence")},
                    status="suggested",
                )
                if memory is None:
                    memory = Memory(
                        id=memory_id, project_id=current.project_id, **values
                    )
                    db.add(memory)
                else:
                    for key, value in values.items():
                        setattr(memory, key, value)
                    memory.version += 1
                await index_document(
                    db, f"memory:{memory_id}", memory.title, memory.body
                )
            # Export only the affected source, and keep each revision immutable.
            root = get_settings().resolved_vault_root / "Sources"
            target = root / f"{digest(source_id)[:24]}-{revision[:16]}.md"
            target.parent.mkdir(parents=True, exist_ok=True)
            await asyncio.to_thread(
                atomic_write_text,
                target,
                f"# {title}\n\nSource: {source_id}\nRevision: {revision}\n\n{body}\n",
            )
            if source_id.startswith("session:"):
                session = await db.get(ChatSession, source_id.removeprefix("session:"))
                if session:
                    session.processing_pending = False
                    session.projection_pending = False
                    session.markdown_path = str(target)
                    session.last_processed_at = utcnow()
            job.state, job.error, job.lease = "done", None, None
            if rejected_items:
                job.error = f"RejectedEvidence:{rejected_items}"
            await db.commit()
    except Exception as exc:
        # No provider response, source text, credential, or exception message in logs.
        logger.warning("Workspace processing failed: %s", type(exc).__name__)
        async with sessions() as db:
            job = await db.get(Job, identity)
            if job and job.lease == lease:
                job.state = "failed" if attempts >= MAX_ATTEMPTS else "pending"
                job.error = type(exc).__name__
                job.available_at = time.time() + min(3600, 10 * 2**attempts)
                job.lease = None
                await db.commit()
    return True


async def run_worker(sessions, stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            worked = await run_one(sessions)
        except Exception as exc:
            logger.warning("Workspace queue unavailable: %s", type(exc).__name__)
            worked = False
        if not worked:
            try:
                await asyncio.wait_for(stop.wait(), timeout=2)
            except TimeoutError:
                pass
