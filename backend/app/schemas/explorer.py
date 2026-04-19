from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.models.enums import ProviderName, SessionCategory
from app.schemas.session import SessionRead


class LabelCount(BaseModel):
    label: str
    count: int


class ProviderCount(BaseModel):
    provider: ProviderName
    count: int


class ActivityBucket(BaseModel):
    bucket: str
    count: int


class CategoryStats(BaseModel):
    category: SessionCategory
    scope_kind: Literal["default", "custom"] = "default"
    scope_label: str
    dominant_category: SessionCategory
    total_sessions: int
    total_messages: int
    total_triplets: int
    latest_updated_at: datetime | None
    avg_messages_per_session: float
    avg_triplets_per_session: float
    notes_with_share_post: int
    notes_with_idea_summary: int
    notes_with_journal_entry: int
    notes_with_todo_summary: int
    system_category_counts: list["CategorySystemCount"]
    provider_counts: list[ProviderCount]
    activity: list[ActivityBucket]
    top_tags: list[LabelCount]
    top_entities: list[LabelCount]
    top_predicates: list[LabelCount]


class CategorySystemCount(BaseModel):
    category: SessionCategory
    count: int


class ExplorerGraphNode(BaseModel):
    id: str
    label: str
    kind: str
    size: int
    session_ids: list[str]
    provider: ProviderName | None = None
    category: SessionCategory | None = None
    updated_at: datetime | None = None
    note_path: str | None = None
    degree: int = 0
    centrality: float = 0
    community_id: str | None = None
    community_label: str | None = None
    evidence_count: int = 0
    evidence: list["ExplorerGraphEvidence"] = Field(default_factory=list)


class ExplorerGraphEdge(BaseModel):
    id: str
    source: str
    target: str
    label: str | None = None
    weight: int
    session_ids: list[str]
    predicate_count: int = 1
    evidence_count: int = 0
    evidence: list["ExplorerGraphEvidence"] = Field(default_factory=list)


class ExplorerGraphEvidence(BaseModel):
    session_id: str
    title: str | None = None
    provider: ProviderName | None = None
    updated_at: datetime | None = None
    note_path: str | None = None
    triplet_id: str | None = None
    predicate: str | None = None
    confidence: float | None = None
    snippet: str | None = None


class CategoryGraph(BaseModel):
    category: SessionCategory
    scope_kind: Literal["default", "custom"] = "default"
    scope_label: str
    dominant_category: SessionCategory
    node_count: int
    edge_count: int
    nodes: list[ExplorerGraphNode]
    edges: list[ExplorerGraphEdge]


class ExplorerGraphPath(BaseModel):
    node_ids: list[str]
    edge_ids: list[str]
    nodes: list[ExplorerGraphNode]
    edges: list[ExplorerGraphEdge]
    hop_count: int
    score: float
    evidence_session_ids: list[str]


class CategoryGraphPath(BaseModel):
    category: SessionCategory
    scope_kind: Literal["default", "custom"] = "default"
    scope_label: str
    dominant_category: SessionCategory
    source: str
    target: str
    paths: list[ExplorerGraphPath]


class SessionNoteRead(SessionRead):
    raw_markdown: str | None = None
    related_entities: list[str]
    word_count: int
