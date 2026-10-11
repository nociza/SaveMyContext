import { afterEach, expect, it, vi } from "vitest";
import { waitForTabComplete } from "../src/background/tab-ready";

function fixture(get: () => Promise<unknown>) {
  const updated = new Set<Function>(), removed = new Set<Function>();
  const event = (set: Set<Function>) => ({ addListener: (f: Function) => set.add(f), removeListener: (f: Function) => set.delete(f) });
  vi.stubGlobal("chrome", { tabs: { get, onUpdated: event(updated), onRemoved: event(removed) } });
  return { updated, removed };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("handles completion during the status read without leaking listeners", async () => {
  const f = fixture(async () => {
    for (const listener of f.updated) listener(1, { status: "complete" });
    return { status: "loading" };
  });
  await waitForTabComplete(1);
  expect(f.updated.size + f.removed.size).toBe(0);
});
it("bounds never-finishing loads and cleans up a closed tab", async () => {
  vi.useFakeTimers();
  const f = fixture(async () => ({ status: "loading" }));
  const timed = expect(waitForTabComplete(1, 50)).rejects.toThrow("finish loading");
  await vi.advanceTimersByTimeAsync(50); await timed;
  expect(f.updated.size + f.removed.size).toBe(0);
  const closed = expect(waitForTabComplete(1)).rejects.toThrow("closed");
  for (const listener of f.removed) listener(1);
  await closed;
  expect(f.updated.size + f.removed.size).toBe(0);
});
