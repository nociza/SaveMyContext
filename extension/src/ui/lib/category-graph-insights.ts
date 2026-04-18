import { categoryPalette, providerColors, providerLabels } from "../../shared/explorer";
import type {
  BackendCategoryGraph,
  BackendExplorerGraphNode,
  BackendSessionListItem,
  ProviderName,
  SessionCategoryName
} from "../../shared/types";

export type GraphGroupingMode = "community" | "provider" | "kind";
export type InsightTone = "neutral" | "info" | "warning" | "danger";

export interface CategoryGraphCluster {
  id: string;
  label: string;
  accent: string;
  mode: GraphGroupingMode;
  provider?: ProviderName | null;
  nodeIds: string[];
  nodeCount: number;
  edgeCount: number;
  sessionIds: string[];
  noteCount: number;
}

export interface CategoryGraphDenseNode {
  id: string;
  label: string;
  accent: string;
  kind: string;
  provider?: ProviderName | null;
  degree: number;
  noteCount: number;
  sessionIds: string[];
  neighbors: string[];
  lastUpdated?: string | null;
}

export interface CategoryGraphStoryline extends CategoryGraphDenseNode {
  clusterId: string;
  clusterLabel: string;
  score: number;
  summary: string;
}

export interface CategoryGraphWarning {
  id: string;
  tone: InsightTone;
  label: string;
  detail: string;
  sessionIds?: string[];
}

export interface CategoryGraphInsights {
  clusters: CategoryGraphCluster[];
  denseNodes: CategoryGraphDenseNode[];
  storylines: CategoryGraphStoryline[];
  warnings: CategoryGraphWarning[];
  graphSessionIds: string[];
  corroboratedNodes: number;
  singleSourceNodes: number;
  orphanNodes: number;
  uncoveredSessions: number;
  sessionCoverage: number;
  averageEdgeWeight: number;
  averageNodesPerSession: number;
}

const kindAccents = ["#0f8a84", "#c77724", "#2477c7", "#b04d37", "#2f855a", "#0ea5a4"];
const communityAccents = ["#0f8a84", "#c77724", "#4968ab", "#b04d37", "#2f855a", "#7c5aa6", "#2477c7", "#8b5e34"];

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function uniqueStrings(values: Iterable<string>): string[] {
  return Array.from(new Set(values));
}

function latestSessionTimestamp(sessionIds: string[], sessionTimestampById: Map<string, string | null | undefined>): string | null {
  let latest: string | null = null;
  for (const sessionId of sessionIds) {
    const candidate = sessionTimestampById.get(sessionId) ?? null;
    if (candidate && (!latest || candidate > latest)) {
      latest = candidate;
    }
  }
  return latest;
}

export function clusterKeyForNode(node: Pick<BackendExplorerGraphNode, "kind" | "provider">, groupingMode: GraphGroupingMode): string {
  if (groupingMode === "community") {
    return "community:unassigned";
  }
  if (groupingMode === "provider") {
    return node.provider ? `provider:${node.provider}` : "provider:unassigned";
  }
  return `kind:${node.kind || "unknown"}`;
}

export function clusterLabelForNode(node: Pick<BackendExplorerGraphNode, "kind" | "provider">, groupingMode: GraphGroupingMode): string {
  if (groupingMode === "community") {
    return "Community";
  }
  if (groupingMode === "provider") {
    return node.provider ? providerLabels[node.provider] : "Unassigned";
  }
  return titleCase(node.kind || "Unknown");
}

export function clusterAccentForNode(
  node: Pick<BackendExplorerGraphNode, "kind" | "provider">,
  category: SessionCategoryName,
  groupingMode: GraphGroupingMode
): string {
  if (groupingMode === "community") {
    return categoryPalette[category].accent;
  }
  if (groupingMode === "provider" && node.provider) {
    return providerColors[node.provider];
  }
  const kind = node.kind?.trim();
  if (!kind) {
    return categoryPalette[category].accent;
  }
  return kindAccents[hashString(kind) % kindAccents.length] ?? categoryPalette[category].accent;
}

type MutableCluster = {
  id: string;
  label: string;
  accent: string;
  mode: GraphGroupingMode;
  provider?: ProviderName | null;
  nodeIds: Set<string>;
  sessionIds: Set<string>;
  edgeCount: number;
};

export interface CategoryGraphClusterLookup {
  clusters: CategoryGraphCluster[];
  byNodeId: Map<string, CategoryGraphCluster>;
}

