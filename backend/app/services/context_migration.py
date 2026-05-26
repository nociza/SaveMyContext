from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import ChatMessage, ChatSession, SyncEvent
from app.models.base import utcnow
from app.schemas.context import (
    CONTEXT_BUNDLE_SCHEMA_VERSION,
    ContextArtifact,
    ContextMigrationBundle,
    ContextMigrationImportRequest,
    ContextMigrationMessage,
    ContextSyncEventRead,
)
from app.schemas.ingest import IngestDiffRequest, IngestMessage
from app.schemas.session import TripletRead
from app.services.accounts import session_account_key, session_account_label
from app.services.extra_piles import visible_custom_tags
from app.services.ingest import IngestService
from app.services.piles import pile_slug_for_category


class ContextMigrationService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def import_context(self, payload: ContextMigrationImportRequest) -> tuple[ChatSession, int]:
        ingest_payload = IngestDiffRequest(
            provider=payload.provider,
            external_session_id=payload.external_session_id,
            account_key=payload.account_key,
            account_label=payload.account_label,
            sync_mode="full_snapshot",
            title=payload.title,
            source_url=payload.source_url,
            captured_at=payload.captured_at,
            custom_tags=self._custom_tags(payload),
            messages=[self._to_ingest_message(message) for message in payload.messages],
            raw_capture=self._raw_capture(payload),
            route_to_discard=payload.route_to_discard,
            discard_word_match=payload.discard_word_match,
        )
        return await IngestService(self.db).ingest(ingest_payload)

    async def export_session(self, session_id: str) -> ContextMigrationBundle | None:
        session = await self._load_session(session_id)
        if session is None:
            return None
        return self.build_bundle(session)

    def build_bundle(self, session: ChatSession) -> ContextMigrationBundle:
        source_interface = self._source_interface(session)
        artifacts = self._artifacts(session)
        messages = [self._from_chat_message(message) for message in session.messages]
        sync_events = [
            ContextSyncEventRead(
                id=event.id,
                created_at=event.created_at,
                message_count=event.message_count,
                raw_capture=event.raw_capture,
            )
            for event in sorted(session.sync_events, key=lambda event: event.created_at)
        ]
        bundle = ContextMigrationBundle(
            session_id=session.id,
            provider=session.provider,
            source_interface=source_interface,
            external_session_id=session.external_session_id,
            account_key=session_account_key(session),
            account_label=session_account_label(session),
            title=session.title,
            source_url=session.source_url,
            captured_at=session.last_captured_at,
            exported_at=utcnow(),
            pile_slug=session.pile.slug if session.pile else pile_slug_for_category(session.built_in_pile),
            is_discarded=session.is_discarded,
            discarded_reason=session.discarded_reason,
            custom_tags=visible_custom_tags(session.custom_tags),
            markdown_path=session.markdown_path,
            classification_reason=session.classification_reason,
            journal_entry=session.journal_entry,
            todo_summary=session.todo_summary,
            idea_summary=session.idea_summary,
            pile_outputs=session.pile_outputs,
            share_post=session.share_post,
            messages=messages,
            triplets=[TripletRead.model_validate(triplet) for triplet in session.triplets],
            sync_events=sync_events,
            artifacts=artifacts,
            metadata=self._metadata(session),
            handoff_markdown="",
        )
        bundle.handoff_markdown = self._stored_handoff_markdown(session) or self.render_handoff_markdown(bundle)
        return bundle

    async def _load_session(self, session_id: str) -> ChatSession | None:
        statement = (
            select(ChatSession)
            .options(
                selectinload(ChatSession.messages),
                selectinload(ChatSession.triplets),
                selectinload(ChatSession.sync_events),
                selectinload(ChatSession.pile),
            )
            .where(ChatSession.id == session_id)
        )
        result = await self.db.execute(statement)
        return result.scalar_one_or_none()

    def _raw_capture(self, payload: ContextMigrationImportRequest) -> dict[str, Any]:
        return {
            "source": "savemycontext-context-migration",
            "schema_version": CONTEXT_BUNDLE_SCHEMA_VERSION,
            "provider": payload.provider.value,
            "source_interface": payload.source_interface,
            "metadata": payload.metadata,
            "artifacts": [artifact.model_dump(mode="json") for artifact in payload.artifacts],
            "handoff_markdown": payload.handoff_markdown,
            "raw_transcript": payload.raw_transcript,
        }

    def _custom_tags(self, payload: ContextMigrationImportRequest) -> list[str]:
        tags = {tag.strip() for tag in payload.custom_tags if tag.strip()}
        tags.add("context-migration")
        if payload.source_interface:
            tags.add(f"interface:{payload.source_interface}")
        return sorted(tags, key=str.casefold)

    def _to_ingest_message(self, message: ContextMigrationMessage) -> IngestMessage:
        raw_payload: dict[str, Any] | list[Any] | None = message.raw_payload
        if message.metadata:
            raw_payload = {
                "metadata": message.metadata,
                "raw_payload": message.raw_payload,
            }
        return IngestMessage(
            external_message_id=message.id,
            parent_external_message_id=message.parent_id,
            role=message.role,
            content=message.content,
            occurred_at=message.occurred_at,
            raw_payload=raw_payload,
        )

    def _from_chat_message(self, message: ChatMessage) -> ContextMigrationMessage:
        metadata: dict[str, Any] = {}
        raw_payload = message.raw_payload
        if isinstance(raw_payload, dict) and isinstance(raw_payload.get("metadata"), dict):
            metadata = dict(raw_payload["metadata"])
        return ContextMigrationMessage(
            id=message.external_message_id,
            parent_id=message.parent_external_message_id,
            role=message.role,
            content=message.content,
            occurred_at=message.occurred_at,
            metadata=metadata,
            raw_payload=raw_payload,
        )

    def _source_interface(self, session: ChatSession) -> str | None:
        for event in sorted(session.sync_events, key=lambda item: item.created_at, reverse=True):
            raw_capture = event.raw_capture
            if isinstance(raw_capture, dict) and isinstance(raw_capture.get("source_interface"), str):
                return raw_capture["source_interface"]
        return None

    def _artifacts(self, session: ChatSession) -> list[ContextArtifact]:
        artifacts: list[ContextArtifact] = []
        for event in sorted(session.sync_events, key=lambda item: item.created_at):
            raw_capture = event.raw_capture
            if not isinstance(raw_capture, dict):
                continue
            for item in raw_capture.get("artifacts") or []:
                if not isinstance(item, dict):
                    continue
                try:
                    artifacts.append(ContextArtifact.model_validate(item))
                except ValueError:
                    continue
        return artifacts

    def _metadata(self, session: ChatSession) -> dict[str, Any]:
        metadata: dict[str, Any] = {}
        for event in sorted(session.sync_events, key=lambda item: item.created_at):
            raw_capture = event.raw_capture
            if not isinstance(raw_capture, dict) or not isinstance(raw_capture.get("metadata"), dict):
                continue
            metadata.update(raw_capture["metadata"])
        return metadata

    def _stored_handoff_markdown(self, session: ChatSession) -> str | None:
        for event in sorted(session.sync_events, key=lambda item: item.created_at, reverse=True):
            raw_capture = event.raw_capture
            if not isinstance(raw_capture, dict):
                continue
            handoff_markdown = raw_capture.get("handoff_markdown")
            if isinstance(handoff_markdown, str) and handoff_markdown.strip():
                return handoff_markdown
        return None

    def render_handoff_markdown(self, bundle: ContextMigrationBundle) -> str:
        lines = [
            "# Context Handoff",
            "",
            f"- Schema: `{bundle.schema_version}`",
            f"- Provider: `{bundle.provider.value}`",
            f"- Interface: `{bundle.source_interface or bundle.provider.value}`",
            f"- Session: `{bundle.external_session_id}`",
            f"- Account: {bundle.account_label}",
        ]
        if bundle.title:
            lines.append(f"- Title: {bundle.title}")
        if bundle.source_url:
            lines.append(f"- Source: {bundle.source_url}")
        if bundle.captured_at:
            lines.append(f"- Captured: {bundle.captured_at.isoformat()}")
        if bundle.markdown_path:
            lines.append(f"- SaveMyContext note: `{bundle.markdown_path}`")
        lines.append("")

        if bundle.classification_reason or bundle.journal_entry or bundle.todo_summary or bundle.idea_summary or bundle.pile_outputs:
            lines.extend(["## Processed Knowledge", ""])
            if bundle.classification_reason:
                lines.extend(["### Classification", bundle.classification_reason, ""])
            if bundle.journal_entry:
                lines.extend(["### Journal", bundle.journal_entry, ""])
            if bundle.todo_summary:
                lines.extend(["### To-Do", bundle.todo_summary, ""])
            if bundle.idea_summary:
                lines.extend(["### Idea Summary", _format_jsonish(bundle.idea_summary), ""])
            if bundle.pile_outputs:
                lines.extend(["### Pile Outputs", _format_jsonish(bundle.pile_outputs), ""])

        if bundle.triplets:
            lines.extend(["## Knowledge Graph Triplets", ""])
            for triplet in bundle.triplets:
                lines.append(f"- {triplet.subject} - {triplet.predicate} - {triplet.object}")
            lines.append("")

        lines.extend(["## Conversation", ""])
        for index, message in enumerate(bundle.messages, start=1):
            role = message.role.value.title()
            lines.extend([f"### {index}. {role}", message.content.strip(), ""])

        if bundle.artifacts:
            lines.extend(["## Artifacts", ""])
            for artifact in bundle.artifacts:
                label = artifact.name or artifact.uri or artifact.kind
                lines.append(f"- `{artifact.kind}` {label}")
            lines.append("")

        return "\n".join(lines).rstrip() + "\n"


def _format_jsonish(value: Any) -> str:
    if isinstance(value, str):
        return value
    return f"```json\n{json.dumps(value, indent=2, ensure_ascii=False)}\n```"
