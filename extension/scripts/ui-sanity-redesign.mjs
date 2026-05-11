import { chromium } from "@playwright/test";
import { resolve } from "node:path";

const extensionDist = resolve("dist");
const backendBaseUrl = "http://127.0.0.1:18888";
const userDataDir = resolve(".playwright-redesign-user");

const sessions = [
  {
    id: "s1",
    provider: "chatgpt",
    external_session_id: "ctx-001",
    title: "Context engineering notes",
    category: "factual",
    custom_tags: ["context"],
    extra_piles: ["Architecture Review"],
    markdown_path: "factual/context-engineering-notes.md",
    share_post: "Working notes on persistent context surfaces and retrieval boundaries.",
    updated_at: "2026-04-11T17:30:00Z",
    last_captured_at: "2026-04-11T17:30:00Z",
    last_processed_at: "2026-04-11T17:32:00Z"
  },
  {
    id: "s2",
    provider: "gemini",
    external_session_id: "ctx-002",
    title: "Knowledge graph management",
    category: "factual",
    custom_tags: ["graph"],
    extra_piles: ["Architecture Review", "Knowledge Ops"],
    markdown_path: "factual/knowledge-graph-management.md",
    share_post: "Design notes on graph coverage, provenance, and maintenance loops.",
    updated_at: "2026-04-12T20:15:00Z",
    last_captured_at: "2026-04-12T20:15:00Z",
    last_processed_at: "2026-04-12T20:17:00Z"
  },
  {
    id: "s3",
    provider: "grok",
    external_session_id: "ctx-003",
    title: "Retrieval diagnostics",
    category: "factual",
    custom_tags: ["retrieval"],
    extra_piles: ["Knowledge Ops"],
    markdown_path: "factual/retrieval-diagnostics.md",
    share_post: "How to trace missing evidence and disconnected entities.",
    updated_at: "2026-04-13T09:45:00Z",
    last_captured_at: "2026-04-13T09:45:00Z",
    last_processed_at: "2026-04-13T09:48:00Z"
  },
  {
    id: "s4",
    provider: "chatgpt",
    external_session_id: "ctx-004",
    title: "Atlas and storyline surfaces",
    category: "factual",
    custom_tags: ["story"],
    extra_piles: ["Knowledge Ops"],
    markdown_path: "factual/atlas-and-storyline-surfaces.md",
    share_post: "Atlas view should support cluster navigation and guided exploration.",
    updated_at: "2026-04-14T11:10:00Z",
    last_captured_at: "2026-04-14T11:10:00Z",
    last_processed_at: "2026-04-14T11:14:00Z"
  },
  {
    id: "s5",
    provider: "gemini",
    external_session_id: "ctx-005",
    title: "Temporal memory patterns",
    category: "factual",
    custom_tags: ["memory"],
    extra_piles: ["Memory Lab"],
    markdown_path: "factual/temporal-memory-patterns.md",
    share_post: "Timeline filters reveal how concepts evolve across sessions.",
    updated_at: "2026-04-15T16:40:00Z",
    last_captured_at: "2026-04-15T16:40:00Z",
    last_processed_at: "2026-04-15T16:42:00Z"
  },
  {
    id: "s6",
    provider: "chatgpt",
    external_session_id: "ctx-006",
    title: "Karpathy LLM wiki patterns",
    category: "factual",
    custom_tags: ["wiki"],
    extra_piles: ["Knowledge Ops", "Research"],
    markdown_path: "factual/karpathy-llm-wiki-patterns.md",
    share_post: "Index, sync, log, lint, and query should be first-class graph management surfaces.",
    updated_at: "2026-04-16T08:05:00Z",
    last_captured_at: "2026-04-16T08:05:00Z",
    last_processed_at: "2026-04-16T08:09:00Z"
  },
  {
    id: "i1",
    provider: "chatgpt",
    external_session_id: "idea-001",
    title: "Context surface concept",
    category: "ideas",
    custom_tags: ["interface"],
    extra_piles: ["Product Thinking"],
    markdown_path: "ideas/context-surface-concept.md",
    share_post: "A persistent context surface should show how ideas develop, not just where notes are filed.",
    updated_at: "2026-04-11T13:20:00Z",
    last_captured_at: "2026-04-11T13:20:00Z",
    last_processed_at: "2026-04-11T13:24:00Z"
  },
  {
    id: "i2",
    provider: "gemini",
    external_session_id: "idea-002",
    title: "Timeline-first idea workspace",
    category: "ideas",
    custom_tags: ["timeline"],
    extra_piles: ["Product Thinking"],
    markdown_path: "ideas/timeline-first-idea-workspace.md",
    share_post: "Idea workspaces should expose the sequence of reasoning and how one claim changes another.",
    updated_at: "2026-04-12T15:10:00Z",
    last_captured_at: "2026-04-12T15:10:00Z",
    last_processed_at: "2026-04-12T15:14:00Z"
  },
  {
    id: "i3",
    provider: "grok",
    external_session_id: "idea-003",
    title: "Joined mind map",
    category: "ideas",
    custom_tags: ["map"],
    extra_piles: ["Product Thinking", "Knowledge Ops"],
    markdown_path: "ideas/joined-mind-map.md",
    share_post: "Mind maps should join projects, threads, evidence, and counterpoints into one navigable surface.",
    updated_at: "2026-04-13T18:35:00Z",
    last_captured_at: "2026-04-13T18:35:00Z",
    last_processed_at: "2026-04-13T18:39:00Z"
  },
  {
    id: "i4",
    provider: "chatgpt",
    external_session_id: "idea-004",
    title: "Attribution and counterpoints",
    category: "ideas",
    custom_tags: ["attribution"],
    extra_piles: ["Product Thinking"],
    markdown_path: "ideas/attribution-and-counterpoints.md",
    share_post: "Claims need provenance, relation types, and next moves so brainstorming does not become a flat pile.",
    updated_at: "2026-04-14T10:05:00Z",
    last_captured_at: "2026-04-14T10:05:00Z",
    last_processed_at: "2026-04-14T10:09:00Z"
  },
  {
    id: "j1",
    provider: "chatgpt",
    external_session_id: "journal-001",
    title: "Ferry Building walk",
    category: "journal",
    custom_tags: ["san-francisco"],
    extra_piles: ["Travel Log"],
    markdown_path: "journal/ferry-building-walk.md",
    share_post: "Morning walk from the Ferry Building to North Beach with Maya and a product planning thread.",
    updated_at: "2026-04-11T09:15:00Z",
    last_captured_at: "2026-04-11T09:15:00Z",
    last_processed_at: "2026-04-11T09:18:00Z"
  },
  {
    id: "j2",
    provider: "gemini",
    external_session_id: "journal-002",
    title: "Mission workshop",
    category: "journal",
    custom_tags: ["workshop"],
    extra_piles: ["Travel Log"],
    markdown_path: "journal/mission-workshop.md",
    share_post: "Afternoon workshop in the Mission with Luis focused on research planning and prototypes.",
    updated_at: "2026-04-12T16:30:00Z",
    last_captured_at: "2026-04-12T16:30:00Z",
    last_processed_at: "2026-04-12T16:34:00Z"
  },
  {
    id: "j3",
    provider: "chatgpt",
    external_session_id: "journal-003",
    title: "Hayes Valley dinner",
    category: "journal",
    custom_tags: ["dinner"],
    extra_piles: ["Travel Log"],
    markdown_path: "journal/hayes-valley-dinner.md",
    share_post: "Dinner in Hayes Valley with Anika, discussing launch risk and design direction.",
    updated_at: "2026-04-13T20:25:00Z",
    last_captured_at: "2026-04-13T20:25:00Z",
    last_processed_at: "2026-04-13T20:30:00Z"
  },
  {
    id: "j4",
    provider: "grok",
    external_session_id: "journal-004",
    title: "Presidio reset",
    category: "journal",
    custom_tags: ["outdoors"],
    extra_piles: ["Travel Log"],
    markdown_path: "journal/presidio-reset.md",
    share_post: "Quiet reset in the Presidio after a design review, with notes on energy and priorities.",
    updated_at: "2026-04-14T08:40:00Z",
    last_captured_at: "2026-04-14T08:40:00Z",
    last_processed_at: "2026-04-14T08:43:00Z"
  },
  {
    id: "t1",
    provider: "chatgpt",
    external_session_id: "todo-001",
    title: "Sprint checklist cleanup",
    category: "todo",
    custom_tags: ["shared-list"],
    extra_piles: ["Launch"],
    markdown_path: "todo/sprint-checklist-cleanup.md",
    share_post: "Closed two stale tasks and reopened release notes for final review.",
    todo_summary: "Checked off 'Archive stale branches' and reopened 'Review release notes'.",
    updated_at: "2026-04-16T10:15:00Z",
    last_captured_at: "2026-04-16T10:15:00Z",
    last_processed_at: "2026-04-16T10:18:00Z"
  },
  {
    id: "t2",
    provider: "gemini",
    external_session_id: "todo-002",
    title: "Product launch board",
    category: "todo",
    custom_tags: ["launch"],
    extra_piles: ["Launch", "Operations"],
    markdown_path: "todo/product-launch-board.md",
    share_post: "Added the rollout checklist and marked launch copy review complete.",
    todo_summary: "Added 'Dry run launch email' and marked 'Review launch copy' done.",
    updated_at: "2026-04-16T12:40:00Z",
    last_captured_at: "2026-04-16T12:40:00Z",
    last_processed_at: "2026-04-16T12:42:00Z"
  }
];

