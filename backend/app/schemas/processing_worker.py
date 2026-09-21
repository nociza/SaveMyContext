from __future__ import annotations

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, model_validator

from app.models.enums import ProviderName, BuiltInPileSlug
from app.schemas.processing import FactualResult, IdeaResult, JournalResult, TodoResult, TripletResult


class SessionPipelineResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    pile: BuiltInPileSlug = Field(validation_alias=AliasChoices("pile", "category"))
    classification_reason: str = Field(min_length=1)
    journal: JournalResult | None = None
    todo: TodoResult | None = None
    todo_source_revision: str | None = Field(default=None, exclude=True)
    factual: FactualResult | None = None
    factual_triplets: list[TripletResult] = Field(default_factory=list)
    idea: IdeaResult | None = None

    @model_validator(mode="after")
    def validate_category_payload(self) -> "SessionPipelineResult":
        if self.pile == BuiltInPileSlug.JOURNAL and self.journal is None:
            raise ValueError("journal is required when pile='journal'.")
        if self.pile == BuiltInPileSlug.TODO and self.todo is None:
            raise ValueError("todo is required when pile='todo'.")
        if self.pile == BuiltInPileSlug.IDEAS and self.idea is None:
            raise ValueError("idea is required when pile='ideas'.")
        if self.pile != BuiltInPileSlug.JOURNAL and self.journal is not None:
            raise ValueError("journal must be null unless pile='journal'.")
        if self.pile != BuiltInPileSlug.TODO and self.todo is not None:
            raise ValueError("todo must be null unless pile='todo'.")
        if self.pile != BuiltInPileSlug.TODO and self.todo_source_revision is not None:
            raise ValueError("todo_source_revision must be null unless pile='todo'.")
        if self.pile != BuiltInPileSlug.IDEAS and self.idea is not None:
            raise ValueError("idea must be null unless pile='ideas'.")
        if self.pile != BuiltInPileSlug.FACTUAL and self.factual is not None:
            raise ValueError("factual must be null unless pile='factual'.")
        if self.pile != BuiltInPileSlug.FACTUAL and self.factual_triplets:
            raise ValueError("factual_triplets must be empty unless pile='factual'.")
        return self

    @property
    def category(self) -> BuiltInPileSlug:
        return self.pile


class ProcessingTaskItem(BaseModel):
    task_key: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    source_revision: str = Field(min_length=64, max_length=64)
    source_provider: ProviderName | None = None
    source_session_id: str | None = None
    title: str | None = None


class ProcessingStatusResponse(BaseModel):
    enabled: bool
    mode: str
    worker_model: str | None = None
    pending_count: int = 0


class ProcessingTaskResponse(BaseModel):
    available: bool
    tasks: list[ProcessingTaskItem] = Field(default_factory=list)
    task_count: int = 0
    prompt: str | None = None
    worker_model: str | None = None
    todo_source_revision: str | None = None

    @model_validator(mode="after")
    def validate_available_payload(self) -> "ProcessingTaskResponse":
        if self.available and (not self.tasks or not self.prompt):
            raise ValueError("tasks and prompt are required when available=true.")
        if self.available and not self.todo_source_revision:
            raise ValueError("todo_source_revision is required when available=true.")
        if not self.available and self.tasks:
            raise ValueError("tasks must be empty when available=false.")
        self.task_count = len(self.tasks)
        return self


class ProcessingResultItem(SessionPipelineResult):
    session_id: str | None = None
    task_key: str | None = None


class ProcessingResultEnvelope(BaseModel):
    results: list[ProcessingResultItem] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_results(self) -> "ProcessingResultEnvelope":
        if not self.results:
            raise ValueError("results must contain at least one item.")
        return self


class ProcessingCompleteRequest(BaseModel):
    session_id: str | None = None
    session_ids: list[str] = Field(default_factory=list)
    response_text: str = Field(min_length=1)
    todo_source_revision: str | None = Field(default=None, min_length=1, max_length=128)
    source_revisions: dict[str, str]

    @model_validator(mode="after")
    def validate_session_ids(self) -> "ProcessingCompleteRequest":
        resolved = self.resolved_session_ids
        if not resolved:
            raise ValueError("At least one session_id is required.")
        if set(self.source_revisions) != set(resolved):
            raise ValueError("source_revisions must contain exactly one entry for every session_id.")
        if any(len(revision) != 64 for revision in self.source_revisions.values()):
            raise ValueError("Every source revision must be a 64-character SHA-256 digest.")
        return self

    @property
    def resolved_session_ids(self) -> list[str]:
        if self.session_ids:
            return self.session_ids
        if self.session_id:
            return [self.session_id]
        return []


class ProcessingCompleteResult(BaseModel):
    session_id: str
    pile_slug: str | None = None
    markdown_path: str | None = None
    processed: bool


class ProcessingCompleteResponse(BaseModel):
    processed_count: int
    results: list[ProcessingCompleteResult] = Field(default_factory=list)
