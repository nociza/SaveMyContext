from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta
import heapq
from itertools import count
from math import log
from pathlib import Path
import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.models import ChatSession, IdeaProject, ProviderName, BuiltInPileSlug
from app.schemas.explorer import (
    ActivityBucket,
    BuiltInPileCount,
    FactualBacklogItem,
    FactualLinkedSource,
    FactualViews,
    IdeaClaimView,
    IdeaEvolutionEdge,
    IdeaEvolutionNode,
    IdeaViews,
    JournalGroup,
    JournalTimelineItem,
    JournalViews,
    PileGraph,
    PileGraphPath,
    PileStats,
    PileViews,
    ExplorerGraphEvidence,
    ExplorerGraphEdge,
    ExplorerGraphNode,
    ExplorerGraphPath,
    LabelCount,
    ProviderCount,
)
from app.services.graph import entity_id, entity_note_path
from app.services.extra_piles import has_extra_pile, summarize_extra_piles, visible_custom_tags
from app.services.idea_projects import IdeaProjectService, best_project_match_for_text, slugify_project_name


STOPWORDS = {
    "about",
    "after",
    "again",
    "also",
    "among",
    "and",
    "any",
    "are",
    "back",
    "been",
    "before",
    "being",
    "between",
    "both",
    "but",
    "can",
    "could",
    "does",
    "each",
    "from",
    "have",
    "into",
    "just",
    "like",
    "many",
    "more",
    "most",
    "must",
    "need",
    "notes",
    "only",
    "other",
    "over",
    "same",
    "save",
    "savemycontext",
    "session",
    "should",
    "some",
    "that",
    "their",
    "them",
    "there",
    "these",
    "they",
    "this",
    "those",
    "through",
    "todo",
    "very",
    "want",
    "what",
    "when",
    "which",
    "with",
    "would",
    "your",
}

TOKEN_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]+")
FACTUAL_GRAPH_NODE_LIMIT = 120
FACTUAL_GRAPH_EDGE_LIMIT = 280
SIMILARITY_GRAPH_NODE_LIMIT = 96
SIMILARITY_GRAPH_EDGE_LIMIT = 220
GRAPH_PATH_LIMIT = 4
GRAPH_PATH_MAX_HOPS = 4
GENERIC_IDEA_GROUP_LABELS = {
    "general",
    "general ideas",
    "idea",
    "ideas",
    "misc",
    "miscellaneous",
    "thread",
    "unassigned",
    "unthreaded",
}


def session_related_entities(session: ChatSession) -> list[str]:
    entities = {triplet.subject.strip() for triplet in session.triplets if triplet.subject.strip()}
    entities.update(triplet.object.strip() for triplet in session.triplets if triplet.object.strip())
    return sorted(entities, key=str.lower)


def read_session_markdown(session: ChatSession) -> str | None:
    if not session.markdown_path:
        return None

    candidate = Path(session.markdown_path).expanduser()
    try:
        resolved = candidate.resolve()
    except OSError:
        return None

    settings = get_settings()
    allowed_roots = (settings.resolved_vault_root.resolve(), settings.resolved_markdown_dir.resolve())
    if not any(root == resolved or root in resolved.parents for root in allowed_roots):
        return None

    if not resolved.exists() or not resolved.is_file():
        return None

    return resolved.read_text(encoding="utf-8")


def session_word_count(session: ChatSession, raw_markdown: str | None = None) -> int:
    source = raw_markdown
    if not source:
        text_parts = [
            session.title or "",
            session.classification_reason or "",
            session.journal_entry or "",
            session.todo_summary or "",
            session.share_post or "",
            *(message.content for message in session.messages),
        ]
        if session.idea_summary:
            text_parts.extend(str(value) for value in session.idea_summary.values())
        source = "\n".join(text_parts)

    return len(re.findall(r"\b\w+\b", source))


def _session_text(session: ChatSession) -> str:
    parts = [
        session.title or "",
        session.classification_reason or "",
        session.journal_entry or "",
        session.todo_summary or "",
        session.share_post or "",
    ]
    if session.idea_summary:
        core_idea = session.idea_summary.get("core_idea")
        if core_idea:
            parts.append(str(core_idea))
        for key in (
            "pros",
            "cons",
            "next_steps",
            "reasoning_steps",
            "related_facts",
            "supports",
            "conflicts_with",
            "builds_on",
            "validates",
            "counters",
        ):
            value = session.idea_summary.get(key)
            if isinstance(value, list):
                parts.extend(str(item) for item in value)
        attributed = session.idea_summary.get("attributed_ideas")
        if isinstance(attributed, list):
            for item in attributed:
                if isinstance(item, dict):
                    parts.extend(str(value) for value in item.values() if value)
    parts.extend(message.content for message in session.messages[:8])
    return "\n".join(part for part in parts if part)


def _tokenize_text(value: str) -> set[str]:
    tokens: set[str] = set()
    for token in TOKEN_PATTERN.findall(value.lower()):
        if len(token) < 3 or token.isdigit() or token in STOPWORDS:
            continue
        tokens.add(token)
    return tokens


def _compact_snippet(value: str, terms: list[str] | None = None, *, max_chars: int = 220) -> str:
    compact = re.sub(r"\s+", " ", value).strip()
    if not compact:
        return ""

    lowered = compact.lower()
    start = 0
    for term in terms or []:
        cleaned = term.strip().lower()
        if not cleaned:
            continue
        index = lowered.find(cleaned)
        if index >= 0:
            start = max(index - 64, 0)
            break

    snippet = compact[start : start + max_chars].strip()
    if start > 0:
        snippet = f"...{snippet}"
    if start + max_chars < len(compact):
        snippet = f"{snippet}..."
    return snippet


def _text_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    items: list[str] = []
    for item in value:
        cleaned = str(item).strip()
        if cleaned:
            items.append(cleaned)
    return items


