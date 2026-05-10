import type {
  BackendCapabilities,
  BackendPileGraph,
  BackendPileGraphPath,
  BackendPileStats,
  BackendPileViews,
  ConnectionRedeemResponse,
  BackendDashboardSummary,
  BackendDiscardedSessionsResponse,
  BackendExplorerGraphEdge,
  BackendExplorerGraphPath,
  BackendExplorerGraphNode,
  BackendJournalGroup,
  BackendGraphEdge,
  BackendGraphNode,
  BackendIdeaProjectRead,
  BackendPileRead,
  BackendPromptTemplateRead,
  BackendProcessingStatus,
  BackendSearchResponse,
  BackendSessionListItem,
  BackendSessionNoteRead,
  BackendSessionRead,
  BackendStorageSettings,
  BackendSystemStatus,
  BackendTodoListRead,
  BackendTodoListUpdate,
  ParsedConnectionBundle,
  BackendExtraPileSummary,
  ExtensionSettings,
  ProcessingCompleteResponse,
  ProcessingTaskResponse,
  ProviderName,
  BuiltInPileSlug,
  SourceCapturePayload,
  SourceCaptureResponse
} from "../shared/types";

const REQUIRED_EXTENSION_SCOPES = ["ingest", "read"] as const;

function normalizeBackendUrl(rawUrl: string): string {
  return rawUrl.trim().replace(/\/$/, "");
}

export function isLocalBackendUrl(candidate: URL): boolean {
  return candidate.hostname === "127.0.0.1" || candidate.hostname === "localhost" || candidate.hostname === "[::1]";
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }
  return 0;
}

function authorizationHeader(token?: string): Record<string, string> {
  if (!token) {
    return {};
  }
  return { Authorization: `Bearer ${token}` };
}

function hasScope(scopes: string[], requiredScope: (typeof REQUIRED_EXTENSION_SCOPES)[number]): boolean {
  return scopes.includes("*") || scopes.includes(requiredScope);
}

function apiPrefix(capabilities?: BackendCapabilities): string {
  return capabilities?.api_prefix ?? "/api/v1";
}

function backendApiUrl(settings: ExtensionSettings, path: string, capabilities?: BackendCapabilities): string {
  return `${normalizeBackendUrl(settings.backendUrl)}${apiPrefix(capabilities)}${path}`;
}

async function fetchBackendJson<TResponse>(
  settings: ExtensionSettings,
  path: string,
  capabilities?: BackendCapabilities
): Promise<TResponse> {
  const response = await fetch(backendApiUrl(settings, path, capabilities), {
    headers: authorizationHeader(settings.backendToken)
  });
  if (!response.ok) {
    throw new Error(`Backend request failed with ${response.status}.`);
  }
  return (await response.json()) as TResponse;
}

function arrayOrEmpty<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function normalizeSessionListItem<TSession extends BackendSessionListItem>(session: TSession): TSession {
  return {
    ...session,
    custom_tags: arrayOrEmpty(session.custom_tags),
    extra_piles: arrayOrEmpty(session.extra_piles)
  };
}

function normalizeSessionRead<TSession extends BackendSessionRead>(session: TSession): TSession {
  return {
    ...normalizeSessionListItem(session),
    messages: arrayOrEmpty(session.messages),
    triplets: arrayOrEmpty(session.triplets)
  };
}

function normalizeSessionNoteRead(note: BackendSessionNoteRead): BackendSessionNoteRead {
  return {
    ...normalizeSessionRead(note),
    related_entities: arrayOrEmpty(note.related_entities),
    word_count: note.word_count ?? 0
  };
}

function normalizeTodoList(todo: BackendTodoListRead): BackendTodoListRead {
  const items = arrayOrEmpty(todo.items);
  const activeCount = items.filter((item) => !item.done).length;
  const completedCount = items.filter((item) => item.done).length;
  const git = todo.git;
  return {
    ...todo,
    title: todo.title ?? "Shared checklist",
    content: todo.content ?? "",
    items,
    active_count: todo.active_count ?? activeCount,
    completed_count: todo.completed_count ?? completedCount,
    total_count: todo.total_count ?? items.length,
    git: {
      ...(git ?? {}),
      versioning_enabled: git?.versioning_enabled ?? false,
      available: git?.available ?? false,
      repository_ready: git?.repository_ready ?? false
    }
  };
}

function normalizePileStats(stats: BackendPileStats, fallbackPile: BuiltInPileSlug, fallbackLabel: string): BackendPileStats {
  return {
    ...stats,
    pile_slug: stats.pile_slug ?? fallbackPile,
    scope_kind: stats.scope_kind ?? "default",
    scope_label: stats.scope_label ?? fallbackLabel,
    dominant_pile_slug: stats.dominant_pile_slug ?? fallbackPile,
    total_sessions: stats.total_sessions ?? 0,
    total_messages: stats.total_messages ?? 0,
    total_triplets: stats.total_triplets ?? 0,
    latest_updated_at: stats.latest_updated_at ?? null,
    avg_messages_per_session: stats.avg_messages_per_session ?? 0,
    avg_triplets_per_session: stats.avg_triplets_per_session ?? 0,
    notes_with_share_post: stats.notes_with_share_post ?? 0,
    notes_with_idea_summary: stats.notes_with_idea_summary ?? 0,
    notes_with_journal_entry: stats.notes_with_journal_entry ?? 0,
    notes_with_todo_summary: stats.notes_with_todo_summary ?? 0,
    built_in_pile_counts: arrayOrEmpty(stats.built_in_pile_counts),
    provider_counts: arrayOrEmpty(stats.provider_counts),
    activity: arrayOrEmpty(stats.activity),
    top_tags: arrayOrEmpty(stats.top_tags),
    top_entities: arrayOrEmpty(stats.top_entities),
    top_predicates: arrayOrEmpty(stats.top_predicates)
  };
}

