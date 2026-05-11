from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.models.enums import ProviderName, BuiltInPileSlug
from app.schemas.session import SessionRead


class LabelCount(BaseModel):
    label: str
    count: int


class ProviderCount(BaseModel):
    provider: ProviderName
    count: int


class AccountCount(BaseModel):
    account_key: str
    account_label: str
    provider: ProviderName | None = None
    count: int


class ActivityBucket(BaseModel):
    bucket: str
    count: int


class PileStats(BaseModel):
    pile_slug: BuiltInPileSlug
    scope_kind: Literal["default", "custom"] = "default"
    scope_label: str
    dominant_pile_slug: BuiltInPileSlug
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
    built_in_pile_counts: list["BuiltInPileCount"]
    provider_counts: list[ProviderCount]
    account_counts: list[AccountCount] = Field(default_factory=list)
    activity: list[ActivityBucket]
    top_tags: list[LabelCount]
    top_entities: list[LabelCount]
    top_predicates: list[LabelCount]


class BuiltInPileCount(BaseModel):
    pile_slug: BuiltInPileSlug
    count: int


class ExplorerGraphNode(BaseModel):
    id: str
    label: str
    kind: str
    size: int
    session_ids: list[str]
    provider: ProviderName | None = None
    account_key: str | None = None
    account_label: str | None = None
    pile_slug: BuiltInPileSlug | None = None
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
    account_key: str | None = None
    account_label: str | None = None
    updated_at: datetime | None = None
    note_path: str | None = None
    triplet_id: str | None = None
    predicate: str | None = None
    confidence: float | None = None
    snippet: str | None = None


class PileGraph(BaseModel):
    pile_slug: BuiltInPileSlug
    scope_kind: Literal["default", "custom"] = "default"
    scope_label: str
    dominant_pile_slug: BuiltInPileSlug
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


class PileGraphPath(BaseModel):
    pile_slug: BuiltInPileSlug
    scope_kind: Literal["default", "custom"] = "default"
    scope_label: str
    dominant_pile_slug: BuiltInPileSlug
    source: str
    target: str
    paths: list[ExplorerGraphPath]


class JournalTimelineItem(BaseModel):
    session_id: str
    title: str | None = None
    provider: ProviderName | None = None
    account_key: str | None = None
    account_label: str | None = None
    updated_at: datetime | None = None
    occurred_on: str | None = None
    entry: str
    mood: str | None = None
    people: list[str] = Field(default_factory=list)
    entities: list[str] = Field(default_factory=list)
    activities: list[str] = Field(default_factory=list)
    locations: list[str] = Field(default_factory=list)
    travel_path: list[str] = Field(default_factory=list)


class JournalGroup(BaseModel):
    label: str
    count: int
    session_ids: list[str]
    dates: list[str] = Field(default_factory=list)
    snippets: list[str] = Field(default_factory=list)
    slug: str | None = None
    kind: str | None = None


class JournalViews(BaseModel):
    timeline: list[JournalTimelineItem] = Field(default_factory=list)
    locations: list[JournalGroup] = Field(default_factory=list)
    people: list[JournalGroup] = Field(default_factory=list)
    entities: list[JournalGroup] = Field(default_factory=list)
    activities: list[JournalGroup] = Field(default_factory=list)


class IdeaClaimView(BaseModel):
    idea: str
    attributed_to: str = "User"
    stance: str = "proposes"
    evidence: str | None = None


class IdeaEvolutionNode(BaseModel):
    id: str
    session_id: str
    title: str | None = None
    provider: ProviderName | None = None
    account_key: str | None = None
    account_label: str | None = None
    updated_at: datetime | None = None
    thread: str | None = None
    project_slug: str | None = None
    project_name: str | None = None
    project_source: str | None = None
    core_idea: str
    reasoning_steps: list[str] = Field(default_factory=list)
    related_facts: list[str] = Field(default_factory=list)
    claims: list[IdeaClaimView] = Field(default_factory=list)
    next_steps: list[str] = Field(default_factory=list)
    share_post: str | None = None


class IdeaEvolutionEdge(BaseModel):
    id: str
    source: str
    target: str
    relation: str
    label: str | None = None
    session_ids: list[str] = Field(default_factory=list)


class IdeaViews(BaseModel):
    nodes: list[IdeaEvolutionNode] = Field(default_factory=list)
    edges: list[IdeaEvolutionEdge] = Field(default_factory=list)
    projects: list[JournalGroup] = Field(default_factory=list)
    threads: list[JournalGroup] = Field(default_factory=list)
    contributors: list[JournalGroup] = Field(default_factory=list)
    facts: list[JournalGroup] = Field(default_factory=list)


class FactualLinkedSource(BaseModel):
    session_id: str
    title: str | None = None
    pile_slug: BuiltInPileSlug | None = None
    provider: ProviderName | None = None
    account_key: str | None = None
    account_label: str | None = None
    matched_terms: list[str] = Field(default_factory=list)


class FactualBacklogItem(BaseModel):
    session_id: str
    title: str | None = None
    provider: ProviderName | None = None
    account_key: str | None = None
    account_label: str | None = None
    updated_at: datetime | None = None
    learned_on: str | None = None
    summary: str | None = None
    context: str | None = None
    keywords: list[str] = Field(default_factory=list)
    entities: list[str] = Field(default_factory=list)
    triplet_count: int = 0
    linked_from: list[FactualLinkedSource] = Field(default_factory=list)


class FactualViews(BaseModel):
    backlog: list[FactualBacklogItem] = Field(default_factory=list)
    keywords: list[LabelCount] = Field(default_factory=list)
    entities: list[LabelCount] = Field(default_factory=list)
    linked_sources: list[FactualLinkedSource] = Field(default_factory=list)


class PileViews(BaseModel):
    pile_slug: BuiltInPileSlug
    scope_kind: Literal["default", "custom"] = "default"
    scope_label: str
    dominant_pile_slug: BuiltInPileSlug
    journal: JournalViews | None = None
    ideas: IdeaViews | None = None
    factual: FactualViews | None = None


class SessionNoteRead(SessionRead):
    raw_markdown: str | None = None
    related_entities: list[str]
    word_count: int