const notes = Object.fromEntries(
  sessions.map((session, index) => [
    session.id,
    {
      ...session,
      source_url: `https://example.com/${session.id}`,
      classification_reason: "Mocked for browser sanity check",
      journal_entry: null,
      todo_summary: session.todo_summary ?? null,
      idea_summary: null,
      created_at: session.updated_at,
      messages: [
        {
          id: `${session.id}-m1`,
          external_message_id: `${session.id}-ext-1`,
          role: "user",
          content: `What matters most about ${session.title}?`,
          sequence_index: 0,
          created_at: session.updated_at
        },
        {
          id: `${session.id}-m2`,
          external_message_id: `${session.id}-ext-2`,
          role: "assistant",
          content: session.share_post,
          sequence_index: 1,
          created_at: session.updated_at
        }
      ],
      triplets:
        session.category === "factual"
          ? [
              {
                id: `${session.id}-t1`,
                subject: session.title.split(" ")[0],
                predicate: "relates_to",
                object: "Context",
                created_at: session.updated_at
              }
            ]
          : [],
      raw_markdown: `# ${session.title}

${session.todo_summary ?? session.share_post}

## Why it matters

- Persistent context needs shape
- Retrieval should be inspectable
- Notes need evidence and provenance`,
      related_entities: session.category === "factual" ? ["Context", "Retrieval", "Memory"] : [],
      word_count: 180 + index * 14
    }
  ])
);

const fullGraph = {
  category: "factual",
  node_count: 7,
  edge_count: 8,
  nodes: [
    {
      id: "n1",
      label: "Context",
      kind: "concept",
      size: 7,
      session_ids: ["s1", "s2", "s4", "s6"],
      provider: "chatgpt",
      updated_at: "2026-04-16T08:05:00Z"
    },
    {
      id: "n2",
      label: "Knowledge Graph",
      kind: "system",
      size: 5,
      session_ids: ["s2", "s3", "s4"],
      provider: "gemini",
      updated_at: "2026-04-14T11:10:00Z"
    },
    {
      id: "n3",
      label: "Retrieval",
      kind: "workflow",
      size: 5,
      session_ids: ["s1", "s3", "s5"],
      provider: "grok",
      updated_at: "2026-04-15T16:40:00Z"
    },
    {
      id: "n4",
      label: "Memory",
      kind: "concept",
      size: 4,
      session_ids: ["s1", "s5", "s6"],
      provider: "gemini",
      updated_at: "2026-04-16T08:05:00Z"
    },
    {
      id: "n5",
      label: "Storyline",
      kind: "pattern",
      size: 3,
      session_ids: ["s4", "s6"],
      provider: "chatgpt",
      updated_at: "2026-04-16T08:05:00Z"
    },
    {
      id: "n6",
      label: "Lint",
      kind: "operation",
      size: 3,
      session_ids: ["s2", "s6"],
      provider: "chatgpt",
      updated_at: "2026-04-16T08:05:00Z"
    },
    {
      id: "n7",
      label: "Orphan evidence",
      kind: "signal",
      size: 1,
      session_ids: ["s3"],
      provider: "grok",
      updated_at: "2026-04-13T09:45:00Z"
    }
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", label: "organizes", weight: 4, session_ids: ["s2", "s4"] },
    { id: "e2", source: "n1", target: "n3", label: "requires", weight: 3, session_ids: ["s1", "s3"] },
    { id: "e3", source: "n3", target: "n4", label: "grounds", weight: 4, session_ids: ["s3", "s5"] },
    { id: "e4", source: "n1", target: "n4", label: "preserves", weight: 3, session_ids: ["s1", "s5", "s6"] },
    { id: "e5", source: "n5", target: "n1", label: "narrates", weight: 2, session_ids: ["s4", "s6"] },
    { id: "e6", source: "n6", target: "n2", label: "audits", weight: 3, session_ids: ["s2", "s6"] },
    { id: "e7", source: "n6", target: "n3", label: "checks", weight: 2, session_ids: ["s3", "s6"] },
    { id: "e8", source: "n5", target: "n3", label: "guides", weight: 2, session_ids: ["s4", "s5"] }
  ]
};

