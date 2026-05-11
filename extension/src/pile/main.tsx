import { useEffect, useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import * as Tabs from "@radix-ui/react-tabs";
import {
  Activity,
  ArrowLeft,
  BookOpen,
  BrainCircuit,
  Clock3,
  Database,
  ExternalLink,
  Filter,
  GitBranch,
  Layers,
  Lightbulb,
  ListChecks,
  MapPin,
  Plus,
  Search,
  Sparkles,
  Tags,
  Users,
  Workflow,
  X
} from "lucide-react";

import {
  fetchPileGraph,
  fetchPileGraphPath,
  fetchPileStats,
  fetchPileViews,
  createIdeaProject,
  deleteIdeaProject,
  fetchCustomPileGraph,
  fetchCustomPileGraphPath,
  fetchCustomPileStats,
  fetchCustomPileViews,
  fetchIdeaProjects,
  fetchExplorerSearch,
  fetchSessionNote,
  fetchSessions,
  fetchTodoList,
  fetchExtraPiles,
  updateSessionExtraPiles,
  updateTodoList
} from "../background/backend";
import {
  displayPileLabel,
  pileGlyphs,
  pileDescriptions,
  pileLabels,
  pileOrder,
  pilePalette,
  formatCompactDate,
  formatLongDate,
  notePageUrl,
  parsePile,
  parsePileWorkspaceView,
  parseProvider,
  parseSortMode,
  providerColors,
  providerLabels,
  titleFromSession,
  type PileSortMode,
  type PileWorkspaceView
} from "../shared/explorer";
import type {
  BackendPileGraph,
  BackendPileGraphPath,
  BackendPileStats,
  BackendPileViews,
  BackendExplorerGraphEvidence,
  BackendExplorerGraphNode,
  BackendExplorerGraphPath,
  BackendSearchResponse,
  BackendSessionListItem,
  BackendSessionNoteRead,
  BackendTodoItem,
  BackendExtraPileSummary,
  BackendIdeaProjectRead,
  ExtensionSettings,
  ProviderName,
  BuiltInPileSlug
} from "../shared/types";
import { mountApp } from "../ui/boot";
import { Badge } from "../ui/components/badge";
import { Button } from "../ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/components/card";
import { CategoryWorkspace, type InformationDetail } from "../ui/components/category-workspaces";
import { PileGraph, type PileGraphDensity, type PileGraphFocusMode, type PileGraphSelection } from "../ui/components/pile-graph";
import { ScrollArea } from "../ui/components/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/components/select";
import { TodoWorkspace } from "../ui/components/todo-workspace";
import { formatNumber, formatPercent } from "../ui/lib/format";
import { MarkdownView, NoteOverview, TranscriptView } from "../ui/lib/notes";
import { buildPileGraphInsights, type GraphGroupingMode } from "../ui/lib/pile-graph-insights";
import { useDebouncedValue, useExtensionBootstrap } from "../ui/lib/runtime";

type RouteState = {
  pile: BuiltInPileSlug;
  q: string;
  provider: ProviderName | null;
  accountKey: string | null;
  sort: PileSortMode;
  view: PileWorkspaceView;
  panel: PilePanelView;
  bucket: string | null;
  project: string | null;
  note: string | null;
  extraPile: string | null;
};

type PilePanelView = "workspace" | "notes" | "reader";

type GraphFocus = {
  label: string;
  sessionIds: string[];
};

function parsePilePanel(value: string | null): PilePanelView {
  return value === "notes" || value === "reader" ? value : "workspace";
}

function readRouteState(): RouteState {
  const params = new URLSearchParams(window.location.search);
  return {
    pile: parsePile(params.get("pile")),
    q: params.get("q")?.trim() ?? "",
    provider: parseProvider(params.get("provider")),
    accountKey: params.get("account")?.trim() ?? null,
    sort: parseSortMode(params.get("sort")),
    view: parsePileWorkspaceView(params.get("view")),
    panel: parsePilePanel(params.get("panel")),
    bucket: params.get("bucket")?.trim() ?? null,
    project: params.get("project")?.trim() ?? null,
    note: params.get("note"),
    extraPile: params.get("extraPile")?.trim() ?? null
  };
}

function writeRouteState(state: RouteState, push = true): void {
  const url = new URL(window.location.href);
  url.searchParams.set("pile", state.pile);
  if (state.q.trim()) {
    url.searchParams.set("q", state.q.trim());
  } else {
    url.searchParams.delete("q");
  }
  if (state.provider) {
    url.searchParams.set("provider", state.provider);
  } else {
    url.searchParams.delete("provider");
  }
  if (state.accountKey?.trim()) {
    url.searchParams.set("account", state.accountKey.trim());
  } else {
    url.searchParams.delete("account");
  }
  if (state.sort !== "recent") {
    url.searchParams.set("sort", state.sort);
  } else {
    url.searchParams.delete("sort");
  }
  if (state.view !== "atlas") {
    url.searchParams.set("view", state.view);
  } else {
    url.searchParams.delete("view");
  }
  if (state.panel !== "workspace") {
    url.searchParams.set("panel", state.panel);
  } else {
    url.searchParams.delete("panel");
  }
  if (state.bucket) {
    url.searchParams.set("bucket", state.bucket);
  } else {
    url.searchParams.delete("bucket");
  }
  if (state.project?.trim()) {
    url.searchParams.set("project", state.project.trim());
  } else {
    url.searchParams.delete("project");
  }
  if (state.note) {
    url.searchParams.set("note", state.note);
  } else {
    url.searchParams.delete("note");
  }
  if (state.extraPile?.trim()) {
    url.searchParams.set("extraPile", state.extraPile.trim());
  } else {
    url.searchParams.delete("extraPile");
  }

  if (push) {
    window.history.pushState(null, "", url);
  } else {
    window.history.replaceState(null, "", url);
  }
}

function createEmptyStats(pile: BuiltInPileSlug): BackendPileStats {
  return {
    pile_slug: pile,
    scope_kind: "default",
    scope_label: pileLabels[pile],
    dominant_pile_slug: pile,
    total_sessions: 0,
    total_messages: 0,
    total_triplets: 0,
    latest_updated_at: null,
    avg_messages_per_session: 0,
    avg_triplets_per_session: 0,
    notes_with_share_post: 0,
    notes_with_idea_summary: 0,
    notes_with_journal_entry: 0,
    notes_with_todo_summary: 0,
    built_in_pile_counts: [{ pile_slug: pile, count: 0 }],
    provider_counts: [],
    account_counts: [],
    activity: [],
    top_tags: [],
    top_entities: [],
    top_predicates: []
  };
}

function createEmptyGraph(pile: BuiltInPileSlug): BackendPileGraph {
  return {
    pile_slug: pile,
    scope_kind: "default",
    scope_label: pileLabels[pile],
    dominant_pile_slug: pile,
    node_count: 0,
    edge_count: 0,
    nodes: [],
    edges: []
  };
}

function sortSessions(items: BackendSessionListItem[], sortMode: PileSortMode): BackendSessionListItem[] {
  const sorted = [...items];
  if (sortMode === "title") {
    sorted.sort((left, right) => titleFromSession(left).localeCompare(titleFromSession(right)));
    return sorted;
  }

  sorted.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  return sorted;
}

function searchMatchMap(search: BackendSearchResponse | undefined): Map<string, { snippet: string; kind: string }> {
  const matches = new Map<string, { snippet: string; kind: string }>();
  for (const result of search?.results ?? []) {
    if (!result.session_id || matches.has(result.session_id)) {
      continue;
    }
    matches.set(result.session_id, {
      snippet: result.snippet,
      kind: result.kind
    });
  }
  return matches;
}

function sessionAccountKey(session: BackendSessionListItem): string {
  return session.account_key || `${session.provider}:default`;
}

function sessionAccountLabel(session: BackendSessionListItem): string {
  if (session.account_label) {
    return session.account_label;
  }
  const suffix = sessionAccountKey(session).split(":").slice(1).join(":");
  return suffix && suffix !== "default" ? suffix : `${providerLabels[session.provider]} account`;
}

function signalGroups(stats: BackendPileStats): {
  primary: Array<{ label: string; count: number }>;
  secondary: Array<{ label: string; count: number }>;
} {
  if (stats.pile_slug === "factual") {
    return {
      primary: stats.top_entities,
      secondary: stats.top_predicates
    };
  }

  return {
    primary: stats.top_tags,
    secondary: [
      {
        label: stats.pile_slug === "ideas" ? "Summaries" : stats.pile_slug === "journal" ? "Entries" : "Task updates",
        count:
          stats.pile_slug === "ideas"
            ? stats.notes_with_idea_summary
            : stats.pile_slug === "journal"
              ? stats.notes_with_journal_entry
              : stats.notes_with_todo_summary
      },
      { label: "Share posts", count: stats.notes_with_share_post }
    ]
  };
}

function sessionPreviewText(
  session: BackendSessionListItem,
  match: { snippet: string; kind: string } | undefined,
  pile: string
): string {
  if (match?.snippet) {
    return match.snippet;
  }
  if (session.share_post) {
    return session.share_post;
  }
  if (pile === "todo") {
    return "Open this saved update to see how the shared checklist changed.";
  }
  return "Open to inspect this note.";
}

function sessionDetailKind(pile: string): InformationDetail["kind"] {
  if (pile === "journal") {
    return "Journal";
  }
  if (pile === "ideas") {
    return "Idea";
  }
  if (pile === "todo") {
    return "Todo";
  }
  if (pile === "factual") {
    return "Fact";
  }
  return "Content";
}

function sessionInformationDetail(
  session: BackendSessionListItem,
  match: { snippet: string; kind: string } | undefined,
  pile: string
): InformationDetail {
  return {
    kind: sessionDetailKind(pile),
    title: titleFromSession(session),
    summary: sessionPreviewText(session, match, pile),
    accountKey: session.account_key,
    accountLabel: sessionAccountLabel(session),
    provider: session.provider,
    date: session.updated_at,
    sourceTitle: titleFromSession(session),
    sessionIds: [session.id],
    chips: [providerLabels[session.provider], displayPileLabel(session.pile_slug ?? pile), ...(session.extra_piles ?? [])]
  };
}

function formatBucketLabel(bucket: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(bucket)) {
    const parsed = new Date(`${bucket}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }
  }

  if (/^\d{4}-\d{2}$/.test(bucket)) {
    const parsed = new Date(`${bucket}-01T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleDateString(undefined, { month: "short", year: "numeric" });
    }
  }

  return bucket;
}

function buildActivityBuckets(sessions: BackendSessionListItem[]): Array<{ bucket: string; count: number; label: string }> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const bucket = session.updated_at.slice(0, 10);
    if (!bucket) {
      continue;
    }
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-12)
    .map(([bucket, count]) => ({
      bucket,
      count,
      label: formatBucketLabel(bucket)
    }));
}

function noteListMeta(
  route: RouteState,
  total: number,
  visible: number,
  focus: GraphFocus | null,
  displayPile: BuiltInPileSlug
): string {
  const providerText = route.provider ? ` in ${providerLabels[route.provider]}` : "";
  const bucketText = route.bucket ? ` · ${formatBucketLabel(route.bucket)}` : "";
  const extraPileText = route.extraPile ? ` · collection ${route.extraPile}` : "";
  const noteLabel = displayPile === "todo" ? "update notes" : "notes";
  if (focus) {
    return `${formatNumber(visible)} ${noteLabel} linked to ${focus.label}${bucketText}${extraPileText}`;
  }
  if (route.q) {
    return `${formatNumber(visible)} matches for "${route.q}" from ${formatNumber(total)} ${noteLabel}${providerText}${bucketText}${extraPileText}`;
  }
  return `${formatNumber(total)} ${noteLabel} in view${providerText}${bucketText}${extraPileText}`;
}

function graphGroupingLabel(mode: GraphGroupingMode): string {
  if (mode === "community") {
    return "Topic communities";
  }
  if (mode === "provider") {
    return "Source provider";
  }
  return "Entity type";
}

function graphDensityLabel(density: PileGraphDensity): string {
  return density === "curated" ? "Curated graph" : "Complete graph";
}

function graphFocusModeLabel(mode: PileGraphFocusMode): string {
  return mode === "context" ? "Focused context" : "Dim outside focus";
}

function graphNodeOptionScore(node: BackendExplorerGraphNode): number {
  return (node.degree ?? 0) * 8 + node.session_ids.length * 5 + (node.centrality ?? 0) * 10 + Math.log(node.size + 1) * 3;
}

function evidenceKey(evidence: BackendExplorerGraphEvidence): string {
  return [evidence.triplet_id, evidence.session_id, evidence.predicate, evidence.snippet].filter(Boolean).join(":");
}

