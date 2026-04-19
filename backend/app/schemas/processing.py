from __future__ import annotations

from pydantic import BaseModel, Field, model_validator

from app.models.enums import SessionCategory


class ClassificationResult(BaseModel):
    category: SessionCategory
    reason: str = Field(min_length=1)


class PileClassificationResult(BaseModel):
    """Generalized classification: the model picks a pile by slug.

    `slug` may be any active pile slug (built-in or user-defined). Unknown slugs
    are treated as a classifier hallucination by the caller and fall back to the
    legacy `journal/factual/ideas/todo` heuristic.
    """

    pile_slug: str = Field(min_length=1, max_length=64)
    reason: str = Field(min_length=1)


class SegmentRouting(BaseModel):
    """Routes one slice of a session (a contiguous range of messages) to a pile.

    `start_index` and `end_index` are inclusive indexes into the session's
    message list. `end_index >= start_index`. A single-segment classification
    covers the full session (`start_index=0`, `end_index=len(messages)-1`).
    """

    pile_slug: str = Field(min_length=1, max_length=64)
    reason: str = Field(min_length=1)
    start_index: int = Field(ge=0)
    end_index: int = Field(ge=0)

    @model_validator(mode="after")
    def _validate_range(self) -> "SegmentRouting":
        if self.end_index < self.start_index:
            raise ValueError("end_index must be >= start_index")
        return self


class SegmentedClassificationResult(BaseModel):
    segments: list[SegmentRouting] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_non_empty(self) -> "SegmentedClassificationResult":
        if not self.segments:
            raise ValueError("segments must contain at least one entry")
        return self


class JournalResult(BaseModel):
    entry: str = Field(min_length=1)
    action_items: list[str] = Field(default_factory=list)
    occurred_on: str | None = None
    people: list[str] = Field(default_factory=list)
    activities: list[str] = Field(default_factory=list)
    locations: list[str] = Field(default_factory=list)
    mood: str | None = None


class TodoItemDetail(BaseModel):
    text: str = Field(min_length=1)
    deadline: str | None = None
    reminder_at: str | None = None
    is_persistent: bool = True
    completed: bool = False


class TodoResult(BaseModel):
    summary: str = Field(min_length=1)
    updated_markdown: str = Field(min_length=1)
    items: list[TodoItemDetail] = Field(default_factory=list)


class TripletResult(BaseModel):
    subject: str = Field(min_length=1)
    predicate: str = Field(min_length=1)
    object: str = Field(min_length=1)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    keywords: list[str] = Field(default_factory=list)


class FactualResult(BaseModel):
    summary: str | None = None
    keywords: list[str] = Field(default_factory=list)
    triplets: list[TripletResult] = Field(default_factory=list)


class IdeaResult(BaseModel):
    core_idea: str = Field(min_length=1)
    pros: list[str] = Field(default_factory=list)
    cons: list[str] = Field(default_factory=list)
    next_steps: list[str] = Field(default_factory=list)
    share_post: str = Field(min_length=1, max_length=280)
    reasoning_steps: list[str] = Field(default_factory=list)
    related_facts: list[str] = Field(default_factory=list)
    supports: list[str] = Field(default_factory=list)
    conflicts_with: list[str] = Field(default_factory=list)
    thread_hint: str | None = None