function buildAdjacency(graph: BackendCategoryGraph): Map<string, Map<string, number>> {
  const adjacency = new Map<string, Map<string, number>>();
  for (const node of graph.nodes) {
    adjacency.set(node.id, new Map());
  }

  for (const edge of graph.edges) {
    if (!adjacency.has(edge.source) || !adjacency.has(edge.target) || edge.source === edge.target) {
      continue;
    }
    const weight = Math.max(edge.weight, 1);
    const sourceNeighbors = adjacency.get(edge.source);
    const targetNeighbors = adjacency.get(edge.target);
    sourceNeighbors?.set(edge.target, (sourceNeighbors.get(edge.target) ?? 0) + weight);
    targetNeighbors?.set(edge.source, (targetNeighbors.get(edge.source) ?? 0) + weight);
  }

  return adjacency;
}

function detectCommunities(graph: BackendCategoryGraph): Map<string, string> {
  const adjacency = buildAdjacency(graph);
  const communities = new Map(graph.nodes.map((node) => [node.id, node.id] as const));
  const rankedNodes = [...graph.nodes].sort((left, right) => {
    const leftDegree = adjacency.get(left.id)?.size ?? 0;
    const rightDegree = adjacency.get(right.id)?.size ?? 0;
    return rightDegree - leftDegree || right.session_ids.length - left.session_ids.length || left.label.localeCompare(right.label);
  });

  for (let iteration = 0; iteration < 10; iteration += 1) {
    let changed = false;

    for (const node of rankedNodes) {
      const neighbors = adjacency.get(node.id);
      if (!neighbors?.size) {
        communities.set(node.id, "peripheral");
        continue;
      }

      const scores = new Map<string, number>();
      for (const [neighborId, weight] of neighbors) {
        const communityId = communities.get(neighborId) ?? neighborId;
        scores.set(communityId, (scores.get(communityId) ?? 0) + weight);
      }

      const currentCommunityId = communities.get(node.id) ?? node.id;
      const currentScore = scores.get(currentCommunityId) ?? 0;
      const [bestCommunityId, bestScore] =
        [...scores.entries()].sort(
          ([leftId, leftScore], [rightId, rightScore]) =>
            rightScore - leftScore || (leftId === currentCommunityId ? -1 : rightId === currentCommunityId ? 1 : leftId.localeCompare(rightId))
        )[0] ?? [currentCommunityId, currentScore];

      if (bestCommunityId !== currentCommunityId && bestScore >= currentScore) {
        communities.set(node.id, bestCommunityId);
        changed = true;
      }
    }

    if (!changed) {
      break;
    }
  }

  return communities;
}

function nodeImportance(node: BackendExplorerGraphNode, adjacency: Map<string, Map<string, number>>): number {
  const degree = adjacency.get(node.id)?.size ?? 0;
  return degree * 5 + node.session_ids.length * 4 + Math.log(node.size + 1) * 6;
}