function normalizeExplorerGraphNode(node: BackendExplorerGraphNode): BackendExplorerGraphNode {
  const evidence = arrayOrEmpty(node.evidence);
  return {
    ...node,
    size: node.size ?? 1,
    session_ids: arrayOrEmpty(node.session_ids),
    degree: node.degree ?? 0,
    centrality: node.centrality ?? 0,
    evidence_count: node.evidence_count ?? evidence.length,
    evidence
  };
}

function normalizeExplorerGraphEdge(edge: BackendExplorerGraphEdge): BackendExplorerGraphEdge {
  const evidence = arrayOrEmpty(edge.evidence);
  return {
    ...edge,
    weight: edge.weight ?? 1,
    session_ids: arrayOrEmpty(edge.session_ids),
    predicate_count: edge.predicate_count ?? 1,
    evidence_count: edge.evidence_count ?? evidence.length,
    evidence
  };
}

function normalizePileGraph(graph: BackendPileGraph, fallbackPile: BuiltInPileSlug, fallbackLabel: string): BackendPileGraph {
  const nodes = arrayOrEmpty(graph.nodes).map(normalizeExplorerGraphNode);
  const edges = arrayOrEmpty(graph.edges).map(normalizeExplorerGraphEdge);
  return {
    ...graph,
    pile_slug: graph.pile_slug ?? fallbackPile,
    scope_kind: graph.scope_kind ?? "default",
    scope_label: graph.scope_label ?? fallbackLabel,
    dominant_pile_slug: graph.dominant_pile_slug ?? fallbackPile,
    node_count: graph.node_count ?? nodes.length,
    edge_count: graph.edge_count ?? edges.length,
    nodes,
    edges
  };
}

function normalizeJournalGroup(group: BackendJournalGroup): BackendJournalGroup {
  return {
    ...group,
    slug: group.slug ?? null,
    kind: group.kind ?? null,
    session_ids: arrayOrEmpty(group.session_ids),
    dates: arrayOrEmpty(group.dates),
    snippets: arrayOrEmpty(group.snippets)
  };
}

function normalizePileViews(views: BackendPileViews, fallbackPile: BuiltInPileSlug, fallbackLabel: string): BackendPileViews {
  return {
    ...views,
    pile_slug: views.pile_slug ?? fallbackPile,
    scope_kind: views.scope_kind ?? "default",
    scope_label: views.scope_label ?? fallbackLabel,
    dominant_pile_slug: views.dominant_pile_slug ?? fallbackPile,
    journal: views.journal
      ? {
          ...views.journal,
          timeline: arrayOrEmpty(views.journal.timeline).map((item) => ({
            ...item,
            people: arrayOrEmpty(item.people),
            entities: arrayOrEmpty(item.entities),
            activities: arrayOrEmpty(item.activities),
            locations: arrayOrEmpty(item.locations),
            travel_path: arrayOrEmpty(item.travel_path)
          })),
          locations: arrayOrEmpty(views.journal.locations).map(normalizeJournalGroup),
          people: arrayOrEmpty(views.journal.people).map(normalizeJournalGroup),
          entities: arrayOrEmpty(views.journal.entities).map(normalizeJournalGroup),
          activities: arrayOrEmpty(views.journal.activities).map(normalizeJournalGroup)
        }
      : views.journal,
    ideas: views.ideas
      ? {
          ...views.ideas,
          nodes: arrayOrEmpty(views.ideas.nodes).map((node) => ({
            ...node,
            reasoning_steps: arrayOrEmpty(node.reasoning_steps),
            related_facts: arrayOrEmpty(node.related_facts),
            claims: arrayOrEmpty(node.claims),
            next_steps: arrayOrEmpty(node.next_steps)
          })),
          edges: arrayOrEmpty(views.ideas.edges).map((edge) => ({
            ...edge,
            session_ids: arrayOrEmpty(edge.session_ids)
          })),
          projects: arrayOrEmpty(views.ideas.projects).map(normalizeJournalGroup),
          threads: arrayOrEmpty(views.ideas.threads).map(normalizeJournalGroup),
          contributors: arrayOrEmpty(views.ideas.contributors).map(normalizeJournalGroup),
          facts: arrayOrEmpty(views.ideas.facts).map(normalizeJournalGroup)
        }
      : views.ideas,
    factual: views.factual
      ? {
          ...views.factual,
          backlog: arrayOrEmpty(views.factual.backlog).map((item) => ({
            ...item,
            keywords: arrayOrEmpty(item.keywords),
            entities: arrayOrEmpty(item.entities),
            triplet_count: item.triplet_count ?? 0,
            linked_from: arrayOrEmpty(item.linked_from).map((source) => ({
              ...source,
              matched_terms: arrayOrEmpty(source.matched_terms)
            }))
          })),
          keywords: arrayOrEmpty(views.factual.keywords),
          entities: arrayOrEmpty(views.factual.entities),
          linked_sources: arrayOrEmpty(views.factual.linked_sources).map((source) => ({
            ...source,
            matched_terms: arrayOrEmpty(source.matched_terms)
          }))
        }
      : views.factual
  };
}

