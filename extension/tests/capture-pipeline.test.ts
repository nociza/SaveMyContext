import { describe, expect, it, vi } from "vitest";
import { drainCaptures, enqueueCapture, indexingAllowsCapture, type CaptureStore, type PendingCapture } from "../src/background/outbox";
import { defaultSettings } from "../src/shared/storage";
import { observeResponse, readBoundedResponse } from "../src/injected/response-observer";
import { flattenText, sortMessages } from "../src/providers/helpers";
import { ChatGPTScraper } from "../src/providers/chatgpt";
import type { BackendIngestPayload, CapturedNetworkEvent } from "../src/shared/types";

class MemoryStore implements CaptureStore {
  rows = new Map<string, PendingCapture>();
  async list() { return [...this.rows.values()].sort((a, b) => a.createdAt - b.createdAt); }
  async put(item: PendingCapture) { this.rows.set(item.id, item); }
  async remove(id: string) { this.rows.delete(id); }
}
const event: CapturedNetworkEvent = {
  source: "savemycontext-network-observer", pageUrl: "https://chatgpt.com/c/test", requestId: "test",
  method: "GET", url: "https://chatgpt.com/backend-api/conversation/test", capturedAt: "2026-06-01T00:00:00Z",
  response: { status: 200, ok: true, text: "" }
};
const payload: BackendIngestPayload = {
  provider: "chatgpt", external_session_id: "test", account_key: "chatgpt:default", account_label: "ChatGPT",
  capture_completeness: "partial", parser_version: "capture-v2", sync_mode: "incremental",
  source_url: event.pageUrl, captured_at: event.capturedAt, custom_tags: [], raw_capture: event,
  messages: [{ external_message_id: "u", role: "user", content: "A question" }]
};

describe("durable capture delivery", () => {
  it("checks trigger words against original context, not an answer-only delta", () => {
    const capture = { ...payload, messages: [{ external_message_id: "a", role: "assistant" as const, content: "An edited answer" }],
      raw_capture: { ...event, response: { ...event.response, json: { messages: [
        { id: "u", author: { role: "user" }, content: { parts: ["remember this project"] } },
        { id: "a", author: { role: "assistant" }, content: { parts: ["An edited answer"] } }
      ] } } }
    };
    const settings = { ...defaultSettings, indexingMode: "trigger_word" as const, triggerWords: ["remember"] };
    expect(indexingAllowsCapture(settings, capture)).toBe(true);
    expect(indexingAllowsCapture({ ...settings, triggerWords: ["unmatched"] }, capture)).toBe(false);
  });
  it("retains failed requests across a restarted drain and deduplicates retry", async () => {
    const store = new MemoryStore();
    await enqueueCapture(store, "https://original", payload);
    await enqueueCapture(store, "https://original", payload);
    const failure = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(drainCaptures(store, "https://original", failure)).rejects.toThrow("offline");
    expect(await store.list()).toHaveLength(1);
    const recovered = vi.fn().mockResolvedValue(undefined);
    expect(await drainCaptures(store, "https://original", recovered)).toBe(1);
    expect(await store.list()).toHaveLength(0);
  });
  it("never delivers private backlog to a changed destination", async () => {
    const store = new MemoryStore();
    await enqueueCapture(store, "https://original", payload);
    const send = vi.fn();
    expect(await drainCaptures(store, "https://new", send)).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(1);
  });
});

describe("nonblocking observer", () => {
  it("lets the application consume an unfinished stream immediately", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream({ start(value) { controller = value; } }));
    const accept = vi.fn();
    observeResponse(response, accept);
    controller.enqueue(new TextEncoder().encode("first"));
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    expect(accept).not.toHaveBeenCalled();
    controller.close();
    await vi.waitFor(() => expect(accept).toHaveBeenCalledWith("first"));
  });
  it("rejects oversized clones without cancelling the provider response", async () => {
    const response = new Response("too large");
    await expect(readBoundedResponse(response.clone(), 2)).rejects.toThrow("too large");
    expect(await response.text()).toBe("too large");
  });
  it("bounds streams that never terminate", async () => {
    await expect(readBoundedResponse(new Response(new ReadableStream()), 100, 5)).rejects.toThrow("timed out");
  });
});

describe("transcript integrity", () => {
  it("preserves code indentation and ignores arbitrary metadata", () => {
    expect(flattenText({ parts: ["One\n\n    code()\nTwo"] })).toBe("One\n\n    code()\nTwo");
    expect(flattenText({ id: "r_abc123", label: "model_editable_context" })).toBe("");
    expect(sortMessages([{ id: "z", role: "user", content: "q" }, { id: "a", role: "assistant", content: "a" }]).map(m => m.id)).toEqual(["z", "a"]);
  });
  it("refuses to flatten unselected ChatGPT branches", () => {
    const mapping = {
      u: { parent: null, message: { id: "u", author: { role: "user" }, content: { parts: ["Question"] } } },
      a: { parent: "u", message: { id: "a", author: { role: "assistant" }, content: { parts: ["Answer A"] } } },
      b: { parent: "u", message: { id: "b", author: { role: "assistant" }, content: { parts: ["Answer B"] } } }
    };
    const scraper = new ChatGPTScraper();
    expect(scraper.parse({ ...event, response: { ...event.response, json: { mapping } } })).toBeNull();
    const selected = scraper.parse({ ...event, response: { ...event.response, json: { mapping, current_node: "b" } } });
    expect(selected?.messages.map(m => m.id)).toEqual(["u", "b"]);
    expect(selected?.completeness).toBe("complete");
  });
});
