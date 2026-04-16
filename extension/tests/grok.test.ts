import { describe, expect, it } from "vitest";

import { GrokScraper } from "../src/providers/grok";
import type { CapturedNetworkEvent } from "../src/shared/types";

describe("GrokScraper", () => {
  it("parses proactive history sync payloads with explicit messages", () => {
    const scraper = new GrokScraper();

    const event: CapturedNetworkEvent = {
      source: "savemycontext-network-observer",
      providerHint: "grok",
      pageUrl: "https://grok.com/c/grok-e2e-session",
      requestId: "req-grok-history-1",
      method: "GET",
      url: "https://grok.com/rest/app-chat/conversations/grok-e2e-session/responses?includeThreads=true",
      capturedAt: "2026-04-01T12:00:00.000Z",
      response: {
        status: 200,
        ok: true,
        contentType: "application/json",
        text: JSON.stringify({
          conversationId: "grok-e2e-session",
          title: "Grok E2E Sync",
          messages: [
            {
              id: "grok-user-1",
              role: "user",
              content: "Explain proactive Grok history sync.",
              occurredAt: "2026-04-01T11:59:00.000Z"
            },
            {
              id: "grok-assistant-1",
              parentId: "grok-user-1",
              role: "assistant",
              content: "It backfills Grok conversations from the website history routes.",
              occurredAt: "2026-04-01T11:59:05.000Z"
            }
          ]
        }),
        json: {
          conversationId: "grok-e2e-session",
          title: "Grok E2E Sync",
          messages: [
            {
              id: "grok-user-1",
              role: "user",
              content: "Explain proactive Grok history sync.",
              occurredAt: "2026-04-01T11:59:00.000Z"
            },
            {
              id: "grok-assistant-1",
              parentId: "grok-user-1",
              role: "assistant",
              content: "It backfills Grok conversations from the website history routes.",
              occurredAt: "2026-04-01T11:59:05.000Z"
            }
          ]
        }
      }
    };

    const snapshot = scraper.parse(event);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.externalSessionId).toBe("grok-e2e-session");
    expect(snapshot?.title).toBe("Grok E2E Sync");
    expect(snapshot?.messages.map((message) => message.id)).toEqual(["grok-user-1", "grok-assistant-1"]);
    expect(snapshot?.messages.map((message) => message.content)).toEqual([
      "Explain proactive Grok history sync.",
      "It backfills Grok conversations from the website history routes."
    ]);
    expect(snapshot?.messages[1]?.parentId).toBe("grok-user-1");
  });

  it("parses current Grok responses arrays", () => {
    const scraper = new GrokScraper();
    const event: CapturedNetworkEvent = {
      source: "savemycontext-network-observer",
      providerHint: "grok",
      pageUrl: "https://grok.com/c/grok-current-session",
      requestId: "req-grok-current-1",
      method: "GET",
      url: "https://grok.com/rest/app-chat/conversations/grok-current-session/responses?includeThreads=true",
      capturedAt: "2026-04-16T18:00:00.000Z",
      response: {
        status: 200,
        ok: true,
        contentType: "application/json",
        text: JSON.stringify({
          responses: [
            {
              responseId: "grok-user-current",
              sender: "USER",
              query: "What changed in the Grok history API?",
              createTime: "2026-04-16T17:59:00.000Z"
            },
            {
              responseId: "grok-assistant-current",
              sender: "ASSISTANT",
              message: "The history list returns conversations, while message details live under responses.",
              parentResponseId: "grok-user-current",
              createTime: "2026-04-16T17:59:03.000Z"
            }
          ]
        }),
        json: {
          responses: [
            {
              responseId: "grok-user-current",
              sender: "USER",
              query: "What changed in the Grok history API?",
              createTime: "2026-04-16T17:59:00.000Z"
            },
            {
              responseId: "grok-assistant-current",
              sender: "ASSISTANT",
              message: "The history list returns conversations, while message details live under responses.",
              parentResponseId: "grok-user-current",
              createTime: "2026-04-16T17:59:03.000Z"
            }
          ]
        }
      }
    };

    expect(scraper.matches(event)).toBe(true);

    const snapshot = scraper.parse(event);

    expect(snapshot?.externalSessionId).toBe("grok-current-session");
    expect(snapshot?.messages.map((message) => message.id)).toEqual(["grok-user-current", "grok-assistant-current"]);
    expect(snapshot?.messages.map((message) => message.content)).toEqual([
      "What changed in the Grok history API?",
      "The history list returns conversations, while message details live under responses."
    ]);
    expect(snapshot?.messages[1]?.parentId).toBe("grok-user-current");
  });

  it("does not treat Grok history list payloads as chat sessions", () => {
    const scraper = new GrokScraper();
    const event: CapturedNetworkEvent = {
      source: "savemycontext-network-observer",
      providerHint: "grok",
      pageUrl: "https://grok.com/",
      requestId: "req-grok-list-1",
      method: "GET",
      url: "https://grok.com/rest/app-chat/conversations?pageSize=60",
      capturedAt: "2026-04-16T18:00:00.000Z",
      response: {
        status: 200,
        ok: true,
        contentType: "application/json",
        text: JSON.stringify({
          conversations: [
            {
              conversationId: "grok-list-session",
              title: "A listed conversation"
            }
          ]
        }),
        json: {
          conversations: [
            {
              conversationId: "grok-list-session",
              title: "A listed conversation"
            }
          ]
        }
      }
    };

    expect(scraper.matches(event)).toBe(false);
    expect(scraper.parse(event)).toBeNull();
  });

  it("does not treat X traffic as Grok traffic", () => {
    const scraper = new GrokScraper();
    const event: CapturedNetworkEvent = {
      source: "savemycontext-network-observer",
      providerHint: "grok",
      pageUrl: "https://x.com/home",
      requestId: "req-x-timeline-1",
      method: "GET",
      url: "https://x.com/i/api/graphql/Yf4WJo0fW46TnqrHUw_1Ow/HomeTimeline",
      capturedAt: "2026-04-16T18:00:00.000Z",
      response: {
        status: 200,
        ok: true,
        contentType: "application/json",
        text: JSON.stringify({
          data: {
            home: {
              timeline: "not a Grok chat"
            }
          }
        }),
        json: {
          data: {
            home: {
              timeline: "not a Grok chat"
            }
          }
        }
      }
    };

    expect(scraper.matches(event)).toBe(false);
    expect(scraper.parse(event)).toBeNull();
  });
});
