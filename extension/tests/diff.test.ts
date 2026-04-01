import { describe, expect, it } from "vitest";

import { buildIngestPayload, mergeSeenMessageIds } from "../src/background/diff";
import type { CapturedNetworkEvent, NormalizedSessionSnapshot } from "../src/shared/types";

const snapshot: NormalizedSessionSnapshot = {
  provider: "chatgpt",
  externalSessionId: "session-1",
  title: "Example",
  sourceUrl: "https://chatgpt.com/c/session-1",
  capturedAt: "2026-03-30T10:00:00.000Z",
  messages: [
    {
      id: "m1",
      role: "user",
      content: "First"
    },
    {
      id: "m2",
      role: "assistant",
      content: "Second"
    }
  ]
};

const rawCapture: CapturedNetworkEvent = {
  source: "tsmc-network-observer",
  providerHint: "chatgpt",
  pageUrl: snapshot.sourceUrl,
  requestId: "req-1",
  method: "GET",
  url: "https://chatgpt.com/backend-api/conversation/session-1",
  capturedAt: snapshot.capturedAt,
  response: {
    status: 200,
    ok: true,
    text: ""
  }
};

describe("diff helpers", () => {
  it("only sends unseen messages to the backend", () => {
    const payload = buildIngestPayload(snapshot, rawCapture, {
      seenMessageIds: ["m1"]
    });

    expect(payload?.messages).toHaveLength(1);
    expect(payload?.messages[0]?.external_message_id).toBe("m2");
  });

  it("merges seen ids without duplicates", () => {
    const merged = mergeSeenMessageIds(["m1"], snapshot.messages);
    expect(merged).toEqual(["m1", "m2"]);
  });
});