const sharedTodo = {
  title: "To-Do List",
  content: `# To-Do List

## Active
- [ ] Dry run launch email
- [ ] Review release notes
- [ ] Ship popup polish

## Done
- [x] Archive stale branches
- [x] Review launch copy
`,
  items: [
    { text: "Dry run launch email", done: false },
    { text: "Review release notes", done: false },
    { text: "Ship popup polish", done: false },
    { text: "Archive stale branches", done: true },
    { text: "Review launch copy", done: true }
  ],
  active_count: 3,
  completed_count: 2,
  total_count: 5,
  git: {
    versioning_enabled: true,
    available: true,
    repository_ready: true,
    branch: "main",
    clean: true,
    last_commit_message: "Check off checklist items",
    last_commit_at: "2026-04-16T13:05:00Z"
  }
};

function dominantCategory(availableSessions, fallback = "factual") {
  const counts = new Map();
  for (const session of availableSessions) {
    if (!session.category) {
      continue;
    }
    counts.set(session.category, (counts.get(session.category) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] ?? fallback;
}

function routePile(url) {
  return url.searchParams.get("pile") ?? url.searchParams.get("category") ?? "factual";
}

function pathPile(url) {
  const marker = "/piles/";
  const index = url.pathname.indexOf(marker);
  if (index < 0) {
    return null;
  }
  const tail = url.pathname.slice(index + marker.length);
  const pile = tail.split("/")[0] ?? "";
  return pile ? decodeURIComponent(pile) : null;
}

function pathExtraPile(url) {
  const marker = "/extra-piles/";
  const index = url.pathname.indexOf(marker);
  if (index < 0) {
    return null;
  }
  const tail = url.pathname.slice(index + marker.length);
  const name = tail.split("/")[0] ?? "";
  return name ? decodeURIComponent(name) : null;
}

function scopeLabel(url) {
  return url.searchParams.get("extra_pile") ?? pathExtraPile(url) ?? pathPile(url) ?? routePile(url);
}

function summarizeUserCategories(availableSessions) {
  const counts = new Map();
  for (const session of availableSessions) {
    for (const category of session.extra_piles ?? []) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, count]) => ({ name, count }));
}

function filteredSessions(url) {
  const provider = url.searchParams.get("provider");
  const pile = pathPile(url) ?? routePile(url);
  const extraPile = url.searchParams.get("extra_pile") ?? pathExtraPile(url);
  return sessions.filter(
    (session) =>
      (!provider || session.provider === provider) &&
      (!pile || session.category === pile) &&
      (!extraPile || (session.extra_piles ?? []).includes(extraPile))
  );
}

function buildSessionGraph(availableSessions, pile) {
  const nodes = availableSessions.map((session, index) => ({
    id: session.id,
    label: session.title,
    kind: "session",
    size: 2 + (session.extra_piles?.length ?? 0),
    session_ids: [session.id],
    provider: session.provider,
    category: session.category,
    updated_at: session.updated_at,
    note_path: session.markdown_path,
    x: index
  }));
  const edges = [];

  for (let index = 0; index < availableSessions.length; index += 1) {
    for (let inner = index + 1; inner < availableSessions.length; inner += 1) {
      const left = availableSessions[index];
      const right = availableSessions[inner];
      const leftTags = new Set([...(left.custom_tags ?? []), ...(left.extra_piles ?? [])]);
      const sharedLabels = [...new Set([...(right.custom_tags ?? []), ...(right.extra_piles ?? [])])].filter((value) => leftTags.has(value));
      if (!sharedLabels.length && left.provider !== right.provider) {
        continue;
      }
      edges.push({
        id: `${left.id}-${right.id}`,
        source: left.id,
        target: right.id,
        label: sharedLabels[0] ?? "provider",
        weight: Math.max(sharedLabels.length, 1),
        session_ids: [left.id, right.id]
      });
    }
  }

  return {
    pile_slug: pile,
    scope_kind: "default",
    scope_label: pile,
    dominant_pile_slug: dominantCategory(availableSessions, pile),
    node_count: nodes.length,
    edge_count: edges.length,
    nodes,
    edges
  };
}

function filteredGraph(url) {
  const availableSessions = filteredSessions(url);
  const requestedPile = pathPile(url) ?? routePile(url);
  const dominant = dominantCategory(availableSessions, requestedPile);
  const scopedIds = new Set(url.searchParams.getAll("session_id"));
  const hasScope = scopedIds.size > 0;
  const allowedSessionIds = new Set(availableSessions.map((session) => session.id));
  const sessionAllowed = (sessionId) => allowedSessionIds.has(sessionId) && (!hasScope || scopedIds.has(sessionId));

  let graphBody;
  if ((url.searchParams.get("extra_pile") || pathExtraPile(url) || dominant !== "factual") && availableSessions.length) {
    const scopedSessions = hasScope ? availableSessions.filter((session) => scopedIds.has(session.id)) : availableSessions;
    graphBody = buildSessionGraph(scopedSessions, dominant);
  } else if (requestedPile !== "factual") {
    graphBody = {
      pile_slug: requestedPile,
      node_count: 0,
      edge_count: 0,
      nodes: [],
      edges: []
    };
  } else {
    const nodes = fullGraph.nodes.filter((node) => node.session_ids.some(sessionAllowed));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = fullGraph.edges.filter(
      (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target) && edge.session_ids.some(sessionAllowed)
    );

    graphBody = {
      pile_slug: dominant,
      node_count: nodes.length,
      edge_count: edges.length,
      nodes,
      edges
    };
  }

  return {
    ...graphBody,
    scope_kind: url.searchParams.get("extra_pile") || pathExtraPile(url) ? "custom" : "default",
    scope_label: scopeLabel(url),
    dominant_pile_slug: dominant
  };
}