function normalizeExplorerGraphPath(path: BackendExplorerGraphPath): BackendExplorerGraphPath {
  const nodes = arrayOrEmpty(path.nodes).map(normalizeExplorerGraphNode);
  const edges = arrayOrEmpty(path.edges).map(normalizeExplorerGraphEdge);
  return {
    ...path,
    node_ids: arrayOrEmpty(path.node_ids),
    edge_ids: arrayOrEmpty(path.edge_ids),
    nodes,
    edges,
    hop_count: path.hop_count ?? Math.max(nodes.length - 1, 0),
    score: path.score ?? 0,
    evidence_session_ids: arrayOrEmpty(path.evidence_session_ids)
  };
}

function normalizePileGraphPath(path: BackendPileGraphPath, fallbackPile: BuiltInPileSlug, fallbackLabel: string): BackendPileGraphPath {
  return {
    ...path,
    pile_slug: path.pile_slug ?? fallbackPile,
    scope_kind: path.scope_kind ?? "default",
    scope_label: path.scope_label ?? fallbackLabel,
    dominant_pile_slug: path.dominant_pile_slug ?? fallbackPile,
    paths: arrayOrEmpty(path.paths).map(normalizeExplorerGraphPath)
  };
}

function normalizeSearchResponse(response: BackendSearchResponse): BackendSearchResponse {
  const results = arrayOrEmpty(response.results).map((result) => ({
    ...result,
    extra_piles: arrayOrEmpty(result.extra_piles)
  }));
  return {
    ...response,
    count: response.count ?? results.length,
    results
  };
}

export function buildBackendHeaders(settings: ExtensionSettings): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...authorizationHeader(settings.backendToken)
  };
}

export async function validateBackendConfiguration(settings: ExtensionSettings): Promise<{
  normalizedUrl: string;
  capabilities: BackendCapabilities;
}> {
  const normalizedUrl = normalizeBackendUrl(settings.backendUrl);
  const parsedUrl = new URL(normalizedUrl);
  const isLocal = isLocalBackendUrl(parsedUrl);
  if (!isLocal && parsedUrl.protocol !== "https:") {
    throw new Error("Remote backends must use https://.");
  }

  const capabilityResponse = await fetch(`${normalizedUrl}/api/v1/meta/capabilities`, {
    headers: authorizationHeader(settings.backendToken)
  });
  if (!capabilityResponse.ok) {
    throw new Error(`Compatibility check failed with ${capabilityResponse.status}.`);
  }

  const capabilities = (await capabilityResponse.json()) as BackendCapabilities;
  if (capabilities.product !== "savemycontext") {
    throw new Error("The configured backend is not a SaveMyContext server.");
  }

  const extensionVersion = chrome.runtime.getManifest().version;
  if (compareVersions(extensionVersion, capabilities.extension.min_version) < 0) {
    throw new Error(
      `This extension is too old for the backend. Minimum required version: ${capabilities.extension.min_version}.`
    );
  }

  if (!isLocal && capabilities.auth.mode !== "app_token") {
    throw new Error("Remote SaveMyContext backends must be provisioned with an app token first.");
  }

  if (capabilities.auth.mode === "app_token" && !settings.backendToken) {
    throw new Error("A backend app token with ingest and read scopes is required.");
  }

  if (settings.backendToken) {
    const verifyResponse = await fetch(`${normalizedUrl}${capabilities.auth.token_verify_path}`, {
      headers: authorizationHeader(settings.backendToken)
    });
    if (!verifyResponse.ok) {
      throw new Error("The backend token is invalid or missing required access.");
    }
    const verification = (await verifyResponse.json()) as { valid?: boolean; scopes?: string[] };
    if (!verification.valid) {
      throw new Error("The backend token is invalid.");
    }
    const scopes = Array.isArray(verification.scopes) ? verification.scopes : [];
    const missingScopes = REQUIRED_EXTENSION_SCOPES.filter((scope) => !hasScope(scopes, scope));
    if (missingScopes.length) {
      throw new Error(`The backend token is missing required scopes: ${missingScopes.join(", ")}.`);
    }
  }

  return {
    normalizedUrl,
    capabilities
  };
}

export async function redeemConnectionBundle(
  bundle: ParsedConnectionBundle,
  payload: {
    installationId: string;
    clientName?: string;
    verificationCode?: string;
  }
): Promise<ConnectionRedeemResponse> {
  const response = await fetch(`${bundle.baseUrl}/api/v1/auth/connections/redeem`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      grant_id: bundle.grantId,
      secret: bundle.secret,
      installation_id: payload.installationId,
      client_name: payload.clientName,
      verification_code: payload.verificationCode?.trim() || undefined
    })
  });
  if (!response.ok) {
    let detail = `Connection enrollment failed with ${response.status}.`;
    try {
      const payload = (await response.json()) as { detail?: string };
      if (payload.detail) {
        detail = payload.detail;
      }
    } catch {
      // ignore non-json failures and keep the status-based message
    }
    throw new Error(detail);
  }
  return (await response.json()) as ConnectionRedeemResponse;
}

