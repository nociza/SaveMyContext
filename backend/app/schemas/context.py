from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from app.models.enums import MessageRole, ProviderName
from app.schemas.ingest import IngestResponse
from app.schemas.session import TripletRead


CONTEXT_BUNDLE_SCHEMA_VERSION = "savemycontext.context.v1"


class ContextArtifact(BaseModel):
    kind: str = Field(min_length=1, max_length=64)
    name: str | None = Field(default=None, max_length=255)
    uri: str | None = None
    content_type: str | None = Field(default=None, max_length=128)
    content: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class ContextMigrationMessage(BaseModel):
    id: str = Field(min_length=1, max_length=255)
    parent_id: str | None = Field(default=None, max_length=255)
    role: MessageRole = MessageRole.UNKNOWN
    content: str = Field(min_length=1)
    occurred_at: datetime | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    raw_payload: dict[str, Any] | list[Any] | None = None


class ContextMigrationImportRequest(BaseModel):
    schema_version: Literal["savemycontext.context.v1"] = CONTEXT_BUNDLE_SCHEMA_VERSION
    provider: ProviderName
    external_session_id: str = Field(min_length=1, max_length=255)
    source_interface: str | None = Field(default=None, max_length=128)
    account_key: str | None = Field(default=None, max_length=255)
    account_label: str | None = Field(default=None, max_length=255)
    title: str | None = None
    source_url: str | None = None
    captured_at: datetime | None = None
    custom_tags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    artifacts: list[ContextArtifact] = Field(default_factory=list)
    messages: list[ContextMigrationMessage] = Field(default_factory=list)
    handoff_markdown: str | None = None
    raw_transcript: dict[str, Any] | list[Any] | None = None
    route_to_discard: bool = False
    discard_word_match: str | None = Field(default=None, max_length=64)

    @model_validator(mode="after")
    def validate_unique_message_ids(self) -> "ContextMigrationImportRequest":
        seen: set[str] = set()
        duplicates: set[str] = set()
        for message in self.messages:
            if message.id in seen:
                duplicates.add(message.id)
                continue
            seen.add(message.id)
        if duplicates:
            duplicate_list = ", ".join(sorted(duplicates))
            raise ValueError(f"Duplicate message ids are not allowed: {duplicate_list}")
        return self


class ContextSyncEventRead(BaseModel):
    id: str
    created_at: datetime
    message_count: int
    raw_capture: dict[str, Any] | list[Any] | None


class ContextMigrationBundle(BaseModel):
    schema_version: Literal["savemycontext.context.v1"] = CONTEXT_BUNDLE_SCHEMA_VERSION
    session_id: str
    provider: ProviderName
    source_interface: str | None = None
    external_session_id: str
    account_key: str
    account_label: str
    title: str | None = None
    source_url: str | None = None
    captured_at: datetime | None = None
    exported_at: datetime
    pile_slug: str | None = None
    is_discarded: bool = False
    discarded_reason: str | None = None
    custom_tags: list[str] = Field(default_factory=list)
    markdown_path: str | None = None
    classification_reason: str | None = None
    journal_entry: str | None = None
    todo_summary: str | None = None
    idea_summary: dict[str, Any] | None = None
    pile_outputs: dict[str, Any] | None = None
    share_post: str | None = None
    messages: list[ContextMigrationMessage]
    triplets: list[TripletRead] = Field(default_factory=list)
    sync_events: list[ContextSyncEventRead] = Field(default_factory=list)
    artifacts: list[ContextArtifact] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    handoff_markdown: str


class ContextMigrationImportResponse(IngestResponse):
    bundle: ContextMigrationBundle