function buildStats(url) {
  const availableSessions = filteredSessions(url);
  const requestedPile = pathPile(url) ?? routePile(url);
  const pile = dominantCategory(availableSessions, requestedPile);
  const scopedIds = new Set(url.searchParams.getAll("session_id"));
  const visibleSessions = scopedIds.size
    ? availableSessions.filter((session) => scopedIds.has(session.id))
    : availableSessions;
  const graph = filteredGraph(url);
  const providerCounts = ["chatgpt", "gemini", "grok"]
    .map((provider) => ({
      provider,
      count: visibleSessions.filter((session) => session.provider === provider).length
    }))
    .filter((item) => item.count > 0);
  const activityMap = new Map();
  for (const session of visibleSessions) {
    const bucket = session.updated_at.slice(0, 10);
    activityMap.set(bucket, (activityMap.get(bucket) ?? 0) + 1);
  }
  const systemPileCounts = Array.from(
    visibleSessions.reduce((counts, session) => counts.set(session.category, (counts.get(session.category) ?? 0) + 1), new Map()).entries()
  ).map(([pile_slug, count]) => ({ pile_slug, count }));
  const entityCounts = graph.nodes
    .map((node) => ({ label: node.label, count: node.session_ids.length }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 6);
  const predicateCounts = new Map();
  for (const edge of graph.edges) {
    predicateCounts.set(edge.label ?? "related", (predicateCounts.get(edge.label ?? "related") ?? 0) + edge.weight);
  }

  return {
    pile_slug: pile,
    scope_kind: url.searchParams.get("extra_pile") || pathExtraPile(url) ? "custom" : "default",
    scope_label: scopeLabel(url),
    dominant_pile_slug: pile,
    total_sessions: visibleSessions.length,
    total_messages: visibleSessions.length * 24,
    total_triplets: pile === "factual" ? graph.edges.reduce((sum, edge) => sum + edge.weight, 0) : 0,
    latest_updated_at: visibleSessions[0]?.updated_at ?? null,
    avg_messages_per_session: visibleSessions.length ? 24 : 0,
    avg_triplets_per_session: visibleSessions.length
      ? (pile === "factual" ? graph.edges.reduce((sum, edge) => sum + edge.weight, 0) : 0) / visibleSessions.length
      : 0,
    notes_with_share_post: visibleSessions.filter((session) => session.share_post).length,
    notes_with_idea_summary: 0,
    notes_with_journal_entry: 0,
    notes_with_todo_summary: visibleSessions.filter((session) => session.category === "todo" && session.todo_summary).length,
    built_in_pile_counts: systemPileCounts,
    provider_counts: providerCounts,
    activity: Array.from(activityMap.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([bucket, count]) => ({ bucket, count })),
    top_tags: Array.from(
      visibleSessions
        .flatMap((session) => session.custom_tags)
        .reduce((counts, tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1), new Map())
        .entries()
    ).map(([label, count]) => ({ label, count })),
    top_entities: pile === "factual" ? entityCounts : [],
    top_predicates:
      pile === "factual"
        ? Array.from(predicateCounts.entries())
            .map(([label, count]) => ({ label, count }))
            .sort((left, right) => right.count - left.count)
        : []
  };
}

function buildPileViews(url) {
  const availableSessions = filteredSessions(url);
  const requestedPile = pathPile(url) ?? routePile(url);
  const graph = filteredGraph(url);
  const scopedIds = new Set(url.searchParams.getAll("session_id"));
  const visibleSessions = scopedIds.size
    ? availableSessions.filter((session) => scopedIds.has(session.id))
    : availableSessions;

  if (requestedPile === "journal") {
    const journalProfiles = {
      j1: {
        entry: "Walked from the Ferry Building toward North Beach with Maya. The day mixed city energy with product planning.",
        mood: "focused",
        people: ["Maya"],
        entities: ["SaveMyContext", "Product planning"],
        activities: ["walk", "planning"],
        locations: ["Ferry Building", "North Beach"],
        travel_path: ["Ferry Building", "Embarcadero", "North Beach"]
      },
      j2: {
        entry: "Workshop in the Mission with Luis. The conversation moved from research questions into prototype scope.",
        mood: "energized",
        people: ["Luis"],
        entities: ["Research plan", "Prototype"],
        activities: ["workshop", "sketching"],
        locations: ["Mission", "Dolores Park"],
        travel_path: ["Mission", "Dolores Park"]
      },
      j3: {
        entry: "Dinner in Hayes Valley with Anika. Talked through launch risk, review loops, and design direction.",
        mood: "reflective",
        people: ["Anika"],
        entities: ["Launch", "Design review"],
        activities: ["dinner", "review"],
        locations: ["Hayes Valley"],
        travel_path: ["Hayes Valley"]
      },
      j4: {
        entry: "Quiet reset in the Presidio after a review. Energy returned once priorities were narrowed.",
        mood: "calm",
        people: ["Maya", "Anika"],
        entities: ["Design direction", "Priorities"],
        activities: ["walk", "reflection"],
        locations: ["Presidio", "Crissy Field"],
        travel_path: ["Presidio", "Crissy Field"]
      }
    };
    const timeline = visibleSessions.map((session) => ({
      session_id: session.id,
      title: session.title,
      provider: session.provider,
      updated_at: session.updated_at,
      occurred_on: session.updated_at.slice(0, 10),
      entry: journalProfiles[session.id]?.entry ?? session.share_post,
      mood: journalProfiles[session.id]?.mood ?? null,
      people: journalProfiles[session.id]?.people ?? [],
      entities: journalProfiles[session.id]?.entities ?? [],
      activities: journalProfiles[session.id]?.activities ?? [],
      locations: journalProfiles[session.id]?.locations ?? [],
      travel_path: journalProfiles[session.id]?.travel_path ?? []
    }));
    const groupFrom = (key) =>
      Array.from(
        timeline
          .flatMap((item) => item[key].map((label) => ({ label, item })))
          .reduce((groups, { label, item }) => {
            const current = groups.get(label) ?? { label, count: 0, session_ids: [], dates: [], snippets: [] };
            current.count += 1;
            current.session_ids.push(item.session_id);
            current.dates.push(item.occurred_on);
            current.snippets.push(item.entry);
            groups.set(label, current);
            return groups;
          }, new Map())
          .values()
      ).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));

    return {
      pile_slug: "journal",
      scope_kind: "default",
      scope_label: scopeLabel(url),
      dominant_pile_slug: "journal",
      factual: null,
      ideas: null,
      journal: {
        timeline,
        locations: groupFrom("locations"),
        people: groupFrom("people"),
        entities: groupFrom("entities"),
        activities: groupFrom("activities")
      }
    };
  }

  if (requestedPile === "ideas") {
    const ideaProfiles = {
      i1: {
        project_slug: "product-thinking",
        project_name: "Product Thinking",
        thread: "Workspace shape",
        core_idea: "Saved context should expose idea development as a first-class surface.",
        reasoning_steps: ["Lists hide how a thought changed.", "The workspace should preserve sequence, project, and evidence."],
        related_facts: ["Context", "Storyline"],
        claims: [{ idea: "Evolution is more useful than filing alone.", attributed_to: "User", stance: "supports", evidence: "The critique asks for timelines and mind maps." }],
        next_steps: ["Prototype an evolution rail", "Add a joined mind map"]
      },
      i2: {
        project_slug: "timeline-systems",
        project_name: "Timeline Systems",
        thread: "Timeline",
        core_idea: "The idea pile needs a timeline-first view of reasoning steps.",
        reasoning_steps: ["A timeline gives order.", "A rail can show when claims build or fork."],
        related_facts: ["Timeline", "Reasoning"],
        claims: [{ idea: "Timeline is the primary exploration pattern.", attributed_to: "Assistant", stance: "supports", evidence: "Idea outputs include updated_at and reasoning_steps." }],
        next_steps: ["Connect timeline nodes to map nodes"]
      },
      i3: {
        project_slug: "map-surface",
        project_name: "Map Surface",
        thread: "Mind map",
        core_idea: "Joined mind maps can connect projects, claims, facts, and counterpoints.",
        reasoning_steps: ["Cards alone do not show adjacency.", "A map can link projects to idea nodes and relations."],
        related_facts: ["Graph", "Projects"],
        claims: [{ idea: "Mind maps should join multiple idea surfaces.", attributed_to: "User", stance: "supports", evidence: "The critique names joined mind maps directly." }],
        next_steps: ["Render relation lines", "Show project hubs"]
      },
      i4: {
        project_slug: "attribution-model",
        project_name: "Attribution Model",
        thread: "Attribution",
        core_idea: "Attribution should separate claims, counterpoints, and next moves.",
        reasoning_steps: ["Claims need provenance.", "Relations need explicit labels."],
        related_facts: ["Attribution", "Counterpoints"],
        claims: [{ idea: "Counterpoints should be visible beside supporting claims.", attributed_to: "Reviewer", stance: "counters", evidence: "A flat list loses disagreement." }],
        next_steps: ["Create claims board", "Show next moves beside relations"]
      }
    };
    const nodes = visibleSessions.map((session, index) => ({
      id: `idea-node-${session.id}`,
      session_id: session.id,
      title: session.title,
      provider: session.provider,
      updated_at: session.updated_at,
      thread: ideaProfiles[session.id]?.thread ?? "Unthreaded",
      project_slug: ideaProfiles[session.id]?.project_slug ?? "product-thinking",
      project_name: ideaProfiles[session.id]?.project_name ?? "Product Thinking",
      project_source: "mock",
      core_idea: ideaProfiles[session.id]?.core_idea ?? session.share_post,
      reasoning_steps: ideaProfiles[session.id]?.reasoning_steps ?? [session.share_post],
      related_facts: ideaProfiles[session.id]?.related_facts ?? [],
      claims: ideaProfiles[session.id]?.claims ?? [],
      next_steps: ideaProfiles[session.id]?.next_steps ?? [],
      share_post: session.share_post,
      _index: index
    }));
    const edges = [
      { id: "idea-edge-1", source: nodes[0]?.id, target: nodes[1]?.id, relation: "builds_on", label: "builds on", session_ids: [nodes[0]?.session_id, nodes[1]?.session_id].filter(Boolean) },
      { id: "idea-edge-2", source: nodes[1]?.id, target: nodes[2]?.id, relation: "validates", label: "validates", session_ids: [nodes[1]?.session_id, nodes[2]?.session_id].filter(Boolean) },
      { id: "idea-edge-3", source: nodes[2]?.id, target: nodes[3]?.id, relation: "counters", label: "counterpoint", session_ids: [nodes[2]?.session_id, nodes[3]?.session_id].filter(Boolean) }
    ].filter((edge) => edge.source && edge.target);
    const group = (label, sessionIds, snippets = []) => ({
      label,
      count: sessionIds.length,
      session_ids: sessionIds,
      dates: sessionIds.map((id) => visibleSessions.find((session) => session.id === id)?.updated_at?.slice(0, 10)).filter(Boolean),
      snippets
    });
    const groupNodes = (labelForNode) =>
      Array.from(
        nodes
          .reduce((groups, node) => {
            const label = labelForNode(node);
            const current = groups.get(label) ?? { label, nodes: [] };
            current.nodes.push(node);
            groups.set(label, current);
            return groups;
          }, new Map())
          .values()
      ).map((item) => group(item.label, item.nodes.map((node) => node.session_id), item.nodes.map((node) => node.core_idea)));

    return {
      pile_slug: "ideas",
      scope_kind: "default",
      scope_label: scopeLabel(url),
      dominant_pile_slug: "ideas",
      factual: null,
      journal: null,
      ideas: {
        nodes,
        edges,
        projects: groupNodes((node) => node.project_name),
        threads: Array.from(new Set(nodes.map((node) => node.thread))).map((thread) =>
          group(thread, nodes.filter((node) => node.thread === thread).map((node) => node.session_id))
        ),
        contributors: [group("User", nodes.map((node) => node.session_id)), group("Assistant", nodes.slice(1).map((node) => node.session_id))],
        facts: Array.from(new Set(nodes.flatMap((node) => node.related_facts))).map((fact) =>
          group(fact, nodes.filter((node) => node.related_facts.includes(fact)).map((node) => node.session_id))
        )
      }
    };
  }

  const topTerms = new Map();
  for (const node of graph.nodes ?? []) {
    topTerms.set(node.label, (topTerms.get(node.label) ?? 0) + node.session_ids.length);
  }
  const termCounts = Array.from(topTerms.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([label, count]) => ({ label, count }));

  const linkedSources = visibleSessions.slice(0, 4).map((session) => ({
    session_id: session.id,
    title: session.title,
    pile_slug: session.category,
    provider: session.provider,
    matched_terms: [session.custom_tags?.[0] ?? "context", ...(session.extra_piles ?? []).slice(0, 2)]
  }));

  const backlog = visibleSessions.map((session) => {
    const linked_from = linkedSources.filter((item) => item.session_id !== session.id).slice(0, 2);
    const relatedNodes = (graph.nodes ?? []).filter((node) => node.session_ids.includes(session.id));
    return {
      session_id: session.id,
      title: session.title,
      provider: session.provider,
      updated_at: session.updated_at,
      learned_on: session.updated_at.slice(0, 10),
      summary: session.share_post,
      context: session.share_post,
      keywords: session.custom_tags ?? [],
      entities: relatedNodes.map((node) => node.label),
      triplet_count: relatedNodes.length,
      linked_from
    };
  });

  return {
    pile_slug: "factual",
    scope_kind: "default",
    scope_label: scopeLabel(url),
    dominant_pile_slug: dominantCategory(visibleSessions, "factual"),
    factual: {
      backlog,
      keywords: Array.from(
        visibleSessions
          .flatMap((session) => session.custom_tags ?? [])
          .reduce((counts, label) => counts.set(label, (counts.get(label) ?? 0) + 1), new Map())
          .entries()
      ).map(([label, count]) => ({ label, count })),
      entities: termCounts,
      linked_sources: linkedSources
    },
    journal: null,
    ideas: null
  };
}

