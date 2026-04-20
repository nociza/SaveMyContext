from __future__ import annotations

from pydantic import BaseModel, Field

from app.models.enums import ProviderName


class SearchResult(BaseModel):
    kind: str
    title: str
    snippet: str
    session_id: str | None = None
    source_id: str | None = None
    entity_id: str | None = None
    pile_slug: str | None = None
    provider: ProviderName | None = None
    extra_piles: list[str] = Field(default_factory=list)
    markdown_path: str | None = None


class SearchResponse(BaseModel):
    query: str
    count: int
    results: list[SearchResult]
