from __future__ import annotations

from typing import TYPE_CHECKING

from pydantic import BaseModel, Field

from app.core.config import get_settings
from app.models import ChatMessage
from app.models.enums import SessionCategory
from app.schemas.processing import (
    ClassificationResult,
    FactualResult,
    IdeaResult,
    JournalResult,
    PileClassificationResult,
    SegmentedClassificationResult,
    SegmentRouting,
    TodoResult,
    TripletResult,
)
from app.services.heuristics import (
    _slice_is_explicit_todo_request,
    heuristic_classification,
    heuristic_idea,
    heuristic_journal,
    heuristic_triplets,
    is_explicit_todo_request,
)
from app.services.llm.base import LLMClient
from app.services.llm.browser_proxy_client import BrowserProxyClient
from app.services.llm.google_client import GoogleGenAIClient
from app.services.llm.openai_client import OpenAIClient
from app.services.todo import heuristic_todo_result

if TYPE_CHECKING:
    from app.services.browser_proxy.service import BrowserProxyService


class TripletListSchema(BaseModel):
    triplets: list[TripletResult] = Field(default_factory=list)


def render_transcript(messages: list[ChatMessage]) -> str:
    lines: list[str] = []
    for message in messages:
        lines.append(f"{message.role.value.upper()}: {message.content.strip()}")
    return "\n".join(lines).strip()


def render_indexed_transcript(messages: list[ChatMessage]) -> str:
    """Transcript with a leading message index so the classifier can carve ranges."""
    lines: list[str] = []
    for index, message in enumerate(messages):
        lines.append(f"[{index}] {message.role.value.upper()}: {message.content.strip()}")
    return "\n".join(lines).strip()


BUILT_IN_PILE_RULES = (
    "Use 'journal' only for the user's personal day-to-day life: what they did, how they "
    "felt, relationships, relatives, routines, reflections. Not a catch-all.\n"
    "Use 'todo' only when the user explicitly asks to add, edit, remove, mark, or reorder "
    "items on the shared to-do list. Generic planning language is never 'todo'.\n"
    "Use 'factual' for objective knowledge the user wants stored as a reference: coding, "
    "research, explanation, how-to, historical or scientific Q&A. It is a queryable dump; "
    "facts are stable and do not depend on the user's opinions.\n"
    "Use 'ideas' only when the user is developing their own original thought: "
    "brainstorming, speculation, 'what if', design directions, arguments, creative "
    "ideation. Ideas are the user's evolving positions, not stored facts.\n"
)