function buildSearch(url) {
  const query = (url.searchParams.get("q") ?? "").toLowerCase();
  const results = filteredSessions(url)
    .filter((session) => session.title.toLowerCase().includes(query) || session.share_post.toLowerCase().includes(query))
    .map((session) => ({
      kind: "session",
      title: session.title,
      snippet: session.share_post,
      session_id: session.id,
      category: session.category,
      provider: session.provider,
      extra_piles: session.extra_piles ?? [],
      markdown_path: session.markdown_path
    }));

  return { query, count: results.length, results };
}

function buildDashboardSummary() {
  const piles = ["factual", "ideas", "journal", "todo"].map((pile_slug) => ({
    pile_slug,
    count: sessions.filter((session) => session.category === pile_slug).length
  }));
  return {
    total_sessions: sessions.length,
    total_messages: sessions.length * 24,
    total_triplets: fullGraph.edges.reduce((sum, edge) => sum + edge.weight, 0),
    total_sync_events: sessions.length,
    active_tokens: 0,
    latest_sync_at: sessions.map((session) => session.updated_at).sort().at(-1),
    piles,
    extra_piles: summarizeUserCategories(sessions)
  };
}

function buildSystemStatus() {
  return {
    product: "savemycontext",
    version: "0.2.0",
    server_time: new Date().toISOString(),
    markdown_root: "/tmp/mock-markdown",
    vault_root: "/tmp/mock-vault/SaveMyContext",
    todo_list_path: "/tmp/mock-vault/SaveMyContext/Dashboards/To-Do List.md",
    public_url: null,
    auth_mode: "bootstrap_local",
    git_versioning_enabled: true,
    git_available: true,
    total_sessions: sessions.length,
    total_messages: sessions.length * 24,
    total_triplets: fullGraph.edges.reduce((sum, edge) => sum + edge.weight, 0)
  };
}

