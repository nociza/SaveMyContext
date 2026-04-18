import { useMemo } from "react";

import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps
} from "@xyflow/react";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum
} from "d3-force";

import { providerLabels } from "../../shared/explorer";
import type { BackendCategoryGraph, BackendExplorerGraphNode, ProviderName, SessionCategoryName } from "../../shared/types";
import {
  buildCategoryGraphClusters,
  clusterAccentForNode,
  type CategoryGraphCluster,
  type GraphGroupingMode
} from "../lib/category-graph-insights";
import { cn } from "../lib/utils";

export type CategoryGraphDensity = "curated" | "complete";
export type CategoryGraphFocusMode = "context" | "dim";

type GraphNodeData = {
  variant: "entity" | "cluster";
  label: string;
  kind: string;
  accent: string;
  sessionIds: string[];
  provider?: ProviderName | null;
  muted: boolean;
  meta: string;
  detail: string;
  noteCount: number;
  degree: number;
  hiddenCount?: number;
  collapsed?: boolean;
};

type GraphEdgeData = {
  label?: string | null;
  sessionIds: string[];
  muted: boolean;
  weight: number;
};

type SimNode = SimulationNodeDatum & {
  id: string;
  variant: "entity" | "cluster";
  label: string;
  kind: string;
  sessionIds: string[];
  provider?: ProviderName | null;
  accent: string;
  radius: number;
  targetX: number;
  targetY: number;
  muted: boolean;
  meta: string;
  detail: string;
  noteCount: number;
  degree: number;
  hiddenCount?: number;
  collapsed?: boolean;
};

type SimEdge = SimulationLinkDatum<SimNode> & {
  id: string;
  source: string | SimNode;
  target: string | SimNode;
  label?: string | null;
  sessionIds: string[];
  weight: number;
  muted: boolean;
};

type MutableCluster = {
  id: string;
  label: string;
  accent: string;
  provider?: ProviderName | null;
  nodes: BackendExplorerGraphNode[];
  sessionIds: Set<string>;
  edgeCount: number;
};

type FlowSummary = {
  visibleNodes: number;
  totalNodes: number;
  hiddenNodes: number;
  visibleEdges: number;
  totalEdges: number;
  clusterCount: number;
  contextOnly: boolean;
};

function GraphNodeCard({ data, selected }: NodeProps<Node<GraphNodeData>>) {
  const clusterCard = data.variant === "cluster";
  const handleStyle = {
    width: 1,
    height: 1,
    minWidth: 1,
    minHeight: 1,
    background: "transparent",
    border: "none",
    pointerEvents: "none" as const
  };

  return (
    <div
      className={cn(
        clusterCard ? "w-[204px] px-3 py-3" : "w-[156px] px-2.5 py-2",
        "relative rounded-[8px] border bg-[var(--color-paper-raised)] text-left transition",
        data.muted ? "border-[var(--color-line)]/70 opacity-35" : "border-[var(--color-line)]",
        selected ? "ring-2 ring-[rgba(15,27,44,0.14)] shadow-[0_10px_28px_-16px_rgba(15,27,44,0.28)]" : ""
      )}
      style={{
        borderColor: selected ? `${data.accent}66` : undefined,
        borderLeft: `3px solid ${data.accent}`
      }}
      title={data.label}
    >
      <Handle id="t" type="target" position={Position.Top} style={handleStyle} isConnectable={false} />
      <Handle id="l" type="target" position={Position.Left} style={handleStyle} isConnectable={false} />
      <Handle id="b" type="source" position={Position.Bottom} style={handleStyle} isConnectable={false} />
      <Handle id="r" type="source" position={Position.Right} style={handleStyle} isConnectable={false} />

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn("shrink-0 rounded-full", clusterCard ? "h-3 w-3" : "h-2.5 w-2.5")}
              style={{ backgroundColor: data.accent }}
            />
            <span className={cn("truncate font-semibold text-[var(--color-ink)]", clusterCard ? "text-sm" : "text-[12.5px]")}>
              {data.label}
            </span>
          </div>
          <div className={cn("mt-1 truncate font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-soft)]", clusterCard ? "text-[10.5px]" : "text-[10px]")}>
            {data.meta}
          </div>
        </div>
        {clusterCard && data.collapsed ? (
          <div className="shrink-0 rounded-full border border-[var(--color-line)] bg-[var(--color-paper-sunken)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">
            Closed
          </div>
        ) : null}
      </div>

      <div className={cn("mt-1.5 text-[11px] leading-4 text-[var(--color-ink-soft)]", clusterCard ? "" : "truncate")}>{data.detail}</div>
      {clusterCard && data.hiddenCount ? (
        <div className="mt-2 rounded-[8px] bg-[var(--color-paper-sunken)] px-2 py-1 text-[10.5px] font-medium text-[var(--color-ink-soft)]">
          {data.hiddenCount} hidden in clean map
        </div>
      ) : null}
    </div>
  );
}