class ProcessingOrchestrator:
    def __init__(self, browser_proxy: BrowserProxyService | None = None) -> None:
        self.settings = get_settings()
        self.browser_proxy = browser_proxy
        self.client = self._resolve_client()

    def _resolve_client(self) -> LLMClient | None:
        backend = self.settings.llm_backend.lower()
        if backend == "browser_proxy":
            if not self.settings.experimental_browser_automation or self.browser_proxy is None:
                return None
            return BrowserProxyClient(self.browser_proxy, settings=self.settings)
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

    async def classify(
        self,
        messages: list[ChatMessage],
        *,
        auto_discard_categories: list[str] | None = None,
    ) -> ClassificationResult:
        transcript = render_transcript(messages)
        if not transcript or not self.client:
            return heuristic_classification(messages)

        cleaned_discard = [item.strip() for item in (auto_discard_categories or []) if item and item.strip()]
        discard_addendum = ""
        if cleaned_discard:
            joined = "; ".join(f"'{item}'" for item in cleaned_discard)
            discard_addendum = (
                "\nIf the transcript clearly fits one of the user's auto-discard categories "
                f"({joined}), return category='discarded' with a short reason naming the matching category. "
                "Otherwise, never use 'discarded'."
            )

        try:
            classification = await self.client.generate_json(
                system_prompt=(
                    "You classify transcripts into one of these buckets: journal, factual, ideas, todo, or discarded. "
                    "Return JSON with keys category and reason."
                ),
                user_prompt=(
                    "Classify this transcript using the rules below. Pick the single pile that best fits the "
                    "dominant intent of the conversation.\n\n"
                    f"{BUILT_IN_PILE_RULES}"
                    f"{discard_addendum}\n\n"
                    f"{transcript}"
                ),
                schema=ClassificationResult,
            )
            if classification.category == SessionCategory.DISCARDED:
                if cleaned_discard:
                    return classification
                # If auto-discard isn't configured, ignore the model's discard label.
                return heuristic_classification(messages)
            if is_explicit_todo_request(messages):
                if classification.category == SessionCategory.TODO:
                    return classification
                return heuristic_classification(messages)
            if classification.category == SessionCategory.TODO:
                return heuristic_classification(messages)
            return classification
        except Exception:
            return heuristic_classification(messages)

    async def classify_pile(
        self,
        messages: list[ChatMessage],
        *,
        candidates: list[tuple[str, str]],
        auto_discard_categories: list[str] | None = None,
    ) -> PileClassificationResult | None:
        """Pick a pile slug from the supplied candidate list.

        `candidates` is an ordered list of (slug, description) tuples representing
        every active pile the user wants the classifier to consider. Returns
        `None` when no transcript / no LLM, so callers can fall back to the
        built-in 4-bucket heuristic. Returns `None` if the model picks a slug
        not in `candidates` (treated as a hallucination).
        """
        if not candidates:
            return None
        transcript = render_transcript(messages)
        if not transcript or not self.client:
            return None

        candidate_lines = "\n".join(f"- '{slug}': {description.strip()}" for slug, description in candidates)
        cleaned_discard = [item.strip() for item in (auto_discard_categories or []) if item and item.strip()]
        discard_addendum = ""
        if cleaned_discard:
            joined = "; ".join(f"'{item}'" for item in cleaned_discard)
            discard_addendum = (
                f"\nIf the transcript clearly fits an auto-discard category ({joined}), pick the 'discarded' pile."
            )

        valid_slugs = {slug for slug, _ in candidates}

        try:
            result = await self.client.generate_json(
                system_prompt=(
                    "You route a transcript to one of the user's piles. "
                    "Return JSON with keys pile_slug and reason. "
                    "pile_slug MUST exactly equal one of the supplied slugs."
                ),
                user_prompt=(
                    "Pick the single best pile for this transcript from the list below. "
                    "Prefer a user-defined pile when its description clearly fits over a generic built-in. "
                    "Use 'todo' only when the user explicitly asks to modify the shared to-do list."
                    f"{discard_addendum}\n\n"
                    "Available piles:\n"
                    f"{candidate_lines}\n\n"
                    "Transcript:\n"
                    f"{transcript}"
                ),
                schema=PileClassificationResult,
            )
            slug = (result.pile_slug or "").strip()
            if slug not in valid_slugs:
                return None
            if slug == "discarded" and not cleaned_discard:
                # Don't trust a 'discarded' pick when auto-discard isn't configured.
                return None
            if slug == "todo" and not is_explicit_todo_request(messages):
                # Same guardrail as the legacy classifier.
                return None
            return PileClassificationResult(pile_slug=slug, reason=result.reason)
        except Exception:
            return None

    async def classify_segments(
        self,
        messages: list[ChatMessage],
        *,
        candidates: list[tuple[str, str]] | None = None,
        auto_discard_categories: list[str] | None = None,
    ) -> list[SegmentRouting]:
        """Split a session into contiguous segments, each routed to a pile.

        Returns `[]` when no LLM is configured or when the model's response is
        unusable; callers should fall back to single-pile classification. When
        the transcript is short or clearly on a single topic, the model is free
        to return a single segment spanning the whole session.
        """
        if not messages:
            return []
        transcript = render_indexed_transcript(messages)
        if not transcript or not self.client:
            return []

        if not candidates:
            candidates = [
                ("journal", "Personal day-to-day life, routines, relationships, reflection."),
                ("factual", "Objective reference knowledge: coding, research, explanation."),
                ("ideas", "The user's own original thoughts, brainstorming, speculation."),
                ("todo", "Explicit add/edit/remove on the shared to-do list."),
            ]
        candidate_lines = "\n".join(f"- '{slug}': {description.strip()}" for slug, description in candidates)
        valid_slugs = {slug for slug, _ in candidates}
        total = len(messages)
        cleaned_discard = [item.strip() for item in (auto_discard_categories or []) if item and item.strip()]

        try:
            result = await self.client.generate_json(
                system_prompt=(
                    "You split a chat transcript into contiguous segments and route each to a pile. "
                    "Return STRICT JSON: {\"segments\":[{\"pile_slug\":\"...\",\"reason\":\"...\",\"start_index\":N,\"end_index\":N}]}. "
                    "start_index and end_index are inclusive message indexes matching the transcript. "
                    "Segments must be contiguous, non-overlapping, and cover every message once."
                ),
                user_prompt=(
                    "Split this transcript into segments by topic/intent and assign each to a pile. "
                    "Return a single segment covering the whole transcript if it is on one topic. "
                    "Segments are at message boundaries; do not carve inside a message.\n\n"
                    f"{BUILT_IN_PILE_RULES}"
                    "\nAvailable piles:\n"
                    f"{candidate_lines}\n\n"
                    f"Messages are numbered [0]..[{total - 1}].\n"
                    "Transcript:\n"
                    f"{transcript}"
                ),
                schema=SegmentedClassificationResult,
            )
        except Exception:
            return []

        segments = [seg for seg in result.segments if seg.pile_slug in valid_slugs]
        if not segments:
            return []
        segments.sort(key=lambda seg: seg.start_index)
        # Clip to valid range and ensure contiguity.
        cleaned: list[SegmentRouting] = []
        cursor = 0
        for seg in segments:
            start = max(seg.start_index, cursor)
            end = min(seg.end_index, total - 1)
            if end < start:
                continue
            if seg.pile_slug == "discarded" and not cleaned_discard:
                # Don't trust 'discarded' unless auto-discard is configured.
                continue
            if seg.pile_slug == "todo" and not _slice_is_explicit_todo_request(messages, start, end):
                # Same guardrail as the single-shot classifier.
                continue
            cleaned.append(
                SegmentRouting(
                    pile_slug=seg.pile_slug,
                    reason=seg.reason,
                    start_index=start,
                    end_index=end,
                )
            )
            cursor = end + 1
        if not cleaned:
            return []
        if cleaned[-1].end_index < total - 1:
            # Extend the last segment to cover any trailing messages the model skipped.
            last = cleaned[-1]
            cleaned[-1] = SegmentRouting(
                pile_slug=last.pile_slug,
                reason=last.reason,
                start_index=last.start_index,
                end_index=total - 1,
            )
        # Collapse consecutive segments that pick the same pile.
        merged: list[SegmentRouting] = []
        for seg in cleaned:
            if merged and merged[-1].pile_slug == seg.pile_slug and merged[-1].end_index + 1 == seg.start_index:
                prev = merged[-1]
                merged[-1] = SegmentRouting(
                    pile_slug=prev.pile_slug,
                    reason=prev.reason,
                    start_index=prev.start_index,
                    end_index=seg.end_index,
                )
            else:
                merged.append(seg)
        return merged

    async def journal(self, messages: list[ChatMessage]) -> JournalResult:
        transcript = render_transcript(messages)
        if not transcript or not self.client:
            return heuristic_journal(messages)

        try:
            return await self.client.generate_json(
                system_prompt=(
                    "You write concise diary-style notes from a user transcript and extract structured "
                    "daily-life fields. Return JSON with keys entry, action_items, occurred_on (ISO date or null), "
                    "people (list of names), activities (list), locations (list), mood (short phrase or null)."
                ),
                user_prompt=(
                    "Focus only on the user's personal day-to-day life: what they did, how they felt, who they "
                    "interacted with, routines and reflections. Do not invent content; leave fields empty when "
                    "the transcript does not mention them. Strip AI filler. Keep the entry grounded.\n\n"
                    f"{transcript}"
                ),
                schema=JournalResult,
            )
        except Exception:
            return heuristic_journal(messages)

    async def factual_triplets(self, messages: list[ChatMessage]) -> list[TripletResult]:
        result = await self.factual(messages)
        return result.triplets

    async def factual(self, messages: list[ChatMessage]) -> FactualResult:
        """Factuals are a lightweight substrate: a queryable dump of the user's
        referenced facts. Triplets are emitted for rough semantic anchoring, not
        for strong graph enforcement. Graph visualization renders these as a
        loose concept map rather than a dependency DAG.
        """
        transcript = render_transcript(messages)
        if not transcript or not self.client:
            return FactualResult(triplets=heuristic_triplets(messages))

        try:
            wrapper = await self.client.generate_json(
                system_prompt=(
                    "Extract a small factual substrate from a transcript. "
                    "Return JSON with keys summary (1-2 sentence neutral recap or null), "
                    "keywords (list of durable concept tags), and triplets "
                    "(list of {subject, predicate, object, confidence, keywords})."
                ),
                user_prompt=(
                    "Emit a lightweight reference pile for this transcript. Triplets anchor durable entities "
                    "(libraries, frameworks, protocols, products, concepts). Keep the set small, high signal, "
                    "and skip speculative relationships. The pile is a queryable substrate, so keywords on each "
                    "triplet should be the tags a user might search for later.\n\n"
                    f"{transcript}"
                ),
                schema=FactualResult,
            )
            return wrapper
        except Exception:
            return FactualResult(triplets=heuristic_triplets(messages))

    async def todo(self, messages: list[ChatMessage], current_markdown: str) -> TodoResult:
        transcript = render_transcript(messages)
        if not transcript or not self.client:
            return heuristic_todo_result(messages, current_markdown)

        try:
            return await self.client.generate_json(
                system_prompt=(
                    "You maintain a shared markdown to-do list and emit structured metadata for each item. "
                    "Return JSON with keys summary, updated_markdown, and items. items is a list of "
                    "{text, deadline (ISO date or null), reminder_at (ISO datetime or null), is_persistent "
                    "(true when the item has no date), completed}. In updated_markdown, dated items "
                    "appear in Active with a `(YYYY-MM-DD)` prefix before the item text; undated items are "
                    "persistent and appear without a date prefix. Keep `## Active` and `## Done` as the "
                    "top-level sections so the file stays compatible with existing parsers."
                ),
                user_prompt=(
                    "Update the shared markdown to-do list using the transcript.\n"
                    "Only apply changes the user clearly requested to the shared to-do list.\n"
                    "Do not turn general planning advice into to-do items unless the transcript explicitly asks to modify the shared list.\n"
                    "Preserve unfinished work unless the transcript says to remove or complete it.\n"
                    "If the user gives a date or relative date, convert to ISO (YYYY-MM-DD) and write it as a "
                    "`(YYYY-MM-DD)` prefix on the item text. Undated items are persistent.\n"
                    "Keep the response markdown concise and readable for Obsidian.\n"
                    "The file should remain a complete standalone markdown document.\n\n"
                    "Current to-do list markdown:\n"
                    f"{current_markdown}\n\n"
                    "Transcript:\n"
                    f"{transcript}"
                ),
                schema=TodoResult,
            )
        except Exception:
            return heuristic_todo_result(messages, current_markdown)

    async def ideas(self, messages: list[ChatMessage]) -> IdeaResult:
        """Ideas are dynamic. Each idea can evolve across sessions, conflict
        with prior threads, and anchor on facts. The structured output keeps
        the graph of threads rich enough to visualize reasoning steps later.
        """
        transcript = render_transcript(messages)
        if not transcript or not self.client:
            return heuristic_idea(messages)

        try:
            return await self.client.generate_json(
                system_prompt=(
                    "Summarize ideation transcripts and extract the causal / reasoning structure. "
                    "Return JSON with keys core_idea, pros, cons, next_steps, share_post, "
                    "reasoning_steps (ordered list of inference steps that developed the idea), "
                    "related_facts (short list of durable facts/entities the idea rests on — "
                    "these anchor into the factual substrate), supports (prior ideas this one reinforces), "
                    "conflicts_with (prior ideas this one contradicts), and thread_hint (a short phrase "
                    "identifying the broader thread of thought, or null)."
                ),
                user_prompt=(
                    "Distill the transcript into a structured brainstorm summary. Capture the reasoning "
                    "path, not just the conclusion: reasoning_steps should read as a chain the user can "
                    "pick up later. Related_facts are pointers into stored factual knowledge.\n"
                    "Keep the share_post concise, specific, and credible. Avoid hype words such as "
                    "revolutionary, effortless, unlock, game-changing, or world-class. Write it like a "
                    "thoughtful builder note.\n\n"
                    f"{transcript}"
                ),
                schema=IdeaResult,
            )
        except Exception:
            return heuristic_idea(messages)

    async def pile_outputs(
        self,
        messages: list[ChatMessage],
        *,
        attributes: list[str],
        custom_prompt_addendum: str | None = None,
    ) -> dict[str, object]:
        """Run the generic attribute-driven pipeline for a user-defined pile.

        Each attribute that we know how to handle adds a structured key to the
        returned dict. Unknown attributes are silently ignored. The dict is a
        plain JSON-serializable shape that gets stored on `ChatSession.pile_outputs`.
        """
        transcript = render_transcript(messages)
        wanted = {attr for attr in attributes if attr}
        if not transcript or not wanted:
            return {}
        if not self.client:
            return _heuristic_pile_outputs(messages, wanted)

        # Ask one structured call for everything we need at once. This keeps user
        # piles cheap even when they enable several attributes.
        attr_lines: list[str] = []
        if "summary" in wanted:
            attr_lines.append("- summary: 1-3 sentence neutral synopsis of what the user took away.")
        if "queryable_qa" in wanted:
            attr_lines.append(
                "- qa_pairs: up to 4 objects {question, answer} suited for later semantic search."
            )
        if "share_post" in wanted:
            attr_lines.append("- share_post: a tweet-sized (<=280 chars) credible note the user would share.")
        if "alternate_phrasings" in wanted:
            attr_lines.append(
                "- alternate_phrasings: up to 3 differently worded restatements of the core takeaway."
            )
        if "importance" in wanted:
            attr_lines.append("- importance: integer 1-5 (1 trivial, 5 critical).")
        if "deadline" in wanted:
            attr_lines.append(
                "- deadline: ISO-8601 date if the transcript clearly mentions one, else null."
            )
        if "completion" in wanted:
            attr_lines.append("- completion: 'open' | 'in_progress' | 'done' if discernible, else 'open'.")
        if not attr_lines:
            return {}

        addendum = f"\n\nAdditional pile-specific instructions:\n{custom_prompt_addendum.strip()}" if custom_prompt_addendum else ""
        request = (
            "Extract the following fields from the transcript. Return STRICT JSON with only these keys (omit any that "
            "aren't requested). Use null for fields you cannot ground in the transcript:\n"
            + "\n".join(attr_lines)
            + addendum
            + "\n\nTranscript:\n"
            + transcript
        )

        try:
            from pydantic import BaseModel as _BaseModel, Field as _Field

            class _GenericPileOutput(_BaseModel):
                model_config = {"extra": "allow"}
                summary: str | None = None
                qa_pairs: list[dict[str, str]] = _Field(default_factory=list)
                share_post: str | None = None
                alternate_phrasings: list[str] = _Field(default_factory=list)
                importance: int | None = None
                deadline: str | None = None
                completion: str | None = None

            raw = await self.client.generate_json(
                system_prompt=(
                    "You extract structured fields from a transcript for a user-defined note pile. "
                    "Return JSON only, no commentary."
                ),
                user_prompt=request,
                schema=_GenericPileOutput,
            )
            payload = raw.model_dump(exclude_none=True)
            return {key: value for key, value in payload.items() if key in wanted}
        except Exception:
            return _heuristic_pile_outputs(messages, wanted)


def _heuristic_pile_outputs(messages: list[ChatMessage], wanted: set[str]) -> dict[str, object]:
    from app.services.heuristics import heuristic_idea, heuristic_journal

    out: dict[str, object] = {}
    if "summary" in wanted or "alternate_phrasings" in wanted or "share_post" in wanted:
        idea = heuristic_idea(messages)
        if "summary" in wanted:
            out["summary"] = idea.core_idea
        if "share_post" in wanted:
            out["share_post"] = idea.share_post
        if "alternate_phrasings" in wanted:
            phrasings = [idea.core_idea]
            phrasings.extend(idea.next_steps[:2])
            out["alternate_phrasings"] = [phrase for phrase in phrasings if phrase][:3]
    if "queryable_qa" in wanted:
        journal = heuristic_journal(messages)
        out["qa_pairs"] = (
            [{"question": "What did the user discuss?", "answer": journal.entry[:280]}] if journal.entry else []
        )
    if "importance" in wanted:
        out["importance"] = 3
    if "completion" in wanted:
        out["completion"] = "open"
    return out