export async function fetchProcessingStatus(
  settings: ExtensionSettings,
  capabilities?: BackendCapabilities
): Promise<BackendProcessingStatus> {
  const statusResponse = await fetch(backendApiUrl(settings, "/processing/status", capabilities), {
    headers: authorizationHeader(settings.backendToken)
  });
  if (!statusResponse.ok) {
    throw new Error(`Processing status check failed with ${statusResponse.status}.`);
  }
  return (await statusResponse.json()) as BackendProcessingStatus;
}

export async function fetchNextProcessingTask(
  settings: ExtensionSettings,
  capabilities?: BackendCapabilities
): Promise<ProcessingTaskResponse> {
  const response = await fetch(backendApiUrl(settings, "/processing/next", capabilities), {
    method: "POST",
    headers: authorizationHeader(settings.backendToken)
  });
  if (!response.ok) {
    throw new Error(`Processing task request failed with ${response.status}.`);
  }
  const task = (await response.json()) as ProcessingTaskResponse;
  const tasks = arrayOrEmpty(task.tasks);
  return {
    ...task,
    tasks,
    task_count: task.task_count ?? tasks.length
  };
}

export async function completeProcessingTask(
  settings: ExtensionSettings,
  payload: {
    sessionIds: string[];
    responseText: string;
  },
  capabilities?: BackendCapabilities
): Promise<ProcessingCompleteResponse> {
  const response = await fetch(backendApiUrl(settings, "/processing/complete", capabilities), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authorizationHeader(settings.backendToken)
    },
    body: JSON.stringify({
      session_ids: payload.sessionIds,
      response_text: payload.responseText
    })
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Processing completion failed with ${response.status}: ${details.slice(0, 300)}`);
  }
  const result = (await response.json()) as ProcessingCompleteResponse;
  const results = arrayOrEmpty(result.results);
  return {
    ...result,
    processed_count: result.processed_count ?? results.filter((item) => item.processed).length,
    results
  };
}

export async function fetchDashboardSummary(
  settings: ExtensionSettings,
  capabilities?: BackendCapabilities
): Promise<BackendDashboardSummary> {
  const summary = await fetchBackendJson<BackendDashboardSummary>(settings, "/dashboard/summary", capabilities);
  return {
    ...summary,
    piles: summary.piles ?? [],
    extra_piles: summary.extra_piles ?? []
  };
}

export async function fetchSystemStatus(
  settings: ExtensionSettings,
  capabilities?: BackendCapabilities
): Promise<BackendSystemStatus> {
  return fetchBackendJson<BackendSystemStatus>(settings, "/system/status", capabilities);
}

export async function fetchTodoList(
  settings: ExtensionSettings,
  capabilities?: BackendCapabilities
): Promise<BackendTodoListRead> {
  return normalizeTodoList(await fetchBackendJson<BackendTodoListRead>(settings, "/todo", capabilities));
}

export async function updateTodoList(
  settings: ExtensionSettings,
  payload: BackendTodoListUpdate,
  capabilities?: BackendCapabilities
): Promise<BackendTodoListRead> {
  const response = await fetch(backendApiUrl(settings, "/todo", capabilities), {
    method: "PUT",
    headers: buildBackendHeaders(settings),
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Shared to-do update failed with ${response.status}: ${details.slice(0, 300)}`);
  }
  return normalizeTodoList((await response.json()) as BackendTodoListRead);
}

export async function fetchPiles(
  settings: ExtensionSettings,
  capabilities?: BackendCapabilities
): Promise<BackendPileRead[]> {
  const piles = await fetchBackendJson<BackendPileRead[]>(settings, "/piles", capabilities);
  return arrayOrEmpty(piles).map((pile) => ({
    ...pile,
    attributes: arrayOrEmpty(pile.attributes),
    pipeline_config: pile.pipeline_config ?? {}
  }));
}

export interface IdeaProjectCreatePayload {
  name: string;
  description?: string;
  sort_order?: number;
}

export interface IdeaProjectUpdatePayload {
  name?: string;
  description?: string;
  is_active?: boolean;
  sort_order?: number;
}

function normalizeIdeaProject(project: BackendIdeaProjectRead): BackendIdeaProjectRead {
  return {
    ...project,
    description: project.description ?? null,
    is_active: project.is_active ?? true,
    sort_order: project.sort_order ?? 100
  };
}

export async function fetchIdeaProjects(
  settings: ExtensionSettings,
  capabilities?: BackendCapabilities
): Promise<BackendIdeaProjectRead[]> {
  const projects = await fetchBackendJson<BackendIdeaProjectRead[]>(settings, "/idea-projects", capabilities);
  return arrayOrEmpty(projects).map(normalizeIdeaProject);
}

