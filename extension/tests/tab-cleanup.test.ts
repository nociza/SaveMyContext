import { afterEach, expect, it, vi } from "vitest";
import { bestEffortTabCleanup } from "../src/background/tab-cleanup";

afterEach(() => vi.useRealTimers());

it.each([{ discarded: true }, { frozen: true }])("does not wake sleeping tabs: %o", async (tab) => {
  const cleanup = vi.fn();
  await bestEffortTabCleanup(tab, cleanup);
  expect(cleanup).not.toHaveBeenCalled();
});

it("releases the caller when a browser injection never settles", async () => {
  vi.useFakeTimers();
  const done = vi.fn();
  const pending = bestEffortTabCleanup({}, () => new Promise(() => {})).then(done);
  await vi.advanceTimersByTimeAsync(1_999);
  expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(done).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("clears the deadline after successful cleanup", async () => {
  vi.useFakeTimers();
  const cleanup = vi.fn().mockResolvedValue([]);
  await bestEffortTabCleanup({}, cleanup);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("handles a tab closing before or after the deadline", async () => {
  await expect(bestEffortTabCleanup({}, () => Promise.reject(new Error('closed')))).resolves.toBeUndefined();
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const pending = bestEffortTabCleanup({}, () => new Promise((_, fail) => { reject = fail; }));
  await vi.advanceTimersByTimeAsync(2_000);
  await pending;
  reject(new Error('closed later'));
  await Promise.resolve();
});