function buildGraphNodes() {
  return fullGraph.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    kind: node.kind,
    degree: node.size,
    note_path: null
  }));
}

function buildGraphEdges() {
  return fullGraph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    predicate: edge.label,
    support_count: edge.weight,
    session_ids: edge.session_ids
  }));
}

function buildGraphPath(url) {
  const graph = filteredGraph(url);
  const source = url.searchParams.get("source") ?? graph.nodes[0]?.id ?? "";
  const target = url.searchParams.get("target") ?? graph.nodes.find((node) => node.id !== source)?.id ?? "";
  const sourceNode = graph.nodes.find((node) => node.id === source) ?? graph.nodes[0] ?? null;
  const targetNode = graph.nodes.find((node) => node.id === target) ?? graph.nodes.find((node) => node.id !== sourceNode?.id) ?? null;
  const edge = graph.edges.find(
    (item) =>
      (item.source === sourceNode?.id && item.target === targetNode?.id) ||
      (item.source === targetNode?.id && item.target === sourceNode?.id)
  );
  const path =
    sourceNode && targetNode
      ? [
          {
            node_ids: [sourceNode.id, targetNode.id],
            nodes: [sourceNode, targetNode],
            edges: edge ? [edge] : [],
            hop_count: 1,
            score: edge?.weight ?? 1,
            evidence_session_ids: [...new Set([...(sourceNode.session_ids ?? []), ...(targetNode.session_ids ?? []), ...(edge?.session_ids ?? [])])]
          }
        ]
      : [];

  return {
    pile_slug: graph.pile_slug ?? graph.dominant_pile_slug ?? "factual",
    scope_kind: graph.scope_kind ?? "default",
    scope_label: graph.scope_label ?? "factual",
    dominant_pile_slug: graph.dominant_pile_slug ?? "factual",
    source,
    target,
    paths: path
  };
}

