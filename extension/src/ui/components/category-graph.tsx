import { useMemo } from "react";

import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  MarkerType,
  BaseEdge,
  getBezierPath
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
import type { BackendCategoryGraph, ProviderName, SessionCategoryName } from "../../shared/types";
import {
  clusterAccentForNode,
  clusterKeyForNode,
  clusterLabelForNode,
  type GraphGroupingMode
} from "../lib/category-graph-insights";
import { cn } from "../lib/utils";

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

function GraphNodeCard({ data, selected }: NodeProps<Node<GraphNodeData>>) {
  const clusterCard = data.variant === "cluster";

  return (
    <div
      className={cn(
        clusterCard ? "w-[224px]" : "w-[188px]",
        "rounded-[8px] border bg-white px-3 py-3 text-left transition",
        data.muted ? "border-zinc-200/80 opacity-45" : "border-zinc-200",
        selected ? "ring-2 ring-zinc-950/10" : ""
      )}
      style={{
        borderColor: selected ? `${data.accent}55` : undefined
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={cn("shrink-0 rounded-full", clusterCard ? "h-3 w-3" : "h-2.5 w-2.5")}
              style={{
                backgroundColor: data.accent
              }}
            />
            <span className={cn("truncate font-semibold text-zinc-950", clusterCard ? "text-sm" : "text-[13px]")}>{data.label}</span>
          </div>
          <div className="mt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">{data.meta}</div>
        </div>
        {data.collapsed ? (
          <div className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-zinc-500">
            Collapsed
          </div>
        ) : null}
      </div>

      <div className="mt-2 text-xs leading-5 text-zinc-500">{data.detail}</div>
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
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY
  });

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      style={{
        stroke: selected ? "#111827" : "#94a3b8",
        strokeOpacity: data?.muted ? 0.14 : selected ? 0.85 : 0.34,
        strokeWidth: selected ? 2.4 : 1.2 + Math.min(Math.log((data?.weight ?? 1) + 1), 2.5),
        strokeLinecap: "round"
      }}
    />
  );
}

const nodeTypes = {
  entity: GraphNodeCard,
  cluster: GraphNodeCard
};

const edgeTypes = {
  relationship: GraphEdgePath
};