function GraphEdgePath({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  data,
  selected
}: EdgeProps<Edge<GraphEdgeData>>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY
  });

  const muted = Boolean(data?.muted);
  const label = data?.label?.trim();
  const showLabel = Boolean(label) && selected;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: selected ? "#0f1b2c" : "#71717a",
          strokeOpacity: muted ? 0.1 : selected ? 0.92 : 0.34,
          strokeWidth: selected ? 2.6 : 1 + Math.min(Math.log((data?.weight ?? 1) + 1), 2.2),
          strokeLinecap: "round"
        }}
      />
      {showLabel ? (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all"
            }}
            className="max-w-[220px] truncate rounded-[8px] border border-[var(--color-line-strong)] bg-[var(--color-paper-raised)] px-2 py-1 text-[10.5px] font-semibold text-[var(--color-ink)] shadow-sm"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const nodeTypes = {
  entity: GraphNodeCard,
  cluster: GraphNodeCard
};

const edgeTypes = {
  relationship: GraphEdgePath
};

function hasActiveSession(sessionIds: string[], activeSessions: Set<string> | null): boolean {
  return Boolean(activeSessions && sessionIds.some((sessionId) => activeSessions.has(sessionId)));
}

function nodeScore(node: BackendExplorerGraphNode, degree: number, activeSessions: Set<string> | null): number {
  const focusBoost = hasActiveSession(node.session_ids, activeSessions) ? 1000 : 0;
  return focusBoost + degree * 8 + node.session_ids.length * 6 + Math.log(node.size + 1) * 8;
}

function fallbackClusterFor(
  node: BackendExplorerGraphNode,
  category: SessionCategoryName,
  groupingMode: GraphGroupingMode
): CategoryGraphCluster {
  return {
    id: `fallback:${node.id}`,
    label: node.label,
    accent: clusterAccentForNode(node, category, groupingMode),
    mode: groupingMode,
    provider: groupingMode === "provider" ? node.provider ?? null : null,
    nodeIds: [node.id],
    nodeCount: 1,
    edgeCount: 0,
    sessionIds: node.session_ids,
    noteCount: node.session_ids.length
  };
}

