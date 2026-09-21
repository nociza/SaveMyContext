import { describe, expect, it } from "vitest";

import { buildIngestPayload, mergeSeenMessageIds, mergeMessageFingerprints } from "../src/background/diff";
import type { CapturedNetworkEvent, NormalizedSessionSnapshot } from "../src/shared/types";

const snapshot: NormalizedSessionSnapshot = {
  provider: "chatgpt",
  externalSessionId: "session-1",
  accountKey: "chatgpt:default",
  accountLabel: "ChatGPT account",
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
  source: "savemycontext-network-observer",
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
  it("only sends new or changed message content to the backend", async () => {
    const payload = await buildIngestPayload(snapshot, rawCapture, {
      seenMessageIds: ["m1"],
      messageFingerprints: await mergeMessageFingerprints({}, [snapshot.messages[0]!])
    });

    expect(payload?.sync_mode).toBe("incremental");
    expect(payload?.messages).toHaveLength(1);
    expect(payload?.messages[0]?.external_message_id).toBe("m2");
  });

  it("sends the full snapshot for proactive history captures", async () => {
    const payload = await buildIngestPayload(
      {
        ...snapshot
      },
      {
        ...rawCapture,
        captureMode: "full_snapshot",
        historySyncRunId: "history-run-1"
      },
      {
        seenMessageIds: ["m1", "m2"]
      }
    );

    expect(payload?.sync_mode).toBe("full_snapshot");
    expect(payload?.messages.map((message) => message.external_message_id)).toEqual(["m1", "m2"]);
  });

  it("merges seen ids without duplicates", () => {
    const merged = mergeSeenMessageIds(["m1"], snapshot.messages);
    expect(merged).toEqual(["m1", "m2"]);
  });

  it("resends edited IDs and upgrades legacy ID-only state", async () => {
    const state = { seenMessageIds: ["m1", "m2"], messageFingerprints: await mergeMessageFingerprints({}, snapshot.messages) };
    expect(await buildIngestPayload(snapshot, rawCapture, state)).toBeNull();
    const edited = { ...snapshot, messages: [{ ...snapshot.messages[0]!, content: "Edited" }] };
    expect((await buildIngestPayload(edited, rawCapture, state))?.messages[0]?.content).toBe("Edited");
    expect((await buildIngestPayload(snapshot, rawCapture, { seenMessageIds: state.seenMessageIds }))?.messages).toHaveLength(2);
  });
});