function attachDebug(page, label) {
  page.on("console", (message) => {
    console.log(`[${label}:console:${message.type()}] ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    console.log(`[${label}:pageerror] ${error?.stack || error}`);
  });
}

async function assertNoOverlap(page, selector, label) {
  const boxes = await page.locator(selector).evaluateAll((elements) =>
    elements
      .map((element, index) => {
        const rect = element.getBoundingClientRect();
        return {
          index,
          text: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80),
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height
        };
      })
      .filter((box) => box.width > 0 && box.height > 0)
  );

  for (let outer = 0; outer < boxes.length; outer += 1) {
    for (let inner = outer + 1; inner < boxes.length; inner += 1) {
      const left = boxes[outer];
      const right = boxes[inner];
      const xOverlap = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
      const yOverlap = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
      if (xOverlap <= 4 || yOverlap <= 4) {
        continue;
      }
      const overlapArea = xOverlap * yOverlap;
      const smallerArea = Math.min(left.width * left.height, right.width * right.height);
      if (overlapArea / smallerArea > 0.12) {
        throw new Error(`${label} overlap: "${left.text}" intersects "${right.text}"`);
      }
    }
  }
}

async function assertNoVerticalClip(page, selector, label) {
  const issues = await page.evaluate((targetSelector) => {
    return Array.from(document.querySelectorAll(targetSelector))
      .map((element) => {
        const styles = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          className: String(element.getAttribute("class") ?? element.tagName.toLowerCase()),
          overflowY: styles.overflowY,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom)
        };
      })
      .filter((item) => ["hidden", "clip"].includes(item.overflowY) && item.scrollHeight > item.clientHeight + 4);
  }, selector);

  if (issues.length) {
    throw new Error(`${label} has clipped vertical content: ${JSON.stringify(issues.slice(0, 3))}`);
  }
}

async function main() {
  console.log("launching-context");
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1200 },
    args: [`--disable-extensions-except=${extensionDist}`, `--load-extension=${extensionDist}`]
  });

  try {
    console.log("routing-backend");
    await context.route(`${backendBaseUrl}/api/v1/**`, async (route) => {
      const url = new URL(route.request().url());
      let body;

      if (url.pathname.endsWith("/meta/capabilities")) {
        body = {
          product: "savemycontext",
          version: "0.2.0",
          api_prefix: "/api/v1",
          server_time: new Date().toISOString(),
          auth: {
            mode: "bootstrap_local",
            token_verify_path: "/api/v1/auth/verify",
            local_unauthenticated_access: true,
            remote_requires_token: false
          },
          extension: {
            min_version: "0.1.0",
            auth_mode: "bootstrap_local"
          },
          features: {
            ingest: true,
            search: true,
            graph: true,
            obsidian_vault: true,
            knowledge_graph_files: true,
            storage_management: true,
            agent_api: true,
            browser_proxy: true,
            openai_compatible_api: true
          },
          storage: {
            markdown_root: "/tmp/mock-markdown",
            vault_root: "/tmp/mock-vault",
            public_url: null
          }
        };
      } else if (url.pathname.endsWith("/processing/status")) {
        body = { enabled: true, mode: "immediate", worker_model: "mock-worker", pending_count: 0 };
      } else if (url.pathname.endsWith("/dashboard/summary")) {
        body = buildDashboardSummary();
      } else if (url.pathname.endsWith("/system/status")) {
        body = buildSystemStatus();
      } else if (url.pathname.endsWith("/graph/nodes")) {
        body = buildGraphNodes();
      } else if (url.pathname.endsWith("/graph/edges")) {
        body = buildGraphEdges();
      } else if (url.pathname.endsWith("/idea-projects")) {
        body = [
          {
            id: "mock-product-thinking",
            slug: "product-thinking",
            name: "Product Thinking",
            description: "Workspace design, idea evolution, and product structure.",
            is_active: true,
            created_at: "2026-04-11T13:20:00Z",
            updated_at: "2026-04-14T10:05:00Z"
          }
        ];
      } else if (url.pathname.endsWith("/todo")) {
        body = sharedTodo;
      } else if (url.pathname.endsWith("/extra-piles")) {
        body = summarizeUserCategories(filteredSessions(url));
      } else if (url.pathname.includes("/sessions/") && url.pathname.endsWith("/extra-piles")) {
        const sessionId = decodeURIComponent(url.pathname.split("/").slice(-2, -1)[0] ?? "");
        const session = sessions.find((item) => item.id === sessionId);
        const payload = route.request().postDataJSON?.() ?? {};
        const nextCategories = Array.isArray(payload.extra_piles) ? payload.extra_piles.filter(Boolean) : [];
        if (!session) {
          await route.fulfill({ status: 404, body: "not found" });
          return;
        }
        session.extra_piles = [...new Set(nextCategories)];
        if (notes[session.id]) {
          notes[session.id].extra_piles = [...session.extra_piles];
        }
        body = session;
      } else if (url.pathname.endsWith("/sessions")) {
        body = filteredSessions(url);
      } else if (url.pathname.includes("/extra-piles/") && url.pathname.endsWith("/stats")) {
        body = buildStats(url);
      } else if (url.pathname.includes("/extra-piles/") && url.pathname.endsWith("/graph")) {
        body = filteredGraph(url);
      } else if (url.pathname.includes("/extra-piles/") && url.pathname.endsWith("/views")) {
        body = buildPileViews(url);
      } else if (url.pathname.includes("/extra-piles/") && url.pathname.endsWith("/graph/path")) {
        body = buildGraphPath(url);
      } else if (url.pathname.includes("/piles/") && url.pathname.endsWith("/stats")) {
        body = buildStats(url);
      } else if (url.pathname.includes("/piles/") && url.pathname.endsWith("/graph")) {
        body = filteredGraph(url);
      } else if (url.pathname.includes("/piles/") && url.pathname.endsWith("/views")) {
        body = buildPileViews(url);
      } else if (url.pathname.includes("/piles/") && url.pathname.endsWith("/graph/path")) {
        body = buildGraphPath(url);
      } else if (url.pathname.endsWith("/search")) {
        body = buildSearch(url);
      } else if (url.pathname.includes("/notes/")) {
        const sessionId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
        body = notes[sessionId];
      } else {
        await route.fulfill({ status: 404, body: "not found" });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body)
      });
    });

    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) {
      console.log("waiting-service-worker");
      serviceWorker = await context.waitForEvent("serviceworker");
    }
    const extensionId = serviceWorker.url().split("/")[2] ?? "";
    console.log(`extension-id:${extensionId}`);

    const optionsPage = await context.newPage();
    attachDebug(optionsPage, "options");
    console.log("configuring-options");
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: "domcontentloaded" });
    await optionsPage.locator("#backend-url").fill(backendBaseUrl);
    await optionsPage.locator("#provider-chatgpt").setChecked(true);
    await optionsPage.locator("#provider-gemini").setChecked(true);
    await optionsPage.locator("#provider-grok").setChecked(true);
    await optionsPage.locator("#settings-form").evaluate((form) => form.requestSubmit());
    await optionsPage.locator("#save-status").waitFor({ state: "visible" });
    console.log("options-saved");

    const popupPage = await context.newPage();
    attachDebug(popupPage, "popup");
    console.log("opening-popup");
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
    await popupPage.locator("text=SaveMyContext").first().waitFor();
    await popupPage.screenshot({ path: "/tmp/smc-popup-redesign.png", fullPage: true });
    console.log("popup-done");

    const dashboardPage = await context.newPage();
    attachDebug(dashboardPage, "dashboard");
    console.log("opening-dashboard");
    await dashboardPage.goto(`chrome-extension://${extensionId}/dashboard.html?view=processing`, {
      waitUntil: "domcontentloaded"
    });
    await dashboardPage.locator("text=Vault & processing").waitFor();
    await dashboardPage.screenshot({ path: "/tmp/smc-dashboard-ops-redesign.png", fullPage: true });
    console.log("dashboard-done");

    const atlasPage = await context.newPage();
    attachDebug(atlasPage, "atlas");
    console.log("opening-atlas");
    await atlasPage.goto(`chrome-extension://${extensionId}/pile.html?pile=factual`, {
      waitUntil: "domcontentloaded"
    });
    try {
      await atlasPage.getByRole("heading", { name: "Factual workspace" }).waitFor();
    } catch (error) {
      await atlasPage.screenshot({ path: "/tmp/smc-category-atlas-redesign-failure.png", fullPage: true });
      const bodyText = await atlasPage.locator("body").textContent();
      console.log(`[atlas:body] ${(bodyText ?? "").trim().slice(0, 1000)}`);
      throw error;
    }
    await atlasPage.locator("text=Context engineering notes").first().waitFor();
    await atlasPage.screenshot({ path: "/tmp/smc-category-atlas-redesign.png", fullPage: true });
    console.log("atlas-done");

    const ideasPage = await context.newPage();
    attachDebug(ideasPage, "ideas");
    console.log("opening-ideas");
    await ideasPage.goto(`chrome-extension://${extensionId}/pile.html?pile=ideas`, {
      waitUntil: "domcontentloaded"
    });
    await ideasPage.locator("text=Evolution timeline").waitFor();
    await assertNoOverlap(ideasPage, ".idea-map-panel--compact .idea-map-node, .idea-map-panel--compact .idea-map-hub", "compact idea map");
    await assertNoVerticalClip(ideasPage, ".pile-workbench--ideas, .pile-workbench--ideas .pile-workbench-main, .pile-workbench--ideas .pile-sidebar-card, .pile-workbench--ideas .pile-sidebar-scroll, .pile-workbench--ideas .pile-main-card", "ideas evolution");
    await ideasPage.screenshot({ path: "/tmp/smc-category-ideas-redesign.png", fullPage: true });
    console.log("ideas-done");

    const ideaMapPage = await context.newPage();
    attachDebug(ideaMapPage, "idea-map");
    console.log("opening-idea-map");
    await ideaMapPage.goto(`chrome-extension://${extensionId}/pile.html?pile=ideas&view=story`, {
      waitUntil: "domcontentloaded"
    });
    await ideaMapPage.locator("text=Joined mind map").first().waitFor();
    await ideaMapPage.locator("text=4 ideas across 4 projects").waitFor();
    await assertNoOverlap(ideaMapPage, ".idea-map-panel .idea-map-node, .idea-map-panel .idea-map-hub", "idea map");
    await assertNoVerticalClip(ideaMapPage, ".pile-workbench--ideas, .pile-workbench--ideas .pile-workbench-main, .pile-workbench--ideas .pile-sidebar-card, .pile-workbench--ideas .pile-sidebar-scroll, .pile-workbench--ideas .pile-main-card", "ideas map");
    await ideaMapPage.screenshot({ path: "/tmp/smc-category-ideas-map-redesign.png", fullPage: true });
    console.log("idea-map-done");

    const ideaClaimsPage = await context.newPage();
    attachDebug(ideaClaimsPage, "idea-claims");
    console.log("opening-idea-claims");
    await ideaClaimsPage.goto(`chrome-extension://${extensionId}/pile.html?pile=ideas&view=ops`, {
      waitUntil: "domcontentloaded"
    });
    await ideaClaimsPage.locator("text=attributed positions").waitFor();
    await ideaClaimsPage.screenshot({ path: "/tmp/smc-category-ideas-claims-redesign.png", fullPage: true });
    console.log("idea-claims-done");

    const journalPage = await context.newPage();
    attachDebug(journalPage, "journal");
    console.log("opening-journal");
    await journalPage.goto(`chrome-extension://${extensionId}/pile.html?pile=journal`, {
      waitUntil: "domcontentloaded"
    });
    await journalPage.locator("text=Latest day").waitFor();
    await journalPage.screenshot({ path: "/tmp/smc-category-journal-redesign.png", fullPage: true });
    console.log("journal-done");

    const journalMapPage = await context.newPage();
    attachDebug(journalMapPage, "journal-map");
    console.log("opening-journal-map");
    await journalMapPage.goto(`chrome-extension://${extensionId}/pile.html?pile=journal&view=story`, {
      waitUntil: "domcontentloaded"
    });
    await journalMapPage.locator("text=Place map").waitFor();
    await assertNoOverlap(journalMapPage, ".journal-map-canvas .journal-map-node, .journal-map-canvas .journal-map-center", "journal place map");
    await journalMapPage.screenshot({ path: "/tmp/smc-category-journal-map-redesign.png", fullPage: true });
    console.log("journal-map-done");

    const journalPeoplePage = await context.newPage();
    attachDebug(journalPeoplePage, "journal-people");
    console.log("opening-journal-people");
    await journalPeoplePage.goto(`chrome-extension://${extensionId}/pile.html?pile=journal&view=ops`, {
      waitUntil: "domcontentloaded"
    });
    await journalPeoplePage.locator("text=People timeline").waitFor();
    await assertNoOverlap(journalPeoplePage, ".people-constellation .person-orbit-node, .people-constellation .people-constellation-core", "journal people constellation");
    await journalPeoplePage.screenshot({ path: "/tmp/smc-category-journal-people-redesign.png", fullPage: true });
    console.log("journal-people-done");

    const storyPage = await context.newPage();
    attachDebug(storyPage, "story");
    console.log("opening-story");
    await storyPage.goto(`chrome-extension://${extensionId}/pile.html?pile=factual&view=story`, {
      waitUntil: "domcontentloaded"
    });
    await storyPage.locator("text=Facts with links from other piles").waitFor();
    await storyPage.screenshot({ path: "/tmp/smc-category-story-redesign.png", fullPage: true });
    console.log("story-done");

    const opsPage = await context.newPage();
    attachDebug(opsPage, "ops");
    console.log("opening-ops");
    await opsPage.goto(`chrome-extension://${extensionId}/pile.html?pile=factual&view=ops`, {
      waitUntil: "domcontentloaded"
    });
    await opsPage.locator("text=Keywords").waitFor();
    await opsPage.screenshot({ path: "/tmp/smc-category-ops-redesign.png", fullPage: true });
    console.log("ops-done");

    const todoPage = await context.newPage();
    attachDebug(todoPage, "todo");
    console.log("opening-todo");
    await todoPage.goto(`chrome-extension://${extensionId}/pile.html?pile=todo`, {
      waitUntil: "domcontentloaded"
    });
    await todoPage.locator("text=Shared list workspace").waitFor();
    await todoPage.screenshot({ path: "/tmp/smc-category-todo-redesign.png", fullPage: true });
    console.log("todo-done");

    const customPage = await context.newPage();
    attachDebug(customPage, "custom");
    console.log("opening-custom");
    await customPage.goto(`chrome-extension://${extensionId}/pile.html?pile=factual&extraPile=Knowledge%20Ops`, {
      waitUntil: "domcontentloaded"
    });
    await customPage.locator("text=Knowledge Ops").first().waitFor();
    await customPage.screenshot({ path: "/tmp/smc-category-custom-redesign.png", fullPage: true });
    console.log("custom-done");

    console.log(
      JSON.stringify({
        popup: "/tmp/smc-popup-redesign.png",
        dashboard: "/tmp/smc-dashboard-ops-redesign.png",
        atlas: "/tmp/smc-category-atlas-redesign.png",
        ideas: "/tmp/smc-category-ideas-redesign.png",
        ideaMap: "/tmp/smc-category-ideas-map-redesign.png",
        ideaClaims: "/tmp/smc-category-ideas-claims-redesign.png",
        journal: "/tmp/smc-category-journal-redesign.png",
        journalMap: "/tmp/smc-category-journal-map-redesign.png",
        journalPeople: "/tmp/smc-category-journal-people-redesign.png",
        story: "/tmp/smc-category-story-redesign.png",
        ops: "/tmp/smc-category-ops-redesign.png",
        todo: "/tmp/smc-category-todo-redesign.png",
        custom: "/tmp/smc-category-custom-redesign.png"
      })
    );
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
