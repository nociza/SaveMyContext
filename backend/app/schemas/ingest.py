from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.models.enums import MessageRole, ProviderName


MAX_CAPTURE_CLOCK_SKEW = timedelta(hours=24)


class IngestMessage(BaseModel):
    external_message_id: str = Field(min_length=1, max_length=255)
    parent_external_message_id: str | None = Field(default=None, max_length=255)
    role: MessageRole = MessageRole.UNKNOWN
    content: str = Field(min_length=1)
    occurred_at: datetime | None = None
    raw_payload: dict[str, Any] | list[Any] | None = None

    @field_validator("raw_payload")
    @classmethod
    def validate_raw_payload_json(cls, value):  # type: ignore[no-untyped-def]
        _validate_json_value(value, field_name="raw_payload")
        return value


class IngestDiffRequest(BaseModel):
    extraction_method: Literal["structured", "heuristic", "unknown"] = "unknown"
    capture_completeness: Literal["complete", "partial", "unknown"] = "unknown"
    parser_version: str | None = Field(default=None, max_length=80)
    provider: ProviderName
    external_session_id: str = Field(min_length=1, max_length=255)
    account_key: str | None = Field(default=None, max_length=255)
    account_label: str | None = Field(default=None, max_length=255)
    sync_mode: Literal["incremental", "full_snapshot"] = "incremental"
    title: str | None = None
    source_url: str | None = None
    captured_at: datetime | None = None
    custom_tags: list[str] = Field(default_factory=list)
    messages: list[IngestMessage] = Field(default_factory=list)
    raw_capture: dict[str, Any] | list[Any] | None = None
    route_to_discard: bool = False
    discard_word_match: str | None = Field(default=None, max_length=64)

    @field_validator("raw_capture")
    @classmethod
    def validate_raw_capture_json(cls, value):  # type: ignore[no-untyped-def]
        _validate_json_value(value, field_name="raw_capture")
        return value

    @field_validator("captured_at")
    @classmethod
    def reject_implausible_future_capture_time(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        comparable = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        if comparable.astimezone(timezone.utc) > datetime.now(timezone.utc) + MAX_CAPTURE_CLOCK_SKEW:
            raise ValueError("captured_at cannot be more than 24 hours in the future.")
        return value

    @model_validator(mode="after")
    def validate_unique_message_ids(self) -> "IngestDiffRequest":
        seen: set[str] = set()
        duplicates: set[str] = set()
        for message in self.messages:
            if message.external_message_id in seen:
                duplicates.add(message.external_message_id)
                continue
            seen.add(message.external_message_id)
        if duplicates:
            duplicate_list = ", ".join(sorted(duplicates))
            raise ValueError(f"Duplicate external_message_id values are not allowed: {duplicate_list}")
        return self


def _validate_json_value(value: object, *, field_name: str) -> None:
    if value is None:
        return
    try:
        json.dumps(value, allow_nan=False)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field_name} must contain finite JSON-compatible values.") from error


class IngestResponse(BaseModel):
    session_id: str | None = None
    disposition: Literal["accepted", "quarantined"] = "accepted"
    receipt_id: str | None = None
    quality: dict[str, Any] | None = None
    pile_slug: str | None = None
    is_discarded: bool = False
    new_message_count: int
    markdown_path: str | None = None
    processed: bool = False
