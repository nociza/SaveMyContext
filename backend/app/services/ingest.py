from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import logging
from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import lazyload, selectinload

from app.models import ChatMessage, ChatSession, SyncEvent
from app.models.base import utcnow
from app.models.sync_event import raw_capture_hash
from app.schemas.ingest import IngestDiffRequest
from app.services.accounts import normalize_account_key, normalize_account_label
from app.services.markdown import MarkdownExporter
from app.services.locks import KeyedAsyncLockPool
from app.services.piles import CATEGORY_TO_BUILT_IN_SLUG
from app.services.processing import ManualPileAssignmentConflictError, SessionProcessor
from app.services.processing_worker import uses_extension_browser_processing
from app.core.config import get_settings


logger = logging.getLogger(__name__)
_INGEST_LOCKS = KeyedAsyncLockPool()


class IngestPhaseTwoError(RuntimeError):
    """The source is durable, but enrichment or projection must be retried."""

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        super().__init__(
            "The source capture was preserved, but enrichment or projection failed. Retry the same capture."
        )


class ProjectionSourceChangedError(RuntimeError):
    """A newer source revision superseded work produced by this request."""


class CaptureQuarantined(RuntimeError):
    def __init__(self, receipt_id: str, quality: dict) -> None:
        self.receipt_id, self.quality = receipt_id, quality
        super().__init__("Capture preserved for review; transcript unchanged.")


