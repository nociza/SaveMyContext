import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it("treats offline fetch as a provider-wide stop, not thousands of per-chat errors", async () => {
  vi.stubGlobal("window", { fetch: vi.fn(async () => { throw new TypeError("offline"); }) });
  const permission = await import("../src/injected/capture-permission");
  const { HistoryTransportError } = await import("../src/injected/history-errors");
  permission.setHistoryCaptureEnabled(true);
  await expect(permission.authorizedHistoryFetch("https://chatgpt.com/backend-api/test")).rejects.toBeInstanceOf(HistoryTransportError);
});

it("pause rejects immediately without provider requests or a rate-limit cooldown", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("window", { fetch: fetcher });
  const permission = await import("../src/injected/capture-permission");
  const { CaptureHandoffError } = await import("../src/injected/capture-receipts");
  await expect(permission.authorizedHistoryFetch("https://chatgpt.com/backend-api/test")).rejects.toBeInstanceOf(CaptureHandoffError);
  expect(fetcher).not.toHaveBeenCalled();
});
