from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import PileKind


class PileRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    slug: str
    name: str
    description: str | None = None
    kind: PileKind
    folder_label: str
    attributes: list[str] = Field(default_factory=list)
    pipeline_config: dict[str, Any] = Field(default_factory=dict)
    is_active: bool = True
    is_visible_on_dashboard: bool = True
    sort_order: int = 0
    created_at: datetime
    updated_at: datetime


class PileCreate(BaseModel):
    slug: str = Field(min_length=2, max_length=64)
    name: str = Field(min_length=1, max_length=128)
    description: str | None = Field(default=None, max_length=2000)
    folder_label: str | None = Field(default=None, max_length=64)
    attributes: list[str] = Field(default_factory=list)
    pipeline_config: dict[str, Any] = Field(default_factory=dict)
    sort_order: int = 100


class PileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    description: str | None = Field(default=None, max_length=2000)
    folder_label: str | None = Field(default=None, max_length=64)
    attributes: list[str] | None = None
    pipeline_config: dict[str, Any] | None = None
    is_active: bool | None = None
    sort_order: int | None = None


class PileCount(BaseModel):
    slug: str
    name: str
    count: int


class DiscardedSessionItem(BaseModel):
    id: str
    provider: str
    external_session_id: str
    title: str | None = None
    discarded_reason: str | None = None
    last_captured_at: datetime | None = None
    updated_at: datetime
    markdown_path: str | None = None


class DiscardedSessionsResponse(BaseModel):
    count: int
    items: list[DiscardedSessionItem] = Field(default_factory=list)


class PileRestructureRequest(BaseModel):
    model: str | None = Field(default=None, max_length=200)
    limit: int = Field(default=25, ge=1, le=500)
    include_discarded: bool = False


class PileRestructureResult(BaseModel):
    scope: str
    pile_slug: str | None = None
    pile_name: str | None = None
    model: str | None = None
    processed_count: int = 0
    moved_count: int = 0
    session_ids: list[str] = Field(default_factory=list)
    started_at: datetime
    completed_at: datetime


class PileRestructureDueRequest(BaseModel):
    limit_per_pile: int = Field(default=10, ge=1, le=100)
    include_discarded: bool = False


class PileRestructureDueResponse(BaseModel):
    checked_count: int = 0
    due_count: int = 0
    processed_count: int = 0
    results: list[PileRestructureResult] = Field(default_factory=list)
