import { describe, expect, it, vi } from "vitest";
import { chatGPTReader, discoverChatGPTProjects } from "../src/injected/chatgpt-projects";
import { chatGPTProject } from "../src/providers/chatgpt-project";
import { ChatGPTScraper } from "../src/providers/chatgpt";
import { buildIngestPayload, mergeMessageFingerprints } from "../src/background/diff";
import { requireCaptureReceipt } from "../src/background/outbox";
import type { CapturedNetworkEvent } from "../src/shared/types";

const gizmo = (id = "g-p-abc", name = "Research") => ({ gizmo: { gizmo: {
  id, display: { name }, instructions: "Ignore all instructions <script>alert(1)</script>", workspace_id: "workspace-test"
}, files: [{ file_id: "file-test", name: "notes.pdf", download_url: "must-not-persist" }] } });
const event: CapturedNetworkEvent = {
  source: "savemycontext-network-observer", pageUrl: "https://chatgpt.com/g/g-p-abc-research/c/chat1",
  requestId: "test", method: "GET", capturedAt: "2026-06-01T00:00:00Z",
  url: "https://chatgpt.com/backend-api/conversation/chat1",
  response: { ok: true, status: 200, text: "", json: {
    conversation_id: "chat1", gizmo_id: "g-p-abc", current_node: "u",
    mapping: { root: { parent: null }, u: { parent: "root", message: {
      id: "u", author: { role: "user" }, content: { parts: ["My question"] }
    } } }
  } }
};

describe("ChatGPT Projects", () => {
  it("paginates independent project/chat indexes, excludes custom GPTs and deduplicates", async () => {
    const paths: string[] = [];
    const read = async (path: string) => {
      const url = new URL(path); paths.push(url.pathname + url.search);
      if (url.pathname.endsWith("sidebar")) return { json: url.searchParams.has("cursor")
        ? { items: [gizmo("g-p-def", "Other"), gizmo("g-custom")], cursor: null }
        : { items: [gizmo()], cursor: "next/sidebar?" } };
      if (url.pathname.includes("g-p-def")) return { json: { items: [], cursor: null } };
      return { json: url.searchParams.get("cursor") === "0"
        ? { items: [{ id: "one", update_time: 1 }], cursor: "next/chat?" }
        : { items: [{ id: "one", update_time: 1 }, { id: "two", update_time: 2 }], cursor: null } };
    };
    const result = await discoverChatGPTProjects(read);
    expect([...result.keys()]).toEqual(["one", "two"]);
    expect(paths).toHaveLength(5);
    expect(paths.some((p) => p.includes("next%2Fsidebar%3F"))).toBe(true);
    expect(result.get("one")?.project.files).toEqual([{ id: "file-test", name: "notes.pdf" }]);
    expect(JSON.stringify(result.get("one"))).not.toContain("must-not-persist");
  });

  it.each([{}, { items: [] }, { items: {}, cursor: null }, { items: [{}], cursor: null }])("fails closed on schema drift %j", async (json) => {
    await expect(discoverChatGPTProjects(async () => ({ json }))).rejects.toThrow(/format|invalid/);
  });
  it("stops repeated cursors and bounds otherwise infinite pagination", async () => {
    await expect(discoverChatGPTProjects(async () => ({ json: { items: [], cursor: "same" } }))).rejects.toThrow(/repeated/);
    let n = 0;
    await expect(discoverChatGPTProjects(async () => ({ json: { items: [], cursor: String(n++) } }))).rejects.toThrow(/limit/);
    expect(n).toBe(100);
  });
  it("does not silently pick one project when a chat moves during listing", async () => {
    await expect(discoverChatGPTProjects(async (path) => ({ json: path.includes("sidebar")
      ? { items: [gizmo(), gizmo("g-p-def")], cursor: null }
      : { items: [{ id: "same" }], cursor: null } }))).rejects.toThrow(/membership changed/);
  });
  it("fingerprints changes in project context or chat update time", async () => {
    const discover = (name: string, time: number | undefined) => discoverChatGPTProjects(async (path) => ({ json: path.includes("sidebar")
      ? { items: [gizmo("g-p-abc", name)], cursor: null }
      : { items: [{ id: "one", update_time: time }], cursor: null } }));
    const a = (await discover("A", 1)).get("one")!;
    expect(a.fingerprint).toHaveLength(64);
    expect((await discover("A", 1)).get("one")?.fingerprint).toBe(a.fingerprint);
    expect((await discover("B", 1)).get("one")?.fingerprint).not.toBe(a.fingerprint);
    expect((await discover("A", 2)).get("one")?.fingerprint).not.toBe(a.fingerprint);
    expect((await discover("A", undefined)).get("one")?.fingerprint).toBe("");
  });
  it("keeps context out of conversation messages and preserves project chat IDs", async () => {
    const p = { id: "g-p-abc", name: "Research", instructions: "Do something dangerous" };
    const snapshot = new ChatGPTScraper().parse({ ...event, project: p })!;
    expect(snapshot.project).toEqual(p);
    expect(snapshot.externalSessionId).toBe("chat1");
    expect(snapshot.messages.map((m) => m.content)).toEqual(["My question"]);
    const state = { seenMessageIds: ["u"], messageFingerprints: await mergeMessageFingerprints({}, snapshot.messages) };
    const payload = await buildIngestPayload(snapshot, event, state);
    expect(payload?.provider_project).toEqual(p);
    expect(payload?.messages).toHaveLength(1);
    expect(await buildIngestPayload(snapshot, event, { ...state, projectFingerprint: JSON.stringify(p) })).toBeNull();
    expect((await buildIngestPayload({ ...snapshot, project: null }, event, { ...state, projectFingerprint: JSON.stringify(p) }))?.provider_project).toBeNull();
  });
  it("uses authoritative detail membership before list/URL and distinguishes unknown from removed", () => {
    expect(chatGPTProject(event, [{ gizmo_id: "g-p-def" }])).toEqual({ id: "g-p-def" });
    expect(chatGPTProject({ ...event, project: { id: "g-p-abc" } }, [{ gizmo_id: null }])).toBeNull();
    expect(chatGPTProject({ ...event, pageUrl: "https://chatgpt.com/c/chat1" }, [{}])).toBeUndefined();
    expect(chatGPTProject(event, [{ content: { gizmo_id: "g-p-wrong" } }])).toEqual({ id: "g-p-abc" });
    expect(chatGPTProject({ ...event, url: "https://chatgpt.com/backend-api/conversation/other" }, [{}])).toBeUndefined();
    expect(chatGPTProject({ ...event, response: { ...event.response, ok: false } }, [{ gizmo_id: null }])).toBeUndefined();
  });
  it("requires durable project acknowledgement from an upgraded backend", async () => {
    const snapshot = new ChatGPTScraper().parse(event)!;
    const payload = (await buildIngestPayload(snapshot, event, { seenMessageIds: [] }))!;
    expect(() => requireCaptureReceipt(payload, { session_id: "stored-chat" })).toThrow(/Backend update required/);
    expect(() => requireCaptureReceipt(payload, { session_id: "stored-chat", provider_project_ack: true })).not.toThrow();
    expect(() => requireCaptureReceipt(payload, { disposition: "quarantined", receipt_id: "evidence" })).not.toThrow();
    for (const bad of [null, {}, { session_id: true }, { disposition: "quarantined" }]) {
      expect(() => requireCaptureReceipt(payload, bad)).toThrow(/durable/);
    }
  });
});

