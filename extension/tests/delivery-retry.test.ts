import { afterEach, expect, it, vi } from "vitest";
import { ensureDeliveryRetry, retryDelayMinutes, scheduleDeliveryRetry } from "../src/background/delivery-retry";
afterEach(() => vi.unstubAllGlobals());
it("backs off within a bounded jitter window", () => {
  expect(retryDelayMinutes(0, 1)).toBe(1);
  expect(retryDelayMinutes(3, 1)).toBe(8);
  expect(retryDelayMinutes(99, 0)).toBe(54);
  expect(retryDelayMinutes(99, 1)).toBe(60);
});
it("never keeps an empty or paused queue awake, and never postpones an armed retry", async () => {
  const create = vi.fn(), clear = vi.fn(), remove = vi.fn();
  vi.stubGlobal("chrome", { alarms: { create, clear, get: async () => ({ name: "existing" }) }, storage: { local: { remove } } });
  await scheduleDeliveryRetry(0, false); await scheduleDeliveryRetry(3, true); await ensureDeliveryRetry();
  expect(clear).toHaveBeenCalledTimes(2); expect(remove).toHaveBeenCalledTimes(2);
  expect(create).not.toHaveBeenCalled();
});