export async function createIdeaProject(
  settings: ExtensionSettings,
  payload: IdeaProjectCreatePayload,
  capabilities?: BackendCapabilities
): Promise<BackendIdeaProjectRead> {
  const response = await fetch(backendApiUrl(settings, "/idea-projects", capabilities), {
    method: "POST",
    headers: buildBackendHeaders(settings),
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Idea project create failed with ${response.status}: ${details.slice(0, 300)}`);
  }
  return normalizeIdeaProject((await response.json()) as BackendIdeaProjectRead);
}

export async function updateIdeaProject(
  settings: ExtensionSettings,
  slug: string,
  payload: IdeaProjectUpdatePayload,
  capabilities?: BackendCapabilities
): Promise<BackendIdeaProjectRead> {
  const response = await fetch(
    backendApiUrl(settings, `/idea-projects/${encodeURIComponent(slug)}`, capabilities),
    {
      method: "PATCH",
      headers: buildBackendHeaders(settings),
      body: JSON.stringify(payload)
    }
  );
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Idea project update failed with ${response.status}: ${details.slice(0, 300)}`);
  }
  return normalizeIdeaProject((await response.json()) as BackendIdeaProjectRead);
}

export async function deleteIdeaProject(
  settings: ExtensionSettings,
  slug: string,
  capabilities?: BackendCapabilities
): Promise<void> {
  const response = await fetch(
    backendApiUrl(settings, `/idea-projects/${encodeURIComponent(slug)}`, capabilities),
    {
      method: "DELETE",
      headers: buildBackendHeaders(settings)
    }
  );
  if (!response.ok && response.status !== 204) {
    const details = await response.text();
    throw new Error(`Idea project delete failed with ${response.status}: ${details.slice(0, 300)}`);
  }
}

export async function fetchPromptTemplates(
  settings: ExtensionSettings,
  capabilities?: BackendCapabilities
): Promise<BackendPromptTemplateRead[]> {
  const templates = await fetchBackendJson<BackendPromptTemplateRead[]>(settings, "/prompts/templates", capabilities);
  return arrayOrEmpty(templates).map((template) => ({
    ...template,
    variables: arrayOrEmpty(template.variables)
  }));
}

export interface PileCreatePayload {
  slug: string;
  name: string;
  description?: string;
  folder_label?: string;
  attributes: string[];
  pipeline_config?: Record<string, unknown>;
  sort_order?: number;
}

export interface PileUpdatePayload {
  name?: string;
  description?: string;
  folder_label?: string;
  attributes?: string[];
  pipeline_config?: Record<string, unknown>;
  is_active?: boolean;
  sort_order?: number;
}

export interface PromptTemplateUpdatePayload {
  system_prompt: string;
  user_prompt: string;
}

export async function createPile(
  settings: ExtensionSettings,
  payload: PileCreatePayload,
  capabilities?: BackendCapabilities
): Promise<BackendPileRead> {
  const response = await fetch(backendApiUrl(settings, "/piles", capabilities), {
    method: "POST",
    headers: buildBackendHeaders(settings),
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Pile create failed with ${response.status}: ${details.slice(0, 300)}`);
  }
  return (await response.json()) as BackendPileRead;
}

export async function updatePile(
  settings: ExtensionSettings,
  slug: string,
  payload: PileUpdatePayload,
  capabilities?: BackendCapabilities
): Promise<BackendPileRead> {
  const response = await fetch(
    backendApiUrl(settings, `/piles/${encodeURIComponent(slug)}`, capabilities),
    {
      method: "PATCH",
      headers: buildBackendHeaders(settings),
      body: JSON.stringify(payload)
    }
  );
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Pile update failed with ${response.status}: ${details.slice(0, 300)}`);
  }
  return (await response.json()) as BackendPileRead;
}

export async function deletePile(
  settings: ExtensionSettings,
  slug: string,
  capabilities?: BackendCapabilities
): Promise<void> {
  const response = await fetch(
    backendApiUrl(settings, `/piles/${encodeURIComponent(slug)}`, capabilities),
    {
      method: "DELETE",
      headers: buildBackendHeaders(settings)
    }
  );
  if (!response.ok && response.status !== 204) {
    const details = await response.text();
    throw new Error(`Pile delete failed with ${response.status}: ${details.slice(0, 300)}`);
  }
}

