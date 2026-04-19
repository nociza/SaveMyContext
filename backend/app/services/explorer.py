from __future__ import annotations

from collections import Counter, defaultdict
from datetime import timedelta
import heapq
from itertools import count
from math import log
from pathlib import Path
import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.models import ChatSession, ProviderName, SessionCategory
from app.schemas.explorer import (
    ActivityBucket,
    CategoryGraph,
    CategoryGraphPath,
    CategorySystemCount,
    CategoryStats,
    ExplorerGraphEvidence,
    ExplorerGraphEdge,
    ExplorerGraphNode,
    ExplorerGraphPath,
    LabelCount,
    ProviderCount,
)
from app.services.graph import entity_id, entity_note_path
from app.services.user_categories import has_user_category, summarize_user_categories, visible_custom_tags


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
        for key in ("pros", "cons", "next_steps"):
            value = session.idea_summary.get(key)
            if isinstance(value, list):
                parts.extend(str(item) for item in value)
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
        category: SessionCategory,
        *,
        session_ids: list[str] | None = None,
        provider: ProviderName | None = None,
    ) -> CategoryStats:
        sessions = await self._sessions(category, session_ids=session_ids, provider=provider)
        return self._build_stats("default", category.value, sessions, fallback_category=category)

    async def custom_category_stats(
        self,
        name: str,
        *,
        session_ids: list[str] | None = None,
        provider: ProviderName | None = None,
    ) -> CategoryStats:
        sessions = await self._sessions_for_user_category(name, session_ids=session_ids, provider=provider)
        return self._build_stats("custom", name, sessions, fallback_category=self._dominant_category(sessions))

    async def category_graph(
        self,
        category: SessionCategory,
        *,
        session_ids: list[str] | None = None,
        provider: ProviderName | None = None,
    ) -> CategoryGraph:
        sessions = await self._sessions(category, session_ids=session_ids, provider=provider)
        return self._build_graph("default", category.value, sessions, fallback_category=category)

    async def custom_category_graph(
        self,
        name: str,
        *,
        session_ids: list[str] | None = None,
        provider: ProviderName | None = None,
    ) -> CategoryGraph:
        sessions = await self._sessions_for_user_category(name, session_ids=session_ids, provider=provider)
        return self._build_graph("custom", name, sessions, fallback_category=self._dominant_category(sessions))

    async def category_graph_path(
        self,
        category: SessionCategory,
        *,
        source: str,
        target: str,
        session_ids: list[str] | None = None,
        provider: ProviderName | None = None,
    ) -> CategoryGraphPath:
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
    ) -> CategoryGraphPath:
        sessions = await self._sessions_for_user_category(name, session_ids=session_ids, provider=provider)
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
        category: SessionCategory,
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
            .where(ChatSession.category == category)
            .order_by(ChatSession.updated_at.desc())
        )
        if session_ids:
            statement = statement.where(ChatSession.id.in_(session_ids))
        if provider:
            statement = statement.where(ChatSession.provider == provider)

        result = await self.db.execute(statement)
        return list(result.scalars().unique().all())

    async def _sessions_for_user_category(
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
        return [session for session in sessions if has_user_category(session.custom_tags, name)]

    def user_category_summaries(self, sessions: list[ChatSession]) -> list[tuple[str, int]]:
        return summarize_user_categories([session.custom_tags for session in sessions])

    def _build_stats(
        self,
        scope_kind: str,
        scope_label: str,
        sessions: list[ChatSession],
        *,
        fallback_category: SessionCategory | None,
    ) -> CategoryStats:
        dominant_category = self._dominant_category(sessions, fallback=fallback_category)
        total_sessions = len(sessions)
        total_messages = sum(len(session.messages) for session in sessions)
        total_triplets = sum(len(session.triplets) for session in sessions)
        latest_updated_at = max((session.updated_at for session in sessions), default=None)

        provider_counts = [
            ProviderCount(provider=provider, count=count)
            for provider, count in sorted(Counter(session.provider for session in sessions).items(), key=lambda item: item[0].value)
        ]
        system_category_counts = [
            CategorySystemCount(category=category, count=count)
            for category, count in sorted(
                Counter(session.category for session in sessions if session.category is not None).items(),
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

        return CategoryStats(
            category=dominant_category,
            scope_kind="custom" if scope_kind == "custom" else "default",
            scope_label=scope_label,
            dominant_category=dominant_category,
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
            system_category_counts=system_category_counts,
            provider_counts=provider_counts,
            activity=activity,
            top_tags=top_tags,
            top_entities=top_entities,
            top_predicates=top_predicates,
        )

    def _build_graph(
        self,
        scope_kind: str,
        scope_label: str,
        sessions: list[ChatSession],
        *,
        fallback_category: SessionCategory | None,
    ) -> CategoryGraph:
        dominant_category = self._dominant_category(sessions, fallback=fallback_category)
        if dominant_category == SessionCategory.FACTUAL and all((session.category == SessionCategory.FACTUAL) for session in sessions):
            nodes, edges = self._factual_graph(dominant_category, sessions)
        else:
            nodes, edges = self._similarity_graph(dominant_category, sessions)

        self._enrich_graph(nodes, edges)

        return CategoryGraph(
            category=dominant_category,
            scope_kind="custom" if scope_kind == "custom" else "default",
            scope_label=scope_label,
            dominant_category=dominant_category,
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
        fallback_category: SessionCategory | None,
    ) -> CategoryGraphPath:
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

        return CategoryGraphPath(
            category=graph.category,
            scope_kind=graph.scope_kind,
            scope_label=graph.scope_label,
            dominant_category=graph.dominant_category,
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
        fallback: SessionCategory | None = None,
    ) -> SessionCategory:
        counts = Counter(session.category for session in sessions if session.category is not None)
        if counts:
            return counts.most_common(1)[0][0]
        return fallback or SessionCategory.FACTUAL

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
        category: SessionCategory,
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
                category=category,
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
        category: SessionCategory,
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
                category=category,
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
