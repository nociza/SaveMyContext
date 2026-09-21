from __future__ import annotations

from dataclasses import dataclass
import hashlib
import hmac
import json
import logging

from pydantic import AliasChoices, BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ChatMessage, MessageRole, SourceCapture
from app.models.enums import BuiltInPileSlug
from app.schemas.source_capture import SourceCaptureRequest, SourceCaptureResponse
from app.services.heuristics import heuristic_classification
from app.services.locks import KeyedAsyncLockPool
from app.services.markdown import MarkdownExporter
from app.services.orchestrator import ProcessingOrchestrator
from app.services.prompt_templates import PromptTemplateService
from app.services.text import normalize_whitespace, take_sentences
from app.core.config import get_settings


logger = logging.getLogger(__name__)
_CAPTURE_LOCKS = KeyedAsyncLockPool()


class SourceCaptureIdempotencyConflictError(RuntimeError):
    """Raised when a capture key is reused for a different request payload."""


class SourceCapturePhaseTwoError(RuntimeError):
    """The source is durable, but enrichment or projection must be retried."""

    def __init__(self, source_id: str) -> None:
        self.source_id = source_id
        super().__init__(
            "The source capture was preserved, but enrichment or projection failed. "
            "Retry the same capture."
        )


def source_capture_payload_hash(payload: SourceCaptureRequest) -> str:
    """Return a stable fingerprint of the accepted request, excluding its key."""
    canonical_payload = payload.model_dump(
        mode="json",
        exclude={"capture_key"},
    )
    encoded = json.dumps(
        canonical_payload,
        allow_nan=False,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


class SourceCaptureAIResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    title: str
    pile: BuiltInPileSlug = Field(validation_alias=AliasChoices("pile", "category"))
    classification_reason: str
    summary: str
    cleaned_markdown: str


@dataclass
class SourceCaptureEnrichment:
    title: str
    pile: BuiltInPileSlug | None
    classification_reason: str | None
    summary: str | None
    cleaned_markdown: str | None


class SourceCaptureProcessor:
    def __init__(self, db: AsyncSession | None = None) -> None:
        self.orchestrator = ProcessingOrchestrator(db=db)
        self.client = self.orchestrator.client
        self.prompts = PromptTemplateService(db)

    async def enrich(self, payload: SourceCaptureRequest) -> SourceCaptureEnrichment:
        transcript = self._build_transcript(payload)
        if self.client:
            try:
                prompt = await self.prompts.render(
                    "capture.enrich",
                    values={
                        "capture_kind": payload.capture_kind,
                        "save_mode": payload.save_mode,
                        "page_title": payload.page_title or "n/a",
                        "source_url": payload.source_url or "n/a",
                        "source_markdown": payload.source_markdown or "n/a",
                        "transcript": transcript,
                    },
                )
                result = await self.client.generate_json(
                    system_prompt=prompt.system_prompt,
                    user_prompt=prompt.user_prompt,
                    schema=SourceCaptureAIResult,
                )
                return SourceCaptureEnrichment(
                    title=result.title.strip() or self._fallback_title(payload),
                    pile=result.pile,
                    classification_reason=result.classification_reason.strip() or "AI-enriched source capture.",
                    summary=result.summary.strip() or take_sentences(transcript, 2),
                    cleaned_markdown=result.cleaned_markdown.strip() or self._fallback_markdown(payload),
                )
            except Exception:  # noqa: BLE001 - enrichment has a documented local fallback
                logger.warning(
                    "Source-capture AI enrichment failed; using the local heuristic fallback.",
                    exc_info=True,
                )

        return self._heuristic_enrichment(payload)

    def _heuristic_enrichment(self, payload: SourceCaptureRequest) -> SourceCaptureEnrichment:
        transcript = self._build_transcript(payload)
        synthetic_messages = [
            ChatMessage(
                session_id="source-capture",
                external_message_id="source-capture",
                role=MessageRole.USER,
                content=transcript,
                sequence_index=1,
            )
        ]
        heuristic_result = heuristic_classification(synthetic_messages)
        return SourceCaptureEnrichment(
            title=self._fallback_title(payload),
            pile=heuristic_result.pile,
            classification_reason=heuristic_result.reason,
            summary=take_sentences(transcript, 2),
            cleaned_markdown=self._fallback_markdown(payload),
        )

    def _fallback_title(self, payload: SourceCaptureRequest) -> str:
        explicit = normalize_whitespace(payload.title or payload.page_title or "")
        if explicit:
            return explicit
        selection = normalize_whitespace(payload.selection_text or "")
        if selection:
            return take_sentences(selection, 1)[:160] or "Saved selection"
        return take_sentences(payload.source_text, 1)[:160] or "Saved page"

    def _fallback_markdown(self, payload: SourceCaptureRequest) -> str:
        if payload.source_markdown and payload.source_markdown.strip():
            return payload.source_markdown.strip()
        lines = [line.strip() for line in payload.source_text.splitlines()]
        compact = [line for line in lines if line]
        return "\n\n".join(compact).strip()

    def _build_transcript(self, payload: SourceCaptureRequest) -> str:
        primary = payload.selection_text or payload.source_text
        return normalize_whitespace(primary)


class SourceCaptureService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.processor = SourceCaptureProcessor(db)
        self.exporter = MarkdownExporter(db)

    async def capture(self, payload: SourceCaptureRequest) -> SourceCaptureResponse:
        if payload.capture_key is None:
            return await self._capture_locked(payload)
        async with _CAPTURE_LOCKS.lock(payload.capture_key):
            return await self._capture_locked(payload)

    async def _capture_locked(self, payload: SourceCaptureRequest) -> SourceCaptureResponse:
        payload_hash = source_capture_payload_hash(payload)
        if payload.capture_key:
            existing_capture = await self._find_by_capture_key(payload.capture_key)
            if existing_capture is not None:
                self._ensure_payload_matches(existing_capture, payload_hash)
                if get_settings().workspace_enabled:
                    return self._response_from_capture(existing_capture)
                if self._projection_is_complete(existing_capture):
                    return self._response_from_capture(existing_capture)
                return await self._complete_capture(existing_capture.id, payload)

        source_text = payload.source_text.strip()
        source_capture = SourceCapture(
            capture_key=payload.capture_key,
            capture_payload_hash=payload_hash if payload.capture_key else None,
            capture_kind=payload.capture_kind,
            save_mode=payload.save_mode,
            title=normalize_whitespace(payload.title or payload.page_title or "") or None,
            page_title=normalize_whitespace(payload.page_title or "") or None,
            source_url=payload.source_url.strip() if payload.source_url else None,
            selection_text=payload.selection_text.strip() if payload.selection_text else None,
            source_text=source_text,
            source_markdown=(payload.source_markdown.strip() if payload.source_markdown else None),
            raw_payload=payload.raw_payload,
        )
        # A useful raw representation exists before any optional enrichment.
        source_capture.title = source_capture.title or self.processor._fallback_title(payload)
        source_capture.cleaned_markdown = self.processor._fallback_markdown(payload)

        self.db.add(source_capture)
        try:
            await self.db.flush()
            source_id = source_capture.id
            if get_settings().workspace_enabled:
                from app.workspace.store import enqueue_capture
                await enqueue_capture(self.db, source_capture)
            # Preserve the accepted source before invoking a provider or filesystem
            # projection. This mirrors the chat-ingest capture boundary.
            await self.db.commit()
        except IntegrityError:
            await self.db.rollback()
            if not payload.capture_key:
                raise
            existing_capture = await self._find_by_capture_key(payload.capture_key)
            if existing_capture is None:
                raise
            self._ensure_payload_matches(existing_capture, payload_hash)
            if get_settings().workspace_enabled:
                return self._response_from_capture(existing_capture)
            if self._projection_is_complete(existing_capture):
                return self._response_from_capture(existing_capture)
            return await self._complete_capture(existing_capture.id, payload)

        if get_settings().workspace_enabled:
            return self._response_from_capture(source_capture)
        return await self._complete_capture(source_id, payload)

    async def _complete_capture(
        self,
        source_id: str,
        payload: SourceCaptureRequest,
    ) -> SourceCaptureResponse:
        result = await self.db.execute(
            select(SourceCapture)
            .where(SourceCapture.id == source_id)
            .with_for_update(of=SourceCapture)
        )
        source_capture = result.scalar_one_or_none()
        if source_capture is None:
            raise RuntimeError("Source capture disappeared after commit.")
        if self._projection_is_complete(source_capture):
            return self._response_from_capture(source_capture)

        try:
            if payload.save_mode == "ai":
                enrichment = await self.processor.enrich(payload)
                source_capture.title = enrichment.title
                source_capture.built_in_pile = enrichment.pile
                source_capture.classification_reason = enrichment.classification_reason
                source_capture.summary = enrichment.summary
                source_capture.cleaned_markdown = enrichment.cleaned_markdown

            markdown_path, raw_source_path = await self.exporter.write_source_capture(source_capture)
            source_capture.markdown_path = str(markdown_path)
            source_capture.raw_source_path = str(raw_source_path)
            await self.db.commit()
        except Exception:  # noqa: BLE001 - accepted source must survive optional phase two
            await self.db.rollback()
            logger.exception(
                "Enrichment or projection failed after preserving source capture %s.",
                source_id,
            )
            raise SourceCapturePhaseTwoError(source_id) from None

        source_capture = await self.db.get(SourceCapture, source_id)
        if source_capture is None:
            raise RuntimeError("Source capture disappeared after commit.")

        return self._response_from_capture(source_capture)

    async def _find_by_capture_key(self, capture_key: str) -> SourceCapture | None:
        result = await self.db.execute(
            select(SourceCapture).where(SourceCapture.capture_key == capture_key)
        )
        return result.scalar_one_or_none()

    def _ensure_payload_matches(
        self,
        source_capture: SourceCapture,
        payload_hash: str,
    ) -> None:
        stored_hash = source_capture.capture_payload_hash
        if stored_hash is None or not hmac.compare_digest(stored_hash, payload_hash):
            raise SourceCaptureIdempotencyConflictError(
                "This capture key was already used for a different source capture."
            )

    @staticmethod
    def _projection_is_complete(source_capture: SourceCapture) -> bool:
        return (
            source_capture.markdown_path is not None
            and source_capture.raw_source_path is not None
        )

    def _response_from_capture(
        self,
        source_capture: SourceCapture,
    ) -> SourceCaptureResponse:
        processed = (
            source_capture.save_mode == "ai"
            and source_capture.markdown_path is not None
            and source_capture.raw_source_path is not None
        )
        return SourceCaptureResponse(
            source_id=source_capture.id,
            capture_key=source_capture.capture_key,
            title=source_capture.title or "Saved source",
            capture_kind=source_capture.capture_kind,
            save_mode=source_capture.save_mode,
            processed=processed,
            pile_slug=(
                source_capture.pile.slug
                if source_capture.pile
                else source_capture.built_in_pile.value
                if source_capture.built_in_pile
                else None
            ),
            markdown_path=source_capture.markdown_path,
            raw_source_path=source_capture.raw_source_path,
        )