export async function updatePromptTemplate(
  settings: ExtensionSettings,
  key: string,
  payload: PromptTemplateUpdatePayload,
  capabilities?: BackendCapabilities
): Promise<BackendPromptTemplateRead> {
  const response = await fetch(
    backendApiUrl(settings, `/prompts/templates/${encodeURIComponent(key)}`, capabilities),
    {
      method: "PUT",
      headers: buildBackendHeaders(settings),
      body: JSON.stringify(payload)
    }
  );
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Prompt update failed with ${response.status}: ${details.slice(0, 300)}`);
  }
  return (await response.json()) as BackendPromptTemplateRead;
}

export async function resetPromptTemplate(
  settings: ExtensionSettings,
  key: string,
  capabilities?: BackendCapabilities
): Promise<void> {
  const response = await fetch(
    backendApiUrl(settings, `/prompts/templates/${encodeURIComponent(key)}`, capabilities),
    {
      method: "DELETE",
      headers: buildBackendHeaders(settings)
    }
  );
  if (!response.ok && response.status !== 204) {
    const details = await response.text();
    throw new Error(`Prompt reset failed with ${response.status}: ${details.slice(0, 300)}`);
  }
}

export async function fetchDiscardedSessions(
  settings: ExtensionSettings,
  capabilities?: BackendCapabilities
): Promise<BackendDiscardedSessionsResponse> {
  const response = await fetchBackendJson<BackendDiscardedSessionsResponse>(
    settings,
    "/piles/discarded/sessions",
    capabilities
  );
  const items = arrayOrEmpty(response.items);
  return {
    ...response,
    count: response.count ?? items.length,
    items
  };
}

export async function recoverDiscardedSession(
  settings: ExtensionSettings,
  sessionId: string,
  capabilities?: BackendCapabilities
): Promise<BackendSessionRead> {
  const response = await fetch(
    backendApiUrl(
      settings,
      `/piles/discarded/sessions/${encodeURIComponent(sessionId)}/recover`,
      capabilities
    ),
    {
      method: "POST",
      headers: buildBackendHeaders(settings)
    }
  );
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Recover discarded session failed with ${response.status}: ${details.slice(0, 300)}`);
  }
  return normalizeSessionRead((await response.json()) as BackendSessionRead);
}