function buildFlow(
  graph: BackendCategoryGraph,
  category: SessionCategoryName,
  groupingMode: GraphGroupingMode,
  collapsedGroups: string[],
  focusSessionIds?: string[]
): {
  nodes: Array<Node<GraphNodeData>>;
  edges: Array<Edge<GraphEdgeData>>;
} {
  const activeSessions = focusSessionIds?.length ? new Set(focusSessionIds) : null;
  const collapsedSet = new Set(collapsedGroups);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node] as const));

  const clusterMap = new Map<
    string,
    {
      id: string;
      label: string;
      accent: string;
      provider?: ProviderName | null;
      nodes: typeof graph.nodes;
      sessionIds: Set<string>;
    }
  >();

  for (const node of graph.nodes) {
    const clusterId = clusterKeyForNode(node, groupingMode);
    const cluster =
      clusterMap.get(clusterId) ??
      (() => {
        const created = {
          id: clusterId,
          label: clusterLabelForNode(node, groupingMode),
          accent: clusterAccentForNode(node, category, groupingMode),
          provider: groupingMode === "provider" ? node.provider ?? null : null,
          nodes: [],
          sessionIds: new Set<string>()
        };
        clusterMap.set(clusterId, created);
        return created;
      })();

    cluster.nodes.push(node);
    for (const sessionId of node.session_ids) {
      cluster.sessionIds.add(sessionId);
    }
  }

  const clusters = Array.from(clusterMap.values()).sort(
    (left, right) => right.nodes.length - left.nodes.length || right.sessionIds.size - left.sessionIds.size || left.label.localeCompare(right.label)
  );

  const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(clusters.length || 1))));
  const centers = new Map<string, { x: number; y: number }>();
  clusters.forEach((cluster, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    centers.set(cluster.id, {
      x: 260 + column * 360,
      y: 260 + row * 280
    });
  });

  const simNodes: SimNode[] = [];
  const headerNodes: Array<Node<GraphNodeData>> = [];

  for (const cluster of clusters) {
    const center = centers.get(cluster.id) ?? { x: 280, y: 280 };
    const clusterSessionIds = Array.from(cluster.sessionIds);
    const clusterMuted = Boolean(activeSessions && !clusterSessionIds.some((sessionId) => activeSessions.has(sessionId)));

    if (collapsedSet.has(cluster.id)) {
      simNodes.push({
        id: cluster.id,
        variant: "cluster",
        label: cluster.label,
        kind: groupingMode,
        sessionIds: clusterSessionIds,
        provider: cluster.provider,
        accent: cluster.accent,
        radius: 92,
        targetX: center.x,
        targetY: center.y,
        x: center.x,
        y: center.y,
        fx: center.x,
        fy: center.y,
        muted: clusterMuted,
        meta: `${cluster.nodes.length} entities · ${clusterSessionIds.length} notes`,
        detail: groupingMode === "provider" ? "Collapsed provider cluster" : "Collapsed semantic cluster",
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
        meta: `${cluster.nodes.length} entities · ${clusterSessionIds.length} notes`,
        detail: groupingMode === "provider" ? "Provider scope" : "Semantic scope"
      },
      position: {
        x: center.x - 112,
        y: center.y - 164
      }
    });

    for (const node of cluster.nodes) {
      const muted = Boolean(activeSessions && !node.session_ids.some((sessionId) => activeSessions.has(sessionId)));
      simNodes.push({
        id: node.id,
        variant: "entity",
        label: node.label,
        kind: node.kind,
        sessionIds: node.session_ids,
        provider: node.provider,
        accent: clusterAccentForNode(node, category, groupingMode),
        radius: 48 + Math.sqrt(Math.max(node.size, 1)) * 5,
        targetX: center.x,
        targetY: center.y + 18,
        x: center.x + (simNodes.length % 3) * 18,
        y: center.y + 24 + (simNodes.length % 4) * 14,
        muted,
        meta: `${node.provider ? providerLabels[node.provider] : node.kind} · ${node.session_ids.length} ${node.session_ids.length === 1 ? "note" : "notes"}`,
        detail: node.kind
      });
    }
  }

  const visibleNodeIdFor = (nodeId: string): string | null => {
    const node = nodeById.get(nodeId);
    if (!node) {
      return null;
    }
    const clusterId = clusterKeyForNode(node, groupingMode);
    return collapsedSet.has(clusterId) ? clusterId : node.id;
  };

  const visibleEdges = new Map<
    string,
    {
      source: string;
      target: string;
      sessionIds: Set<string>;
      weight: number;
      label?: string | null;
    }
  >();

  for (const edge of graph.edges) {
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
          weight: 0,
          label: edge.label
        };
        visibleEdges.set(key, created);
        return created;
      })();

    aggregate.weight += edge.weight;
    for (const sessionId of edge.session_ids) {
      aggregate.sessionIds.add(sessionId);
    }
    if (!aggregate.label && edge.label) {
      aggregate.label = edge.label;
    }
  }

  const simEdges: SimEdge[] = Array.from(visibleEdges.entries()).map(([id, edge]) => ({
    id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    sessionIds: Array.from(edge.sessionIds),
    weight: edge.weight,
    muted: Boolean(activeSessions && !Array.from(edge.sessionIds).some((sessionId) => activeSessions.has(sessionId)))
  }));

  const simulation = forceSimulation(simNodes)
    .force(
      "link",
      forceLink<SimNode, SimEdge>(simEdges)
        .id((node) => node.id)
        .distance((edge) => (edge.source === edge.target ? 0 : 168 - Math.min(edge.weight, 10) * 7))
        .strength((edge) => 0.1 + Math.min(edge.weight, 8) * 0.03)
    )
    .force("charge", forceManyBody<SimNode>().strength((node) => (node.variant === "cluster" ? -160 : -280)))
    .force("collision", forceCollide<SimNode>().radius((node) => node.radius))
    .force("forceX", forceX<SimNode>((node) => node.targetX).strength((node) => (node.variant === "cluster" ? 0.65 : 0.18)))
    .force("forceY", forceY<SimNode>((node) => node.targetY).strength((node) => (node.variant === "cluster" ? 0.65 : 0.2)))
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
        collapsed: node.collapsed
      },
      position: {
        x: (node.x ?? node.targetX) - (node.variant === "cluster" ? 112 : 94),
        y: (node.y ?? node.targetY) - (node.variant === "cluster" ? 48 : 42)
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
      width: 14,
      height: 14,
      color: "#a1a1aa"
    },
    data: {
      label: edge.label,
      sessionIds: edge.sessionIds,
      muted: edge.muted,
      weight: edge.weight
    }
  }));

  return { nodes, edges };
}

export function CategoryGraph({
  graph,
  category,
  groupingMode,
  collapsedGroups,
  focusSessionIds,
  onFocus,
  className
}: {
  graph: BackendCategoryGraph;
  category: SessionCategoryName;
  groupingMode: GraphGroupingMode;
  collapsedGroups: string[];
  focusSessionIds?: string[];
  onFocus: (label: string, sessionIds: string[]) => void;
  className?: string;
}) {
  const { nodes, edges } = useMemo(
    () => buildFlow(graph, category, groupingMode, collapsedGroups, focusSessionIds),
    [category, collapsedGroups, focusSessionIds, graph, groupingMode]
  );

  if (!graph.nodes.length) {
    return (
      <div
        className={cn(
          "flex h-[620px] items-center justify-center rounded-[8px] border border-dashed border-zinc-200 bg-white text-sm text-zinc-500",
          className
        )}
      >
        No graph data is available for this view yet.
      </div>
    );
  }

  return (
    <div className={cn("h-[620px] overflow-hidden rounded-[8px] border border-zinc-200 bg-white", className)}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.16 }}
        minZoom={0.42}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => {
          onFocus(node.data.label, node.data.sessionIds);
        }}
        onEdgeClick={(_, edge) => {
          onFocus(edge.data?.label ?? "Relationship", edge.data?.sessionIds ?? []);
        }}
      >
        <Background gap={28} size={1} color="#e4e4e7" />
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