export function buildCategoryGraphClusters(
  graph: BackendCategoryGraph,
  category: SessionCategoryName,
  groupingMode: GraphGroupingMode
): CategoryGraphClusterLookup {
  const adjacency = buildAdjacency(graph);
  const communityByNodeId = groupingMode === "community" ? detectCommunities(graph) : null;
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const mutableClusters = new Map<string, MutableCluster>();

  const ensureCluster = (node: BackendExplorerGraphNode): MutableCluster => {
    const communityId = communityByNodeId?.get(node.id);
    const id =
      groupingMode === "community"
        ? `community:${communityId ?? node.id}`
        : clusterKeyForNode(node, groupingMode);
    const created =
      mutableClusters.get(id) ??
      (() => {
        const cluster: MutableCluster = {
          id,
          label:
            groupingMode === "community"
              ? communityId === "peripheral"
                ? "Peripheral facts"
                : "Community"
              : clusterLabelForNode(node, groupingMode),
          accent:
            groupingMode === "community"
              ? communityAccents[mutableClusters.size % communityAccents.length] ?? categoryPalette[category].accent
              : clusterAccentForNode(node, category, groupingMode),
          mode: groupingMode,
          provider: groupingMode === "provider" ? node.provider ?? null : null,
          nodeIds: new Set<string>(),
          sessionIds: new Set<string>(),
          edgeCount: 0
        };
        mutableClusters.set(id, cluster);
        return cluster;
      })();

    return created;
  };

  for (const node of graph.nodes) {
    const cluster = ensureCluster(node);
    cluster.nodeIds.add(node.id);
    for (const sessionId of node.session_ids) {
      cluster.sessionIds.add(sessionId);
    }
  }

  for (const edge of graph.edges) {
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);
    if (!sourceNode || !targetNode) {
      continue;
    }

    const sourceCluster = ensureCluster(sourceNode);
    const targetCluster = ensureCluster(targetNode);
    sourceCluster.edgeCount += 1;
    if (sourceCluster.id !== targetCluster.id) {
      targetCluster.edgeCount += 1;
    }
  }

  const rankedMutableClusters = [...mutableClusters.values()].sort(
    (left, right) =>
      right.sessionIds.size - left.sessionIds.size ||
      right.edgeCount - left.edgeCount ||
      right.nodeIds.size - left.nodeIds.size ||
      left.id.localeCompare(right.id)
  );

  for (const [index, cluster] of rankedMutableClusters.entries()) {
    if (groupingMode !== "community") {
      continue;
    }
    cluster.accent = communityAccents[index % communityAccents.length] ?? categoryPalette[category].accent;
    if (cluster.id === "community:peripheral") {
      cluster.label = "Peripheral facts";
      continue;
    }

    const anchorLabels = [...cluster.nodeIds]
      .map((nodeId) => nodeById.get(nodeId))
      .filter((node): node is BackendExplorerGraphNode => Boolean(node))
      .sort((left, right) => nodeImportance(right, adjacency) - nodeImportance(left, adjacency) || left.label.localeCompare(right.label))
      .slice(0, 2)
      .map((node) => node.label);
    cluster.label = anchorLabels.length ? anchorLabels.join(" + ") : `Community ${index + 1}`;
  }

  const clusters = rankedMutableClusters.map((cluster) => ({
    id: cluster.id,
    label: cluster.label,
    accent: cluster.accent,
    mode: cluster.mode,
    provider: cluster.provider,
    nodeIds: Array.from(cluster.nodeIds),
    nodeCount: cluster.nodeIds.size,
    edgeCount: cluster.edgeCount,
    sessionIds: Array.from(cluster.sessionIds),
    noteCount: cluster.sessionIds.size
  }));

  const clusterById = new Map(clusters.map((cluster) => [cluster.id, cluster] as const));
  const byNodeId = new Map<string, CategoryGraphCluster>();
  for (const node of graph.nodes) {
    const clusterId =
      groupingMode === "community"
        ? `community:${communityByNodeId?.get(node.id) ?? node.id}`
        : clusterKeyForNode(node, groupingMode);
    const cluster = clusterById.get(clusterId);
    if (cluster) {
      byNodeId.set(node.id, cluster);
    }
  }

  return { clusters, byNodeId };
}