export async function discardSession(
  settings: ExtensionSettings,
  sessionId: string,
  reason?: string,
  capabilities?: BackendCapabilities
): Promise<BackendSessionRead> {
  const url = backendApiUrl(
    settings,
    `/piles/discarded/sessions/${encodeURIComponent(sessionId)}/discard${
      reason ? `?reason=${encodeURIComponent(reason)}` : ""
    }`,
    capabilities
  );
  const response = await fetch(url, {
    method: "POST",
    headers: buildBackendHeaders(settings)
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Manual discard failed with ${response.status}: ${details.slice(0, 300)}`);
  }
  return normalizeSessionRead((await response.json()) as BackendSessionRead);
}

export async function fetchGraphNodes(
  settings: ExtensionSettings,
  capabilities?: BackendCapabilities
): Promise<BackendGraphNode[]> {
  const nodes = await fetchBackendJson<BackendGraphNode[]>(settings, "/graph/nodes", capabilities);
  return arrayOrEmpty(nodes).map((node) => ({
    ...node,
    degree: node.degree ?? 0
  }));
}

export async function fetchGraphEdges(
  settings: ExtensionSettings,
  capabilities?: BackendCapabilities
): Promise<BackendGraphEdge[]> {
  const edges = await fetchBackendJson<BackendGraphEdge[]>(settings, "/graph/edges", capabilities);
  return arrayOrEmpty(edges).map((edge) => ({
    ...edge,
    support_count: edge.support_count ?? 0,
    session_ids: arrayOrEmpty(edge.session_ids)
  }));
}

export async function fetchSessions(
  settings: ExtensionSettings,
  filters?: {
    provider?: ProviderName;
    pile?: string;
    extraPile?: string;
  },
  capabilities?: BackendCapabilities
): Promise<BackendSessionListItem[]> {
  const search = new URLSearchParams();
  if (filters?.provider) {
    search.set("provider", filters.provider);
  }
  if (filters?.pile) {
    search.set("pile", filters.pile);
  }
  if (filters?.extraPile) {
    search.set("extra_pile", filters.extraPile);
  }
  const query = search.toString();
  const sessions = await fetchBackendJson<BackendSessionListItem[]>(settings, `/sessions${query ? `?${query}` : ""}`, capabilities);
  return arrayOrEmpty(sessions).map(normalizeSessionListItem);
}

export async function fetchSession(
  settings: ExtensionSettings,
  sessionId: string,
  capabilities?: BackendCapabilities
): Promise<BackendSessionRead> {
  return normalizeSessionRead(await fetchBackendJson<BackendSessionRead>(settings, `/sessions/${encodeURIComponent(sessionId)}`, capabilities));
}

export async function fetchSessionNote(
  settings: ExtensionSettings,
  sessionId: string,
  capabilities?: BackendCapabilities
): Promise<BackendSessionNoteRead> {
  return normalizeSessionNoteRead(await fetchBackendJson<BackendSessionNoteRead>(settings, `/notes/${encodeURIComponent(sessionId)}`, capabilities));
}

export async function fetchPileStats(
  settings: ExtensionSettings,
  pile: BuiltInPileSlug,
  filters?: {
    provider?: ProviderName;
    sessionIds?: string[];
  },
  capabilities?: BackendCapabilities
): Promise<BackendPileStats> {
  const search = new URLSearchParams();
  if (filters?.provider) {
    search.set("provider", filters.provider);
  }
  for (const sessionId of filters?.sessionIds ?? []) {
    search.append("session_id", sessionId);
  }
  const query = search.toString();
  const stats = await fetchBackendJson<BackendPileStats>(
    settings,
    `/piles/${encodeURIComponent(pile)}/stats${query ? `?${query}` : ""}`,
    capabilities
  );
  return normalizePileStats(stats, pile, pile);
}

export async function fetchCustomPileStats(
  settings: ExtensionSettings,
  name: string,
  filters?: {
    provider?: ProviderName;
    sessionIds?: string[];
  },
  capabilities?: BackendCapabilities
): Promise<BackendPileStats> {
  const search = new URLSearchParams();
  if (filters?.provider) {
    search.set("provider", filters.provider);
  }
  for (const sessionId of filters?.sessionIds ?? []) {
    search.append("session_id", sessionId);
  }
  const query = search.toString();
  const stats = await fetchBackendJson<BackendPileStats>(
    settings,
    `/extra-piles/${encodeURIComponent(name)}/stats${query ? `?${query}` : ""}`,
    capabilities
  );
  return normalizePileStats(stats, stats.dominant_pile_slug ?? "factual", name);
}

export async function fetchPileGraph(
  settings: ExtensionSettings,
  pile: BuiltInPileSlug,
  filters?: {
    provider?: ProviderName;
    sessionIds?: string[];
  },
  capabilities?: BackendCapabilities
): Promise<BackendPileGraph> {
  const search = new URLSearchParams();
  if (filters?.provider) {
    search.set("provider", filters.provider);
  }
  for (const sessionId of filters?.sessionIds ?? []) {
    search.append("session_id", sessionId);
  }
  const query = search.toString();
  const graph = await fetchBackendJson<BackendPileGraph>(
    settings,
    `/piles/${encodeURIComponent(pile)}/graph${query ? `?${query}` : ""}`,
    capabilities
  );
  return normalizePileGraph(graph, pile, pile);
}

export async function fetchPileViews(
  settings: ExtensionSettings,
  pile: BuiltInPileSlug,
  filters?: {
    provider?: ProviderName;
    sessionIds?: string[];
  },
  capabilities?: BackendCapabilities
): Promise<BackendPileViews> {
  const search = new URLSearchParams();
  if (filters?.provider) {
    search.set("provider", filters.provider);
  }
  for (const sessionId of filters?.sessionIds ?? []) {
    search.append("session_id", sessionId);
  }
  const query = search.toString();
  const views = await fetchBackendJson<BackendPileViews>(
    settings,
    `/piles/${encodeURIComponent(pile)}/views${query ? `?${query}` : ""}`,
    capabilities
  );
  return normalizePileViews(views, pile, pile);
}

export async function fetchCustomPileGraph(
  settings: ExtensionSettings,
  name: string,
  filters?: {
    provider?: ProviderName;
    sessionIds?: string[];
  },
  capabilities?: BackendCapabilities
): Promise<BackendPileGraph> {
  const search = new URLSearchParams();
  if (filters?.provider) {
    search.set("provider", filters.provider);
  }
  for (const sessionId of filters?.sessionIds ?? []) {
    search.append("session_id", sessionId);
  }
  const query = search.toString();
  const graph = await fetchBackendJson<BackendPileGraph>(
    settings,
    `/extra-piles/${encodeURIComponent(name)}/graph${query ? `?${query}` : ""}`,
    capabilities
  );
  return normalizePileGraph(graph, graph.dominant_pile_slug ?? "factual", name);
}

export async function fetchCustomPileViews(
  settings: ExtensionSettings,
  name: string,
  filters?: {
    provider?: ProviderName;
    sessionIds?: string[];
  },
  capabilities?: BackendCapabilities
): Promise<BackendPileViews> {
  const search = new URLSearchParams();
  if (filters?.provider) {
    search.set("provider", filters.provider);
  }
  for (const sessionId of filters?.sessionIds ?? []) {
    search.append("session_id", sessionId);
  }
  const query = search.toString();
  const views = await fetchBackendJson<BackendPileViews>(
    settings,
    `/extra-piles/${encodeURIComponent(name)}/views${query ? `?${query}` : ""}`,
    capabilities
  );
  return normalizePileViews(views, views.dominant_pile_slug ?? "factual", name);
}

export async function fetchPileGraphPath(
  settings: ExtensionSettings,
  pile: BuiltInPileSlug,
  source: string,
  target: string,
  filters?: {
    provider?: ProviderName;
    sessionIds?: string[];
  },
  capabilities?: BackendCapabilities
): Promise<BackendPileGraphPath> {
  const search = new URLSearchParams({ source, target });
  if (filters?.provider) {
    search.set("provider", filters.provider);
  }
  for (const sessionId of filters?.sessionIds ?? []) {
    search.append("session_id", sessionId);
  }
  const path = await fetchBackendJson<BackendPileGraphPath>(
    settings,
    `/piles/${encodeURIComponent(pile)}/graph/path?${search.toString()}`,
    capabilities
  );
  return normalizePileGraphPath(path, pile, pile);
}

export async function fetchCustomPileGraphPath(
  settings: ExtensionSettings,
  name: string,
  source: string,
  target: string,
  filters?: {
    provider?: ProviderName;
    sessionIds?: string[];
  },
  capabilities?: BackendCapabilities
): Promise<BackendPileGraphPath> {
  const search = new URLSearchParams({ source, target });
  if (filters?.provider) {
    search.set("provider", filters.provider);
  }
  for (const sessionId of filters?.sessionIds ?? []) {
    search.append("session_id", sessionId);
  }
  const path = await fetchBackendJson<BackendPileGraphPath>(
    settings,
    `/extra-piles/${encodeURIComponent(name)}/graph/path?${search.toString()}`,
    capabilities
  );
  return normalizePileGraphPath(path, path.dominant_pile_slug ?? "factual", name);
}

export async function fetchExplorerSearch(
  settings: ExtensionSettings,
  query: string,
  options?: {
    limit?: number;
    pile?: string;
    provider?: ProviderName;
    extraPile?: string;
    kinds?: string[];
  },
  capabilities?: BackendCapabilities
): Promise<BackendSearchResponse> {
  const search = new URLSearchParams({
    q: query.trim(),
    limit: String(options?.limit ?? 25)
  });
  if (options?.pile) {
    search.set("pile", options.pile);
  }
  if (options?.provider) {
    search.set("provider", options.provider);
  }
  if (options?.extraPile) {
    search.set("extra_pile", options.extraPile);
  }
  for (const kind of options?.kinds ?? []) {
    search.append("kind", kind);
  }
  return normalizeSearchResponse(await fetchBackendJson<BackendSearchResponse>(settings, `/search?${search.toString()}`, capabilities));
}

export async function fetchExtraPiles(
  settings: ExtensionSettings,
  filters?: {
    provider?: ProviderName;
    pile?: string;
  },
  capabilities?: BackendCapabilities
): Promise<BackendExtraPileSummary[]> {
  const search = new URLSearchParams();
  if (filters?.provider) {
    search.set("provider", filters.provider);
  }
  if (filters?.pile) {
    search.set("pile", filters.pile);
  }
  const query = search.toString();
  const extraPiles = await fetchBackendJson<BackendExtraPileSummary[]>(
    settings,
    `/extra-piles${query ? `?${query}` : ""}`,
    capabilities
  );
  return arrayOrEmpty(extraPiles);
}

export async function updateSessionExtraPiles(
  settings: ExtensionSettings,
  sessionId: string,
  extraPiles: string[],
  capabilities?: BackendCapabilities
): Promise<BackendSessionListItem> {
  const response = await fetch(backendApiUrl(settings, `/sessions/${encodeURIComponent(sessionId)}/extra-piles`, capabilities), {
    method: "PUT",
    headers: buildBackendHeaders(settings),
    body: JSON.stringify({
      extra_piles: extraPiles
    })
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Session extra piles update failed with ${response.status}: ${details.slice(0, 300)}`);
  }
  return normalizeSessionListItem((await response.json()) as BackendSessionListItem);
}

