from __future__ import annotations

from pydantic import BaseModel, Field

from app.core.config import get_settings
from app.models import ChatMessage
from app.schemas.processing import ClassificationResult, IdeaResult, JournalResult, TripletResult
from app.services.heuristics import (
    heuristic_classification,
    heuristic_idea,
    heuristic_journal,
    heuristic_triplets,
)
from app.services.llm.base import LLMClient
from app.services.llm.google_client import GoogleGenAIClient
from app.services.llm.openai_client import OpenAIClient


class TripletListSchema(BaseModel):
    triplets: list[TripletResult] = Field(default_factory=list)


def render_transcript(messages: list[ChatMessage]) -> str:
    lines: list[str] = []
    for message in messages:
        lines.append(f"{message.role.value.upper()}: {message.content.strip()}")
    return "\n".join(lines).strip()


class ProcessingOrchestrator:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.client = self._resolve_client()

    def _resolve_client(self) -> LLMClient | None:
        backend = self.settings.llm_backend.lower()
        if backend == "openai":
            return OpenAIClient()
        if backend == "google":
            return GoogleGenAIClient()
        if backend == "auto":
            if self.settings.openai_api_key:
                return OpenAIClient()
            if self.settings.google_api_key:
                return GoogleGenAIClient()
        return None

    async def classify(self, messages: list[ChatMessage]) -> ClassificationResult:
        transcript = render_transcript(messages)
        if not transcript or not self.client:
            return heuristic_classification(messages)

        try:
            return await self.client.generate_json(
                system_prompt=(
                    "You classify transcripts into one of three buckets: journal, factual, or ideas. "
                    "Return JSON with keys category and reason."
                ),
                user_prompt=(
                    "Classify this transcript. Use 'journal' for personal context, day-to-day planning, or reflection. "
                    "Use 'factual' for coding, research, explanation, or objective Q&A. "
                    "Use 'ideas' for brainstorming, creative exploration, or original concepts.\n\n"
                    f"{transcript}"
                ),
                schema=ClassificationResult,
            )
        except Exception:
            return heuristic_classification(messages)

    async def journal(self, messages: list[ChatMessage]) -> JournalResult:
        transcript = render_transcript(messages)
        if not transcript or not self.client:
            return heuristic_journal(messages)

        try:
            return await self.client.generate_json(
                system_prompt=(
                    "You write concise diary-style notes from a user transcript. "
                    "Return JSON with keys entry and action_items."
                ),
                user_prompt=(
                    "Summarize the transcript into a short journal entry focused on the user's context and action items. "
                    "Strip AI filler and keep the note grounded and practical.\n\n"
                    f"{transcript}"
                ),
                schema=JournalResult,
            )
        except Exception:
            return heuristic_journal(messages)

    async def factual_triplets(self, messages: list[ChatMessage]) -> list[TripletResult]:
        transcript = render_transcript(messages)
        if not transcript or not self.client:
            return heuristic_triplets(messages)

        try:
            wrapper = await self.client.generate_json(
                system_prompt=(
                    "Extract subject-predicate-object triplets from factual transcripts. "
                    "Return JSON with one key named triplets containing a list of objects with subject, predicate, object, confidence."
                ),
                user_prompt=(
                    "Extract the clearest factual relationships from this transcript. "
                    "Use normalized predicates and skip speculative relationships.\n\n"
                    f"{transcript}"
                ),
                schema=TripletListSchema,
            )
            return wrapper.triplets
        except Exception:
            return heuristic_triplets(messages)

    async def ideas(self, messages: list[ChatMessage]) -> IdeaResult:
        transcript = render_transcript(messages)
        if not transcript or not self.client:
            return heuristic_idea(messages)

        try:
            return await self.client.generate_json(
                system_prompt=(
                    "Summarize ideation transcripts. "
                    "Return JSON with keys core_idea, pros, cons, next_steps, and share_post."
                ),
                user_prompt=(
                    "Distill the transcript into a structured brainstorm summary. "
                    "Keep the share_post concise and engaging without hype.\n\n"
                    f"{transcript}"
                ),
                schema=IdeaResult,
            )
        except Exception:
            return heuristic_idea(messages)