export function buildCategoryGraphInsights(
  graph: BackendCategoryGraph,
  sessions: BackendSessionListItem[],
  category: SessionCategoryName,
  groupingMode: GraphGroupingMode
): CategoryGraphInsights {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const sessionTimestampById = new Map(sessions.map((session) => [session.id, session.updated_at] as const));
  const graphSessionIds = new Set<string>();
  const adjacency = new Map<string, Set<string>>();
  const weightedNeighbors = new Map<string, Array<{ id: string; weight: number }>>();

  for (const node of graph.nodes) {
    adjacency.set(node.id, new Set());
    weightedNeighbors.set(node.id, []);
    for (const sessionId of node.session_ids) {
      graphSessionIds.add(sessionId);
    }
  }

  const clusterLookup = buildCategoryGraphClusters(graph, category, groupingMode);

  for (const edge of graph.edges) {
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);
    if (!sourceNode || !targetNode) {
      continue;
    }

    adjacency.get(sourceNode.id)?.add(targetNode.id);
    adjacency.get(targetNode.id)?.add(sourceNode.id);
    weightedNeighbors.get(sourceNode.id)?.push({ id: targetNode.id, weight: edge.weight });
    weightedNeighbors.get(targetNode.id)?.push({ id: sourceNode.id, weight: edge.weight });

    for (const sessionId of edge.session_ids) {
      graphSessionIds.add(sessionId);
    }
  }

  const clusters = clusterLookup.clusters;

  const orphanNodes = graph.nodes.filter((node) => (adjacency.get(node.id)?.size ?? 0) === 0);
  const corroboratedNodes = graph.nodes.filter((node) => node.session_ids.length > 1).length;
  const singleSourceNodes = graph.nodes.filter((node) => node.session_ids.length <= 1).length;

  const denseNodes = graph.nodes
    .map((node) => {
      const neighbors = (weightedNeighbors.get(node.id) ?? [])
        .sort((left, right) => right.weight - left.weight)
        .map((neighbor) => nodeById.get(neighbor.id)?.label ?? neighbor.id)
        .filter((value, index, values) => values.indexOf(value) === index)
        .slice(0, 4);

      return {
        id: node.id,
        label: node.label,
        accent: clusterLookup.byNodeId.get(node.id)?.accent ?? clusterAccentForNode(node, category, groupingMode),
        kind: node.kind,
        provider: node.provider ?? null,
        degree: adjacency.get(node.id)?.size ?? 0,
        noteCount: node.session_ids.length,
        sessionIds: node.session_ids,
        neighbors,
        lastUpdated: node.updated_at ?? latestSessionTimestamp(node.session_ids, sessionTimestampById)
      };
    })
    .sort((left, right) => {
      const leftScore = left.degree * 4 + left.noteCount * 3;
      const rightScore = right.degree * 4 + right.noteCount * 3;
      return rightScore - leftScore || right.noteCount - left.noteCount || left.label.localeCompare(right.label);
    })
    .slice(0, 8);

  const storylineMap = new Map(clusters.map((cluster) => [cluster.id, cluster.label] as const));
  const storylines = graph.nodes
    .map((node) => {
      const clusterId = clusterKeyForNode(node, groupingMode);
      const cluster = clusterLookup.byNodeId.get(node.id);
      const degree = adjacency.get(node.id)?.size ?? 0;
      const noteCount = node.session_ids.length;
      const score = degree * 4 + noteCount * 3 + Math.log(node.size + 1) * 6;
      const neighbors = (weightedNeighbors.get(node.id) ?? [])
        .sort((left, right) => right.weight - left.weight)
        .map((neighbor) => nodeById.get(neighbor.id)?.label ?? neighbor.id)
        .filter((value, index, values) => values.indexOf(value) === index)
        .slice(0, 3);

      const summary =
        neighbors.length > 0
          ? `Connects with ${neighbors.join(", ")} across ${noteCount} ${noteCount === 1 ? "note" : "notes"}.`
          : `Appears in ${noteCount} ${noteCount === 1 ? "note" : "notes"} without visible links in this scope.`;

      return {
        id: node.id,
        label: node.label,
        accent: cluster?.accent ?? clusterAccentForNode(node, category, groupingMode),
        kind: node.kind,
        provider: node.provider ?? null,
        degree,
        noteCount,
        sessionIds: node.session_ids,
        neighbors,
        lastUpdated: node.updated_at ?? latestSessionTimestamp(node.session_ids, sessionTimestampById),
        clusterId: cluster?.id ?? clusterId,
        clusterLabel: cluster?.label ?? storylineMap.get(clusterId) ?? clusterId,
        score,
        summary
      };
    })
    .sort((left, right) => right.score - left.score || right.noteCount - left.noteCount || left.label.localeCompare(right.label))
    .slice(0, 6);

  const uncoveredSessionIds = sessions.filter((session) => !graphSessionIds.has(session.id)).map((session) => session.id);
  const sessionCoverage = sessions.length ? graphSessionIds.size / sessions.length : 0;
  const averageEdgeWeight = graph.edges.length ? graph.edges.reduce((sum, edge) => sum + edge.weight, 0) / graph.edges.length : 0;
  const averageNodesPerSession = sessions.length ? graph.nodes.length / sessions.length : 0;

  const warnings: CategoryGraphWarning[] = [];

  if (orphanNodes.length > 0) {
    warnings.push({
      id: "orphans",
      tone: orphanNodes.length >= 6 ? "warning" : "info",
      label: `${orphanNodes.length} disconnected ${orphanNodes.length === 1 ? "node" : "nodes"}`,
      detail: "These entities appear in the current scope without visible relationships.",
      sessionIds: uniqueStrings(orphanNodes.flatMap((node) => node.session_ids))
    });
  }

  if (uncoveredSessionIds.length > 0) {
    warnings.push({
      id: "coverage",
      tone: sessionCoverage < 0.6 ? "warning" : "info",
      label: `${uncoveredSessionIds.length} ${uncoveredSessionIds.length === 1 ? "note is" : "notes are"} outside the graph`,
      detail: "The scoped note list is larger than the graph evidence available for this view.",
      sessionIds: uncoveredSessionIds
    });
  }

  if (singleSourceNodes > corroboratedNodes && graph.nodes.length > 4) {
    warnings.push({
      id: "single-source",
      tone: "info",
      label: "Most nodes are single-source",
      detail: "Cross-note corroboration is still thin in this slice of the graph."
    });
  }

  return {
    clusters,
    denseNodes,
    storylines,
    warnings,
    graphSessionIds: Array.from(graphSessionIds),
    corroboratedNodes,
    singleSourceNodes,
    orphanNodes: orphanNodes.length,
    uncoveredSessions: uncoveredSessionIds.length,
    sessionCoverage,
    averageEdgeWeight,
    averageNodesPerSession
  };
}