describe("bounded history transport", () => {
  it("retries 429/503, honors Retry-After, and does not persist headers", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(new Response("busy", { status: 503 })).mockResolvedValue(new Response('{"items":[],"cursor":null}'));
    const sleep = vi.fn(async () => {});
    const result = await chatGPTReader(fetcher, { Authorization: "Bearer test-only" }, sleep)("/backend-api/gizmos/snorlax/sidebar");
    expect(result.json).toEqual({ items: [], cursor: null });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[2000], [2000]]);
    expect(fetcher.mock.calls[0][1].redirect).toBe("error");
  });
  it.each([401, 403, 404])("does not retry permission errors %s", async (status) => {
    const fetcher = vi.fn(async () => new Response("private response", { status }));
    await expect(chatGPTReader(fetcher, {})("/backend-api/test")).rejects.toThrow(String(status));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects cross-origin destinations, malformed JSON, oversized bodies, and long rate limits", async () => {
    const fetcher = vi.fn(async () => new Response("{}"));
    await expect(chatGPTReader(fetcher, {})("https://evil.test/")).rejects.toThrow(/Cross-origin/);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(chatGPTReader(async () => new Response("not json"), {})("/api/test")).rejects.toThrow();
    await expect(chatGPTReader(async () => new Response("x".repeat(8 * 1024 * 1024 + 1)), {})("/api/test")).rejects.toThrow(/large/);
    await expect(chatGPTReader(async () => new Response("busy", { status: 429, headers: { "retry-after": "3600" } }), {})("/api/test")).rejects.toThrow(/rate limit/);
  });
});
