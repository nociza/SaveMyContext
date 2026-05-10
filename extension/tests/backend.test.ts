import { beforeEach, describe, expect, it, vi } from "vitest";

describe("backend validation helpers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("chrome", {
      runtime: {
        getManifest: () => ({ version: "0.1.0" })
      }
    });
  });

  function remoteSettings() {
    return {
      backendUrl: "https://notes.example.com/",
      backendToken: "savemycontext_pat_test",
      autoSyncHistory: true,
      indexingMode: "all" as const,
      triggerWords: ["lorem"],
      blacklistWords: [],
      discardWordsEnabled: true,
      discardWords: [],
      selectionCaptureEnabled: false,
      contextSuggestionsEnabled: false,
      contextSuggestionsFloatingButtonEnabled: true,
      enabledProviders: {
        chatgpt: true,
        gemini: true,
        grok: true
      }
    };
  }

  it("treats localhost as local", async () => {
    const { isLocalBackendUrl } = await import("../src/background/backend");
    expect(isLocalBackendUrl(new URL("http://127.0.0.1:18888"))).toBe(true);
    expect(isLocalBackendUrl(new URL("http://localhost:18888"))).toBe(true);
    expect(isLocalBackendUrl(new URL("https://notes.example.com"))).toBe(false);
  });

  it("rejects insecure remote backends", async () => {
    const { validateBackendConfiguration } = await import("../src/background/backend");
    await expect(
      validateBackendConfiguration({
        backendUrl: "http://notes.example.com",
        backendToken: "",
        autoSyncHistory: true,
        indexingMode: "all",
        triggerWords: ["lorem"],
        blacklistWords: [],
        discardWordsEnabled: true,
        discardWords: [],
        selectionCaptureEnabled: false,
        contextSuggestionsEnabled: false,
        contextSuggestionsFloatingButtonEnabled: true,
        enabledProviders: {
          chatgpt: true,
          gemini: true,
          grok: true
        }
      })
    ).rejects.toThrow("Remote backends must use https://.");
  });

  it("requires a token for remote app-token backends", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          product: "savemycontext",
          version: "0.2.0",
          api_prefix: "/api/v1",
          server_time: "2026-04-02T00:00:00Z",
          auth: {
            mode: "app_token",
            token_verify_path: "/api/v1/auth/token/verify",
            local_unauthenticated_access: true,
            remote_requires_token: true
          },
          extension: {
            min_version: "0.1.0",
            auth_mode: "app_token"
          },
          features: {
            ingest: true,
            search: true,
            graph: true,
            obsidian_vault: true,
            knowledge_graph_files: true,
            agent_api: true,
            browser_proxy: false,
            openai_compatible_api: false
          },
          storage: {
            markdown_root: "/srv/savemycontext/markdown",
            vault_root: "/srv/savemycontext/markdown/SaveMyContext"
          }
        })
      }))
    );

    const { validateBackendConfiguration } = await import("../src/background/backend");
    await expect(
      validateBackendConfiguration({
        backendUrl: "https://notes.example.com",
        backendToken: "",
        autoSyncHistory: true,
        indexingMode: "all",
        triggerWords: ["lorem"],
        blacklistWords: [],
        discardWordsEnabled: true,
        discardWords: [],
        selectionCaptureEnabled: false,
        contextSuggestionsEnabled: false,
        contextSuggestionsFloatingButtonEnabled: true,
        enabledProviders: {
          chatgpt: true,
          gemini: true,
          grok: true
        }
      })
    ).rejects.toThrow("A backend app token with ingest and read scopes is required.");
  });

  it("requires a token for local backends once the server is in token mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          product: "savemycontext",
          version: "0.2.0",
          api_prefix: "/api/v1",
          server_time: "2026-04-02T00:00:00Z",
          auth: {
            mode: "app_token",
            token_verify_path: "/api/v1/auth/token/verify",
            local_unauthenticated_access: false,
            remote_requires_token: true
          },
          extension: {
            min_version: "0.1.0",
            auth_mode: "app_token"
          },
          features: {
            ingest: true,
            search: true,
            graph: true,
            obsidian_vault: true,
            knowledge_graph_files: true,
            agent_api: true,
            browser_proxy: false,
            openai_compatible_api: false
          },
          storage: {
            markdown_root: "/srv/savemycontext/markdown",
            vault_root: "/srv/savemycontext/markdown/SaveMyContext"
          }
        })
      }))
    );

    const { validateBackendConfiguration } = await import("../src/background/backend");
    await expect(
      validateBackendConfiguration({
        backendUrl: "http://127.0.0.1:18888",
        backendToken: "",
        autoSyncHistory: true,
        indexingMode: "all",
        triggerWords: ["lorem"],
        blacklistWords: [],
        discardWordsEnabled: true,
        discardWords: [],
        selectionCaptureEnabled: false,
        contextSuggestionsEnabled: false,
        contextSuggestionsFloatingButtonEnabled: true,
        enabledProviders: {
          chatgpt: true,
          gemini: true,
          grok: true
        }
      })
    ).rejects.toThrow("A backend app token with ingest and read scopes is required.");
  });

  it("rejects tokens that are missing required extension scopes", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.endsWith("/api/v1/meta/capabilities")) {
        return {
          ok: true,
          json: async () => ({
            product: "savemycontext",
            version: "0.2.0",
            api_prefix: "/api/v1",
            server_time: "2026-04-02T00:00:00Z",
            auth: {
              mode: "app_token",
              token_verify_path: "/api/v1/auth/token/verify",
              local_unauthenticated_access: false,
              remote_requires_token: true
            },
            extension: {
              min_version: "0.1.0",
              auth_mode: "app_token"
            },
            features: {
              ingest: true,
              search: true,
              graph: true,
              obsidian_vault: true,
              knowledge_graph_files: true,
              agent_api: true,
              browser_proxy: false,
              openai_compatible_api: false
            },
            storage: {
              markdown_root: "/srv/savemycontext/markdown",
              vault_root: "/srv/savemycontext/markdown/SaveMyContext"
            }
          })
        };
      }
      return {
        ok: true,
        json: async () => ({
          valid: true,
          scopes: ["read"]
        })
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { validateBackendConfiguration } = await import("../src/background/backend");
    await expect(
      validateBackendConfiguration({
        backendUrl: "https://notes.example.com",
        backendToken: "savemycontext_pat_test",
        autoSyncHistory: true,
        indexingMode: "all",
        triggerWords: ["lorem"],
        blacklistWords: [],
        discardWordsEnabled: true,
        discardWords: [],
        selectionCaptureEnabled: false,
        contextSuggestionsEnabled: false,
        contextSuggestionsFloatingButtonEnabled: true,
        enabledProviders: {
          chatgpt: true,
          gemini: true,
          grok: true
        }
      })
    ).rejects.toThrow("The backend token is missing required scopes: ingest.");
  });

  it("fetches dashboard summary with backend auth headers", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        total_sessions: 3,
        total_messages: 6,
        total_triplets: 3,
        total_sync_events: 3,
        active_tokens: 0,
        latest_sync_at: "2026-04-14T00:00:00Z",
        piles: [
          { pile_slug: "factual", count: 1 },
          { pile_slug: "ideas", count: 1 },
          { pile_slug: "todo", count: 1 }
        ]
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchDashboardSummary } = await import("../src/background/backend");
    const summary = await fetchDashboardSummary({
      backendUrl: "https://notes.example.com/",
      backendToken: "savemycontext_pat_test",
      autoSyncHistory: true,
      indexingMode: "all",
      triggerWords: ["lorem"],
      blacklistWords: [],
      discardWordsEnabled: true,
      discardWords: [],
      selectionCaptureEnabled: false,
      contextSuggestionsEnabled: false,
      contextSuggestionsFloatingButtonEnabled: true,
      enabledProviders: {
        chatgpt: true,
        gemini: true,
        grok: true
      }
    });

    expect(fetchMock).toHaveBeenCalledWith("https://notes.example.com/api/v1/dashboard/summary", {
      headers: {
        Authorization: "Bearer savemycontext_pat_test"
      }
    });
    expect(summary.total_sessions).toBe(3);
    expect(summary.piles).toHaveLength(3);
    expect(summary.extra_piles).toEqual([]);
  });

  it("normalizes missing dashboard summary arrays", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          total_sessions: 0,
          total_messages: 0,
          total_triplets: 0,
          total_sync_events: 0,
          active_tokens: 0,
          latest_sync_at: null
        })
      }))
    );

    const { fetchDashboardSummary } = await import("../src/background/backend");
    const summary = await fetchDashboardSummary({
      backendUrl: "https://notes.example.com/",
      backendToken: "savemycontext_pat_test",
      autoSyncHistory: true,
      indexingMode: "all",
      triggerWords: ["lorem"],
      blacklistWords: [],
      discardWordsEnabled: true,
      discardWords: [],
      selectionCaptureEnabled: false,
      contextSuggestionsEnabled: false,
      contextSuggestionsFloatingButtonEnabled: true,
      enabledProviders: {
        chatgpt: true,
        gemini: true,
        grok: true
      }
    });

    expect(summary.piles).toEqual([]);
    expect(summary.extra_piles).toEqual([]);
  });

  it("normalizes missing shared to-do arrays and counters", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          title: "Shared checklist",
          content: ""
        })
      }))
    );

    const { fetchTodoList } = await import("../src/background/backend");
    const todo = await fetchTodoList(remoteSettings());

    expect(todo.items).toEqual([]);
    expect(todo.active_count).toBe(0);
    expect(todo.completed_count).toBe(0);
    expect(todo.total_count).toBe(0);
    expect(todo.git.repository_ready).toBe(false);
  });

  it("normalizes missing nested pile workspace arrays", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          pile_slug: "journal",
          scope_kind: "default",
          scope_label: "journal",
          dominant_pile_slug: "journal",
          journal: {
            timeline: [
              {
                session_id: "session-1",
                entry: "A day in motion"
              }
            ],
            locations: [
              {
                label: "Lisbon",
                count: 1
              }
            ]
          },
          ideas: {
            nodes: [
              {
                id: "idea-1",
                session_id: "session-2",
                core_idea: "Use typed boundaries"
              }
            ],
            edges: [
              {
                id: "edge-1",
                source: "idea-1",
                target: "idea-2",
                relation: "builds_on"
              }
            ]
          },
          factual: {
            backlog: [
              {
                session_id: "session-3",
                title: "Fact"
              }
            ],
            linked_sources: [
              {
                session_id: "session-4",
                title: "Source"
              }
            ]
          }
        })
      }))
    );

    const { fetchPileViews } = await import("../src/background/backend");
    const views = await fetchPileViews(remoteSettings(), "journal");

    expect(views.journal?.timeline[0].people).toEqual([]);
    expect(views.journal?.timeline[0].travel_path).toEqual([]);
    expect(views.journal?.locations[0].session_ids).toEqual([]);
    expect(views.journal?.people).toEqual([]);
    expect(views.ideas?.nodes[0].claims).toEqual([]);
    expect(views.ideas?.edges[0].session_ids).toEqual([]);
    expect(views.factual?.backlog[0].keywords).toEqual([]);
    expect(views.factual?.backlog[0].linked_from).toEqual([]);
    expect(views.factual?.linked_sources[0].matched_terms).toEqual([]);
  });

  it("normalizes missing graph path arrays", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          pile_slug: "factual",
          scope_kind: "default",
          scope_label: "factual",
          dominant_pile_slug: "factual",
          source: "node-a",
          target: "node-b"
        })
      }))
    );

    const { fetchPileGraphPath } = await import("../src/background/backend");
    const path = await fetchPileGraphPath(remoteSettings(), "factual", "node-a", "node-b");

    expect(path.paths).toEqual([]);
  });

  it("normalizes missing pile stats arrays and counters", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          pile_slug: "factual",
          scope_kind: "default",
          scope_label: "factual",
          dominant_pile_slug: "factual"
        })
      }))
    );

    const { fetchPileStats } = await import("../src/background/backend");
    const stats = await fetchPileStats(remoteSettings(), "factual");

    expect(stats.total_sessions).toBe(0);
    expect(stats.provider_counts).toEqual([]);
    expect(stats.activity).toEqual([]);
    expect(stats.top_tags).toEqual([]);
    expect(stats.top_entities).toEqual([]);
    expect(stats.top_predicates).toEqual([]);
  });

  it("normalizes missing pile graph arrays", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          pile_slug: "factual",
          scope_kind: "default",
          scope_label: "factual",
          dominant_pile_slug: "factual",
          nodes: [
            {
              id: "node-1",
              label: "Node",
              kind: "entity"
            }
          ],
          edges: [
            {
              id: "edge-1",
              source: "node-1",
              target: "node-2"
            }
          ]
        })
      }))
    );

    const { fetchPileGraph } = await import("../src/background/backend");
    const graph = await fetchPileGraph(remoteSettings(), "factual");

    expect(graph.node_count).toBe(1);
    expect(graph.edge_count).toBe(1);
    expect(graph.nodes[0].session_ids).toEqual([]);
    expect(graph.nodes[0].evidence).toEqual([]);
    expect(graph.edges[0].session_ids).toEqual([]);
    expect(graph.edges[0].evidence).toEqual([]);
  });

  it("fetches knowledge search results with encoded query params", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        query: "rust ownership",
        count: 1,
        results: [
          {
            kind: "entity",
            title: "Rust",
            snippet: "Rust | uses | ownership"
          }
        ]
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchKnowledgeSearch } = await import("../src/background/backend");
    const response = await fetchKnowledgeSearch(
      {
        backendUrl: "https://notes.example.com/",
        backendToken: "savemycontext_pat_test",
        autoSyncHistory: true,
        indexingMode: "all",
        triggerWords: ["lorem"],
        blacklistWords: [],
        discardWordsEnabled: true,
        discardWords: [],
        selectionCaptureEnabled: false,
        contextSuggestionsEnabled: false,
        contextSuggestionsFloatingButtonEnabled: true,
        enabledProviders: {
          chatgpt: true,
          gemini: true,
          grok: true
        }
      },
      "rust ownership",
      5
    );

    expect(fetchMock).toHaveBeenCalledWith("https://notes.example.com/api/v1/search?q=rust+ownership&limit=5", {
      headers: {
        Authorization: "Bearer savemycontext_pat_test"
      }
    });
    expect(response.count).toBe(1);
    expect(response.results[0]?.snippet).toBe("Rust | uses | ownership");
  });

  it("updates the backend knowledge storage path with auth headers", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        markdown_root: "/srv/knowledge",
        vault_root: "/srv/knowledge/SaveMyContext",
        todo_list_path: "/srv/knowledge/SaveMyContext/Dashboards/To-Do List.md",
        persistence_kind: "cli_config",
        persisted_to: "/home/test/.config/savemycontext/config.toml",
        regenerated_session_count: 12,
        git_initialized: true
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { updateKnowledgeStoragePath } = await import("../src/background/backend");
    const response = await updateKnowledgeStoragePath(
      {
        backendUrl: "https://notes.example.com/",
        backendToken: "savemycontext_pat_test",
        autoSyncHistory: true,
        indexingMode: "all",
        triggerWords: ["lorem"],
        blacklistWords: [],
        discardWordsEnabled: true,
        discardWords: [],
        selectionCaptureEnabled: false,
        contextSuggestionsEnabled: false,
        contextSuggestionsFloatingButtonEnabled: true,
        enabledProviders: {
          chatgpt: true,
          gemini: true,
          grok: true
        }
      },
      "/srv/knowledge"
    );

    expect(fetchMock).toHaveBeenCalledWith("https://notes.example.com/api/v1/system/storage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer savemycontext_pat_test"
      },
      body: JSON.stringify({
        markdown_root: "/srv/knowledge"
      })
    });
    expect(response.vault_root).toBe("/srv/knowledge/SaveMyContext");
    expect(response.regenerated_session_count).toBe(12);
  });

  it("posts source captures to the backend in the expected shape", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        source_id: "capture-1",
        title: "Rust ownership note",
        capture_kind: "selection",
        save_mode: "ai",
        processed: true,
        pile_slug: "factual",
        markdown_path: "/srv/knowledge/SaveMyContext/Captures/selection--rust-ownership-note--capture.md",
        raw_source_path: "/srv/knowledge/SaveMyContext/Sources/selection--rust-ownership-note--capture--source.md"
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { saveSourceCaptureToBackend } = await import("../src/background/backend");
    const response = await saveSourceCaptureToBackend(
      {
        backendUrl: "https://notes.example.com/",
        backendToken: "savemycontext_pat_test",
        autoSyncHistory: true,
        indexingMode: "all",
        triggerWords: ["lorem"],
        blacklistWords: [],
        discardWordsEnabled: true,
        discardWords: [],
        selectionCaptureEnabled: false,
        contextSuggestionsEnabled: false,
        contextSuggestionsFloatingButtonEnabled: true,
        enabledProviders: {
          chatgpt: true,
          gemini: true,
          grok: true
        }
      },
      {
        captureKind: "selection",
        saveMode: "ai",
        title: "Rust ownership note",
        pageTitle: "Rust reference",
        sourceUrl: "https://example.com/rust",
        selectionText: "Rust uses ownership to manage memory safely.",
        sourceText: "Rust uses ownership to manage memory safely.",
        sourceMarkdown: "Rust uses ownership to manage memory safely.",
        rawPayload: {
          selectionLength: 44
        }
      }
    );

    expect(fetchMock).toHaveBeenCalledWith("https://notes.example.com/api/v1/capture/source", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer savemycontext_pat_test"
      },
      body: JSON.stringify({
        capture_kind: "selection",
        save_mode: "ai",
        title: "Rust ownership note",
        page_title: "Rust reference",
        source_url: "https://example.com/rust",
        selection_text: "Rust uses ownership to manage memory safely.",
        source_text: "Rust uses ownership to manage memory safely.",
        source_markdown: "Rust uses ownership to manage memory safely.",
        raw_payload: {
          selectionLength: 44
        }
      })
    });
    expect(response.ok).toBe(true);
    expect(response.pile_slug).toBe("factual");
    expect(response.sourceId).toBe("capture-1");
  });
});
