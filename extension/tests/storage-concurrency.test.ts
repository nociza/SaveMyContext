import { afterEach, expect, it, vi } from "vitest";
import { getStatus, setStatus, saveSessionSyncState, getAllSessionSyncStates,
  saveProviderHistorySyncState, getProviderHistorySyncState } from "../src/shared/storage";

afterEach(() => vi.unstubAllGlobals());

it("concurrent progress, backend validation and capture acknowledgements never erase each other", async () => {
  const data: Record<string, unknown> = {
    "savemycontext.status": { backendUrl: "http://localhost", autoSyncHistory: true }
  };
  const local = {
    get: async (key: string) => structuredClone({ [key]: data[key] }),
    set: async (values: object) => { await Promise.resolve(); Object.assign(data, structuredClone(values)); }
  };
  vi.stubGlobal("chrome", { storage: { local } });
  await Promise.all([
    setStatus({ lastSessionKey: "chatgpt:project-chat", lastSuccessAt: "now" }),
    setStatus({ historySyncLastResult: "success" }),
    setStatus({ backendVersion: "test" }),
    ...Array.from({ length: 20 }, (_, i) => setStatus({ historySyncProcessedCount: i }))
  ]);
  expect(await getStatus()).toMatchObject({ lastSessionKey: "chatgpt:project-chat", lastSuccessAt: "now",
    historySyncLastResult: "success", backendVersion: "test", historySyncProcessedCount: 19 });
  await Promise.all(Array.from({ length: 20 }, (_, i) => saveSessionSyncState(`chatgpt:${i}`, { seenMessageIds: [`m${i}`] })));
  expect(Object.keys(await getAllSessionSyncStates())).toHaveLength(20);
  await Promise.all([
    saveProviderHistorySyncState("chatgpt", { lastTopSessionId: "one" }),
    saveProviderHistorySyncState("gemini", { lastTopSessionId: "two" })
  ]);
  expect((await getProviderHistorySyncState("chatgpt")).lastTopSessionId).toBe("one");
  expect((await getProviderHistorySyncState("gemini")).lastTopSessionId).toBe("two");
});
