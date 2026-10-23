import { describe, expect, it } from "vitest";

import { countRetryableHistoryFailures, runWithConcurrency } from "../src/injected/history-shared";

describe("history shared helpers", () => {
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
