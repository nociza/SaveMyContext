import { describe, expect, it } from "vitest";

import { countRetryableHistoryFailures, runWithConcurrency, historyMetadataReceipt, hasHistoryReceipt } from "../src/injected/history-shared";

describe("history shared helpers", () => {
  it("reconciles scoped metadata, including titles, revisions and archive flags, without storing raw rows", async () => {
    const original = { conversationId: "same", title: "Old", modifyTime: "1", archived: false };
    const receipt = await historyMetadataReceipt("grok", "same", original);
    expect(hasHistoryReceipt(receipt, await historyMetadataReceipt("grok", "same", { ...original }))).toBe(true);
    for (const change of [{ title: "New" }, { modifyTime: "2" }, { archived: true }]) {
      expect(hasHistoryReceipt(receipt, await historyMetadataReceipt("grok", "same", { ...original, ...change }))).toBe(false);
    }
    expect(hasHistoryReceipt(receipt, await historyMetadataReceipt("gemini", "u1__same", original))).toBe(false);
    expect(Object.values(receipt)[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(await historyMetadataReceipt("grok", "same", { b: 2, a: 1 })).toEqual(await historyMetadataReceipt("grok", "same", { a: 1, b: 2 }));
  });
  it("counts pending conversations that did not produce a synced capture", () => {
    expect(countRetryableHistoryFailures(5, 5)).toBe(0);
    expect(countRetryableHistoryFailures(5, 3)).toBe(2);
  });

  it("does not return negative retryable counts", () => {
    expect(countRetryableHistoryFailures(2, 3)).toBe(0);
  });
  it("stops scheduling on backpressure and joins active workers before rejecting", async () => {
    const started: number[] = [];
    let finished = false;
    await expect(runWithConcurrency([0, 1, 2, 3, 4], 2, async id => {
      started.push(id);
      if (id === 0) throw new Error("storage full");
      await new Promise(resolve => setTimeout(resolve, 10));
      finished = true;
    })).rejects.toThrow("storage full");
    expect(started).toEqual([0, 1]);
    expect(finished).toBe(true);
  });
});