def _dict_list(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _clean_label(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _idea_project_label(node: IdeaEvolutionNode) -> str:
    if node.project_name:
        return node.project_name
    if node.project_slug:
        return node.project_slug.replace("-", " ").title()
    return "Unassigned"


def _titleize_label(value: str) -> str:
    words = re.split(r"[\s_-]+", value.strip())
    small_words = {"a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "with"}
    titled: list[str] = []
    for index, word in enumerate(words):
        cleaned = word.strip()
        if not cleaned:
            continue
        lowered = cleaned.casefold()
        if index > 0 and lowered in small_words:
            titled.append(lowered)
        else:
            titled.append(cleaned[:1].upper() + cleaned[1:])
    return " ".join(titled)


def _usable_project_label(value: str | None) -> str | None:
    cleaned = _clean_label(value)
    if not cleaned:
        return None
    if cleaned.casefold() in GENERIC_IDEA_GROUP_LABELS:
        return None
    return _titleize_label(cleaned)


def _date_label(session: ChatSession, explicit: object | None = None) -> str:
    explicit_text = _clean_label(explicit)
    if explicit_text:
        return explicit_text
    timestamp = session.last_captured_at or session.updated_at
    return timestamp.date().isoformat() if timestamp is not None else ""


def datetime_sort_key(value: datetime | None) -> tuple[int, float]:
    if value is None:
        return (1, float("-inf"))
    return (0, value.timestamp())


def _structured_output(session: ChatSession, key: str) -> dict[str, object]:
    outputs = session.pile_outputs if isinstance(session.pile_outputs, dict) else {}
    nested = outputs.get(key)
    if isinstance(nested, dict):
        return nested
    # Some older or user-defined outputs were stored directly under pile_outputs.
    return outputs if outputs else {}


def _journal_entry_body(value: str | None) -> str:
    normalized = (value or "").strip()
    if not normalized:
        return ""
    marker = "Action Items:"
    index = normalized.find(marker)
    return normalized[:index].strip() if index >= 0 else normalized


def _triplet_snippet(subject: str, predicate: str, object_: str) -> str:
    return f"{subject} | {predicate} | {object_}"


def _session_evidence(
    session: ChatSession,
    *,
    snippet: str | None = None,
    triplet: object | None = None,
    predicate: str | None = None,
) -> ExplorerGraphEvidence:
    return ExplorerGraphEvidence(
        session_id=session.id,
        title=session.title,
        provider=session.provider,
        updated_at=session.updated_at,
        note_path=session.markdown_path,
        triplet_id=getattr(triplet, "id", None),
        predicate=predicate,
        confidence=getattr(triplet, "confidence", None),
        snippet=snippet,
    )


class ExplorerService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def category_stats(
        self,
        category: BuiltInPileSlug,
        *,
        session_ids: list[str] | None = None,
        provider: ProviderName | None = None,
    ) -> PileStats:
        sessions = await self._sessions(category, session_ids=session_ids, provider=provider)
        return self._build_stats("default", category.value, sessions, fallback_category=category)

    async def custom_category_stats(
        self,
        name: str,
        *,
        session_ids: list[str] | None = None,
        provider: ProviderName | None = None,
    ) -> PileStats:
        sessions = await self._sessions_for_extra_pile(name, session_ids=session_ids, provider=provider)
        return self._build_stats("custom", name, sessions, fallback_category=self._dominant_category(sessions))

    async def category_graph(
        self,
        category: BuiltInPileSlug,
        *,
        session_ids: list[str] | None = None,
        provider: ProviderName | None = None,
    ) -> PileGraph:
        sessions = await self._sessions(category, session_ids=session_ids, provider=provider)
        return self._build_graph("default", category.value, sessions, fallback_category=category)

    async def category_views(
        self,
        category: BuiltInPileSlug,
        *,
        session_ids: list[str] | None = None,
        provider: ProviderName | None = None,
    ) -> PileViews:
        sessions = await self._sessions(category, session_ids=session_ids, provider=provider)
        related_sessions = await self._all_sessions(provider=provider) if category == BuiltInPileSlug.FACTUAL else []
        idea_projects = await IdeaProjectService(self.db).list_projects() if category == BuiltInPileSlug.IDEAS else None
        return self._build_views(
            "default",
            category.value,
            sessions,
            fallback_category=category,
            related_sessions=related_sessions,
            idea_projects=idea_projects,
        )

    async def custom_category_graph(
        self,
        name: str,
        *,
        session_ids: list[str] | None = None,
        provider: ProviderName | None = None,
    ) -> PileGraph:
        sessions = await self._sessions_for_extra_pile(name, session_ids=session_ids, provider=provider)
        return self._build_graph("custom", name, sessions, fallback_category=self._dominant_category(sessions))

    async def custom_category_views(
        self,
        name: str,
        *,
        session_ids: list[str] | None = None,
        provider: ProviderName | None = None,
    ) -> PileViews:
        sessions = await self._sessions_for_extra_pile(name, session_ids=session_ids, provider=provider)
        dominant = self._dominant_category(sessions)
        related_sessions = await self._all_sessions(provider=provider) if dominant == BuiltInPileSlug.FACTUAL else []
        idea_projects = await IdeaProjectService(self.db).list_projects() if dominant == BuiltInPileSlug.IDEAS else None
        return self._build_views(
            "custom",
            name,
            sessions,
            fallback_category=dominant,
            related_sessions=related_sessions,
            idea_projects=idea_projects,
        )

    async def category_graph_path(
        self,
        category: BuiltInPileSlug,
        *,
        source: str,
        target: str,
        session_ids: list[str] | None = None,
        provider: ProviderName | None = None,
    ) -> PileGraphPath:
        sessions = await self._sessions(category, session_ids=session_ids, provider=provider)
        return self._build_graph_path("default", category.value, sessions, source=source, target=target, fallback_category=category)

    async def custom_category_graph_path(
        self,
        name: str,
        *,
        source: str,
        target: str,
        session_ids: list[str] | None = None,
        provider: ProviderName | None = None,
    ) -> PileGraphPath:
        sessions = await self._sessions_for_extra_pile(name, session_ids=session_ids, provider=provider)
        return self._build_graph_path(
            "custom",
            name,
            sessions,
            source=source,
            target=target,
            fallback_category=self._dominant_category(sessions),
        )

    async def _sessions(
        self,
        category: BuiltInPileSlug,
        *,
        session_ids: list[str] | None = None,
        provider: ProviderName | None = None,
    ) -> list[ChatSession]:
        statement = (
            select(ChatSession)
            .options(
                selectinload(ChatSession.messages),
                selectinload(ChatSession.triplets),
            )
            .where(ChatSession.built_in_pile == category)
            .order_by(ChatSession.updated_at.desc())
        )
        if session_ids:
            statement = statement.where(ChatSession.id.in_(session_ids))
        if provider:
            statement = statement.where(ChatSession.provider == provider)

        result = await self.db.execute(statement)
        return list(result.scalars().unique().all())

    async def _sessions_for_extra_pile(
        self,
        name: str,
        *,
        session_ids: list[str] | None = None,
        provider: ProviderName | None = None,
    ) -> list[ChatSession]:
        statement = (
            select(ChatSession)
            .options(
                selectinload(ChatSession.messages),
                selectinload(ChatSession.triplets),
            )
            .order_by(ChatSession.updated_at.desc())
        )
        if session_ids:
            statement = statement.where(ChatSession.id.in_(session_ids))
        if provider:
            statement = statement.where(ChatSession.provider == provider)

        result = await self.db.execute(statement)
        sessions = list(result.scalars().unique().all())
        return [session for session in sessions if has_extra_pile(session.custom_tags, name)]

    async def _all_sessions(
        self,
        *,
        provider: ProviderName | None = None,
    ) -> list[ChatSession]:
        statement = (
            select(ChatSession)
            .options(
                selectinload(ChatSession.messages),
                selectinload(ChatSession.triplets),
            )
            .where(ChatSession.is_discarded.is_(False))
            .order_by(ChatSession.updated_at.desc())
        )
        if provider:
            statement = statement.where(ChatSession.provider == provider)
        result = await self.db.execute(statement)
        return list(result.scalars().unique().all())

    def extra_pile_summaries(self, sessions: list[ChatSession]) -> list[tuple[str, int]]:
        return summarize_extra_piles([session.custom_tags for session in sessions])

    def _build_stats(
        self,
        scope_kind: str,
        scope_label: str,
        sessions: list[ChatSession],
        *,
        fallback_category: BuiltInPileSlug | None,
    ) -> PileStats:
        dominant_category = self._dominant_category(sessions, fallback=fallback_category)
        total_sessions = len(sessions)
        total_messages = sum(len(session.messages) for session in sessions)
        total_triplets = sum(len(session.triplets) for session in sessions)
        latest_updated_at = max((session.updated_at for session in sessions), default=None)

        provider_counts = [
            ProviderCount(provider=provider, count=count)
            for provider, count in sorted(Counter(session.provider for session in sessions).items(), key=lambda item: item[0].value)
        ]
        built_in_pile_counts = [
            BuiltInPileCount(pile_slug=pile, count=count)
            for pile, count in sorted(
                Counter(session.built_in_pile for session in sessions if session.built_in_pile is not None).items(),
                key=lambda item: item[0].value,
            )
        ]

        activity = self._activity_buckets(sessions, latest_updated_at)
        top_tags = self._label_counts(
            tag
            for session in sessions
            for tag in visible_custom_tags(session.custom_tags)
            if tag and tag.strip() and tag.strip().lower() != "savemycontext"
        )
        top_entities = self._label_counts(
            entity
            for session in sessions
            for triplet in session.triplets
            for entity in (triplet.subject.strip(), triplet.object.strip())
            if entity
        )
        top_predicates = self._label_counts(
            triplet.predicate.strip()
            for session in sessions
            for triplet in session.triplets
            if triplet.predicate.strip()
        )

        avg_messages_per_session = (total_messages / total_sessions) if total_sessions else 0.0
        avg_triplets_per_session = (total_triplets / total_sessions) if total_sessions else 0.0

        return PileStats(
            pile_slug=dominant_category,
            scope_kind="custom" if scope_kind == "custom" else "default",
            scope_label=scope_label,
            dominant_pile_slug=dominant_category,
            total_sessions=total_sessions,
            total_messages=total_messages,
            total_triplets=total_triplets,
            latest_updated_at=latest_updated_at,
            avg_messages_per_session=avg_messages_per_session,
            avg_triplets_per_session=avg_triplets_per_session,
            notes_with_share_post=sum(1 for session in sessions if (session.share_post or "").strip()),
            notes_with_idea_summary=sum(1 for session in sessions if session.idea_summary),
            notes_with_journal_entry=sum(1 for session in sessions if (session.journal_entry or "").strip()),
            notes_with_todo_summary=sum(1 for session in sessions if (session.todo_summary or "").strip()),
            built_in_pile_counts=built_in_pile_counts,
            provider_counts=provider_counts,
            activity=activity,
            top_tags=top_tags,
            top_entities=top_entities,
            top_predicates=top_predicates,
        )

    def _build_views(
        self,
        scope_kind: str,
        scope_label: str,
        sessions: list[ChatSession],
        *,
        fallback_category: BuiltInPileSlug | None,
        related_sessions: list[ChatSession] | None = None,
        idea_projects: list[IdeaProject] | None = None,
    ) -> PileViews:
        dominant_category = self._dominant_category(sessions, fallback=fallback_category)
        normalized_scope = "custom" if scope_kind == "custom" else "default"
        return PileViews(
            pile_slug=dominant_category,
            scope_kind=normalized_scope,
            scope_label=scope_label,
            dominant_pile_slug=dominant_category,
            journal=self._journal_views(sessions) if dominant_category == BuiltInPileSlug.JOURNAL else None,
            ideas=self._idea_views(sessions, idea_projects=idea_projects) if dominant_category == BuiltInPileSlug.IDEAS else None,
            factual=(
                self._factual_views(sessions, related_sessions or sessions)
                if dominant_category == BuiltInPileSlug.FACTUAL
                else None
            ),
        )

    def _journal_views(self, sessions: list[ChatSession]) -> JournalViews:
        timeline: list[JournalTimelineItem] = []
        people: dict[str, list[tuple[ChatSession, str]]] = defaultdict(list)
        entities: dict[str, list[tuple[ChatSession, str]]] = defaultdict(list)
        activities: dict[str, list[tuple[ChatSession, str]]] = defaultdict(list)
        locations: dict[str, list[tuple[ChatSession, str]]] = defaultdict(list)

        for session in sorted(sessions, key=lambda item: datetime_sort_key(item.last_captured_at or item.updated_at)):
            payload = _structured_output(session, "journal")
            entry = _clean_label(payload.get("entry")) or _journal_entry_body(session.journal_entry)
            if not entry:
                entry = _compact_snippet(_session_text(session), max_chars=180)
            people_values = _text_list(payload.get("people"))
            entity_values = _text_list(payload.get("entities"))
            activity_values = _text_list(payload.get("activities"))
            location_values = _text_list(payload.get("locations"))
            travel_path = _text_list(payload.get("travel_path")) or location_values
            date = _date_label(session, payload.get("occurred_on"))

            item = JournalTimelineItem(
                session_id=session.id,
                title=session.title,
                provider=session.provider,
                updated_at=session.updated_at,
                occurred_on=date or None,
                entry=entry,
                mood=_clean_label(payload.get("mood")) or None,
                people=people_values,
                entities=entity_values,
                activities=activity_values,
                locations=location_values,
                travel_path=travel_path,
            )
            timeline.append(item)

            for value in people_values:
                people[value].append((session, entry))
            for value in entity_values:
                entities[value].append((session, entry))
            for value in activity_values:
                activities[value].append((session, entry))
            for value in location_values:
                locations[value].append((session, entry))

        return JournalViews(
            timeline=timeline,
            locations=self._journal_groups(locations),
            people=self._journal_groups(people),
            entities=self._journal_groups(entities),
            activities=self._journal_groups(activities),
        )

    def _journal_groups(self, groups: dict[str, list[tuple[ChatSession, str]]]) -> list[JournalGroup]:
        rows: list[JournalGroup] = []
        for label, entries in groups.items():
            session_ids = list(dict.fromkeys(session.id for session, _ in entries))
            dates = sorted(
                {
                    _date_label(session)
                    for session, _ in entries
                    if _date_label(session)
                }
            )
            snippets = [
                _compact_snippet(snippet, [label], max_chars=120)
                for _, snippet in entries
                if snippet
            ]
            rows.append(
                JournalGroup(
                    label=label,
                    count=len(session_ids),
                    session_ids=session_ids,
                    dates=dates[-4:],
                    snippets=list(dict.fromkeys(snippets))[:3],
                )
            )
        return sorted(rows, key=lambda item: (-item.count, item.label.lower()))[:24]

    def _idea_views(
        self,
        sessions: list[ChatSession],
        *,
        idea_projects: list[IdeaProject] | None = None,
    ) -> IdeaViews:
        node_inputs: list[dict[str, object]] = []
        sorted_sessions = sorted(sessions, key=lambda item: datetime_sort_key(item.updated_at))
        for session in sorted_sessions:
            payload = session.idea_summary if isinstance(session.idea_summary, dict) else _structured_output(session, "idea")
            core = _clean_label(payload.get("core_idea") or payload.get("summary"))
            if not core:
                core = _compact_snippet(_session_text(session), max_chars=180)
            if not core:
                continue
            node_inputs.append(
                {
                    "session": session,
                    "payload": payload,
                    "core": core,
                    "suggestion_text": " ".join(
                        [
                            session.title or "",
                            core,
                            _clean_label(payload.get("thread_hint")),
                            " ".join(_text_list(payload.get("related_facts"))),
                            " ".join(_text_list(payload.get("reasoning_steps"))),
                            session.share_post or "",
                        ]
                    ),
                }
            )

        suggestion_token_counts = Counter(
            token
            for item in node_inputs
            for token in _tokenize_text(str(item["suggestion_text"]))
        )

        nodes: list[IdeaEvolutionNode] = []
        for item in node_inputs:
            session = item["session"]
            assert isinstance(session, ChatSession)
            payload = item["payload"]
            assert isinstance(payload, dict)
            core = str(item["core"])

            claim_rows = [
                IdeaClaimView(
                    idea=_clean_label(item.get("idea")),
                    attributed_to=_clean_label(item.get("attributed_to")) or "User",
                    stance=_clean_label(item.get("stance")) or "proposes",
                    evidence=_clean_label(item.get("evidence")) or None,
                )
                for item in _dict_list(payload.get("attributed_ideas"))
                if _clean_label(item.get("idea"))
            ]
            if not claim_rows:
                claim_rows = [IdeaClaimView(idea=core, attributed_to="User", stance="proposes")]

            project_slug = _clean_label(payload.get("project_slug")) or None
            project_name = _clean_label(payload.get("project_name")) or None
            project_source: str | None = "defined" if project_slug or project_name else None
            if not project_slug and idea_projects:
                matched_project = best_project_match_for_text(
                    idea_projects,
                    core_idea=core,
                    thread_hint=_clean_label(payload.get("thread_hint")) or None,
                    related_facts=_text_list(payload.get("related_facts")),
                    reasoning_steps=_text_list(payload.get("reasoning_steps")),
                    evidence_text=_session_text(session),
                )
                if matched_project is not None:
                    project_slug = matched_project.slug
                    project_name = matched_project.name
                    project_source = "defined"

            if not project_slug:
                suggested_project_name = self._suggested_idea_project_name(
                    session=session,
                    payload=payload,
                    core=core,
                    token_counts=suggestion_token_counts,
                )
                project_slug = f"suggested-{slugify_project_name(suggested_project_name)}"
                project_name = suggested_project_name
                project_source = "suggested"

            nodes.append(
                IdeaEvolutionNode(
                    id=session.id,
                    session_id=session.id,
                    title=session.title,
                    provider=session.provider,
                    updated_at=session.updated_at,
                    thread=_clean_label(payload.get("thread_hint")) or None,
                    project_slug=project_slug,
                    project_name=project_name,
                    project_source=project_source,
                    core_idea=core,
                    reasoning_steps=_text_list(payload.get("reasoning_steps")),
                    related_facts=_text_list(payload.get("related_facts")),
                    claims=claim_rows,
                    next_steps=_text_list(payload.get("next_steps")),
                    share_post=session.share_post,
                )
            )

        node_by_id = {node.id: node for node in nodes}
        edges: list[IdeaEvolutionEdge] = []
        edge_keys: set[tuple[str, str, str]] = set()

        nodes_by_thread: dict[str, list[IdeaEvolutionNode]] = defaultdict(list)
        for node in nodes:
            nodes_by_thread[f"{_idea_project_label(node).casefold()}::{(node.thread or 'Unthreaded').casefold()}"].append(node)
        for thread_nodes in nodes_by_thread.values():
            thread_nodes.sort(key=lambda node: datetime_sort_key(node.updated_at))
            for left, right in zip(thread_nodes, thread_nodes[1:], strict=False):
                self._append_idea_edge(edges, edge_keys, left.id, right.id, "builds_on", "evolves into", [left.session_id, right.session_id])

        for session in sessions:
            payload = session.idea_summary if isinstance(session.idea_summary, dict) else _structured_output(session, "idea")
            source = node_by_id.get(session.id)
            if source is None:
                continue
            relation_inputs: list[tuple[str, str, str | None]] = []
            relation_inputs.extend((target, "builds_on", None) for target in _text_list(payload.get("builds_on")))
            relation_inputs.extend((target, "validates", None) for target in _text_list(payload.get("validates")))
            relation_inputs.extend((target, "validates", None) for target in _text_list(payload.get("supports")))
            relation_inputs.extend((target, "counters", None) for target in _text_list(payload.get("counters")))
            relation_inputs.extend((target, "counters", None) for target in _text_list(payload.get("conflicts_with")))
            for item in _dict_list(payload.get("relations")):
                relation_inputs.append(
                    (
                        _clean_label(item.get("target")),
                        _clean_label(item.get("relation")) or "related_to",
                        _clean_label(item.get("rationale")) or None,
                    )
                )
            for target_text, relation, rationale in relation_inputs:
                target = self._best_idea_target(target_text, nodes, source.id)
                if target is None:
                    continue
                self._append_idea_edge(
                    edges,
                    edge_keys,
                    target.id if relation == "builds_on" else source.id,
                    source.id if relation == "builds_on" else target.id,
                    relation,
                    rationale or relation.replace("_", " "),
                    [source.session_id, target.session_id],
                )

        projects = self._idea_group_counts(
            (_idea_project_label(node), node.session_id, node.core_idea, node.project_slug, node.project_source)
            for node in nodes
        )
        threads = self._idea_group_counts(
            (node.thread or "Unthreaded", node.session_id, node.core_idea)
            for node in nodes
        )
        contributors = self._idea_group_counts(
            (claim.attributed_to, node.session_id, claim.idea)
            for node in nodes
            for claim in node.claims
        )
        facts = self._idea_group_counts(
            (fact, node.session_id, node.core_idea)
            for node in nodes
            for fact in node.related_facts
        )

        return IdeaViews(nodes=nodes, edges=edges, projects=projects, threads=threads, contributors=contributors, facts=facts)

    def _append_idea_edge(
        self,
        edges: list[IdeaEvolutionEdge],
        seen: set[tuple[str, str, str]],
        source: str,
        target: str,
        relation: str,
        label: str | None,
        session_ids: list[str],
    ) -> None:
        if source == target:
            return
        key = (source, target, relation)
        if key in seen:
            return
        seen.add(key)
        edges.append(
            IdeaEvolutionEdge(
                id=f"{source}:{relation}:{target}",
                source=source,
                target=target,
                relation=relation,
                label=label,
                session_ids=list(dict.fromkeys(session_ids)),
            )
        )

    def _best_idea_target(
        self,
        target_text: str,
        nodes: list[IdeaEvolutionNode],
        source_id: str,
    ) -> IdeaEvolutionNode | None:
        cleaned = target_text.casefold().strip()
        if not cleaned:
            return None
        target_tokens = _tokenize_text(cleaned)
        candidates: list[tuple[int, IdeaEvolutionNode]] = []
        for node in nodes:
            if node.id == source_id:
                continue
            haystack = f"{node.core_idea} {node.title or ''} {node.thread or ''}".casefold()
            if cleaned in haystack or haystack in cleaned:
                candidates.append((1000, node))
                continue
            overlap = len(target_tokens & _tokenize_text(haystack))
            if overlap:
                candidates.append((overlap, node))
        if not candidates:
            return None
        candidates.sort(key=lambda item: (-item[0], datetime_sort_key(item[1].updated_at)))
        return candidates[0][1]

    def _suggested_idea_project_name(
        self,
        *,
        session: ChatSession,
        payload: dict[str, object],
        core: str,
        token_counts: Counter[str],
    ) -> str:
        thread_label = _usable_project_label(_clean_label(payload.get("thread_hint")))
        if thread_label:
            return thread_label

        for tag in visible_custom_tags(session.custom_tags):
            tag_label = _usable_project_label(tag)
            if tag_label and tag_label.casefold() != "savemycontext":
                return tag_label

        text = " ".join(
            [
                session.title or "",
                core,
                " ".join(_text_list(payload.get("related_facts"))),
                " ".join(_text_list(payload.get("reasoning_steps"))),
                " ".join(_text_list(payload.get("next_steps"))),
            ]
        )
        tokens = sorted(
            _tokenize_text(text),
            key=lambda token: (-token_counts.get(token, 0), len(token), token),
        )
        repeated_tokens = [token for token in tokens if token_counts.get(token, 0) > 1]
        chosen = repeated_tokens[:2] or tokens[:2]
        if chosen:
            return _titleize_label(" ".join(chosen))

        return "General Ideas"

    def _idea_group_counts(self, rows) -> list[JournalGroup]:
        grouped: dict[str, dict[str, object]] = {}
        for row in rows:
            label, session_id, snippet, *metadata = row
            cleaned = _clean_label(label)
            if not cleaned:
                continue
            bucket = grouped.setdefault(
                cleaned,
                {
                    "values": [],
                    "slug": None,
                    "kind": None,
                },
            )
            values = bucket["values"]
            assert isinstance(values, list)
            values.append((session_id, _clean_label(snippet)))
            if metadata:
                bucket["slug"] = bucket["slug"] or (_clean_label(metadata[0]) or None)
            if len(metadata) >= 2:
                bucket["kind"] = bucket["kind"] or (_clean_label(metadata[1]) or None)

        def sort_key(item: tuple[str, dict[str, object]]) -> tuple[int, int, str]:
            values = item[1]["values"]
            assert isinstance(values, list)
            kind = item[1].get("kind")
            kind_rank = 0 if kind == "defined" else 1 if kind == "suggested" else 2
            return (kind_rank, -len({row[0] for row in values}), item[0].lower())

        return [
            JournalGroup(
                label=label,
                count=len({session_id for session_id, _ in values}),
                session_ids=sorted({session_id for session_id, _ in values}),
                snippets=list(dict.fromkeys(snippet for _, snippet in values if snippet))[:3],
                slug=_clean_label(bucket.get("slug")) or None,
                kind=_clean_label(bucket.get("kind")) or None,
            )
            for label, bucket in sorted(grouped.items(), key=sort_key)[:24]
            for values in [bucket["values"]]
            if isinstance(values, list)
        ]

    def _factual_views(
        self,
        sessions: list[ChatSession],
        related_sessions: list[ChatSession],
    ) -> FactualViews:
        backlog: list[FactualBacklogItem] = []
        keyword_counter: Counter[str] = Counter()
        entity_counter: Counter[str] = Counter()
        linked_sources: dict[str, FactualLinkedSource] = {}
        related_lookup = [session for session in related_sessions if session.built_in_pile != BuiltInPileSlug.FACTUAL]

        for session in sorted(sessions, key=lambda item: datetime_sort_key(item.updated_at), reverse=True):
            payload = _structured_output(session, "factual")
            keywords = _text_list(payload.get("keywords"))
            entities = sorted(
                {
                    value
                    for triplet in session.triplets
                    for value in (triplet.subject.strip(), triplet.object.strip())
                    if value
                },
                key=str.lower,
            )
            if not keywords:
                keywords = sorted(
                    {
                        keyword
                        for triplet in session.triplets
                        for keyword in (getattr(triplet, "keywords", None) or [])
                    },
                    key=str.lower,
                )
            for keyword in keywords:
                keyword_counter[keyword] += 1
            for entity in entities:
                entity_counter[entity] += 1

            summary = _clean_label(payload.get("summary")) or None
            context = session.classification_reason or _compact_snippet(_session_text(session), entities[:3] or keywords[:3], max_chars=180)
            links = self._factual_links(session, entities + keywords, related_lookup)
            for link in links:
                existing = linked_sources.get(link.session_id)
                if existing is None:
                    linked_sources[link.session_id] = link
                else:
                    existing.matched_terms = sorted(set([*existing.matched_terms, *link.matched_terms]), key=str.lower)

            backlog.append(
                FactualBacklogItem(
                    session_id=session.id,
                    title=session.title,
                    provider=session.provider,
                    updated_at=session.updated_at,
                    learned_on=_date_label(session) or None,
                    summary=summary,
                    context=context,
                    keywords=keywords,
                    entities=entities,
                    triplet_count=len(session.triplets),
                    linked_from=links[:6],
                )
            )

        return FactualViews(
            backlog=backlog,
            keywords=[LabelCount(label=label, count=count) for label, count in keyword_counter.most_common(24)],
            entities=[LabelCount(label=label, count=count) for label, count in entity_counter.most_common(24)],
            linked_sources=sorted(linked_sources.values(), key=lambda item: (-(len(item.matched_terms)), item.title or ""))[:24],
        )

    def _factual_links(
        self,
        factual_session: ChatSession,
        terms: list[str],
        related_sessions: list[ChatSession],
    ) -> list[FactualLinkedSource]:
        cleaned_terms = [term for term in dict.fromkeys(_clean_label(term) for term in terms) if len(term) >= 3]
        if not cleaned_terms:
            return []
        links: list[FactualLinkedSource] = []
        for session in related_sessions:
            if session.id == factual_session.id:
                continue
            haystack = _session_text(session).casefold()
            matches = [term for term in cleaned_terms if term.casefold() in haystack]
            if not matches:
                continue
            links.append(
                FactualLinkedSource(
                    session_id=session.id,
                    title=session.title,
                    pile_slug=session.built_in_pile,
                    provider=session.provider,
                    matched_terms=matches[:6],
                )
            )
        links.sort(key=lambda item: (-len(item.matched_terms), item.title or item.session_id))
        return links

    def _build_graph(
        self,
        scope_kind: str,
        scope_label: str,
        sessions: list[ChatSession],
        *,
        fallback_category: BuiltInPileSlug | None,
    ) -> PileGraph:
        dominant_category = self._dominant_category(sessions, fallback=fallback_category)
        if dominant_category == BuiltInPileSlug.FACTUAL and all((session.built_in_pile == BuiltInPileSlug.FACTUAL) for session in sessions):
            nodes, edges = self._factual_graph(dominant_category, sessions)
        else:
            nodes, edges = self._similarity_graph(dominant_category, sessions)

        self._enrich_graph(nodes, edges)

        return PileGraph(
            pile_slug=dominant_category,
            scope_kind="custom" if scope_kind == "custom" else "default",
            scope_label=scope_label,
            dominant_pile_slug=dominant_category,
            node_count=len(nodes),
            edge_count=len(edges),
            nodes=nodes,
            edges=edges,
        )

    def _build_graph_path(
        self,
        scope_kind: str,
        scope_label: str,
        sessions: list[ChatSession],
        *,
        source: str,
        target: str,
        fallback_category: BuiltInPileSlug | None,
    ) -> PileGraphPath:
        graph = self._build_graph(scope_kind, scope_label, sessions, fallback_category=fallback_category)
        node_by_id = {node.id: node for node in graph.nodes}
        edge_by_id = {edge.id: edge for edge in graph.edges}
        paths: list[ExplorerGraphPath] = []

        if source in node_by_id and target in node_by_id and source != target:
            adjacency: dict[str, list[tuple[str, ExplorerGraphEdge]]] = defaultdict(list)
            for edge in graph.edges:
                if edge.source not in node_by_id or edge.target not in node_by_id:
                    continue
                adjacency[edge.source].append((edge.target, edge))
                adjacency[edge.target].append((edge.source, edge))

            tie_breaker = count()
            queue: list[tuple[float, int, str, list[str], list[str]]] = [(0.0, next(tie_breaker), source, [source], [])]
            seen_paths: set[tuple[str, ...]] = set()

            while queue and len(paths) < GRAPH_PATH_LIMIT:
                cost, _, node_id, node_path, edge_path = heapq.heappop(queue)
                if len(edge_path) > GRAPH_PATH_MAX_HOPS:
                    continue
                if node_id == target:
                    path_key = tuple(node_path)
                    if path_key in seen_paths:
                        continue
                    seen_paths.add(path_key)
                    path_edges = [edge_by_id[edge_id] for edge_id in edge_path if edge_id in edge_by_id]
                    evidence_session_ids = sorted({session_id for edge in path_edges for session_id in edge.session_ids})
                    score = sum(edge.weight for edge in path_edges) / max(len(path_edges), 1)
                    paths.append(
                        ExplorerGraphPath(
                            node_ids=node_path,
                            edge_ids=edge_path,
                            nodes=[node_by_id[node] for node in node_path if node in node_by_id],
                            edges=path_edges,
                            hop_count=len(edge_path),
                            score=score,
                            evidence_session_ids=evidence_session_ids,
                        )
                    )
                    continue

                if len(edge_path) >= GRAPH_PATH_MAX_HOPS:
                    continue

                for next_node_id, edge in adjacency.get(node_id, []):
                    if next_node_id in node_path:
                        continue
                    edge_cost = 1 / (max(edge.weight, 1) + 1)
                    heapq.heappush(
                        queue,
                        (
                            cost + edge_cost,
                            next(tie_breaker),
                            next_node_id,
                            [*node_path, next_node_id],
                            [*edge_path, edge.id],
                        ),
                    )

        return PileGraphPath(
            pile_slug=graph.pile_slug,
            scope_kind=graph.scope_kind,
            scope_label=graph.scope_label,
            dominant_pile_slug=graph.dominant_pile_slug,
            source=source,
            target=target,
            paths=paths,
        )

    def _enrich_graph(self, nodes: list[ExplorerGraphNode], edges: list[ExplorerGraphEdge]) -> None:
        node_by_id = {node.id: node for node in nodes}
        weighted_adjacency: dict[str, dict[str, int]] = {node.id: {} for node in nodes}

        for edge in edges:
            if edge.source not in node_by_id or edge.target not in node_by_id or edge.source == edge.target:
                continue
            weight = max(edge.weight, 1)
            weighted_adjacency[edge.source][edge.target] = weighted_adjacency[edge.source].get(edge.target, 0) + weight
            weighted_adjacency[edge.target][edge.source] = weighted_adjacency[edge.target].get(edge.source, 0) + weight
            edge.evidence_count = max(edge.evidence_count, len(edge.evidence) or len(edge.session_ids))

        community_by_node_id = self._detect_communities(nodes, weighted_adjacency)
        community_label_by_id = self._community_labels(nodes, weighted_adjacency, community_by_node_id)
        denominator = max(len(nodes) - 1, 1)

        for node in nodes:
            degree = len(weighted_adjacency.get(node.id, {}))
            node.degree = degree
            node.centrality = round(degree / denominator, 4)
            node.evidence_count = max(node.evidence_count, len(node.evidence) or len(node.session_ids))
            community_id = community_by_node_id.get(node.id) or "community:peripheral"
            node.community_id = community_id
            node.community_label = community_label_by_id.get(community_id, community_id.removeprefix("community:"))

    def _detect_communities(
        self,
        nodes: list[ExplorerGraphNode],
        adjacency: dict[str, dict[str, int]],
    ) -> dict[str, str]:
        communities = {node.id: node.id for node in nodes}
        ranked_nodes = sorted(
            nodes,
            key=lambda node: (
                -len(adjacency.get(node.id, {})),
                -len(node.session_ids),
                node.label.lower(),
            ),
        )

        for _ in range(10):
            changed = False
            for node in ranked_nodes:
                neighbors = adjacency.get(node.id, {})
                if not neighbors:
                    if communities.get(node.id) != "peripheral":
                        communities[node.id] = "peripheral"
                        changed = True
                    continue

                scores: Counter[str] = Counter()
                for neighbor_id, weight in neighbors.items():
                    scores[communities.get(neighbor_id, neighbor_id)] += weight

                current = communities.get(node.id, node.id)
                best, best_score = max(
                    scores.items(),
                    key=lambda item: (item[1], item[0] == current, item[0]),
                )
                if best != current and best_score >= scores.get(current, 0):
                    communities[node.id] = best
                    changed = True

            if not changed:
                break

        return {node_id: f"community:{community_id}" for node_id, community_id in communities.items()}

    def _community_labels(
        self,
        nodes: list[ExplorerGraphNode],
        adjacency: dict[str, dict[str, int]],
        community_by_node_id: dict[str, str],
    ) -> dict[str, str]:
        nodes_by_community: dict[str, list[ExplorerGraphNode]] = defaultdict(list)
        for node in nodes:
            nodes_by_community[community_by_node_id.get(node.id, "community:peripheral")].append(node)

        labels: dict[str, str] = {}
        for community_id, community_nodes in nodes_by_community.items():
            if community_id == "community:peripheral":
                labels[community_id] = "Peripheral facts"
                continue

            anchors = sorted(
                community_nodes,
                key=lambda node: (
                    -(len(adjacency.get(node.id, {})) * 5 + len(node.session_ids) * 4 + log(node.size + 1) * 6),
                    node.label.lower(),
                ),
            )[:2]
            labels[community_id] = " + ".join(node.label for node in anchors) if anchors else "Community"
        return labels

    def _dominant_category(
        self,
        sessions: list[ChatSession],
        *,
        fallback: BuiltInPileSlug | None = None,
    ) -> BuiltInPileSlug:
        counts = Counter(session.built_in_pile for session in sessions if session.built_in_pile is not None)
        if counts:
            return counts.most_common(1)[0][0]
        return fallback or BuiltInPileSlug.FACTUAL

    def _activity_buckets(
        self,
        sessions: list[ChatSession],
        latest_updated_at,
    ) -> list[ActivityBucket]:
        if latest_updated_at is None:
            return []

        latest_day = latest_updated_at.date()
        counts = Counter(session.updated_at.date().isoformat() for session in sessions if session.updated_at is not None)
        buckets: list[ActivityBucket] = []
        for offset in range(13, -1, -1):
            day = (latest_day - timedelta(days=offset)).isoformat()
            buckets.append(ActivityBucket(bucket=day, count=counts.get(day, 0)))
        return buckets

    def _label_counts(self, labels) -> list[LabelCount]:
        counter = Counter(label.strip() for label in labels if label and label.strip())
        return [
            LabelCount(label=label, count=count)
            for label, count in counter.most_common(8)
        ]

    def _factual_graph(
        self,
        category: BuiltInPileSlug,
        sessions: list[ChatSession],
    ) -> tuple[list[ExplorerGraphNode], list[ExplorerGraphEdge]]:
        node_sessions: dict[str, set[str]] = defaultdict(set)
        node_degrees: Counter[str] = Counter()
        node_labels: dict[str, str] = {}
        edge_sessions: dict[tuple[str, str, str], set[str]] = defaultdict(set)
        node_evidence: dict[str, list[ExplorerGraphEvidence]] = defaultdict(list)
        edge_evidence: dict[tuple[str, str, str], list[ExplorerGraphEvidence]] = defaultdict(list)

        for session in sessions:
            for triplet in session.triplets:
                source = entity_id(triplet.subject)
                target = entity_id(triplet.object)
                edge_key = (source, triplet.predicate, target)
                evidence = _session_evidence(
                    session,
                    triplet=triplet,
                    predicate=triplet.predicate,
                    snippet=_triplet_snippet(triplet.subject, triplet.predicate, triplet.object),
                )
                node_labels[source] = triplet.subject
                node_labels[target] = triplet.object
                node_sessions[source].add(session.id)
                node_sessions[target].add(session.id)
                node_degrees[source] += 1
                node_degrees[target] += 1
                edge_sessions[edge_key].add(session.id)
                node_evidence[source].append(evidence)
                node_evidence[target].append(evidence)
                edge_evidence[edge_key].append(evidence)

        ranked_nodes = sorted(node_degrees.items(), key=lambda item: (-item[1], node_labels.get(item[0], item[0]).lower()))[:FACTUAL_GRAPH_NODE_LIMIT]
        allowed_node_ids = {node_id for node_id, _ in ranked_nodes}

        nodes = [
            ExplorerGraphNode(
                id=node_id,
                label=node_labels[node_id],
                kind="entity",
                size=degree,
                session_ids=sorted(node_sessions[node_id]),
                pile_slug=category,
                note_path=entity_note_path(node_labels[node_id]),
                evidence_count=len(node_evidence[node_id]),
                evidence=node_evidence[node_id][:5],
            )
            for node_id, degree in ranked_nodes
        ]

        edges = [
            ExplorerGraphEdge(
                id=f"{source}:{predicate}:{target}",
                source=source,
                target=target,
                label=predicate,
                weight=len(session_ids),
                session_ids=sorted(session_ids),
                evidence_count=len(edge_evidence[(source, predicate, target)]),
                evidence=edge_evidence[(source, predicate, target)][:5],
            )
            for (source, predicate, target), session_ids in sorted(
                edge_sessions.items(),
                key=lambda item: (-len(item[1]), item[0][1], item[0][0], item[0][2]),
            )
            if source in allowed_node_ids and target in allowed_node_ids
        ][:FACTUAL_GRAPH_EDGE_LIMIT]

        return nodes, edges

    def _similarity_graph(
        self,
        category: BuiltInPileSlug,
        sessions: list[ChatSession],
    ) -> tuple[list[ExplorerGraphNode], list[ExplorerGraphEdge]]:
        tokens_by_session = {session.id: _tokenize_text(_session_text(session)) for session in sessions}
        session_by_id = {session.id: session for session in sessions}

        nodes = [
            ExplorerGraphNode(
                id=session.id,
                label=session.title or session.external_session_id,
                kind="session",
                size=max(len(session.messages), 1),
                session_ids=[session.id],
                provider=session.provider,
                pile_slug=category,
                updated_at=session.updated_at,
                note_path=session.markdown_path,
                evidence_count=1,
                evidence=[
                    _session_evidence(
                        session,
                        snippet=_compact_snippet(_session_text(session), [session.title or session.external_session_id]),
                    )
                ],
            )
            for session in sessions[:SIMILARITY_GRAPH_NODE_LIMIT]
        ]
        visible_ids = {node.id for node in nodes}

        edges: list[ExplorerGraphEdge] = []
        visible_sessions = [session for session in sessions if session.id in visible_ids]
        for index, left in enumerate(visible_sessions):
            left_tokens = tokens_by_session.get(left.id, set())
            if not left_tokens:
                continue
            for right in visible_sessions[index + 1 :]:
                shared = sorted(left_tokens & tokens_by_session.get(right.id, set()))
                if len(shared) < 2:
                    continue
                label = ", ".join(shared[:3])
                edges.append(
                    ExplorerGraphEdge(
                        id=f"{left.id}:{right.id}",
                        source=left.id,
                        target=right.id,
                        label=label,
                        weight=min(len(shared), 8),
                        session_ids=[left.id, right.id],
                        predicate_count=len(shared),
                        evidence_count=2,
                        evidence=[
                            _session_evidence(
                                session_by_id[left.id],
                                snippet=_compact_snippet(_session_text(session_by_id[left.id]), shared[:3]),
                            ),
                            _session_evidence(
                                session_by_id[right.id],
                                snippet=_compact_snippet(_session_text(session_by_id[right.id]), shared[:3]),
                            ),
                        ],
                    )
                )

        edges.sort(key=lambda edge: (-edge.weight, edge.label or "", edge.source, edge.target))
        return nodes, edges[:SIMILARITY_GRAPH_EDGE_LIMIT]
