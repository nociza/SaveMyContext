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
    markdown_path: "factual/karpathy-llm-wiki-patterns.md",
    share_post: "Index, sync, log, lint, and query should be first-class graph management surfaces.",
    updated_at: "2026-04-16T08:05:00Z",
    last_captured_at: "2026-04-16T08:05:00Z",
    last_processed_at: "2026-04-16T08:09:00Z"
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
      todo_summary: null,
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
      triplets: [
        {
          id: `${session.id}-t1`,
          subject: session.title.split(" ")[0],
          predicate: "relates_to",
          object: "Context",
          created_at: session.updated_at
        }
      ],
      raw_markdown: `# ${session.title}

${session.share_post}

## Why it matters

- Persistent context needs shape
- Retrieval should be inspectable
- Notes need evidence and provenance`,
      related_entities: ["Context", "Retrieval", "Memory"],
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

function filteredSessions(url) {
  const provider = url.searchParams.get("provider");
  const category = url.searchParams.get("category");
  return sessions.filter(
    (session) => (!provider || session.provider === provider) && (!category || session.category === category)
  );
}

function filteredGraph(url) {
  const scopedIds = new Set(url.searchParams.getAll("session_id"));
  const hasScope = scopedIds.size > 0;
  const allowedSessionIds = new Set(filteredSessions(url).map((session) => session.id));
  const sessionAllowed = (sessionId) => allowedSessionIds.has(sessionId) && (!hasScope || scopedIds.has(sessionId));

  const nodes = fullGraph.nodes.filter((node) => node.session_ids.some(sessionAllowed));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = fullGraph.edges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target) && edge.session_ids.some(sessionAllowed)
  );

  return {
    category: "factual",
    node_count: nodes.length,
    edge_count: edges.length,
    nodes,
    edges
  };
}

function buildStats(url) {
  const availableSessions = filteredSessions(url);
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
  const entityCounts = graph.nodes
    .map((node) => ({ label: node.label, count: node.session_ids.length }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 6);
  const predicateCounts = new Map();
  for (const edge of graph.edges) {
    predicateCounts.set(edge.label ?? "related", (predicateCounts.get(edge.label ?? "related") ?? 0) + edge.weight);
  }

  return {
    category: "factual",
    total_sessions: visibleSessions.length,
    total_messages: visibleSessions.length * 24,
    total_triplets: graph.edges.reduce((sum, edge) => sum + edge.weight, 0),
    latest_updated_at: visibleSessions[0]?.updated_at ?? null,
    avg_messages_per_session: visibleSessions.length ? 24 : 0,
    avg_triplets_per_session: visibleSessions.length
      ? graph.edges.reduce((sum, edge) => sum + edge.weight, 0) / visibleSessions.length
      : 0,
    notes_with_share_post: visibleSessions.filter((session) => session.share_post).length,
    notes_with_idea_summary: 0,
    notes_with_journal_entry: 0,
    notes_with_todo_summary: 0,
    provider_counts: providerCounts,
    activity: Array.from(activityMap.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([bucket, count]) => ({ bucket, count })),
    top_tags: [],
    top_entities: entityCounts,
    top_predicates: Array.from(predicateCounts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((left, right) => right.count - left.count)
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
      markdown_path: session.markdown_path
    }));

  return { query, count: results.length, results };
}

function attachDebug(page, label) {
  page.on("console", (message) => {
    console.log(`[${label}:console:${message.type()}] ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    console.log(`[${label}:pageerror] ${error?.stack || error}`);
  });
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
      } else if (url.pathname.endsWith("/sessions")) {
        body = filteredSessions(url);
      } else if (url.pathname.includes("/categories/factual/stats")) {
        body = buildStats(url);
      } else if (url.pathname.includes("/categories/factual/graph")) {
        body = filteredGraph(url);
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

    const atlasPage = await context.newPage();
    attachDebug(atlasPage, "atlas");
    console.log("opening-atlas");
    await atlasPage.goto(`chrome-extension://${extensionId}/category.html?category=factual`, {
      waitUntil: "domcontentloaded"
    });
    try {
      await atlasPage.locator("text=Knowledge graph workspace").waitFor();
    } catch (error) {
      await atlasPage.screenshot({ path: "/tmp/smc-category-atlas-redesign-failure.png", fullPage: true });
      const bodyText = await atlasPage.locator("body").textContent();
      console.log(`[atlas:body] ${(bodyText ?? "").trim().slice(0, 1000)}`);
      throw error;
    }
    await atlasPage.locator(".react-flow__node").first().waitFor();
    await atlasPage.screenshot({ path: "/tmp/smc-category-atlas-redesign.png", fullPage: true });
    console.log("atlas-done");

    const storyPage = await context.newPage();
    attachDebug(storyPage, "story");
    console.log("opening-story");
    await storyPage.goto(`chrome-extension://${extensionId}/category.html?category=factual&view=story`, {
      waitUntil: "domcontentloaded"
    });
    await storyPage.locator("text=Recent note movement").waitFor();
    await storyPage.screenshot({ path: "/tmp/smc-category-story-redesign.png", fullPage: true });
    console.log("story-done");

    const opsPage = await context.newPage();
    attachDebug(opsPage, "ops");
    console.log("opening-ops");
    await opsPage.goto(`chrome-extension://${extensionId}/category.html?category=factual&view=ops`, {
      waitUntil: "domcontentloaded"
    });
    await opsPage.locator("text=Graph hygiene").waitFor();
    await opsPage.screenshot({ path: "/tmp/smc-category-ops-redesign.png", fullPage: true });
    console.log("ops-done");

    console.log(
      JSON.stringify({
        atlas: "/tmp/smc-category-atlas-redesign.png",
        story: "/tmp/smc-category-story-redesign.png",
        ops: "/tmp/smc-category-ops-redesign.png"
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