function evidenceForSelection(graph: BackendPileGraph, selection: PileGraphSelection | null): BackendExplorerGraphEvidence[] {
  if (!selection) {
    return [];
  }

  const sessionSet = new Set(selection.sessionIds);
  const evidence =
    selection.kind === "node"
      ? (graph.nodes.find((node) => node.id === selection.id)?.evidence ?? [])
      : graph.edges
          .filter((edge) => edge.session_ids.some((sessionId) => sessionSet.has(sessionId)))
          .filter((edge) => !selection.label || selection.label === "Relationship" || selection.label.includes(edge.label ?? ""))
          .flatMap((edge) => edge.evidence ?? []);

  const seen = new Set<string>();
  const unique: BackendExplorerGraphEvidence[] = [];
  for (const item of evidence) {
    const key = evidenceKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function GraphEvidencePanel({
  graph,
  selection,
  onClear
}: {
  graph: BackendPileGraph;
  selection: PileGraphSelection | null;
  onClear: () => void;
}) {
  const selectedNode = selection?.kind === "node" ? graph.nodes.find((node) => node.id === selection.id) ?? null : null;
  const evidence = evidenceForSelection(graph, selection);

  return (
    <div className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-2.5">
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-soft)]">Evidence</div>
          <div className="mt-0.5 truncate text-sm font-semibold text-[var(--color-ink)]">
            {selection ? selection.label : "Select a node or link"}
          </div>
        </div>
        {selection ? (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={onClear}>
            Clear
          </Button>
        ) : null}
      </div>

      {selectedNode ? (
        <div className="mb-1.5 grid grid-cols-3 gap-1">
          {[
            { label: "Links", value: formatNumber(selectedNode.degree ?? 0) },
            { label: "Notes", value: formatNumber(selectedNode.session_ids.length) },
            { label: "Score", value: `${Math.round((selectedNode.centrality ?? 0) * 100)}%` }
          ].map((metric) => (
            <div key={metric.label} className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-2 py-1">
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">{metric.label}</div>
              <div className="mt-1 text-sm font-semibold text-[var(--color-ink)]">{metric.value}</div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="space-y-1.5">
        {evidence.slice(0, 2).map((item, index) => (
          <div key={`${evidenceKey(item)}:${index}`} className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold text-[var(--color-ink)]">{item.title || "Untitled note"}</div>
                <div className="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">
                  {item.provider ? providerLabels[item.provider] : "source"} · {formatCompactDate(item.updated_at, "No date")}
                </div>
              </div>
              {typeof item.confidence === "number" ? <Badge tone="info">{Math.round(item.confidence * 100)}%</Badge> : null}
            </div>
            {item.snippet ? <p className="mt-1 line-clamp-1 text-xs leading-5 text-[var(--color-ink-soft)]">{item.snippet}</p> : null}
          </div>
        ))}
        {!selection ? <p className="text-xs leading-5 text-[var(--color-ink-soft)]">Click a node or link for source notes and extracted facts.</p> : null}
        {selection && !evidence.length ? <p className="text-xs leading-5 text-[var(--color-ink-soft)]">No snippets are available for this selection yet.</p> : null}
      </div>
    </div>
  );
}

function GraphPathPanel({
  nodes,
  sourceId,
  targetId,
  path,
  loading,
  error,
  onSourceChange,
  onTargetChange,
  onFocusPath
}: {
  nodes: BackendExplorerGraphNode[];
  sourceId: string | null;
  targetId: string | null;
  path: BackendPileGraphPath | null;
  loading: boolean;
  error: Error | null;
  onSourceChange: (nodeId: string) => void;
  onTargetChange: (nodeId: string) => void;
  onFocusPath: (path: BackendExplorerGraphPath) => void;
}) {
  const canSearch = nodes.length >= 2 && sourceId && targetId && sourceId !== targetId;
  const paths = path?.paths ?? [];

  return (
    <div className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-soft)]">Path finder</div>
      <div className="mt-0.5 text-sm font-semibold text-[var(--color-ink)]">Connect two concepts</div>

      <div className="mt-2 grid gap-1.5">
        <Select value={sourceId ?? ""} onValueChange={onSourceChange} disabled={!nodes.length}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            {nodes.map((node) => (
              <SelectItem key={node.id} value={node.id} className="py-1.5 text-xs">
                {node.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={targetId ?? ""} onValueChange={onTargetChange} disabled={!nodes.length}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Target" />
          </SelectTrigger>
          <SelectContent>
            {nodes.map((node) => (
              <SelectItem key={node.id} value={node.id} className="py-1.5 text-xs">
                {node.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-2 space-y-1.5">
        {nodes.length < 2 ? <p className="text-xs leading-5 text-[var(--color-ink-soft)]">At least two visible concepts are needed.</p> : null}
        {loading ? <p className="text-xs text-[var(--color-ink-soft)]">Finding paths...</p> : null}
        {error && canSearch ? <p className="text-xs text-[#963c24]">{error.message}</p> : null}
        {paths.slice(0, 2).map((item, index) => (
          <button
            key={`${item.node_ids.join(":")}:${index}`}
            type="button"
            onClick={() => onFocusPath(item)}
            className="w-full rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-1.5 text-left transition hover:bg-[var(--color-paper-sunken)]"
          >
            <div className="line-clamp-1 text-xs font-semibold leading-5 text-[var(--color-ink)]">
              {item.nodes.map((node) => node.label).join(" -> ")}
            </div>
            <div className="mt-1 text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">
              {formatNumber(item.hop_count)} hops · strength {item.score.toFixed(1)} · {formatNumber(item.evidence_session_ids.length)} notes
            </div>
          </button>
        ))}
        {path && !paths.length && canSearch ? (
          <p className="text-xs leading-5 text-[var(--color-ink-soft)]">No visible path connects those concepts.</p>
        ) : null}
      </div>
    </div>
  );
}

function App() {
  const { settings, status, loading, error } = useExtensionBootstrap();
  const [route, setRoute] = useState<RouteState>(readRouteState);
  const [graphFocus, setGraphFocus] = useState<GraphFocus | null>(null);
  const [informationDetail, setInformationDetail] = useState<InformationDetail | null>(null);
  const [graphInspect, setGraphInspect] = useState<PileGraphSelection | null>(null);
  const [readerTab, setReaderTab] = useState<"overview" | "transcript" | "markdown">("overview");
  const [groupingMode, setGroupingMode] = useState<GraphGroupingMode>("community");
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const [graphDensity, setGraphDensity] = useState<PileGraphDensity>("curated");
  const [graphFocusMode, setGraphFocusMode] = useState<PileGraphFocusMode>("context");
  const [graphProviderFilter, setGraphProviderFilter] = useState<ReadonlySet<ProviderName>>(() => new Set());
  const [graphKindFilter, setGraphKindFilter] = useState<ReadonlySet<string>>(() => new Set());
  const [pathSourceId, setPathSourceId] = useState<string | null>(null);
  const [pathTargetId, setPathTargetId] = useState<string | null>(null);
  const [todoDraft, setTodoDraft] = useState("");
  const [todoActionError, setTodoActionError] = useState<string | null>(null);
  const [todoSavingSummary, setTodoSavingSummary] = useState<string | null>(null);
  const [extraPileDraft, setExtraPileDraft] = useState("");
  const [extraPileError, setExtraPileError] = useState<string | null>(null);
  const [ideaProjectNameDraft, setIdeaProjectNameDraft] = useState("");
  const [ideaProjectDescriptionDraft, setIdeaProjectDescriptionDraft] = useState("");
  const [ideaProjectError, setIdeaProjectError] = useState<string | null>(null);
  const [ideaProjectSaving, setIdeaProjectSaving] = useState(false);
  const debouncedQuery = useDebouncedValue(route.q);
  const isCustomScope = Boolean(route.extraPile);
  const usesCategoryWorkspace = !isCustomScope && route.pile !== "todo" && route.pile !== "discarded";

  useEffect(() => {
    const handlePopState = (): void => {
      setRoute(readRouteState());
      setGraphFocus(null);
      setInformationDetail(null);
      setGraphInspect(null);
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  function updateRoute(next: Partial<RouteState>, push = true): void {
    setRoute((current) => {
      const updated = { ...current, ...next };
      writeRouteState(updated, push);
      return updated;
    });
  }

  const sessionsQuery = useQuery({
    queryKey: ["pile-sessions", settings?.backendUrl, settings?.backendToken, route.pile, route.provider, route.accountKey, route.extraPile],
    queryFn: () =>
      fetchSessions(
        settings as ExtensionSettings,
        route.provider || route.accountKey || route.extraPile
          ? {
              pile: isCustomScope ? undefined : route.pile,
              provider: route.provider ?? undefined,
              accountKey: route.accountKey ?? undefined,
              extraPile: route.extraPile ?? undefined
            }
          : { pile: route.pile }
      ),
    enabled: Boolean(settings && !status?.backendValidationError)
  });

  const accountSessionsQuery = useQuery({
    queryKey: ["pile-account-sessions", settings?.backendUrl, settings?.backendToken, route.pile, route.provider, route.extraPile],
    queryFn: () =>
      fetchSessions(
        settings as ExtensionSettings,
        route.provider || route.extraPile
          ? {
              pile: isCustomScope ? undefined : route.pile,
              provider: route.provider ?? undefined,
              extraPile: route.extraPile ?? undefined
            }
          : { pile: route.pile }
      ),
    enabled: Boolean(settings && !status?.backendValidationError)
  });

  const extraPilesQuery = useQuery({
    queryKey: ["session-extra-piles", settings?.backendUrl, settings?.backendToken, route.provider, route.accountKey, isCustomScope ? null : route.pile],
    queryFn: () =>
      fetchExtraPiles(settings as ExtensionSettings, {
        provider: route.provider ?? undefined,
        accountKey: route.accountKey ?? undefined,
        pile: isCustomScope ? undefined : route.pile
      }),
    enabled: Boolean(settings && !status?.backendValidationError)
  });

  const ideaProjectsQuery = useQuery<BackendIdeaProjectRead[]>({
    queryKey: ["idea-projects", settings?.backendUrl, settings?.backendToken],
    queryFn: () => fetchIdeaProjects(settings as ExtensionSettings),
    enabled: Boolean(settings && !status?.backendValidationError && !isCustomScope && route.pile === "ideas")
  });

  const searchQuery = useQuery({
    queryKey: [
      "pile-search",
      settings?.backendUrl,
      settings?.backendToken,
      route.pile,
      route.provider,
      route.accountKey,
      route.extraPile,
      debouncedQuery
    ],
    queryFn: () =>
      fetchExplorerSearch(settings as ExtensionSettings, debouncedQuery, {
        pile: isCustomScope ? undefined : route.pile,
        provider: route.provider ?? undefined,
        accountKey: route.accountKey ?? undefined,
        extraPile: route.extraPile ?? undefined,
        limit: 80
      }),
    enabled: Boolean(settings && !status?.backendValidationError && debouncedQuery.trim())
  });

  const matches = useMemo(() => searchMatchMap(searchQuery.data), [searchQuery.data]);
  const allSessions = sessionsQuery.data ?? [];
  const accountScopeSessions = accountSessionsQuery.data ?? [];
  const accountOptions = useMemo(() => {
    const counts = new Map<string, { key: string; label: string; provider: ProviderName; count: number }>();
    for (const session of accountScopeSessions) {
      const key = sessionAccountKey(session);
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
        continue;
      }
      counts.set(key, {
        key,
        label: sessionAccountLabel(session),
        provider: session.provider,
        count: 1
      });
    }
    return Array.from(counts.values()).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  }, [accountScopeSessions]);
  const preBucketSessions = useMemo(() => {
    const base = sortSessions(allSessions, route.sort);
    if (!debouncedQuery.trim()) {
      return base;
    }
    const visibleIds = new Set(matches.keys());
    return base.filter((session) => visibleIds.has(session.id));
  }, [allSessions, debouncedQuery, matches, route.sort]);
  const activityBuckets = useMemo(() => buildActivityBuckets(preBucketSessions), [preBucketSessions]);

  useEffect(() => {
    if (route.bucket && !activityBuckets.some((bucket) => bucket.bucket === route.bucket)) {
      updateRoute({ bucket: null }, false);
    }
  }, [activityBuckets, route.bucket]);

  const visibleSessions = useMemo(() => {
    if (!route.bucket) {
      return preBucketSessions;
    }
    return preBucketSessions.filter((session) => session.updated_at.startsWith(route.bucket as string));
  }, [preBucketSessions, route.bucket]);

  useEffect(() => {
    if (!route.accountKey || accountSessionsQuery.isLoading || !accountOptions.length) {
      return;
    }
    if (!accountOptions.some((account) => account.key === route.accountKey)) {
      updateRoute({ accountKey: null, note: null }, false);
    }
  }, [accountOptions, accountSessionsQuery.isLoading, route.accountKey]);

  const scopedSessionIds = debouncedQuery.trim() || route.bucket ? visibleSessions.map((session) => session.id) : undefined;

  const statsQuery = useQuery({
    queryKey: [
      "pile-stats",
      settings?.backendUrl,
      settings?.backendToken,
      route.pile,
      route.provider,
      route.accountKey,
      route.extraPile,
      scopedSessionIds?.join("|") ?? "*"
    ],
    queryFn: () =>
      isCustomScope
        ? fetchCustomPileStats(
            settings as ExtensionSettings,
            route.extraPile as string,
            route.provider || route.accountKey || scopedSessionIds
              ? {
                  provider: route.provider ?? undefined,
                  accountKey: route.accountKey ?? undefined,
                  sessionIds: scopedSessionIds
                }
              : undefined
          )
        : fetchPileStats(
            settings as ExtensionSettings,
            route.pile,
            route.provider || route.accountKey || scopedSessionIds
              ? {
                  provider: route.provider ?? undefined,
                  accountKey: route.accountKey ?? undefined,
                  sessionIds: scopedSessionIds
                }
              : undefined
          ),
    enabled: Boolean(settings && !status?.backendValidationError && (!scopedSessionIds || scopedSessionIds.length > 0))
  });

  const graphQuery = useQuery({
    queryKey: [
      "pile-graph",
      settings?.backendUrl,
      settings?.backendToken,
      route.pile,
      route.provider,
      route.accountKey,
      route.extraPile,
      scopedSessionIds?.join("|") ?? "*"
    ],
    queryFn: () =>
      isCustomScope
        ? fetchCustomPileGraph(
            settings as ExtensionSettings,
            route.extraPile as string,
            route.provider || route.accountKey || scopedSessionIds
              ? {
                  provider: route.provider ?? undefined,
                  accountKey: route.accountKey ?? undefined,
                  sessionIds: scopedSessionIds
                }
              : undefined
          )
        : fetchPileGraph(
            settings as ExtensionSettings,
            route.pile,
            route.provider || route.accountKey || scopedSessionIds
              ? {
                  provider: route.provider ?? undefined,
                  accountKey: route.accountKey ?? undefined,
                  sessionIds: scopedSessionIds
                }
              : undefined
          ),
    enabled: Boolean(settings && !status?.backendValidationError && !usesCategoryWorkspace && (!scopedSessionIds || scopedSessionIds.length > 0))
  });

  const categoryViewsQuery = useQuery<BackendPileViews>({
    queryKey: [
      "pile-views",
      settings?.backendUrl,
      settings?.backendToken,
      route.pile,
      route.provider,
      route.accountKey,
      route.extraPile,
      scopedSessionIds?.join("|") ?? "*"
    ],
    queryFn: () =>
      isCustomScope
        ? fetchCustomPileViews(
            settings as ExtensionSettings,
            route.extraPile as string,
            route.provider || route.accountKey || scopedSessionIds
              ? {
                  provider: route.provider ?? undefined,
                  accountKey: route.accountKey ?? undefined,
                  sessionIds: scopedSessionIds
                }
              : undefined
          )
        : fetchPileViews(
            settings as ExtensionSettings,
            route.pile,
            route.provider || route.accountKey || scopedSessionIds
              ? {
                  provider: route.provider ?? undefined,
                  accountKey: route.accountKey ?? undefined,
                  sessionIds: scopedSessionIds
                }
              : undefined
          ),
    enabled: Boolean(settings && !status?.backendValidationError && usesCategoryWorkspace && (!scopedSessionIds || scopedSessionIds.length > 0))
  });

  const categoryViews = categoryViewsQuery.data;
  const ideaProjectGroups = categoryViews?.ideas?.projects ?? [];
  const activeIdeaProjectGroup =
    !isCustomScope && route.pile === "ideas" && route.project
      ? ideaProjectGroups.find((project) => (project.slug ?? project.label) === route.project || project.label === route.project) ?? null
      : null;
  const activeIdeaProjectSessionIds = activeIdeaProjectGroup ? new Set(activeIdeaProjectGroup.session_ids) : null;
  const projectScopedSessions = useMemo(() => {
    if (!activeIdeaProjectSessionIds) {
      return visibleSessions;
    }
    return visibleSessions.filter((session) => activeIdeaProjectSessionIds.has(session.id));
  }, [activeIdeaProjectSessionIds, visibleSessions]);

  useEffect(() => {
    if (!route.project || route.pile !== "ideas" || categoryViewsQuery.isLoading) {
      return;
    }
    const projectExists = ideaProjectGroups.some((project) => (project.slug ?? project.label) === route.project || project.label === route.project);
    if (!projectExists) {
      updateRoute({ project: null, note: null }, false);
    }
  }, [categoryViewsQuery.isLoading, ideaProjectGroups, route.pile, route.project]);

  const noteListItems = useMemo(() => {
    const baseSessions = projectScopedSessions;
    if (!graphFocus) {
      return baseSessions;
    }
    const focusSet = new Set(graphFocus.sessionIds);
    return baseSessions.filter((session) => focusSet.has(session.id));
  }, [graphFocus, projectScopedSessions]);

  useEffect(() => {
    if (route.note && noteListItems.some((session) => session.id === route.note)) {
      return;
    }

    const nextNoteId = noteListItems[0]?.id ?? null;
    if (nextNoteId !== route.note) {
      updateRoute({ note: nextNoteId }, false);
    }
  }, [noteListItems, route.note]);

  const selectedSessionId = route.note;
  const selectedSession = noteListItems.find((session) => session.id === selectedSessionId) ?? null;

  const noteQuery = useQuery({
    queryKey: ["pile-note", settings?.backendUrl, settings?.backendToken, selectedSessionId],
    queryFn: () => fetchSessionNote(settings as ExtensionSettings, selectedSessionId as string),
    enabled: Boolean(settings && !status?.backendValidationError && selectedSessionId)
  });

  const todoQuery = useQuery({
    queryKey: ["pile-todo", settings?.backendUrl, settings?.backendToken],
    queryFn: () => fetchTodoList(settings as ExtensionSettings),
    enabled: Boolean(settings && !status?.backendValidationError && !isCustomScope && route.pile === "todo")
  });

  const stats =
    (scopedSessionIds && !visibleSessions.length) || (debouncedQuery.trim() && !visibleSessions.length)
      ? createEmptyStats(route.pile)
      : statsQuery.data ?? createEmptyStats(route.pile);
  const graph =
    (scopedSessionIds && !visibleSessions.length) || (debouncedQuery.trim() && !visibleSessions.length)
      ? createEmptyGraph(route.pile)
      : graphQuery.data ?? createEmptyGraph(route.pile);
  const todo = !isCustomScope && route.pile === "todo" ? todoQuery.data ?? null : null;
  const activeDisplayCategory = graph.dominant_pile_slug ?? stats.dominant_pile_slug ?? route.pile;
  const extraPiles = extraPilesQuery.data ?? [];
  const ideaProjects = ideaProjectsQuery.data ?? [];

  const signals = signalGroups(stats);
  const providerPie = stats.provider_counts.map((item) => ({
    provider: item.provider,
    label: providerLabels[item.provider],
    count: item.count,
    color: providerColors[item.provider]
  }));
  const availableGraphProviders = useMemo(() => {
    const providers = new Set<ProviderName>();
    for (const node of graph.nodes) {
      if (node.provider) {
        providers.add(node.provider);
      }
    }
    return Array.from(providers).sort();
  }, [graph.nodes]);
  const availableGraphKinds = useMemo(() => {
    const kinds = new Set<string>();
    for (const node of graph.nodes) {
      if (node.kind) {
        kinds.add(node.kind);
      }
    }
    return Array.from(kinds).sort();
  }, [graph.nodes]);
  const filteredGraph = useMemo(() => {
    if (graphProviderFilter.size === 0 && graphKindFilter.size === 0) {
      return graph;
    }
    const nodes = graph.nodes.filter((node) => {
      const providerOk = graphProviderFilter.size === 0 || (node.provider ? graphProviderFilter.has(node.provider) : false);
      const kindOk = graphKindFilter.size === 0 || graphKindFilter.has(node.kind);
      return providerOk && kindOk;
    });
    const visibleIds = new Set(nodes.map((node) => node.id));
    const edges = graph.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
    return { ...graph, nodes, edges, node_count: nodes.length, edge_count: edges.length };
  }, [graph, graphProviderFilter, graphKindFilter]);
  const graphInsights = useMemo(
    () => buildPileGraphInsights(filteredGraph, visibleSessions, activeDisplayCategory, groupingMode),
    [activeDisplayCategory, filteredGraph, groupingMode, visibleSessions]
  );
  const graphNodeOptions = useMemo(
    () =>
      [...filteredGraph.nodes]
        .filter((node) => node.session_ids.length > 0)
        .sort((left, right) => graphNodeOptionScore(right) - graphNodeOptionScore(left) || left.label.localeCompare(right.label))
        .slice(0, 120),
    [filteredGraph.nodes]
  );
  const pathFilterOptions = route.provider || route.accountKey || scopedSessionIds
    ? {
        provider: route.provider ?? undefined,
        accountKey: route.accountKey ?? undefined,
        sessionIds: scopedSessionIds
      }
    : undefined;
  const pathQuery = useQuery({
    queryKey: [
      "pile-graph-path",
      settings?.backendUrl,
      settings?.backendToken,
      route.pile,
      route.provider,
      route.accountKey,
      route.extraPile,
      scopedSessionIds?.join("|") ?? "*",
      pathSourceId,
      pathTargetId
    ],
    queryFn: () =>
      isCustomScope
        ? fetchCustomPileGraphPath(
            settings as ExtensionSettings,
            route.extraPile as string,
            pathSourceId as string,
            pathTargetId as string,
            pathFilterOptions
          )
        : fetchPileGraphPath(
            settings as ExtensionSettings,
            route.pile,
            pathSourceId as string,
            pathTargetId as string,
            pathFilterOptions
          ),
    enabled: Boolean(
      settings &&
        !status?.backendValidationError &&
        !usesCategoryWorkspace &&
        pathSourceId &&
        pathTargetId &&
        pathSourceId !== pathTargetId &&
        (!scopedSessionIds || scopedSessionIds.length > 0)
    )
  });
  const scopePills = [
    { key: "pile", label: isCustomScope ? "Default pile" : "Pile", value: pileLabels[activeDisplayCategory] },
    route.extraPile ? { key: "extra-pile", label: "Collection", value: route.extraPile } : null,
    route.provider ? { key: "provider", label: "Provider", value: providerLabels[route.provider] } : null,
    route.accountKey
      ? {
          key: "account",
          label: "Account",
          value: accountOptions.find((account) => account.key === route.accountKey)?.label ?? route.accountKey
        }
      : null,
    route.q ? { key: "query", label: "Query", value: route.q } : null,
    route.bucket ? { key: "bucket", label: "Time", value: formatBucketLabel(route.bucket) } : null,
    activeIdeaProjectGroup ? { key: "idea-project", label: "Project", value: activeIdeaProjectGroup.label } : null,
    graphFocus ? { key: "focus", label: "Focus", value: graphFocus.label } : null
  ].filter((item): item is { key: string; label: string; value: string } => Boolean(item));
  const scopeSummary = scopePills.length
    ? scopePills.map((pill) => `${pill.label}: ${pill.value}`).join(" · ")
    : "Whole pile";
  const providerFilterValue =
    graphProviderFilter.size === 0
      ? "__all__"
      : graphProviderFilter.size === 1
        ? Array.from(graphProviderFilter)[0]
        : "__mixed__";
  const kindFilterValue =
    graphKindFilter.size === 0
      ? "__all__"
      : graphKindFilter.size === 1
        ? Array.from(graphKindFilter)[0]
        : "__mixed__";

  function handleProviderFilterSelect(value: string): void {
    if (value === "__all__" || value === "__mixed__") {
      setGraphProviderFilter(new Set());
      return;
    }
    setGraphProviderFilter(new Set([value as ProviderName]));
  }

  function handleKindFilterSelect(value: string): void {
    if (value === "__all__" || value === "__mixed__") {
      setGraphKindFilter(new Set());
      return;
    }
    setGraphKindFilter(new Set([value]));
  }

  useEffect(() => {
    const allowedClusters = new Set(graphInsights.clusters.map((cluster) => cluster.id));
    setCollapsedGroups((current) => {
      const next = current.filter((clusterId) => allowedClusters.has(clusterId));
      return next.length === current.length && next.every((clusterId, index) => clusterId === current[index]) ? current : next;
    });
  }, [graphInsights.clusters]);

  useEffect(() => {
    setGraphInspect(null);
  }, [graph]);

  useEffect(() => {
    if (!graphNodeOptions.length) {
      if (pathSourceId) {
        setPathSourceId(null);
      }
      if (pathTargetId) {
        setPathTargetId(null);
      }
      return;
    }

    const allowedIds = new Set(graphNodeOptions.map((node) => node.id));
    const nextSourceId = pathSourceId && allowedIds.has(pathSourceId) ? pathSourceId : graphNodeOptions[0]?.id ?? null;
    const nextTargetId =
      pathTargetId && allowedIds.has(pathTargetId) && pathTargetId !== nextSourceId
        ? pathTargetId
        : graphNodeOptions.find((node) => node.id !== nextSourceId)?.id ?? null;

    if (nextSourceId !== pathSourceId) {
      setPathSourceId(nextSourceId);
    }
    if (nextTargetId !== pathTargetId) {
      setPathTargetId(nextTargetId);
    }
  }, [graphNodeOptions, pathSourceId, pathTargetId]);

  function handlePileSwitch(pile: BuiltInPileSlug): void {
    setGraphFocus(null);
    setInformationDetail(null);
    setGraphInspect(null);
    setCollapsedGroups([]);
    updateRoute({ pile, note: null, bucket: null, project: null, view: "atlas", panel: "workspace", extraPile: null }, true);
  }

  function handleExtraPileSwitch(name: string): void {
    setGraphFocus(null);
    setInformationDetail(null);
    setGraphInspect(null);
    setCollapsedGroups([]);
    updateRoute({ extraPile: name, note: null, bucket: null, project: null, view: "atlas", panel: "workspace" }, true);
  }

  function activateFocus(label: string, sessionIds: string[], nextView?: PileWorkspaceView, detail?: InformationDetail): void {
    setGraphInspect(null);
    setGraphFocus({ label, sessionIds });
    setInformationDetail(detail ?? null);
    const nextId = visibleSessions.find((item) => sessionIds.includes(item.id))?.id ?? sessionIds[0] ?? null;
    updateRoute({ note: nextId, view: nextView ?? route.view }, false);
  }

  function handleFocus(label: string, sessionIds: string[]): void {
    activateFocus(label, sessionIds);
  }

  function inspectTodoItem(item: BackendTodoItem): void {
    setInformationDetail({
      kind: "Todo",
      title: item.text,
      summary: item.done ? "Completed task in the shared checklist." : "Active task in the shared checklist.",
      accountKey: item.account_key,
      accountLabel: item.account_label ?? "Shared checklist",
      sessionIds: [],
      chips: [item.done ? "Completed" : "Active"]
    });
  }

  function handleBucketToggle(bucket: string): void {
    setGraphFocus(null);
    setInformationDetail(null);
    setGraphInspect(null);
    updateRoute({ bucket: route.bucket === bucket ? null : bucket, note: null }, true);
  }

  function clearScope(): void {
    setGraphFocus(null);
    setInformationDetail(null);
    setGraphInspect(null);
    setCollapsedGroups([]);
    updateRoute({ q: "", provider: null, accountKey: null, sort: "recent", bucket: null, project: null, note: null, view: "atlas", panel: "workspace", extraPile: null }, true);
  }

  function handlePathFocus(path: BackendExplorerGraphPath): void {
    const labels = path.nodes.map((node) => node.label).filter(Boolean);
    const sessionIds = Array.from(
      new Set([
        ...path.evidence_session_ids,
        ...path.nodes.flatMap((node) => node.session_ids),
        ...path.edges.flatMap((edge) => edge.session_ids)
      ])
    );
    activateFocus(`Path: ${labels.join(" -> ")}`, sessionIds, "atlas");
  }

  const journalEntryCount = categoryViews?.journal?.timeline?.length ?? 0;
  const journalPlaceCount = categoryViews?.journal?.locations?.length ?? 0;
  const journalPeopleCount = categoryViews?.journal?.people?.length ?? 0;
  const journalEntityCount = categoryViews?.journal?.entities?.length ?? 0;
  const ideaNodeCount = categoryViews?.ideas?.nodes?.length ?? 0;
  const ideaProjectCount = categoryViews?.ideas?.projects?.length ?? 0;
  const ideaThreadCount = categoryViews?.ideas?.threads?.length ?? 0;
  const ideaContributorCount = categoryViews?.ideas?.contributors?.length ?? 0;
  const ideaRelationCount = categoryViews?.ideas?.edges?.length ?? 0;
  const factualBacklogCount = categoryViews?.factual?.backlog?.length ?? 0;
  const factualLinkedSourceCount = categoryViews?.factual?.linked_sources?.length ?? 0;
  const factualEntityCount = categoryViews?.factual?.entities?.length ?? 0;

  const workspaceCards = usesCategoryWorkspace
    ? activeDisplayCategory === "journal"
      ? [
          {
            value: "atlas" as const,
            label: "Timeline",
            accent: pilePalette.journal.accent,
            icon: Activity,
            metric: `${formatNumber(journalEntryCount)} entries`,
            detail: "Chronological journal"
          },
          {
            value: "story" as const,
            label: "Places",
            accent: "#2477c7",
            icon: MapPin,
            metric: `${formatNumber(journalPlaceCount)} places`,
            detail: "Location movement"
          },
          {
            value: "ops" as const,
            label: "People",
            accent: "#0f8a84",
            icon: Users,
            metric: `${formatNumber(journalPeopleCount + journalEntityCount)} named`,
            detail: "People and entities"
          }
        ]
      : activeDisplayCategory === "ideas"
        ? [
            {
              value: "atlas" as const,
              label: "Evolution",
              accent: pilePalette.ideas.accent,
              icon: GitBranch,
              metric: `${formatNumber(ideaNodeCount)} ideas`,
              detail: "Idea progression"
            },
            {
              value: "story" as const,
              label: "Projects",
              accent: "#4968ab",
              icon: BrainCircuit,
              metric: `${formatNumber(ideaProjectCount || ideaThreadCount)} projects`,
              detail: "Projects, threads, facts"
            },
            {
              value: "ops" as const,
              label: "Attribution",
              accent: "#0f8a84",
              icon: Users,
              metric: `${formatNumber(ideaContributorCount)} voices`,
              detail: "Claims and relations"
            }
          ]
        : [
            {
              value: "atlas" as const,
              label: "Backlog",
              accent: pilePalette.factual.accent,
              icon: ListChecks,
              metric: `${formatNumber(factualBacklogCount)} notes`,
              detail: "Learned by date"
            },
            {
              value: "story" as const,
              label: "Cross-links",
              accent: "#4968ab",
              icon: Workflow,
              metric: `${formatNumber(factualLinkedSourceCount)} sources`,
              detail: "Referenced by other piles"
            },
            {
              value: "ops" as const,
              label: "Terms",
              accent: "#c77724",
              icon: Tags,
              metric: `${formatNumber(factualEntityCount)} entities`,
              detail: "Keywords and entities"
            }
          ]
    : [
        {
          value: "atlas" as const,
          label: "Concept Map",
          accent: pilePalette[activeDisplayCategory].accent,
          icon: BrainCircuit,
          metric: `${formatNumber(filteredGraph.node_count)} nodes`,
          detail: `${formatNumber(filteredGraph.edge_count)} visible links`
        },
        {
          value: "story" as const,
          label: "Storylines",
          accent: "#c77724",
          icon: Sparkles,
          metric: `${formatNumber(graphInsights.storylines.length)} trails`,
          detail: "Guided graph trails"
        },
        {
          value: "ops" as const,
          label: "Graph Health",
          accent: "#2477c7",
          icon: Workflow,
          metric: `${formatPercent(graphInsights.sessionCoverage * 100)}% coverage`,
          detail: graphInsights.warnings.length ? `${graphInsights.warnings.length} maintenance signals` : "Scope is connected"
        }
      ];

  async function persistTodoItems(nextItems: BackendTodoItem[], summary: string): Promise<void> {
    if (!settings || route.pile !== "todo") {
      return;
    }

    setTodoActionError(null);
    setTodoSavingSummary(summary);
    try {
      await updateTodoList(settings as ExtensionSettings, {
        items: nextItems,
        summary
      });
      setTodoDraft("");
      await todoQuery.refetch();
    } catch (todoError) {
      setTodoActionError(todoError instanceof Error ? todoError.message : "Could not update the shared checklist.");
    } finally {
      setTodoSavingSummary(null);
    }
  }

  async function handleTodoAdd(): Promise<void> {
    const text = todoDraft.trim();
    if (!text || !todo) {
      return;
    }

    const nextItems = [...todo.items.filter((item) => item.text.toLowerCase() !== text.toLowerCase()), { text, done: false }];
    await persistTodoItems(nextItems, `Add task: ${text}`);
  }

  async function handleTodoToggle(item: BackendTodoItem, done: boolean): Promise<void> {
    if (!todo) {
      return;
    }

    const nextItems = todo.items.map((current) => (current.text === item.text ? { ...current, done } : current));
    await persistTodoItems(nextItems, done ? `Check off: ${item.text}` : `Reopen: ${item.text}`);
  }

  async function updateSelectedSessionExtraPiles(nextPiles: string[]): Promise<void> {
    if (!settings || !selectedSession) {
      return;
    }

    setExtraPileError(null);
    try {
      await updateSessionExtraPiles(settings as ExtensionSettings, selectedSession.id, nextPiles);
      setExtraPileDraft("");
      await Promise.all([sessionsQuery.refetch(), noteQuery.refetch(), extraPilesQuery.refetch()]);
    } catch (categoryError) {
      setExtraPileError(categoryError instanceof Error ? categoryError.message : "Could not update collections.");
    }
  }

  async function handleAddExtraPile(name: string): Promise<void> {
    const cleaned = name.trim();
    if (!cleaned || !selectedSession) {
      return;
    }
    const nextPiles = Array.from(new Set([...(selectedSession.extra_piles ?? []), cleaned]));
    await updateSelectedSessionExtraPiles(nextPiles);
    handleExtraPileSwitch(cleaned);
  }

  async function handleRemoveExtraPile(name: string): Promise<void> {
    if (!selectedSession) {
      return;
    }
    const nextPiles = (selectedSession.extra_piles ?? []).filter((value) => value !== name);
    await updateSelectedSessionExtraPiles(nextPiles);
    if (route.extraPile === name) {
      updateRoute({ extraPile: null, project: null }, true);
    }
  }

  async function handleCreateIdeaProject(): Promise<void> {
    const name = ideaProjectNameDraft.trim();
    const description = ideaProjectDescriptionDraft.trim();
    if (!settings || !name) {
      return;
    }

    setIdeaProjectError(null);
    setIdeaProjectSaving(true);
    try {
      await createIdeaProject(settings as ExtensionSettings, {
        name,
        description: description || undefined
      });
      setIdeaProjectNameDraft("");
      setIdeaProjectDescriptionDraft("");
      await Promise.all([ideaProjectsQuery.refetch(), categoryViewsQuery.refetch()]);
    } catch (projectError) {
      setIdeaProjectError(projectError instanceof Error ? projectError.message : "Could not create idea project.");
    } finally {
      setIdeaProjectSaving(false);
    }
  }

  async function handleDeleteIdeaProject(project: BackendIdeaProjectRead): Promise<void> {
    if (!settings || !confirm(`Deactivate idea project '${project.name}'? Existing idea notes stay assigned.`)) {
      return;
    }

    setIdeaProjectError(null);
    setIdeaProjectSaving(true);
    try {
      await deleteIdeaProject(settings as ExtensionSettings, project.slug);
      await Promise.all([ideaProjectsQuery.refetch(), categoryViewsQuery.refetch()]);
    } catch (projectError) {
      setIdeaProjectError(projectError instanceof Error ? projectError.message : "Could not deactivate idea project.");
    } finally {
      setIdeaProjectSaving(false);
    }
  }

  const isTodoWorkspace = !isCustomScope && route.pile === "todo";
  const workspaceTitle = isTodoWorkspace
    ? "Shared list workspace"
    : usesCategoryWorkspace && activeDisplayCategory === "journal"
      ? "Journal workspace"
      : usesCategoryWorkspace && activeDisplayCategory === "ideas"
        ? "Ideas workspace"
        : usesCategoryWorkspace && activeDisplayCategory === "factual"
          ? "Factual workspace"
          : activeDisplayCategory === "factual"
            ? "Concept map workspace"
            : "Context workspace";
  const workspaceDescription = isTodoWorkspace
    ? "A plain shared checklist with active and completed tasks."
    : usesCategoryWorkspace && activeDisplayCategory === "journal"
      ? "Daily progression, places, people, entities, and mentioned activities."
      : usesCategoryWorkspace && activeDisplayCategory === "ideas"
        ? "Projects preserve where ideas belong while threads show how they build, validate, and counter."
        : usesCategoryWorkspace && activeDisplayCategory === "factual"
          ? "Browse learned facts by date, cross-pile references, and searchable terms."
          : isCustomScope
            ? "This view follows a cross-pile collection while preserving the original pile and note structure."
            : "Use the concept map for relationships, storylines for guided trails, and graph health for coverage.";

  const headerMetrics =
    isTodoWorkspace
      ? [
          { label: "Shared tasks", value: formatNumber(todo?.total_count), icon: Database },
          { label: "Active", value: formatNumber(todo?.active_count), icon: Workflow },
          { label: "Completed", value: formatNumber(todo?.completed_count), icon: Activity },
          { label: "Update notes", value: formatNumber(stats.notes_with_todo_summary), icon: Activity }
        ]
      : usesCategoryWorkspace
        ? [
            { label: "Notes in scope", value: formatNumber(visibleSessions.length), icon: Database },
            {
              label:
                activeDisplayCategory === "journal"
                  ? "Journal entries"
                  : activeDisplayCategory === "ideas"
                    ? "Idea nodes"
                    : "Backlog notes",
              value:
                activeDisplayCategory === "journal"
                  ? formatNumber(journalEntryCount)
                  : activeDisplayCategory === "ideas"
                    ? formatNumber(ideaNodeCount)
                    : formatNumber(factualBacklogCount),
              icon: activeDisplayCategory === "journal" ? Activity : activeDisplayCategory === "ideas" ? BrainCircuit : ListChecks
            },
            {
              label:
                activeDisplayCategory === "journal"
                  ? "People"
                  : activeDisplayCategory === "ideas"
                    ? "Projects"
                    : "Entities",
              value:
                activeDisplayCategory === "journal"
                  ? formatNumber(journalPeopleCount)
                  : activeDisplayCategory === "ideas"
                    ? formatNumber(ideaProjectCount)
                    : formatNumber(factualEntityCount),
              icon: Users
            },
            {
              label:
                activeDisplayCategory === "journal"
                  ? "Places"
                  : activeDisplayCategory === "ideas"
                    ? "Relations"
                    : "Linked from",
              value:
                activeDisplayCategory === "journal"
                  ? formatNumber(journalPlaceCount)
                  : activeDisplayCategory === "ideas"
                    ? formatNumber(ideaRelationCount)
                    : formatNumber(factualLinkedSourceCount),
              icon: Workflow
            }
        ]
      : [
          { label: "Notes in scope", value: formatNumber(visibleSessions.length), icon: Database },
          {
            label: activeDisplayCategory === "factual" ? "Facts" : "Messages",
            value: activeDisplayCategory === "factual" ? formatNumber(stats.total_triplets) : formatNumber(stats.total_messages),
            icon: activeDisplayCategory === "factual" ? BrainCircuit : Activity
          },
          {
            label: "Graph coverage",
            value: `${formatPercent(graphInsights.sessionCoverage * 100)}%`,
            icon: Workflow
          },
          {
            label: "Last updated",
            value: formatCompactDate(stats.latest_updated_at, "No data"),
            icon: Activity
          }
        ];
  const maxActivityBucketCount = Math.max(...activityBuckets.map((bucket) => bucket.count), 1);
  const activePileAccent = pilePalette[activeDisplayCategory].accent;
  const activePileName = isCustomScope ? route.extraPile : pileLabels[route.pile];
  const notesTitle = !isCustomScope && route.pile === "todo" ? "Change log notes" : isCustomScope ? "Notes in collection" : "Notes in scope";
  const panelCards = [
    {
      value: "workspace" as const,
      label: "Explore",
      icon: BrainCircuit,
      metric: isTodoWorkspace ? "Shared checklist" : workspaceTitle
    },
    {
      value: "notes" as const,
      label: "Notes",
      icon: ListChecks,
      metric: noteListMeta(route, allSessions.length, noteListItems.length, graphFocus, activeDisplayCategory)
    },
    {
      value: "reader" as const,
      label: "Reader",
      icon: BookOpen,
      metric: selectedSession ? titleFromSession(selectedSession) : "Choose a note"
    }
  ];
  const activePanelTitle =
    route.panel === "reader"
      ? selectedSession
        ? titleFromSession(selectedSession)
        : "Reader"
      : route.panel === "notes"
        ? notesTitle
        : workspaceTitle;
  const activePanelDescription =
    route.panel === "reader"
      ? "Read the selected note with full-width transcript, overview, and markdown views."
      : route.panel === "notes"
        ? noteListMeta(route, allSessions.length, noteListItems.length, graphFocus, activeDisplayCategory)
        : workspaceDescription;

  function renderGraphGroupSelect() {
    return (
      <label className="control-field">
        <span>Group by</span>
        <Select value={groupingMode} onValueChange={(value) => setGroupingMode(value as GraphGroupingMode)}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder={graphGroupingLabel(groupingMode)} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="community" className="py-1.5 text-xs">Topic communities</SelectItem>
            <SelectItem value="provider" className="py-1.5 text-xs">Source provider</SelectItem>
            <SelectItem value="kind" className="py-1.5 text-xs">Entity type</SelectItem>
          </SelectContent>
        </Select>
      </label>
    );
  }

  function renderSemanticGroupSelect() {
    if (!graphInsights.clusters.length) {
      return null;
    }

    return (
      <label className="control-field">
        <span>Focus group</span>
        <Select
          value="__semantic_groups__"
          onValueChange={(value) => {
            if (value === "__semantic_groups__") {
              return;
            }
            if (value === "__all_groups__") {
              setCollapsedGroups([]);
              setGraphFocus(null);
              setGraphInspect(null);
              return;
            }
            const cluster = graphInsights.clusters.find((item) => item.id === value);
            if (cluster) {
              activateFocus(cluster.label, cluster.sessionIds, "atlas");
            }
          }}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Choose group" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__semantic_groups__" className="py-1.5 text-xs">Choose group</SelectItem>
            <SelectItem value="__all_groups__" className="py-1.5 text-xs">All groups</SelectItem>
            {graphInsights.clusters.slice(0, 12).map((cluster) => (
              <SelectItem key={cluster.id} value={cluster.id} className="py-1.5 text-xs">
                {cluster.label} · {formatNumber(cluster.nodeCount)} nodes
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
    );
  }

  function renderProviderFilterSelect() {
    if (!availableGraphProviders.length) {
      return null;
    }

    return (
      <label className="control-field">
        <span>Source</span>
        <Select value={providerFilterValue} onValueChange={handleProviderFilterSelect}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__" className="py-1.5 text-xs">All sources</SelectItem>
            {providerFilterValue === "__mixed__" ? (
              <SelectItem value="__mixed__" className="py-1.5 text-xs">Mixed sources</SelectItem>
            ) : null}
            {availableGraphProviders.map((provider) => (
              <SelectItem key={provider} value={provider} className="py-1.5 text-xs">
                {providerLabels[provider]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
    );
  }

  function renderKindFilterSelect() {
    if (!availableGraphKinds.length) {
      return null;
    }

    return (
      <label className="control-field">
        <span>Type</span>
        <Select value={kindFilterValue} onValueChange={handleKindFilterSelect}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__" className="py-1.5 text-xs">
              All {pileLabels[activeDisplayCategory].toLowerCase()}
            </SelectItem>
            {kindFilterValue === "__mixed__" ? (
              <SelectItem value="__mixed__" className="py-1.5 text-xs">Mixed types</SelectItem>
            ) : null}
            {availableGraphKinds.map((kind) => (
              <SelectItem key={kind} value={kind} className="py-1.5 text-xs">
                {kind}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
    );
  }

  function renderDensitySelect() {
    return (
      <label className="control-field">
        <span>Density</span>
        <Select value={graphDensity} onValueChange={(value) => setGraphDensity(value as PileGraphDensity)}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder={graphDensityLabel(graphDensity)} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="curated" className="py-1.5 text-xs">Curated graph</SelectItem>
            <SelectItem value="complete" className="py-1.5 text-xs">Complete graph</SelectItem>
          </SelectContent>
        </Select>
      </label>
    );
  }

  function renderFocusModeSelect() {
    if (!graphFocus) {
      return null;
    }

    return (
      <label className="control-field">
        <span>Focus</span>
        <Select value={graphFocusMode} onValueChange={(value) => setGraphFocusMode(value as PileGraphFocusMode)}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder={graphFocusModeLabel(graphFocusMode)} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="context" className="py-1.5 text-xs">Focused context</SelectItem>
            <SelectItem value="dim" className="py-1.5 text-xs">Dim outside focus</SelectItem>
          </SelectContent>
        </Select>
      </label>
    );
  }

  function renderGraphActionButtons() {
    return (
      <div className="control-actions">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setCollapsedGroups(graphInsights.clusters.map((cluster) => cluster.id))}
          disabled={!graphInsights.clusters.length}
          className="h-8 px-2.5 text-xs"
        >
          Collapse
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setCollapsedGroups([])} disabled={!collapsedGroups.length} className="h-8 px-2.5 text-xs">
          Expand
        </Button>
        {graphFocus ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setGraphFocus(null);
              setGraphInspect(null);
            }}
            className="h-8 px-2.5 text-xs"
          >
            Clear focus
          </Button>
        ) : null}
      </div>
    );
  }

  const issueMessage =
    status?.backendValidationError ||
    error ||
    (sessionsQuery.error instanceof Error && sessionsQuery.error.message) ||
    (searchQuery.error instanceof Error && searchQuery.error.message) ||
    (statsQuery.error instanceof Error && statsQuery.error.message) ||
    (graphQuery.error instanceof Error && graphQuery.error.message) ||
    (categoryViewsQuery.error instanceof Error && categoryViewsQuery.error.message) ||
    (noteQuery.error instanceof Error && noteQuery.error.message) ||
    (todoQuery.error instanceof Error && todoQuery.error.message) ||
    (extraPilesQuery.error instanceof Error && extraPilesQuery.error.message) ||
    null;

  return (
    <div className={`app-page app-page--wide pile-workbench pile-workbench--${activeDisplayCategory}${!isCustomScope && activeDisplayCategory === "ideas" ? " pile-workbench--ideas" : ""}`}>
      <Card className="pile-workbench-header workbench-topbar p-3">
        <div className="grid gap-3 xl:grid-cols-[minmax(260px,0.42fr)_minmax(0,1fr)_auto] xl:items-center">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="display-serif flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] text-[16px]"
              style={{
                backgroundColor: `${activePileAccent}1a`,
                color: activePileAccent
              }}
              aria-hidden="true"
            >
              {isCustomScope ? "◎" : (pileGlyphs as Record<string, string>)[activeDisplayCategory] ?? "§"}
            </span>
            <div className="min-w-0">
              <div className="eyebrow text-[10px]">{isCustomScope ? "Collection" : "Pile"}</div>
              <CardTitle className="display-serif truncate text-[20px] font-semibold leading-tight">{activePileName}</CardTitle>
              <CardDescription className="mt-0.5 line-clamp-2 text-xs leading-5">
                {isCustomScope ? `${pileLabels[activeDisplayCategory]} source notes grouped as a cross-pile collection.` : pileDescriptions[route.pile]}
              </CardDescription>
            </div>
          </div>

          <div className="metric-strip">
            {headerMetrics.map((metric) => (
              <div key={metric.label} className="metric-tile">
                <div className="flex items-center gap-1.5">
                  <metric.icon className="h-3.5 w-3.5 text-[var(--color-ink-subtle)]" />
                  <span className="truncate text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-soft)]">{metric.label}</span>
                </div>
                <div className="mt-1 truncate text-sm font-semibold text-[var(--color-ink)]">{metric.value}</div>
              </div>
            ))}
          </div>

          <Button variant="secondary" size="sm" className="justify-self-start xl:justify-self-end" onClick={() => (window.location.href = chrome.runtime.getURL("dashboard.html"))}>
            <ArrowLeft className="h-3.5 w-3.5" />
            Dashboard
          </Button>
        </div>
        {scopePills.length ? (
          <div className="scope-chip-list mt-3">
            {scopePills.map((pill) => (
              <span key={pill.key} className="scope-token">
                {pill.label}
                <strong className="truncate">{pill.value}</strong>
              </span>
            ))}
          </div>
        ) : null}
      </Card>

      <div className="pile-workbench-main grid min-h-0 gap-3 xl:grid-cols-[264px_minmax(0,1fr)]">
        <aside className="min-h-0 min-w-0">
          <Card className="pile-sidebar-card p-3">
            <CardHeader className="gap-2">
              <div>
                <div className="rail-heading"><Layers className="h-3.5 w-3.5" /> Navigate</div>
                <CardTitle className="mt-0.5 text-base">Pile lanes</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="pile-sidebar-scroll mt-3 space-y-4 pr-1">
              <div className="grid gap-0.5">
                {pileOrder.map((pile) => {
                  const active = !isCustomScope && route.pile === pile;
                  const accent = pilePalette[pile].accent;
                  return (
                    <button
                      key={pile}
                      type="button"
                      onClick={() => handlePileSwitch(pile)}
                      className="pile-nav-button group"
                      data-active={active}
                    >
                      <span
                        className="display-serif flex h-6 w-6 shrink-0 items-center justify-center rounded-[8px] text-[12px] leading-none"
                        style={{
                          backgroundColor: active ? "rgba(255,255,255,0.14)" : `${accent}1a`,
                          color: active ? "#ffffff" : accent
                        }}
                      >
                        {pileGlyphs[pile]}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] font-semibold">{pileLabels[pile]}</span>
                        <span className="pile-nav-description">{pileDescriptions[pile]}</span>
                      </span>
                    </button>
                  );
                })}
              </div>

              {!isCustomScope && route.pile === "ideas" ? (
                <div className="rail-section space-y-2">
                  <div>
                    <div className="rail-heading"><Lightbulb className="h-3.5 w-3.5" /> Idea projects</div>
                    <p className="mt-1 text-xs leading-5 text-[var(--color-ink-soft)]">Switch the workspace by project. Suggested groups appear until you define your own.</p>
                  </div>

                  <div className="grid gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setGraphFocus(null);
                        setGraphInspect(null);
                        updateRoute({ project: null, note: null, panel: "workspace" }, true);
                      }}
                      className="flex w-full items-center justify-between gap-2 rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-2 py-1.5 text-left text-xs transition hover:bg-[var(--color-paper-sunken)]"
                      data-active={!route.project}
                    >
                      <span className="font-semibold text-[var(--color-ink)]">All ideas</span>
                      <span className="text-[var(--color-ink-soft)]">{formatNumber(ideaNodeCount)}</span>
                    </button>
                    {ideaProjectGroups.map((project) => {
                      const activeProject = route.project === (project.slug ?? project.label) || route.project === project.label;
                      return (
                        <button
                          key={project.slug ?? project.label}
                          type="button"
                          onClick={() => {
                            setGraphFocus(null);
                            setGraphInspect(null);
                            updateRoute({ project: project.slug ?? project.label, note: null, view: "atlas", panel: "workspace" }, true);
                          }}
                          className={`w-full rounded-[8px] border px-2 py-1.5 text-left text-xs transition ${
                            activeProject
                              ? "border-[var(--color-ink)] bg-[var(--color-ink)] text-white"
                              : "border-[var(--color-line)] bg-[var(--color-paper-raised)] hover:bg-[var(--color-paper-sunken)]"
                          }`}
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate font-semibold">{project.label}</span>
                            <span className={activeProject ? "text-white/75" : "text-[var(--color-ink-soft)]"}>{formatNumber(project.count)}</span>
                          </span>
                          {project.kind === "suggested" ? (
                            <span className={activeProject ? "mt-1 block text-[10px] uppercase tracking-[0.08em] text-white/60" : "mt-1 block text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-soft)]"}>
                              Suggested
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                    {!ideaProjectGroups.length && categoryViewsQuery.isLoading ? <p className="text-xs leading-5 text-[var(--color-ink-soft)]">Loading project groups...</p> : null}
                    {!ideaProjectGroups.length && !categoryViewsQuery.isLoading ? <p className="text-xs leading-5 text-[var(--color-ink-soft)]">Project groups appear as ideas are extracted.</p> : null}
                  </div>

                  <div className="border-t border-[var(--color-line)] pt-2">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">Definitions</div>
                    <p className="mt-1 text-xs leading-5 text-[var(--color-ink-soft)]">Saved definitions steer future AI classification.</p>
                  </div>

                  <div className="grid gap-1.5">
                    {ideaProjects.map((project) => (
                      <div key={project.id} className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-xs font-semibold text-[var(--color-ink)]">{project.name}</div>
                            <div className="mt-0.5 truncate text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">{project.slug}</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleDeleteIdeaProject(project)}
                            disabled={ideaProjectSaving}
                            className="rounded-[6px] p-1 text-[var(--color-ink-soft)] transition hover:bg-[var(--color-paper-raised)] hover:text-[var(--color-ink)] disabled:opacity-50"
                            aria-label={`Deactivate ${project.name}`}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        {project.description ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--color-ink-soft)]">{project.description}</p> : null}
                      </div>
                    ))}
                    {!ideaProjects.length && !ideaProjectsQuery.isLoading ? <p className="text-xs leading-5 text-[var(--color-ink-soft)]">No saved definitions yet.</p> : null}
                    {ideaProjectsQuery.isLoading ? <p className="text-xs leading-5 text-[var(--color-ink-soft)]">Loading projects...</p> : null}
                  </div>

                  <form
                    className="grid gap-1.5"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleCreateIdeaProject();
                    }}
                  >
                    <input
                      type="text"
                      value={ideaProjectNameDraft}
                      onChange={(event) => setIdeaProjectNameDraft(event.target.value)}
                      placeholder="Project name"
                      className="compact-field"
                    />
                    <textarea
                      value={ideaProjectDescriptionDraft}
                      onChange={(event) => setIdeaProjectDescriptionDraft(event.target.value)}
                      placeholder="What are you working on?"
                      rows={3}
                      className="compact-field compact-textarea"
                    />
                    <Button type="submit" size="sm" variant="secondary" className="h-8 px-2.5 text-xs" disabled={ideaProjectSaving || !ideaProjectNameDraft.trim()}>
                      <Plus className="h-3.5 w-3.5" />
                      {ideaProjectSaving ? "Saving..." : "Add project"}
                    </Button>
                  </form>
                  {ideaProjectError ? <p className="text-xs leading-5 text-[#963c24]">{ideaProjectError}</p> : null}
                </div>
              ) : null}

              <div className="rail-section space-y-1.5">
                <div>
                  <div className="rail-heading"><Tags className="h-3.5 w-3.5" /> Collections</div>
                  <p className="mt-1 text-xs leading-5 text-[var(--color-ink-soft)]">Cross-pile groupings that keep each note in its original pile.</p>
                </div>

                <Select
                  value={route.extraPile ?? "__default__"}
                  onValueChange={(value) => {
                    setGraphFocus(null);
                    setGraphInspect(null);
                    setCollapsedGroups([]);
                    if (value === "__default__") {
                      updateRoute({ extraPile: null, note: null, bucket: null, project: null, view: "atlas" }, true);
                    } else {
                      handleExtraPileSwitch(value);
                    }
                  }}
                  disabled={!extraPiles.length}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Collection" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__" className="py-1.5 text-xs">Current pile only</SelectItem>
                    {extraPiles.map((item) => (
                      <SelectItem key={item.name} value={item.name} className="py-1.5 text-xs">
                        {item.name} · {formatNumber(item.count)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!extraPiles.length ? <p className="text-xs leading-5 text-[var(--color-ink-soft)]">Assign a note to create one.</p> : null}

                <form
                  className="flex gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleAddExtraPile(extraPileDraft);
                  }}
                >
                  <input
                    type="text"
                    value={extraPileDraft}
                    onChange={(event) => setExtraPileDraft(event.target.value)}
                    placeholder={selectedSession ? "Add to collection" : "Select a note first"}
                    className="compact-field h-8 min-w-0 flex-1"
                  />
                  <Button type="submit" size="sm" variant="secondary" className="h-8 shrink-0 px-2 text-xs" disabled={!selectedSession || !extraPileDraft.trim()}>
                    <Plus className="h-3.5 w-3.5" />
                    <span className="sr-only">Add collection</span>
                  </Button>
                </form>
              </div>

              <div className="rail-section space-y-1.5">
                <div className="rail-heading"><Filter className="h-3.5 w-3.5" /> Scope</div>

                <label className="block">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-subtle)]" />
                    <input
                      type="search"
                      value={route.q}
                      onChange={(event) => {
                        setGraphFocus(null);
                        setGraphInspect(null);
                        updateRoute({ q: event.target.value, project: null, note: null }, true);
                      }}
                      placeholder="Search notes"
                      className="compact-field h-8 pl-8 pr-2"
                    />
                  </div>
                </label>

                {signals.primary.length ? (
                  <Select
                    value={signals.primary.some((item) => item.label === route.q) ? route.q : "__suggestion__"}
                    onValueChange={(value) => {
                      if (value === "__suggestion__") {
                        return;
                      }
                      updateRoute({ q: value, project: null, note: null, view: "atlas" }, true);
                      setGraphFocus(null);
                      setGraphInspect(null);
                    }}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__suggestion__" className="py-1.5 text-xs">Suggested scope</SelectItem>
                      {signals.primary.slice(0, 6).map((item) => (
                        <SelectItem key={item.label} value={item.label} className="py-1.5 text-xs">
                          {item.label} · {formatNumber(item.count)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}

                <div className="grid gap-1.5">
                  <div>
                    <Select
                      value={route.provider ?? "__all__"}
                      onValueChange={(value) => {
                        setGraphFocus(null);
                        setInformationDetail(null);
                        setGraphInspect(null);
                        updateRoute({ provider: value === "__all__" ? null : (value as ProviderName), accountKey: null, note: null }, true);
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__all__" className="py-1.5 text-xs">All providers</SelectItem>
                        <SelectItem value="chatgpt" className="py-1.5 text-xs">ChatGPT</SelectItem>
                        <SelectItem value="gemini" className="py-1.5 text-xs">Gemini</SelectItem>
                        <SelectItem value="grok" className="py-1.5 text-xs">Grok</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Select
                      value={route.accountKey ?? "__all__"}
                      onValueChange={(value) => {
                        setGraphFocus(null);
                        setInformationDetail(null);
                        setGraphInspect(null);
                        updateRoute({ accountKey: value === "__all__" ? null : value, note: null }, true);
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__all__" className="py-1.5 text-xs">All accounts</SelectItem>
                        {accountOptions.map((account) => (
                          <SelectItem key={account.key} value={account.key} className="py-1.5 text-xs">
                            {account.label} · {formatNumber(account.count)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Select value={route.sort} onValueChange={(value) => updateRoute({ sort: value as PileSortMode }, true)}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="recent" className="py-1.5 text-xs">Most recent</SelectItem>
                        <SelectItem value="title" className="py-1.5 text-xs">Title</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="secondary" className="h-8 px-2.5 text-xs" onClick={clearScope}>
                    Reset
                  </Button>
                  {graphFocus ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setGraphFocus(null);
                        setInformationDetail(null);
                        setGraphInspect(null);
                      }}
                      className="h-8 px-2.5 text-xs"
                    >
                      Clear focus
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className="rail-section space-y-1.5">
                <div className="rail-heading"><Clock3 className="h-3.5 w-3.5" /> Activity</div>
                <div className="grid gap-1">
                  {activityBuckets.slice(-5).map((bucket) => {
                    const active = route.bucket === bucket.bucket;
                    return (
                      <button
                        key={bucket.bucket}
                        type="button"
                        onClick={() => handleBucketToggle(bucket.bucket)}
                        className={`rounded-[8px] border px-2 py-1.5 text-left transition ${
                          active
                            ? "border-[var(--color-ink)] bg-[var(--color-ink)] text-white"
                            : "border-[var(--color-line)] bg-[var(--color-paper-raised)] hover:bg-[var(--color-paper-sunken)]"
                        }`}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold">{bucket.label}</span>
                          <span className={active ? "text-xs text-white/75" : "text-xs text-[var(--color-ink-soft)]"}>{formatNumber(bucket.count)}</span>
                        </span>
                        <span className={active ? "mt-1.5 block h-1.5 rounded-full bg-white/20" : "mt-1.5 block h-1.5 rounded-full bg-[var(--color-paper-sunken)]"}>
                          <span
                            className="block h-full rounded-full"
                            style={{
                              width: `${(bucket.count / maxActivityBucketCount) * 100}%`,
                              backgroundColor: active ? "#ffffff" : activePileAccent
                            }}
                          />
                        </span>
                      </button>
                    );
                  })}
                  {!activityBuckets.length ? <p className="text-xs text-[var(--color-ink-soft)]">No recent activity yet.</p> : null}
                </div>
              </div>

            </CardContent>
          </Card>
        </aside>

        <div className="pile-workbench-content min-h-0 xl:h-full">
          <Card className="pile-main-card flex min-h-0 flex-col overflow-hidden p-2.5 sm:p-3 xl:h-full">
            <CardHeader className="workbench-content-header flex-wrap items-center gap-3">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-soft)]">Main view</div>
                <CardTitle className="mt-0.5 text-base">{activePanelTitle}</CardTitle>
                <CardDescription className="line-clamp-1 text-xs leading-5">{activePanelDescription}</CardDescription>
              </div>
              <div className="panel-switch w-full shrink-0 sm:w-auto sm:min-w-[440px]" role="tablist" aria-label="Main view">
                {panelCards.map((card) => {
                  const active = route.panel === card.value;
                  return (
                    <button
                      key={card.value}
                      type="button"
                      onClick={() => updateRoute({ panel: card.value }, true)}
                      className="panel-switch-button"
                      data-active={active}
                      aria-pressed={active}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <card.icon className="h-3.5 w-3.5 shrink-0" style={{ color: activePileAccent }} />
                        <span className="truncate text-xs font-semibold">{card.label}</span>
                      </span>
                      <span className="panel-switch-meta">{card.metric}</span>
                    </button>
                  );
                })}
              </div>
            </CardHeader>

            <CardContent className="pile-main-body mt-2 flex min-h-0 flex-1 flex-col">
              {route.panel === "workspace" && !isTodoWorkspace ? (
                <div className="workspace-mode-grid mb-2 w-full shrink-0" role="tablist" aria-label="Workspace mode">
                  {workspaceCards.map((card) => {
                    const active = route.view === card.value;
                    return (
                      <button
                        key={card.value}
                        type="button"
                        onClick={() => updateRoute({ view: card.value }, true)}
                        className="workspace-mode-button"
                        data-active={active}
                        aria-pressed={active}
                      >
                        <span className="flex min-w-0 items-start gap-2">
                          <span className="workspace-mode-icon" style={{ color: card.accent, backgroundColor: `${card.accent}1a` }}>
                            <card.icon className="h-3.5 w-3.5 shrink-0" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-semibold">{card.label}</span>
                            <span className="workspace-mode-detail">{card.detail}</span>
                          </span>
                        </span>
                        <span className="workspace-mode-metric">{card.metric}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {route.panel === "notes" ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="rail-heading"><ListChecks className="h-3.5 w-3.5" /> Results</div>
                      <div className="mt-1 text-sm text-[var(--color-ink-soft)]">
                        {noteListMeta(route, allSessions.length, noteListItems.length, graphFocus, activeDisplayCategory)}
                      </div>
                    </div>
                    {graphFocus ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setGraphFocus(null);
                          setGraphInspect(null);
                        }}
                      >
                        Clear focus
                      </Button>
                    ) : null}
                  </div>
                  <ScrollArea className="min-h-0 flex-1">
                    <div className="grid gap-2 pr-5 pb-1 md:grid-cols-2 2xl:grid-cols-3">
                      {noteListItems.map((session) => {
                        const match = matches.get(session.id);
                        const isActive = session.id === selectedSessionId;
                        return (
                          <button
                            key={session.id}
                            type="button"
                            onClick={() => {
                              setGraphFocus({ label: titleFromSession(session), sessionIds: [session.id] });
                              setInformationDetail(sessionInformationDetail(session, match, session.pile_slug ?? activeDisplayCategory));
                              updateRoute({ note: session.id }, false);
                            }}
                            className={`rounded-[8px] border p-3 text-left transition ${
                              isActive ? "border-[var(--color-ink)] bg-[var(--color-ink)] text-white" : "border-[var(--color-line)] bg-[var(--color-paper-raised)] hover:bg-[var(--color-paper-sunken)]"
                            }`}
                          >
                            <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
                              <span className="min-w-0 truncate text-sm font-semibold">{titleFromSession(session)}</span>
                              <span className="flex shrink-0 flex-wrap justify-end gap-1">
                                <Badge tone="neutral">{sessionAccountLabel(session)}</Badge>
                                <Badge tone="neutral">{providerLabels[session.provider]}</Badge>
                              </span>
                            </div>
                            {(session.extra_piles ?? []).length ? (
                              <div className="mb-2 flex flex-wrap gap-1">
                                {(session.extra_piles ?? []).slice(0, 3).map((pile) => (
                                  <span
                                    key={pile}
                                    className={isActive ? "rounded-full border border-white/20 px-2 py-0.5 text-[10px] text-white/75" : "rounded-full border border-[var(--color-line)] px-2 py-0.5 text-[10px] text-[var(--color-ink-soft)]"}
                                  >
                                    {pile}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                            <div className={isActive ? "text-xs uppercase tracking-[0.08em] text-white/70" : "text-xs uppercase tracking-[0.08em] text-[var(--color-ink-soft)]"}>
                              {formatCompactDate(session.updated_at)}
                            </div>
                            <p className={isActive ? "mt-2 line-clamp-3 break-words text-sm leading-6 text-white/80" : "mt-2 line-clamp-3 break-words text-sm leading-6 text-[var(--color-ink-soft)]"}>
                              {sessionPreviewText(session, match, session.pile_slug ?? activeDisplayCategory)}
                            </p>
                          </button>
                        );
                      })}
                      {!noteListItems.length ? <p className="text-sm text-[var(--color-ink-soft)]">No notes match this view yet.</p> : null}
                    </div>
                  </ScrollArea>
                </div>
              ) : route.panel === "reader" ? (
                <div className="reader-pane reader-viewport flex min-h-0 flex-1 flex-col">
                  <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-line)] pb-3">
                    <div className="min-w-0">
                      <div className="rail-heading"><BookOpen className="h-3.5 w-3.5" /> Reader</div>
                      <CardTitle className="mt-1 truncate text-2xl">{selectedSession ? titleFromSession(selectedSession) : "Choose a note"}</CardTitle>
                      <CardDescription className="mt-1 text-sm leading-6">
                        {noteQuery.data
                          ? [
                              providerLabels[noteQuery.data.provider],
                              sessionAccountLabel(noteQuery.data),
                              displayPileLabel(noteQuery.data.pile_slug ?? route.pile),
                              formatLongDate(noteQuery.data.updated_at),
                              `${formatNumber(noteQuery.data.word_count)} words`
                            ].join(" · ")
                          : "Select a note from Notes, the concept map, or a storyline to inspect it here."}
                      </CardDescription>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button variant="secondary" size="sm" onClick={() => updateRoute({ panel: "notes" }, true)}>
                        <ListChecks className="h-3.5 w-3.5" />
                        Notes
                      </Button>
                      {selectedSession ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            window.location.href = notePageUrl({
                              id: selectedSession.id,
                              pile: selectedSession.pile_slug ?? route.pile,
                              q: route.q,
                              provider: route.provider,
                              accountKey: route.accountKey,
                              sort: route.sort,
                              extraPile: route.extraPile
                            });
                          }}
                        >
                          <BookOpen className="h-3.5 w-3.5" />
                          Open note
                        </Button>
                      ) : null}
                      {noteQuery.data?.source_url ? (
                        <Button variant="secondary" size="sm" onClick={() => void chrome.tabs.create({ url: noteQuery.data!.source_url! })}>
                          <ExternalLink className="h-4 w-4" />
                          Source
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {extraPileError ? (
                    <div className="mb-4 rounded-[8px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{extraPileError}</div>
                  ) : null}
                  {selectedSession && noteQuery.isLoading ? (
                    <div className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-5 text-sm text-[var(--color-ink-soft)]">Loading note content...</div>
                  ) : selectedSession && noteQuery.data ? (
                    <Tabs.Root className="flex min-h-0 flex-1 flex-col" value={readerTab} onValueChange={(value) => setReaderTab(value as typeof readerTab)}>
                      <Tabs.List className="mb-3 grid w-full grid-cols-3 rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-1">
                        {[
                          { value: "overview", label: "Overview" },
                          { value: "transcript", label: "Transcript" },
                          { value: "markdown", label: "Markdown" }
                        ].map((tab) => (
                          <Tabs.Trigger
                            key={tab.value}
                            value={tab.value}
                            className="rounded-[6px] px-3 py-2 text-sm font-medium text-[var(--color-ink-soft)] outline-none transition data-[state=active]:bg-[var(--color-paper-raised)] data-[state=active]:text-[var(--color-ink)] data-[state=active]:shadow-sm"
                          >
                            {tab.label}
                          </Tabs.Trigger>
                        ))}
                      </Tabs.List>

                      <ScrollArea className="min-h-0 flex-1">
                        <div className="mx-auto max-w-[920px] pr-5 pb-6">
                          <Tabs.Content value="overview" className="outline-none">
                            <NoteOverview note={noteQuery.data as BackendSessionNoteRead} />
                          </Tabs.Content>
                          <Tabs.Content value="transcript" className="outline-none">
                            <TranscriptView note={noteQuery.data as BackendSessionNoteRead} />
                          </Tabs.Content>
                          <Tabs.Content value="markdown" className="outline-none">
                            <MarkdownView note={noteQuery.data as BackendSessionNoteRead} />
                          </Tabs.Content>
                        </div>
                      </ScrollArea>
                    </Tabs.Root>
                  ) : (
                    <div className="rounded-[8px] border border-dashed border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-8 text-sm text-[var(--color-ink-soft)]">
                      Select a note from Notes, the concept map, or a storyline to inspect its summary, transcript, and markdown.
                    </div>
                  )}
                </div>
              ) : isTodoWorkspace ? (
                <TodoWorkspace
                  todo={todo}
                  loading={todoQuery.isLoading}
                  error={todoActionError || (todoQuery.error instanceof Error ? todoQuery.error.message : null)}
                  savingSummary={todoSavingSummary}
                  taskUpdateCount={stats.notes_with_todo_summary}
                  draft={todoDraft}
                  onDraftChange={setTodoDraft}
                  onAddTask={() => void handleTodoAdd()}
                  onToggleTask={(item, done) => void handleTodoToggle(item, done)}
                  onInspectTask={inspectTodoItem}
                />
              ) : usesCategoryWorkspace ? (
                <CategoryWorkspace
                  pile={activeDisplayCategory}
                  view={route.view}
                  views={categoryViewsQuery.data ?? null}
                  sessions={visibleSessions}
                  loading={categoryViewsQuery.isLoading}
                  focusedProjectSlug={activeIdeaProjectGroup?.slug ?? null}
                  onFocus={activateFocus}
                />
              ) : (
                <Tabs.Root className="flex min-h-0 flex-1 flex-col" value={route.view} onValueChange={(value) => updateRoute({ view: value as PileWorkspaceView }, true)}>
                <Tabs.Content value="atlas" className="min-h-0 flex-1 outline-none">
                  <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-2">
                    <div className="graph-control-shelf">
                      <div className="control-shelf-summary">
                        <span className="tool-label">Concept map</span>
                        <span className="workspace-scope-chip">{scopeSummary}</span>
                      </div>

                      <div className="control-shelf-grid">
                        {renderGraphGroupSelect()}
                        {renderSemanticGroupSelect()}
                        {renderProviderFilterSelect()}
                        {renderKindFilterSelect()}
                        {renderDensitySelect()}
                        {renderFocusModeSelect()}
                        {renderGraphActionButtons()}
                      </div>
                    </div>

                    <div className="grid min-h-0 gap-2 xl:grid-cols-[minmax(0,1fr)_264px]">
                      <div className="flex min-h-0 flex-col">
                        <PileGraph
                          graph={filteredGraph}
                          pile={activeDisplayCategory}
                          groupingMode={groupingMode}
                          collapsedGroups={collapsedGroups}
                          density={graphDensity}
                          focusMode={graphFocusMode}
                          focusSessionIds={graphFocus?.sessionIds}
                          className="h-full min-h-[340px] flex-1 xl:min-h-0"
                          onFocus={handleFocus}
                          onInspect={setGraphInspect}
                        />
                    </div>

                    <div className="min-h-0 space-y-2">
                      <GraphEvidencePanel graph={graph} selection={graphInspect} onClear={() => setGraphInspect(null)} />

                      <GraphPathPanel
                        nodes={graphNodeOptions}
                        sourceId={pathSourceId}
                        targetId={pathTargetId}
                        path={pathQuery.data ?? null}
                        loading={pathQuery.isFetching}
                        error={pathQuery.error instanceof Error ? pathQuery.error : null}
                        onSourceChange={(nodeId) => {
                          setPathSourceId(nodeId);
                          if (nodeId === pathTargetId) {
                            setPathTargetId(graphNodeOptions.find((node) => node.id !== nodeId)?.id ?? null);
                          }
                        }}
                        onTargetChange={(nodeId) => {
                          setPathTargetId(nodeId);
                          if (nodeId === pathSourceId) {
                            setPathSourceId(graphNodeOptions.find((node) => node.id !== nodeId)?.id ?? null);
                          }
                        }}
                        onFocusPath={handlePathFocus}
                      />
                    </div>
                    </div>
                  </div>
                </Tabs.Content>

                <Tabs.Content value="story" className="min-h-0 flex-1 outline-none">
                  <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-2">
                    <div className="graph-control-shelf">
                      <div className="control-shelf-summary">
                        <span className="tool-label">Storylines</span>
                        <span className="workspace-scope-chip">{scopeSummary}</span>
                      </div>
                      <div className="control-shelf-grid control-shelf-grid--compact">
                        {renderGraphGroupSelect()}
                        {graphFocus ? (
                          <div className="control-actions">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setGraphFocus(null);
                                setGraphInspect(null);
                              }}
                              className="h-8 px-2.5 text-xs"
                            >
                              Clear focus
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <div className="grid min-h-0 gap-2 xl:grid-cols-[minmax(0,1fr)_300px]">
                    <div className="grid gap-2 md:grid-cols-2">
                      {graphInsights.storylines.slice(0, 6).map((storyline) => (
                        <button
                          key={storyline.id}
                          type="button"
                          onClick={() => activateFocus(storyline.label, storyline.sessionIds, "atlas")}
                          className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-3 text-left transition hover:border-[var(--color-line-strong)] hover:bg-[var(--color-paper-raised)]"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-soft)]">{storyline.clusterLabel}</div>
                              <div className="mt-1 truncate text-base font-semibold text-[var(--color-ink)]">{storyline.label}</div>
                            </div>
                            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: storyline.accent }} />
                          </div>

                          <p className="mt-2 line-clamp-2 text-sm leading-5 text-[var(--color-ink-soft)]">{storyline.summary}</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Badge tone="neutral">{formatNumber(storyline.noteCount)} notes</Badge>
                            <Badge tone="neutral">{formatNumber(storyline.degree)} links</Badge>
                          </div>
                          <div className="mt-2 text-xs uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">
                            Updated {formatCompactDate(storyline.lastUpdated, "No recent change")}
                          </div>
                        </button>
                      ))}
                      {!graphInsights.storylines.length ? (
                        <div className="rounded-[8px] border border-dashed border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-4 text-sm text-[var(--color-ink-soft)] md:col-span-2">
                          No storylines are available in this scope yet.
                        </div>
                      ) : null}
                    </div>

                    <div className="space-y-2">
                      <div className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-3">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-soft)]">Dense nodes</div>
                        <div className="mt-1 text-base font-semibold text-[var(--color-ink)]">High-traffic concepts</div>
                        <div className="mt-2 space-y-1.5">
                          {graphInsights.denseNodes.slice(0, 5).map((node) => (
                            <button
                              key={node.id}
                              type="button"
                              onClick={() => activateFocus(node.label, node.sessionIds, "atlas")}
                              className="flex w-full items-center justify-between gap-3 rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-2 py-2 text-left transition hover:bg-[var(--color-paper-sunken)]"
                            >
                              <div className="min-w-0">
                                <div className="truncate text-sm font-semibold text-[var(--color-ink)]">{node.label}</div>
                                <div className="mt-1 text-xs uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">
                                  {formatNumber(node.degree)} links · {formatNumber(node.noteCount)} notes
                                </div>
                              </div>
                              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: node.accent }} />
                            </button>
                          ))}
                          {!graphInsights.denseNodes.length ? <p className="text-sm text-[var(--color-ink-soft)]">No dense nodes in this scope yet.</p> : null}
                        </div>
                      </div>
                    </div>
                    </div>
                  </div>
                </Tabs.Content>

                <Tabs.Content value="ops" className="min-h-0 flex-1 outline-none">
                  <div className="grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-2">
                    <div className="graph-control-shelf">
                      <div className="control-shelf-summary">
                        <span className="tool-label">Graph health</span>
                        <span className="workspace-scope-chip">{scopeSummary}</span>
                      </div>
                      <div className="control-shelf-grid control-shelf-grid--compact">
                        {renderGraphGroupSelect()}
                        {renderProviderFilterSelect()}
                        {renderKindFilterSelect()}
                      </div>
                    </div>

                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                      {[
                        { label: "Coverage", value: `${formatPercent(graphInsights.sessionCoverage * 100)}%`, detail: `${formatNumber(graphInsights.graphSessionIds.length)} linked notes` },
                        { label: "Corroborated", value: formatNumber(graphInsights.corroboratedNodes), detail: "Shared nodes" },
                        { label: "Orphans", value: formatNumber(graphInsights.orphanNodes), detail: "Disconnected" },
                        {
                          label: "Clusters",
                          value: formatNumber(graphInsights.clusters.length),
                          detail: `${groupingMode === "community" ? "Topic" : groupingMode === "provider" ? "Provider" : "Type"} groups`
                        }
                      ].map((metric) => (
                        <div key={metric.label} className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-2.5">
                          <div className="flex items-baseline justify-between gap-2">
                            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">{metric.label}</div>
                            <div className="text-xl font-semibold text-[var(--color-ink)]">{metric.value}</div>
                          </div>
                          <div className="mt-1 truncate text-xs text-[var(--color-ink-soft)]">{metric.detail}</div>
                        </div>
                      ))}
                    </div>

                    <div className="grid min-h-0 gap-2 xl:grid-cols-[1.1fr_0.9fr]">
                      <div className="grid min-h-0 gap-2 xl:grid-rows-[minmax(0,1fr)_auto]">
                        <div className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-2.5">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <div>
                              <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-soft)]">Graph hygiene</div>
                              <div className="text-sm font-semibold text-[var(--color-ink)]">Maintenance cues</div>
                            </div>
                            <Badge tone={graphInsights.warnings.length ? "warning" : "success"}>
                              {graphInsights.warnings.length ? `${graphInsights.warnings.length} signals` : "Healthy"}
                            </Badge>
                          </div>

                          <div className="space-y-1.5">
                            {graphInsights.warnings.slice(0, 3).map((warning) => (
                              <div key={warning.id} className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-2">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="truncate text-sm font-semibold text-[var(--color-ink)]">{warning.label}</div>
                                    <div className="mt-0.5 line-clamp-1 text-xs leading-5 text-[var(--color-ink-soft)]">{warning.detail}</div>
                                  </div>
                                  <Badge tone={warning.tone === "warning" ? "warning" : warning.tone === "danger" ? "danger" : "info"}>
                                    {warning.tone}
                                  </Badge>
                                </div>
                                {warning.sessionIds?.length ? (
                                  <div className="mt-1.5">
                                    <Button size="sm" variant="secondary" className="h-7 px-2 text-[11px]" onClick={() => activateFocus(warning.label, warning.sessionIds ?? [], "atlas")}>
                                      Inspect
                                    </Button>
                                  </div>
                                ) : null}
                              </div>
                            ))}

                            {!graphInsights.warnings.length ? (
                              <div className="rounded-[8px] border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-800">
                                The current scope is connected enough to inspect clusters and storylines.
                              </div>
                            ) : null}
                          </div>
                        </div>

                        <div className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-2.5">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-soft)]">Query surface</div>
                            <Badge tone="neutral">{formatNumber(visibleSessions.length)} notes</Badge>
                          </div>
                          <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-4">
                            {[
                              { label: "Avg weight", value: graphInsights.averageEdgeWeight.toFixed(1) },
                              { label: "Nodes/note", value: graphInsights.averageNodesPerSession.toFixed(1) },
                              { label: "Single source", value: formatNumber(graphInsights.singleSourceNodes) },
                              { label: "Uncovered", value: formatNumber(graphInsights.uncoveredSessions) }
                            ].map((metric) => (
                              <div key={metric.label} className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-2 py-1.5">
                                <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">{metric.label}</div>
                                <div className="mt-0.5 text-sm font-semibold text-[var(--color-ink)]">{metric.value}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="grid min-h-0 gap-2 xl:grid-rows-[auto_minmax(0,1fr)]">
                        <div className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-2.5">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <div>
                              <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-soft)]">Provider mix</div>
                              <div className="text-sm font-semibold text-[var(--color-ink)]">Evidence by source</div>
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            {providerPie.map((item) => {
                              const maxCount = Math.max(...providerPie.map((provider) => provider.count), 1);
                              return (
                                <div key={item.provider} className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-2 py-1.5">
                                  <div className="flex items-center justify-between gap-3">
                                    <div className="text-xs font-medium text-[var(--color-ink)]">{item.label}</div>
                                    <div className="text-xs font-semibold text-[var(--color-ink)]">{formatNumber(item.count)}</div>
                                  </div>
                                  <div className="mt-1.5 h-1.5 rounded-full bg-[var(--color-paper-sunken)]">
                                    <div
                                      className="h-full rounded-full"
                                      style={{
                                        width: `${(item.count / maxCount) * 100}%`,
                                        backgroundColor: item.color
                                      }}
                                    />
                                  </div>
                                </div>
                              );
                            })}
                            {!providerPie.length ? <p className="text-sm text-[var(--color-ink-soft)]">No provider evidence in this scope yet.</p> : null}
                          </div>
                        </div>

                        <div className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-2.5">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <div>
                              <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-soft)]">Top signals</div>
                              <div className="text-sm font-semibold text-[var(--color-ink)]">Repeated labels</div>
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            {signals.primary.slice(0, 5).map((item) => (
                              <button
                                key={item.label}
                                type="button"
                                onClick={() => {
                                  setGraphFocus(null);
                                  setGraphInspect(null);
                                  updateRoute({ q: item.label, project: null, view: "atlas", note: null }, true);
                                }}
                                className="flex w-full items-center justify-between gap-2 rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-2 py-1.5 text-left transition hover:bg-[var(--color-paper-sunken)]"
                              >
                                <span className="truncate text-xs font-medium text-[var(--color-ink)]">{item.label}</span>
                                <span className="text-xs font-semibold text-[var(--color-ink)]">{formatNumber(item.count)}</span>
                              </button>
                            ))}
                            {!signals.primary.length ? <p className="text-sm text-[var(--color-ink-soft)]">No repeated labels yet.</p> : null}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </Tabs.Content>
                </Tabs.Root>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {informationDetail ? (
        <div className="information-detail-backdrop" role="dialog" aria-modal="true" aria-label={`${informationDetail.kind} detail`}>
          <div className="information-detail-panel">
            <div className="information-detail-header">
              <div className="min-w-0">
                <div className="information-detail-kicker">
                  {[informationDetail.kind, informationDetail.accountLabel, informationDetail.provider ? providerLabels[informationDetail.provider] : null, informationDetail.date ? formatCompactDate(informationDetail.date) : null]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                <h2>{informationDetail.title}</h2>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setInformationDetail(null)} aria-label="Close detail">
                <X className="h-4 w-4" />
              </Button>
            </div>

            {informationDetail.summary ? <p className="information-detail-summary">{informationDetail.summary}</p> : null}

            {informationDetail.chips?.length ? (
              <div className="information-detail-chips">
                {informationDetail.chips.slice(0, 14).map((chip) => (
                  <span key={chip}>{chip}</span>
                ))}
              </div>
            ) : null}

            {informationDetail.sections?.some((section) => section.body || section.items?.length) ? (
              <div className="information-detail-sections">
                {informationDetail.sections
                  .filter((section) => section.body || section.items?.length)
                  .map((section) => (
                    <section key={section.title}>
                      <h3>{section.title}</h3>
                      {section.body ? <p>{section.body}</p> : null}
                      {section.items?.length ? (
                        <ul>
                          {section.items.slice(0, 8).map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      ) : null}
                    </section>
                  ))}
              </div>
            ) : null}

            <div className="information-detail-actions">
              {informationDetail.sessionIds[0] ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    updateRoute({ note: informationDetail.sessionIds[0], panel: "reader" }, true);
                    setInformationDetail(null);
                  }}
                >
                  <BookOpen className="h-4 w-4" />
                  Source note
                </Button>
              ) : null}
              <Button variant="ghost" onClick={() => setInformationDetail(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {issueMessage ? (
        <div className="pile-workbench-error rounded-[8px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {issueMessage}
        </div>
      ) : null}
    </div>
  );
}

mountApp(<App />);