function buildFlow(
  graph: BackendCategoryGraph,
  category: SessionCategoryName,
  groupingMode: GraphGroupingMode,
  collapsedGroups: string[],
  density: CategoryGraphDensity,
  focusMode: CategoryGraphFocusMode,
  focusSessionIds?: string[]
): {
  nodes: Array<Node<GraphNodeData>>;
  edges: Array<Edge<GraphEdgeData>>;
  summary: FlowSummary;
} {
  const activeSessions = focusSessionIds?.length ? new Set(focusSessionIds) : null;
  const contextOnly = Boolean(activeSessions && focusMode === "context");
  const collapsedSet = new Set(collapsedGroups);
  const clusterLookup = buildCategoryGraphClusters(graph, category, groupingMode);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const degreeByNodeId = new Map<string, number>(graph.nodes.map((node) => [node.id, 0]));

  for (const edge of graph.edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target) || edge.source === edge.target) {
      continue;
    }
    degreeByNodeId.set(edge.source, (degreeByNodeId.get(edge.source) ?? 0) + 1);
    degreeByNodeId.set(edge.target, (degreeByNodeId.get(edge.target) ?? 0) + 1);
  }

  const scopedEdges = contextOnly
    ? graph.edges.filter((edge) => hasActiveSession(edge.session_ids, activeSessions))
    : graph.edges;
  const scopedNodeIds = new Set<string>();

  for (const node of graph.nodes) {
    if (!contextOnly || hasActiveSession(node.session_ids, activeSessions)) {
      scopedNodeIds.add(node.id);
    }
  }
  for (const edge of scopedEdges) {
    scopedNodeIds.add(edge.source);
    scopedNodeIds.add(edge.target);
  }

  const clusterMap = new Map<string, MutableCluster>();
  for (const node of graph.nodes) {
    if (!scopedNodeIds.has(node.id)) {
      continue;
    }
    const cluster = clusterLookup.byNodeId.get(node.id) ?? fallbackClusterFor(node, category, groupingMode);
    const entry =
      clusterMap.get(cluster.id) ??
      (() => {
        const created: MutableCluster = {
          id: cluster.id,
          label: cluster.label,
          accent: cluster.accent,
          provider: cluster.provider,
          nodes: [],
          sessionIds: new Set<string>(),
          edgeCount: cluster.edgeCount
        };
        clusterMap.set(cluster.id, created);
        return created;
      })();

    entry.nodes.push(node);
    for (const sessionId of node.session_ids) {
      entry.sessionIds.add(sessionId);
    }
  }

  const clusters = Array.from(clusterMap.values()).sort(
    (left, right) => right.sessionIds.size - left.sessionIds.size || right.edgeCount - left.edgeCount || left.label.localeCompare(right.label)
  );

  const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(clusters.length || 1))));
  const centers = new Map<string, { x: number; y: number }>();
  clusters.forEach((cluster, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    centers.set(cluster.id, {
      x: 240 + column * 320,
      y: 240 + row * 250
    });
  });

  const simNodes: SimNode[] = [];
  const headerNodes: Array<Node<GraphNodeData>> = [];
  const visibleEntityIds = new Set<string>();

  for (const cluster of clusters) {
    const center = centers.get(cluster.id) ?? { x: 260, y: 240 };
    const clusterSessionIds = Array.from(cluster.sessionIds);
    const clusterMuted = Boolean(activeSessions && !hasActiveSession(clusterSessionIds, activeSessions));
    const sortedClusterNodes = [...cluster.nodes].sort((left, right) => {
      const leftDegree = degreeByNodeId.get(left.id) ?? 0;
      const rightDegree = degreeByNodeId.get(right.id) ?? 0;
      return nodeScore(right, rightDegree, activeSessions) - nodeScore(left, leftDegree, activeSessions) || left.label.localeCompare(right.label);
    });
    const visibleLimit = density === "curated" ? (contextOnly ? 14 : 8) : sortedClusterNodes.length;
    const visibleClusterNodes = sortedClusterNodes.slice(0, visibleLimit);
    const hiddenCount = Math.max(sortedClusterNodes.length - visibleClusterNodes.length, 0);

    if (collapsedSet.has(cluster.id)) {
      simNodes.push({
        id: cluster.id,
        variant: "cluster",
        label: cluster.label,
        kind: groupingMode,
        sessionIds: clusterSessionIds,
        provider: cluster.provider,
        accent: cluster.accent,
        radius: 86,
        targetX: center.x,
        targetY: center.y,
        x: center.x,
        y: center.y,
        fx: center.x,
        fy: center.y,
        muted: clusterMuted,
        meta: `${cluster.nodes.length} entities · ${clusterSessionIds.length} notes`,
        detail: groupingMode === "community" ? "Collapsed topic community" : "Collapsed group",
        noteCount: clusterSessionIds.length,
        degree: cluster.edgeCount,
        hiddenCount,
        collapsed: true
      });
      continue;
    }

    headerNodes.push({
      id: `cluster:${cluster.id}`,
      type: "cluster",
      draggable: false,
      data: {
        variant: "cluster",
        label: cluster.label,
        kind: groupingMode,
        accent: cluster.accent,
        sessionIds: clusterSessionIds,
        provider: cluster.provider,
        muted: clusterMuted,
        meta: `${visibleClusterNodes.length}/${cluster.nodes.length} entities · ${clusterSessionIds.length} notes`,
        detail: groupingMode === "community" ? "Topic community" : groupingMode === "provider" ? "Provider group" : "Node type group",
        noteCount: clusterSessionIds.length,
        degree: cluster.edgeCount,
        hiddenCount
      },
      position: {
        x: center.x - 102,
        y: center.y - 142
      }
    });

    visibleClusterNodes.forEach((node, index) => {
      const degree = degreeByNodeId.get(node.id) ?? 0;
      const muted = Boolean(activeSessions && !hasActiveSession(node.session_ids, activeSessions));
      visibleEntityIds.add(node.id);
      simNodes.push({
        id: node.id,
        variant: "entity",
        label: node.label,
        kind: node.kind,
        sessionIds: node.session_ids,
        provider: node.provider,
        accent: cluster.accent,
        radius: 38 + Math.sqrt(Math.max(node.size, 1)) * 3,
        targetX: center.x,
        targetY: center.y + 16,
        x: center.x + (index % 3) * 18,
        y: center.y + 24 + (index % 4) * 13,
        muted,
        meta: `${node.session_ids.length} ${node.session_ids.length === 1 ? "note" : "notes"} · ${degree} links`,
        detail: node.provider ? providerLabels[node.provider] : node.kind,
        noteCount: node.session_ids.length,
        degree
      });
    });
  }

  const visibleNodeIdFor = (nodeId: string): string | null => {
    const node = nodeById.get(nodeId);
    if (!node || !scopedNodeIds.has(nodeId)) {
      return null;
    }
    const cluster = clusterLookup.byNodeId.get(node.id) ?? fallbackClusterFor(node, category, groupingMode);
    if (collapsedSet.has(cluster.id)) {
      return cluster.id;
    }
    return visibleEntityIds.has(node.id) ? node.id : null;
  };

  const visibleEdges = new Map<
    string,
    {
      source: string;
      target: string;
      sessionIds: Set<string>;
      labels: Set<string>;
      weight: number;
    }
  >();

  for (const edge of scopedEdges) {
    const visibleSource = visibleNodeIdFor(edge.source);
    const visibleTarget = visibleNodeIdFor(edge.target);
    if (!visibleSource || !visibleTarget || visibleSource === visibleTarget) {
      continue;
    }

    const key = `${visibleSource}:${visibleTarget}`;
    const aggregate =
      visibleEdges.get(key) ??
      (() => {
        const created = {
          source: visibleSource,
          target: visibleTarget,
          sessionIds: new Set<string>(),
          labels: new Set<string>(),
          weight: 0
        };
        visibleEdges.set(key, created);
        return created;
      })();

    aggregate.weight += edge.weight;
    for (const sessionId of edge.session_ids) {
      aggregate.sessionIds.add(sessionId);
    }
    if (edge.label?.trim()) {
      aggregate.labels.add(edge.label.trim());
    }
  }

  const simEdges: SimEdge[] = Array.from(visibleEdges.entries()).map(([id, edge]) => ({
    id,
    source: edge.source,
    target: edge.target,
    label: Array.from(edge.labels).slice(0, 3).join(", "),
    sessionIds: Array.from(edge.sessionIds),
    weight: edge.weight,
    muted: Boolean(activeSessions && !hasActiveSession(Array.from(edge.sessionIds), activeSessions))
  }));

  const simulation = forceSimulation(simNodes)
    .force(
      "link",
      forceLink<SimNode, SimEdge>(simEdges)
        .id((node) => node.id)
        .distance((edge) => (edge.source === edge.target ? 0 : 132 - Math.min(edge.weight, 10) * 5))
        .strength((edge) => 0.08 + Math.min(edge.weight, 8) * 0.025)
    )
    .force("charge", forceManyBody<SimNode>().strength((node) => (node.variant === "cluster" ? -180 : -210)))
    .force("collision", forceCollide<SimNode>().radius((node) => node.radius))
    .force("forceX", forceX<SimNode>((node) => node.targetX).strength((node) => (node.variant === "cluster" ? 0.72 : 0.2)))
    .force("forceY", forceY<SimNode>((node) => node.targetY).strength((node) => (node.variant === "cluster" ? 0.72 : 0.22)))
    .stop();

  for (let index = 0; index < 260; index += 1) {
    simulation.tick();
  }

  const nodes: Array<Node<GraphNodeData>> = [
    ...headerNodes,
    ...simNodes.map((node) => ({
      id: node.id,
      type: node.variant === "cluster" ? "cluster" : "entity",
      draggable: false,
      data: {
        variant: node.variant,
        label: node.label,
        kind: node.kind,
        accent: node.accent,
        sessionIds: node.sessionIds,
        provider: node.provider,
        muted: node.muted,
        meta: node.meta,
        detail: node.detail,
        noteCount: node.noteCount,
        degree: node.degree,
        hiddenCount: node.hiddenCount,
        collapsed: node.collapsed
      },
      position: {
        x: (node.x ?? node.targetX) - (node.variant === "cluster" ? 102 : 78),
        y: (node.y ?? node.targetY) - (node.variant === "cluster" ? 48 : 30)
      }
    }))
  ];

  const edges: Array<Edge<GraphEdgeData>> = simEdges.map((edge) => ({
    id: edge.id,
    source: typeof edge.source === "string" ? edge.source : edge.source.id,
    target: typeof edge.target === "string" ? edge.target : edge.target.id,
    type: "relationship",
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 12,
      height: 12,
      color: "#a1a1aa"
    },
    data: {
      label: edge.label,
      sessionIds: edge.sessionIds,
      muted: edge.muted,
      weight: edge.weight
    }
  }));

  return {
    nodes,
    edges,
    summary: {
      visibleNodes: visibleEntityIds.size,
      totalNodes: scopedNodeIds.size,
      hiddenNodes: Math.max(scopedNodeIds.size - visibleEntityIds.size, 0),
      visibleEdges: edges.length,
      totalEdges: scopedEdges.length,
      clusterCount: clusters.length,
      contextOnly
    }
  };
}

