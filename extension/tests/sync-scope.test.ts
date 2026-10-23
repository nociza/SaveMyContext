import { describe, expect, it } from "vitest";
import { SyncOperations, isCurrentHistoryRun, mayAdvanceSyncState, syncStateAtDestination } from "../src/shared/sync-scope";
import type { SessionSyncState } from "../src/shared/types";

describe("sync lifecycle invariants", () => {
  it("never reuses legacy or other-database receipts, including a switch back", () => {
    const state = { destination: "https://one", seenMessageIds: ["m"], lastTitle: "Saved", historyFingerprints: { chat: "ack" } };
    expect(syncStateAtDestination(state, "https://one")).toBe(state);
    expect(syncStateAtDestination(state, "https://two")).toEqual({ seenMessageIds: [] });
    expect(syncStateAtDestination({ ...state, destination: undefined }, "https://one")).toEqual({ seenMessageIds: [] });
    expect(syncStateAtDestination({ ...state, destination: "https://two" }, "https://one")).toEqual({ seenMessageIds: [] });
  });

  it("rejects stale/foreign/unsolicited run messages and captures", () => {
    const state = { activeRunId: "new-run", destination: "https://one" };
    expect(isCurrentHistoryRun(state, "new-run", "https://one")).toBe(true);
    expect(isCurrentHistoryRun(state, "old-run", "https://one")).toBe(false);
    expect(isCurrentHistoryRun(state, "new-run", "https://two")).toBe(false);
    expect(isCurrentHistoryRun(state, undefined, "https://one")).toBe(false);
    expect(isCurrentHistoryRun({ ...state, activeRunId: undefined }, "new-run", "https://one")).toBe(false);
  });

  it("does not rewind durable metadata under shuffled and duplicate acknowledgements", () => {
    // Deterministic property-style test over many delivery orders, no random flakiness.
    for (let seed = 1; seed <= 100; seed++) {
      let random = seed;
      const captures = Array.from({ length: 40 }, (_, n) => n % 20);
      for (let i = captures.length - 1; i > 0; i--) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const j = random % (i + 1);
        [captures[i], captures[j]] = [captures[j], captures[i]];
      }
      let state: SessionSyncState = { seenMessageIds: [] };
      for (const revision of captures) {
        const capturedAt = new Date(1_000 + revision).toISOString();
        if (mayAdvanceSyncState(state, capturedAt)) state = { ...state, lastCapturedAt: capturedAt, lastTitle: String(revision) };
      }
      expect(state.lastTitle).toBe("19");
      expect(mayAdvanceSyncState(state, "not-a-date")).toBe(false);
      expect(mayAdvanceSyncState({ ...state, lastCapturedAt: "corrupt-local-time" }, "2026-01-01")).toBe(true);
    }
  });

  it("serializes same-provider transitions, lets others progress, and recovers after a failure", async () => {
    const operations = new SyncOperations(), order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = operations.run("chatgpt", async () => { order.push("start"); await gate; throw new Error("interrupted"); });
    const failed = expect(first).rejects.toThrow("interrupted");
    const second = operations.run("chatgpt", async () => { order.push("finish"); });
    await operations.run("gemini", async () => { order.push("other"); });
    expect(order).toEqual(["start", "other"]);
    release(); await failed; await second;
    expect(order).toEqual(["start", "other", "finish"]);
  });
});