export async function fetchKnowledgeSearch(
  settings: ExtensionSettings,
  query: string,
  limit = 8,
  options?: {
    provider?: ProviderName;
    kinds?: string[];
  },
  capabilities?: BackendCapabilities
): Promise<BackendSearchResponse> {
  const search = new URLSearchParams({
    q: query.trim(),
    limit: String(limit)
  });
  if (options?.provider) {
    search.set("provider", options.provider);
  }
  for (const kind of options?.kinds ?? []) {
    search.append("kind", kind);
  }
  return normalizeSearchResponse(await fetchBackendJson<BackendSearchResponse>(settings, `/search?${search.toString()}`, capabilities));
}

export async function updateKnowledgeStoragePath(
  settings: ExtensionSettings,
  markdownRoot: string,
  capabilities?: BackendCapabilities
): Promise<BackendStorageSettings> {
  const response = await fetch(backendApiUrl(settings, "/system/storage", capabilities), {
    method: "POST",
    headers: buildBackendHeaders(settings),
    body: JSON.stringify({
      markdown_root: markdownRoot.trim()
    })
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Knowledge path update failed with ${response.status}: ${details.slice(0, 300)}`);
  }
  return (await response.json()) as BackendStorageSettings;
}

export async function saveSourceCaptureToBackend(
  settings: ExtensionSettings,
  payload: SourceCapturePayload,
  capabilities?: BackendCapabilities
): Promise<SourceCaptureResponse> {
  const response = await fetch(backendApiUrl(settings, "/capture/source", capabilities), {
    method: "POST",
    headers: buildBackendHeaders(settings),
    body: JSON.stringify({
      capture_kind: payload.captureKind,
      save_mode: payload.saveMode,
      title: payload.title,
      page_title: payload.pageTitle,
      source_url: payload.sourceUrl,
      selection_text: payload.selectionText,
      source_text: payload.sourceText,
      source_markdown: payload.sourceMarkdown,
      raw_payload: payload.rawPayload
    })
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Source capture failed with ${response.status}: ${details.slice(0, 300)}`);
  }

  const saved = (await response.json()) as {
    source_id: string;
    title: string;
    capture_kind: "selection" | "page";
    save_mode: "raw" | "ai";
    processed: boolean;
    pile_slug?: string | null;
    markdown_path?: string | null;
    raw_source_path?: string | null;
  };
  return {
    ok: true,
    sourceId: saved.source_id,
    title: saved.title,
    captureKind: saved.capture_kind,
    saveMode: saved.save_mode,
    processed: saved.processed,
    pile_slug: saved.pile_slug ?? null,
    markdownPath: saved.markdown_path ?? null,
    rawSourcePath: saved.raw_source_path ?? null
  };
}
