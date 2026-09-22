import { afterEach, describe, expect, it, vi } from "vitest";
import { validateWorkspaceUrl, workspaceUrl } from "../src/shared/workspace-link";
import { defaultSettings } from "../src/shared/storage";

afterEach(() => vi.unstubAllGlobals());
describe("workspace launcher", () => {
  it("uses the shared component by default and limits the requested view", () => {
    vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => `chrome-extension://fixture/${path}` } });
    expect(workspaceUrl(defaultSettings, "tasks")).toBe("chrome-extension://fixture/workspace.html?view=tasks");
    expect(workspaceUrl(defaultSettings, "arbitrary")).toBe("chrome-extension://fixture/workspace.html?view=memory");
  });
  it("never adds backend credentials to an external workspace link", () => {
    expect(workspaceUrl({ ...defaultSettings, backendToken: "private-token", workspaceUrl: "https://dashboard.example/memory" }))
      .toBe("https://dashboard.example/memory");
  });
  it.each(["javascript:alert(1)", "http://remote.example/", "https://user:secret@example.com", "https://example.com/?token=secret", "https://example.com/#token", "chrome-extension://other/workspace.html"])("rejects unsafe URL %s", url => {
    expect(() => validateWorkspaceUrl(url)).toThrow();
  });
  it("allows local standalone workspaces and empty fallback", () => {
    expect(validateWorkspaceUrl(" http://127.0.0.1:18888/workspace ")).toBe("http://127.0.0.1:18888/workspace");
    expect(validateWorkspaceUrl(" ")).toBe("");
  });
  it("does not import all history or apply arbitrary word filters on a new installation", () => {
    expect(defaultSettings.autoSyncHistory).toBe(false);
    expect(defaultSettings.capturePaused).toBe(true);
    expect(defaultSettings.triggerWords).toEqual([]);
    expect(defaultSettings.discardWordsEnabled).toBe(false);
  });
});
