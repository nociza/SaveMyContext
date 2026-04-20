from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.models.enums import BuiltInPileSlug


class PileCount(BaseModel):
    pile_slug: BuiltInPileSlug
    count: int


class ExtraPileCount(BaseModel):
    name: str
    count: int


class DashboardSummary(BaseModel):
    total_sessions: int
    total_messages: int
    total_triplets: int
    total_sync_events: int
    active_tokens: int
    latest_sync_at: datetime | None
    piles: list[PileCount]
    extra_piles: list[ExtraPileCount] = Field(default_factory=list)
