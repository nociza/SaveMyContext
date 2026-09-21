from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

CaptureKind = Literal["selection", "page"]
CaptureSaveMode = Literal["raw", "ai"]


class SourceCaptureRequest(BaseModel):
    capture_key: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    )
    capture_kind: CaptureKind
    save_mode: CaptureSaveMode
    title: str | None = None
    page_title: str | None = None
    source_url: str | None = None
    selection_text: str | None = None
    source_text: str = Field(min_length=1)
    source_markdown: str | None = None
    raw_payload: dict[str, Any] | list[Any] | None = None

    @field_validator("raw_payload")
    @classmethod
    def validate_raw_payload_json(cls, value):  # type: ignore[no-untyped-def]
        if value is None:
            return value
        try:
            json.dumps(value, allow_nan=False, sort_keys=True)
        except (TypeError, ValueError) as error:
            raise ValueError("raw_payload must contain finite JSON-compatible values.") from error
        return value


class SourceCaptureResponse(BaseModel):
    source_id: str
    capture_key: str | None = None
    title: str
    capture_kind: CaptureKind
    save_mode: CaptureSaveMode
    processed: bool
    pile_slug: str | None = None
    markdown_path: str | None = None
    raw_source_path: str | None = None
