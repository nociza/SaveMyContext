import { describe, expect, it } from "vitest";
import { extractStructuredCandidates } from "../src/providers/helpers";
import { ChatGPTScraper } from "../src/providers/chatgpt";
import { GeminiScraper } from "../src/providers/gemini";
import { GrokScraper } from "../src/providers/grok";
import type { CapturedNetworkEvent } from "../src/shared/types";

describe("single-representation provider evidence", () => {
  const payload = { conversation_id: "memory-test", conversationId: "memory-test", title: "Exact evidence", messages: [
    { id: "u", role: "user", content: "Question 🌱\n\n    code()", occurredAt: "2026-10-10T00:00:00Z" },
    { id: "a", role: "assistant", content: "Answer 漢字", occurredAt: "2026-10-10T00:00:01Z" }
  ], providerEvidence: { untouched: ["raw", 0, false, null] } };
  it.each([undefined, 2])("parses a complete JSON document only once (indentation %s)", indent => {
    expect(extractStructuredCandidates(JSON.stringify(payload, null, indent))).toEqual([payload]);
  });
  it("preserves SSE, NDJSON and batchexecute framing", () => {
    const a = { token: "a" }, b = { token: "b" };
    expect(extractStructuredCandidates(`data: ${JSON.stringify(a)}\r\n\r\ndata: ${JSON.stringify(b)}\ndata: [DONE]`)).toEqual([a, b]);
    expect(extractStructuredCandidates(`${JSON.stringify(a)}\n${JSON.stringify(b)}`)).toEqual([a, b]);
    expect(extractStructuredCandidates(`)]}'\n42\n${JSON.stringify([a, b])}`)).toEqual([[a, b]]);
  });
  it.each([
    [new ChatGPTScraper(), "https://chatgpt.com/c/memory-test", "https://chatgpt.com/backend-api/conversation/memory-test"],
    [new GeminiScraper(), "https://gemini.google.com/app/memory-test", "https://gemini.google.com/_/BardChatUi/data/batchexecute"],
    [new GrokScraper(), "https://grok.com/c/memory-test", "https://grok.com/rest/app-chat/conversations/memory-test/responses"]
  ] as const)("keeps legacy and text-only snapshots equivalent for %s", (scraper, pageUrl, url) => {
    const event: CapturedNetworkEvent = { source: "savemycontext-network-observer", pageUrl, url, requestId: "memory", method: "GET", capturedAt: "2026-10-10T00:00:02Z",
      response: { status: 200, ok: true, text: JSON.stringify(payload) } };
    const textOnly = scraper.parse(event);
    expect(textOnly?.messages.map(m => m.content)).toEqual(payload.messages.map(m => m.content));
    expect(textOnly).toEqual(scraper.parse({ ...event, response: { ...event.response, json: payload } }));
    expect(JSON.parse(event.response.text).providerEvidence).toEqual(payload.providerEvidence);
  });
});
