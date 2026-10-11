import { afterEach, expect, it, vi } from "vitest";
import { CaptureReceipts } from "../src/injected/capture-receipts";
afterEach(() => vi.useRealTimers());
it("waits for storage acknowledgement and rejects failure, pause, and capacity overflow", async () => {
  const receipts = new CaptureReceipts(100, 1);
  const first = receipts.wait("one", () => {});
  await expect(receipts.wait("two", () => {})).rejects.toThrow("busy");
  receipts.acknowledge("unknown", true);
  receipts.acknowledge("one", true);
  await first;
  const failed = expect(receipts.wait("two", () => {})).rejects.toThrow("persisted");
  receipts.acknowledge("two", false); await failed;
  const paused = expect(receipts.wait("three", () => {})).rejects.toThrow("paused");
  receipts.cancel(); await paused;
});
it("times out a lost handoff and permits a retry", async () => {
  vi.useFakeTimers();
  const receipts = new CaptureReceipts(100);
  const timed = expect(receipts.wait("one", () => {})).rejects.toThrow("not acknowledged");
  await vi.advanceTimersByTimeAsync(100); await timed;
  await receipts.wait("one", () => receipts.acknowledge("one", true));
});