export function CategoryGraph({
  graph,
  category,
  groupingMode,
  collapsedGroups,
  density,
  focusMode,
  focusSessionIds,
  onFocus,
  className
}: {
  graph: BackendCategoryGraph;
  category: SessionCategoryName;
  groupingMode: GraphGroupingMode;
  collapsedGroups: string[];
  density: CategoryGraphDensity;
  focusMode: CategoryGraphFocusMode;
  focusSessionIds?: string[];
  onFocus: (label: string, sessionIds: string[]) => void;
  className?: string;
}) {
  const { nodes, edges, summary } = useMemo(
    () => buildFlow(graph, category, groupingMode, collapsedGroups, density, focusMode, focusSessionIds),
    [category, collapsedGroups, density, focusMode, focusSessionIds, graph, groupingMode]
  );

  if (!graph.nodes.length) {
    return (
      <div
        className={cn(
          "flex min-h-[420px] h-[min(62vh,700px)] items-center justify-center rounded-[8px] border border-dashed border-[var(--color-line)] bg-[var(--color-paper-raised)] text-sm text-[var(--color-ink-soft)]",
          className
        )}
      >
        No graph data is available for this view yet.
      </div>
    );
  }

  return (
    <div className={cn("min-h-[420px] h-[min(62vh,700px)] overflow-hidden rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)]", className)}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.38}
        maxZoom={1.9}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => {
          onFocus(node.data.label, node.data.sessionIds);
        }}
        onEdgeClick={(_, edge) => {
          onFocus(edge.data?.label ?? "Relationship", edge.data?.sessionIds ?? []);
        }}
      >
        <Panel position="top-left" className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-soft)] shadow-sm">
          {summary.clusterCount} groups · {summary.visibleNodes}/{summary.totalNodes} nodes · {summary.visibleEdges}/{summary.totalEdges} links
          {summary.hiddenNodes ? ` · ${summary.hiddenNodes} hidden` : ""}
          {summary.contextOnly ? " · context" : ""}
        </Panel>
        <Background gap={30} size={1} color="#e4e4e7" />
        <MiniMap pannable zoomable nodeColor={(node) => (node.data as GraphNodeData).accent} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