class IngestService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.exporter = MarkdownExporter(db)
        self.processor = SessionProcessor(db)

    async def ingest(self, payload: IngestDiffRequest) -> tuple[ChatSession, int]:
        # SQLite ignores SELECT FOR UPDATE, while PostgreSQL cannot lock a row
        # before its first insert. Serialize same-session work inside a server
        # process; database constraints/row locks remain the cross-process
        # authority for PostgreSQL deployments.
        key = f"{payload.provider.value}\0{payload.external_session_id}"
        async with _INGEST_LOCKS.lock(key):
            return await self._ingest_locked(payload)

    async def _ingest_locked(self, payload: IngestDiffRequest) -> tuple[ChatSession, int]:
        if get_settings().workspace_enabled:
            from app.workspace.models import CaptureQuarantine
            from app.workspace.quality import payload_quality
            from app.workspace.store import digest

            quality = payload_quality(payload)
            if quality["status"] == "needs_repair":
                evidence = payload.model_dump(mode="json")
                receipt_id = digest(evidence)
                if await self.db.get(CaptureQuarantine, receipt_id) is None:
                    self.db.add(CaptureQuarantine(
                        id=receipt_id, provider=payload.provider.value,
                        external_session_id=payload.external_session_id,
                        payload=evidence, quality=quality,
                    ))
                    try:
                        await self.db.commit()
                    except IntegrityError:
                        await self.db.rollback()
                        if await self.db.get(CaptureQuarantine, receipt_id) is None:
                            raise
                raise CaptureQuarantined(receipt_id, quality)
        session, created = await self._get_or_create_session(payload)
        if not created and self._is_stale_full_snapshot(session, payload):
            session_id = session.id
            raw_capture_added = await self._record_sync_event(
                session_id=session_id,
                message_count=0,
                raw_capture=payload.raw_capture,
                messages_changed=False,
            )
            if raw_capture_added:
                session.projection_pending = True
            await self.db.flush()
            if raw_capture_added:
                await self._force_pending_flags(session.id, projection=True)
            # Source evidence is the durable boundary. A projection failure
            # after this point must never erase an accepted capture.
            await self.db.commit()
            if get_settings().workspace_enabled:
                return await self._load_session(session_id), 0
            if session.projection_pending:
                try:
                    session = await self._load_session_for_projection(session_id)
                    markdown_path = await self.exporter.write_session(session)
                    session.markdown_path = str(markdown_path)
                    session.projection_pending = False
                    await self.db.commit()
                except Exception:  # noqa: BLE001 - capture already committed; projection is best effort
                    await self.db.rollback()
                    logger.exception(
                        "Projection failed after preserving stale raw capture for session %s.",
                        session_id,
                    )
                    raise IngestPhaseTwoError(session_id) from None
            return await self._load_session(session_id), 0

        metadata_changed = self._update_session_metadata(
            session,
            payload,
            replace_existing=created or self._payload_is_newer(session, payload),
        )
        # Legacy clients never established completeness. Workspace mode must
        # treat those captures as append/update-only, even during history sync.
        complete = payload.capture_completeness == "complete" or (
            not get_settings().workspace_enabled and payload.capture_completeness == "unknown"
        )
        if payload.sync_mode == "full_snapshot" and complete:
            delete_missing = created or self._full_snapshot_is_newer(session, payload)
            new_message_count, messages_changed = await self._ingest_full_snapshot(
                session.id,
                payload,
                delete_missing=delete_missing,
            )
        else:
            new_message_count, messages_changed = await self._ingest_incremental(
                session.id, payload, allow_updates=not created and self._full_snapshot_is_newer(session, payload)
            )

        if payload.captured_at is not None:
            # This column began as a full-snapshot watermark. Keep the stored
            # name for schema compatibility, but advance it across every
            # timestamped ingest so delayed full snapshots cannot overwrite a
            # newer incremental capture.
            session.last_snapshot_at = self._latest_available_datetime(
                session.last_snapshot_at,
                session.last_captured_at,
                payload.captured_at,
            )

        if messages_changed:
            session.last_captured_at = self._latest_datetime(
                session.last_captured_at,
                payload.captured_at or utcnow(),
            )

        raw_capture_added = await self._record_sync_event(
            session_id=session.id,
            message_count=new_message_count,
            raw_capture=payload.raw_capture,
            messages_changed=messages_changed,
        )
        if messages_changed:
            session.processing_pending = True
        reason = (
            f"Auto-discarded by trigger word '{payload.discard_word_match}'."
            if payload.discard_word_match
            else session.discarded_reason or "Auto-discarded by client."
        )
        discard_state_changed = payload.route_to_discard and (
            session.processing_pending
            or not session.is_discarded
            or session.discarded_reason != reason
        )
        projection_changed = (
            created or metadata_changed or messages_changed or raw_capture_added or discard_state_changed
        )
        if projection_changed:
            session.projection_pending = True

        await self.db.flush()
        if messages_changed or projection_changed:
            # SQLite can read while another local transaction holds its write
            # lock. If the stale ORM value was already true, assigning true
            # again emits no UPDATE and an older processor could clear it
            # before this transaction writes. Force the canonical flags after
            # source rows flush so the waiting capture always wins. PostgreSQL
            # also benefits from the explicit invariant at this boundary.
            await self._force_pending_flags(
                session.id,
                processing=messages_changed,
                projection=projection_changed,
            )
        if get_settings().workspace_enabled:
            from app.workspace.store import enqueue_session
            session_id = session.id
            if payload.route_to_discard:
                session.is_discarded = True
                session.discarded_reason = reason
            session = await self._load_session(session_id)
            source = await enqueue_session(self.db, session)
            from app.workspace.provider_projects import apply_provider_project
            await apply_provider_project(self.db, source, payload, session.account_key or "chatgpt:default")
            await self.db.commit()
            return session, new_message_count

        # Commit canonical source state before invoking any provider, file,
        # projection, or Git work. The future durable-outbox pipeline should
        # replace this synchronous second phase, but capture is already safe.
        await self.db.commit()
        # Re-read under a row lock after the source commit. This is the
        # cross-process serialization boundary for synchronous phase two:
        # a competing worker waits, refreshes the winner's state, and skips
        # already-completed AI/projection work instead of replaying it.
        session = await self._load_session_for_projection(session.id)
        session_id = session.id
        source_revision = self.projection_source_revision(session)
        self.processor.base_dir = self.exporter.base_dir
        processing_needed = session.processing_pending
        keep_discarded = session.is_discarded and not session.pile_assignment_locked
        should_route_to_discard = (
            session.pile_assignment_locked
            and session.is_discarded
            and processing_needed
        ) or (
            not session.pile_assignment_locked
            and (
                (
                    payload.route_to_discard
                    and (
                        processing_needed
                        or not session.is_discarded
                        or session.discarded_reason != reason
                    )
                )
                or (keep_discarded and processing_needed)
            )
        )
        processing_attempted = False

        try:
            if should_route_to_discard:
                processing_attempted = True
                session = await self.processor.route_to_discard(
                    session.id,
                    reason=reason,
                    manual_assignment=session.pile_assignment_locked,
                )
            elif processing_needed and session.pile_assignment_locked:
                # A user's pile choice is durable. Immediate processing may
                # refresh that exact pipeline, but the experimental browser
                # worker cannot yet execute user-defined pile contracts, so it
                # leaves the prior projection visibly stale instead of silently
                # reclassifying it.
                if not uses_extension_browser_processing():
                    pile_slug = (
                        session.pile.slug
                        if session.pile is not None
                        else CATEGORY_TO_BUILT_IN_SLUG.get(session.built_in_pile)
                    )
                    if pile_slug:
                        processing_attempted = True
                        session = await self.processor.reassign_to_pile(session.id, pile_slug)
                else:
                    # Keep the chosen pile and its last successful projection,
                    # but make staleness explicit until browser workers gain an
                    # exact user-defined-pile execution contract.
                    session.processing_pending = True
            elif processing_needed:
                processing_attempted = True
                if uses_extension_browser_processing():
                    session = await self.processor.mark_pending(session.id)
                else:
                    session = await self.processor.process(session.id)

            should_export = (
                session.projection_pending
                or should_route_to_discard
                or processing_attempted
            )
            if should_export:
                session = await self._load_session_for_projection(session.id)
                if (
                    processing_attempted
                    and self.projection_source_revision(session) != source_revision
                ):
                    raise ProjectionSourceChangedError(
                        "A newer source revision arrived while this capture was being processed."
                    )
                markdown_path = await self.exporter.write_session(session)
                session.markdown_path = str(markdown_path)
                session.projection_pending = False
            await self.db.commit()
        except ManualPileAssignmentConflictError:
            await self.db.rollback()
            logger.info(
                "Preserved a concurrent manual pile assignment for session %s instead of applying stale automatic output.",
                session_id,
            )
            return await self._load_session(session_id), new_message_count
        except ProjectionSourceChangedError:
            await self.db.rollback()
            logger.warning(
                "Discarded stale enrichment for session %s because a newer source revision won.",
                session_id,
            )
            raise IngestPhaseTwoError(session_id) from None
        except Exception:  # noqa: BLE001 - source commit must survive enrichment/projection failure
            await self.db.rollback()
            logger.exception(
                "Enrichment or projection failed after preserving source capture for session %s.",
                session_id,
            )
            # The canonical transaction already persisted the pending flags.
            # Rolling phase two back restores them; writing them again here
            # could race and reopen work another process just completed.
            raise IngestPhaseTwoError(session_id) from None
        return await self._load_session(session_id), new_message_count

    @classmethod
    def processing_is_current(cls, session: ChatSession) -> bool:
        return not session.processing_pending

    async def _ingest_incremental(
        self, session_id: str, payload: IngestDiffRequest, *, allow_updates: bool = False
    ) -> tuple[int, bool]:
        existing_messages = await self._existing_messages(session_id)
        next_index = await self._next_sequence_index(session_id)
        new_message_count = 0
        changed = False

        for message in payload.messages:
            existing = existing_messages.get(message.external_message_id)
            if existing is not None:
                if allow_updates:
                    for name in ("parent_external_message_id", "role", "content", "occurred_at", "raw_payload"):
                        value = getattr(message, name)
                        if getattr(existing, name) != value:
                            setattr(existing, name, value)
                            changed = True
                continue
            self.db.add(
                ChatMessage(
                    session_id=session_id,
                    external_message_id=message.external_message_id,
                    parent_external_message_id=message.parent_external_message_id,
                    role=message.role,
                    content=message.content,
                    sequence_index=next_index,
                    occurred_at=message.occurred_at,
                    raw_payload=message.raw_payload,
                )
            )
            next_index += 1
            new_message_count += 1

        return new_message_count, changed or new_message_count > 0

    async def _ingest_full_snapshot(
        self,
        session_id: str,
        payload: IngestDiffRequest,
        *,
        delete_missing: bool = True,
    ) -> tuple[int, bool]:
        existing_messages = await self._existing_messages(session_id)
        next_append_index = max(
            (message.sequence_index for message in existing_messages.values()),
            default=0,
        ) + 1
        new_message_count = 0
        changed = False

        for sequence_index, message in enumerate(payload.messages, start=1):
            existing = existing_messages.pop(message.external_message_id, None)
            if existing is not None:
                if not delete_missing:
                    # Without a strictly newer capture timestamp there is no
                    # safe basis for replacing existing content or ordering.
                    # Preserve the accepted source and only append unseen IDs.
                    continue
                target_sequence_index = sequence_index
                next_values = (
                    message.parent_external_message_id,
                    message.role,
                    message.content,
                    target_sequence_index,
                    message.occurred_at,
                    message.raw_payload,
                )
                current_values = (
                    existing.parent_external_message_id,
                    existing.role,
                    existing.content,
                    existing.sequence_index,
                    existing.occurred_at,
                    existing.raw_payload,
                )
                changed = changed or current_values != next_values
                existing.parent_external_message_id = message.parent_external_message_id
                existing.role = message.role
                existing.content = message.content
                existing.sequence_index = target_sequence_index
                existing.occurred_at = message.occurred_at
                existing.raw_payload = message.raw_payload
                continue

            target_sequence_index = sequence_index if delete_missing else next_append_index
            self.db.add(
                ChatMessage(
                    session_id=session_id,
                    external_message_id=message.external_message_id,
                    parent_external_message_id=message.parent_external_message_id,
                    role=message.role,
                    content=message.content,
                    sequence_index=target_sequence_index,
                    occurred_at=message.occurred_at,
                    raw_payload=message.raw_payload,
                )
            )
            if not delete_missing:
                next_append_index += 1
            new_message_count += 1
            changed = True

        if delete_missing and existing_messages:
            stale_ids = [message.id for message in existing_messages.values()]
            await self.db.execute(delete(ChatMessage).where(ChatMessage.id.in_(stale_ids)))
            changed = True

        return new_message_count, changed

    async def _get_or_create_session(self, payload: IngestDiffRequest) -> tuple[ChatSession, bool]:
        statement = select(ChatSession).where(
            ChatSession.provider == payload.provider,
            ChatSession.external_session_id == payload.external_session_id,
        ).options(lazyload(ChatSession.pile)).with_for_update(of=ChatSession)
        result = await self.db.execute(statement)
        session = result.scalar_one_or_none()
        if session is None:
            account_key = normalize_account_key(payload.provider, payload.account_key, payload.external_session_id)
            session = ChatSession(
                provider=payload.provider,
                external_session_id=payload.external_session_id,
                account_key=account_key,
                account_label=normalize_account_label(payload.provider, account_key, payload.account_label),
                title=payload.title,
                source_url=payload.source_url,
                custom_tags=sorted(set(payload.custom_tags)),
                last_captured_at=payload.captured_at or utcnow(),
            )
            self.db.add(session)
            try:
                await self.db.flush()
                return session, True
            except IntegrityError:
                # SELECT FOR UPDATE cannot lock a row that does not exist. If
                # two first captures race, the unique session identity chooses
                # the winner; the loser rolls back and continues by merging its
                # payload into that canonical row instead of returning 500.
                await self.db.rollback()
                winner_result = await self.db.execute(
                    select(ChatSession)
                    .where(
                        ChatSession.provider == payload.provider,
                        ChatSession.external_session_id == payload.external_session_id,
                    )
                    .options(lazyload(ChatSession.pile))
                    .with_for_update(of=ChatSession)
                )
                winner = winner_result.scalar_one_or_none()
                if winner is None:
                    raise
                return winner, False

        return session, False

    def _update_session_metadata(
        self,
        session: ChatSession,
        payload: IngestDiffRequest,
        *,
        replace_existing: bool,
    ) -> bool:
        account_key = normalize_account_key(
            payload.provider,
            payload.account_key or session.account_key,
            payload.external_session_id,
        )
        account_label = normalize_account_label(
            payload.provider,
            account_key,
            payload.account_label or session.account_label,
        )
        changed = False
        if replace_existing or not session.account_key:
            changed = changed or session.account_key != account_key
            session.account_key = account_key
        if replace_existing or not session.account_label:
            changed = changed or session.account_label != account_label
            session.account_label = account_label
        if payload.title and (replace_existing or not session.title):
            changed = changed or session.title != payload.title
            session.title = payload.title
        if payload.source_url and (replace_existing or not session.source_url):
            changed = changed or session.source_url != payload.source_url
            session.source_url = payload.source_url
        if payload.custom_tags:
            custom_tags = sorted(set([*session.custom_tags, *payload.custom_tags]))
            changed = changed or session.custom_tags != custom_tags
            session.custom_tags = custom_tags
        return changed

    async def _record_sync_event(
        self,
        *,
        session_id: str,
        message_count: int,
        raw_capture: dict[str, Any] | list[Any] | None,
        messages_changed: bool,
    ) -> bool:
        capture_hash = raw_capture_hash(raw_capture)
        if capture_hash is None:
            if not messages_changed:
                return False
            self.db.add(
                SyncEvent(
                    session_id=session_id,
                    message_count=message_count,
                    raw_capture=None,
                    capture_hash=None,
                )
            )
            return True

        existing_id = await self.db.scalar(
            select(SyncEvent.id).where(
                SyncEvent.session_id == session_id,
                SyncEvent.capture_hash == capture_hash,
            )
        )
        if existing_id is not None:
            return False

        try:
            async with self.db.begin_nested():
                event = SyncEvent(
                    session_id=session_id,
                    message_count=message_count,
                    raw_capture=raw_capture,
                    capture_hash=capture_hash,
                )
                self.db.add(event)
                await self.db.flush([event])
        except IntegrityError:
            # A concurrent replay may win the per-session hash race. The
            # unique index is the portable final authority for deduplication.
            return False
        return True

    @classmethod
    def _is_stale_full_snapshot(cls, session: ChatSession, payload: IngestDiffRequest) -> bool:
        if payload.sync_mode != "full_snapshot" or payload.captured_at is None:
            return False
        watermark = cls._latest_available_datetime(
            session.last_snapshot_at,
            session.last_captured_at,
        )
        if watermark is None:
            return False
        return cls._aware_utc(payload.captured_at) < cls._aware_utc(watermark)

    @classmethod
    def _full_snapshot_is_newer(cls, session: ChatSession, payload: IngestDiffRequest) -> bool:
        if payload.captured_at is None:
            return False
        watermark = cls._latest_available_datetime(
            session.last_snapshot_at,
            session.last_captured_at,
        )
        if watermark is None:
            return True
        return cls._aware_utc(payload.captured_at) > cls._aware_utc(watermark)

    @classmethod
    def _payload_is_newer(cls, session: ChatSession, payload: IngestDiffRequest) -> bool:
        return cls._full_snapshot_is_newer(session, payload)

    @classmethod
    def projection_source_revision(cls, session: ChatSession) -> str:
        """Hash every source field used by the Markdown projection.

        Derived pile output is intentionally excluded. A row lock plus this
        revision prevents slower work from overwriting a newer capture.
        """

        messages = [
            {
                "external_message_id": message.external_message_id,
                "parent_external_message_id": message.parent_external_message_id,
                "role": message.role.value,
                "content": message.content,
                "sequence_index": message.sequence_index,
                "occurred_at": cls._datetime_for_revision(message.occurred_at),
                "raw_payload": message.raw_payload,
            }
            for message in sorted(
                session.messages,
                key=lambda item: (item.sequence_index, item.external_message_id),
            )
        ]
        sync_events = [
            {
                "id": event.id,
                "message_count": event.message_count,
                "capture_hash": event.capture_hash,
                "raw_capture": event.raw_capture,
                "created_at": cls._datetime_for_revision(event.created_at),
            }
            for event in sorted(
                session.sync_events,
                key=lambda item: (
                    cls._datetime_for_revision(item.created_at) or "",
                    item.id,
                ),
            )
        ]
        canonical = json.dumps(
            {
                "provider": session.provider.value,
                "external_session_id": session.external_session_id,
                "account_key": session.account_key,
                "account_label": session.account_label,
                "title": session.title,
                "source_url": session.source_url,
                "custom_tags": sorted(session.custom_tags),
                "last_captured_at": cls._datetime_for_revision(session.last_captured_at),
                "last_snapshot_at": cls._datetime_for_revision(session.last_snapshot_at),
                "messages": messages,
                "sync_events": sync_events,
            },
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    @classmethod
    def _latest_available_datetime(cls, *values: datetime | None) -> datetime | None:
        available = [value for value in values if value is not None]
        if not available:
            return None
        return max(available, key=cls._aware_utc)

    @classmethod
    def _latest_datetime(cls, left: datetime | None, right: datetime) -> datetime:
        if left is None:
            return right
        return right if cls._aware_utc(right) > cls._aware_utc(left) else left

    @classmethod
    def _datetime_for_revision(cls, value: datetime | None) -> str | None:
        return cls._aware_utc(value).isoformat() if value is not None else None

    @staticmethod
    def _aware_utc(value: datetime) -> datetime:
        if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    async def _existing_message_ids(self, session_id: str) -> set[str]:
        statement = select(ChatMessage.external_message_id).where(ChatMessage.session_id == session_id)
        result = await self.db.execute(statement)
        return set(result.scalars().all())

    async def _existing_messages(self, session_id: str) -> dict[str, ChatMessage]:
        statement = select(ChatMessage).where(ChatMessage.session_id == session_id)
        result = await self.db.execute(statement)
        return {
            message.external_message_id: message
            for message in result.scalars().all()
        }

    async def _next_sequence_index(self, session_id: str) -> int:
        statement = select(func.max(ChatMessage.sequence_index)).where(ChatMessage.session_id == session_id)
        result = await self.db.execute(statement)
        maximum = result.scalar_one_or_none()
        return (maximum or 0) + 1

    async def _load_session(self, session_id: str) -> ChatSession:
        statement = (
            select(ChatSession)
            .options(
                selectinload(ChatSession.messages),
                selectinload(ChatSession.triplets),
                selectinload(ChatSession.sync_events),
                selectinload(ChatSession.pile),
            )
            .where(ChatSession.id == session_id)
            .execution_options(populate_existing=True)
        )
        result = await self.db.execute(statement)
        return result.scalar_one()

    async def _force_pending_flags(
        self,
        session_id: str,
        *,
        processing: bool = False,
        projection: bool = False,
    ) -> None:
        values: dict[str, bool] = {}
        if processing:
            values["processing_pending"] = True
        if projection:
            values["projection_pending"] = True
        if not values:
            return
        await self.db.execute(
            update(ChatSession)
            .where(ChatSession.id == session_id)
            .values(**values)
            .execution_options(synchronize_session=False)
        )

    async def _load_session_for_projection(self, session_id: str) -> ChatSession:
        statement = (
            select(ChatSession)
            .options(
                selectinload(ChatSession.messages),
                selectinload(ChatSession.triplets),
                selectinload(ChatSession.sync_events),
                selectinload(ChatSession.pile),
            )
            .where(ChatSession.id == session_id)
            .with_for_update(of=ChatSession)
            .execution_options(populate_existing=True)
        )
        result = await self.db.execute(statement)
        return result.scalar_one()

    @staticmethod
    def _message_sort_key(message: object) -> tuple[int, str]:
        occurred_at = getattr(message, "occurred_at", None)
        return (1 if occurred_at is None else 0, occurred_at.isoformat() if occurred_at else "")
