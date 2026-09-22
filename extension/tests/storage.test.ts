import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StorageState = Record<string, unknown>;

function createStorageArea(initial: StorageState = {}) {
  const state: StorageState = { ...initial };

  return {
    state,
    get: vi.fn(async (keys?: string | string[] | Record<string, unknown>) => {
      if (typeof keys === "string") {
        return { [keys]: state[keys] };
      }

      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, state[key]]));
      }

      if (keys && typeof keys === "object") {
        return Object.fromEntries(Object.keys(keys).map((key) => [key, state[key] ?? keys[key]]));
      }

      return { ...state };
    }),
    set: vi.fn(async (items: StorageState) => {
      Object.assign(state, items);
    })
  };
}

describe("storage", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not write to chrome.storage.sync when reading settings", async () => {
    const sync = createStorageArea();
    const local = createStorageArea({
      "savemycontext.settings.secrets": {
        backendToken: "secret-token"
      }
    });
    vi.stubGlobal("chrome", {
      storage: {
        sync,
        local
      }
    });

    const { defaultSettings, getSettings } = await import("../src/shared/storage");
    const settings = await getSettings();

    expect(settings).toEqual({
      ...defaultSettings,
      backendToken: "secret-token"
    });
    expect(sync.get).toHaveBeenCalledOnce();
    expect(sync.set).not.toHaveBeenCalled();
  });

  it("prefers the local settings cache for live reads when sync is stale", async () => {
    const sync = createStorageArea({
      "savemycontext.settings": {
        backendUrl: "http://127.0.0.1:18888",
        enabledProviders: {
          chatgpt: true,
          gemini: true,
          grok: true
        },
        autoSyncHistory: true,
        scheduledProviderRefreshEnabled: false,
        scheduledProviderRefreshIntervalMinutes: 60,
        indexingMode: "all",
        triggerWords: ["lorem"],
        blacklistWords: [],
        discardWordsEnabled: true,
        discardWords: ["loom"],
        selectionCaptureEnabled: false,
        contextSuggestionsEnabled: false,
        contextSuggestionsFloatingButtonEnabled: true,
        pageSurfaceScope: "ai_providers",
        accountCaptureMode: "all",
        enabledAccountKeys: {}
      }
    });
    const local = createStorageArea({
      "savemycontext.settings.cache": {
        backendUrl: "http://127.0.0.1:9999",
        enabledProviders: {
          chatgpt: true,
          gemini: true,
          grok: true
        },
        autoSyncHistory: false,
        indexingMode: "trigger_word",
        triggerWords: ["lorem", "alpha"],
        blacklistWords: ["ignore"],
        discardWordsEnabled: true,
        discardWords: [],
        selectionCaptureEnabled: true,
        contextSuggestionsEnabled: true,
        contextSuggestionsFloatingButtonEnabled: false,
        pageSurfaceScope: "all_pages"
      },
      "savemycontext.settings.secrets": {
        backendToken: "secret-token"
      }
    });
    vi.stubGlobal("chrome", {
      storage: {
        sync,
        local
      }
    });

    const { getSettings } = await import("../src/shared/storage");
    const settings = await getSettings();

    expect(settings.backendUrl).toBe("http://127.0.0.1:9999");
    expect(settings.autoSyncHistory).toBe(false);
    expect(settings.backendToken).toBe("secret-token");
    expect(settings.indexingMode).toBe("trigger_word");
    expect(settings.triggerWords).toEqual(["lorem", "alpha"]);
    expect(settings.blacklistWords).toEqual(["ignore"]);
    expect(settings.pageSurfaceScope).toBe("all_pages");
  });

  it("persists merged defaults once during initialization when settings are incomplete", async () => {
    const sync = createStorageArea({
      "savemycontext.settings": {
        backendUrl: "http://127.0.0.1:9000"
      }
    });
    const local = createStorageArea();
    vi.stubGlobal("chrome", {
      storage: {
        sync,
        local
      }
    });

    const { initializeStorage } = await import("../src/shared/storage");
    await initializeStorage();

    expect(sync.set).toHaveBeenCalledTimes(1);
    expect(sync.set).toHaveBeenCalledWith({
      "savemycontext.settings": {
        workspaceUrl: "",
        capturePaused: false,
        backendUrl: "http://127.0.0.1:9000",
        enabledProviders: {
          chatgpt: true,
          gemini: true,
          grok: true
        },
        autoSyncHistory: false,
        scheduledProviderRefreshEnabled: false,
        scheduledProviderRefreshIntervalMinutes: 60,
        indexingMode: "all",
        triggerWords: [],
        blacklistWords: [],
        discardWordsEnabled: false,
        discardWords: [],
        selectionCaptureEnabled: false,
        contextSuggestionsEnabled: false,
        contextSuggestionsFloatingButtonEnabled: true,
        pageSurfaceScope: "ai_providers",
        accountCaptureMode: "all",
        enabledAccountKeys: {}
      }
    });
    expect(local.set).toHaveBeenCalledWith({
      "savemycontext.settings.cache": {
        workspaceUrl: "",
        capturePaused: false,
        backendUrl: "http://127.0.0.1:9000",
        enabledProviders: {
          chatgpt: true,
          gemini: true,
          grok: true
        },
        autoSyncHistory: false,
        scheduledProviderRefreshEnabled: false,
        scheduledProviderRefreshIntervalMinutes: 60,
        indexingMode: "all",
        triggerWords: [],
        blacklistWords: [],
        discardWordsEnabled: false,
        discardWords: [],
        selectionCaptureEnabled: false,
        contextSuggestionsEnabled: false,
        contextSuggestionsFloatingButtonEnabled: true,
        pageSurfaceScope: "ai_providers",
        accountCaptureMode: "all",
        enabledAccountKeys: {}
      }
    });
  });

  it("persists pause and workspace settings without syncing the API token or resetting existing preferences", async () => {
    const sync = createStorageArea();
    const local = createStorageArea();
    vi.stubGlobal("chrome", { storage: { sync, local } });
    const { saveSettings, getSettings, initializeStorage, acceptCaptureConsent } = await import("../src/shared/storage");
    await saveSettings({ autoSyncHistory: true, triggerWords: ["custom"], backendToken: "private-secret" });
    await saveSettings({ capturePaused: true, workspaceUrl: "https://dashboard.example/memory" });
    await initializeStorage();
    expect(await getSettings()).toMatchObject({ capturePaused: true, workspaceUrl: "https://dashboard.example/memory", autoSyncHistory: true, triggerWords: ["custom"], backendToken: "private-secret" });
    expect(JSON.stringify(sync.state)).not.toContain("private-secret");
    await acceptCaptureConsent((await getSettings()).backendUrl);
    await Promise.all([saveSettings({ capturePaused: false }), saveSettings({ workspaceUrl: "https://updated.example/memory" })]);
    expect(await getSettings()).toMatchObject({ capturePaused: false, workspaceUrl: "https://updated.example/memory" });
  });

  it("requires local destination-bound consent even when synced settings claim otherwise", async () => {
    const sync = createStorageArea({ "savemycontext.settings": { capturePaused: false, captureConsentGranted: true } });
    const local = createStorageArea();
    vi.stubGlobal("chrome", { storage: { sync, local } });
    const { getSettings, saveSettings, acceptCaptureConsent } = await import("../src/shared/storage");
    expect(await getSettings()).toMatchObject({ capturePaused: true, captureConsentGranted: false });
    await acceptCaptureConsent((await getSettings()).backendUrl);
    expect(await getSettings()).toMatchObject({ capturePaused: false, captureConsentGranted: true });
    expect(JSON.stringify(sync.state)).not.toContain("acceptedAt");
    await saveSettings({ backendUrl: "https://other.example", capturePaused: false, captureConsentGranted: true });
    expect(await getSettings()).toMatchObject({ capturePaused: true, captureConsentGranted: false });
    await expect(acceptCaptureConsent("http://127.0.0.1:18888")).rejects.toThrow("Destination changed");
    await acceptCaptureConsent("https://other.example");
    expect((await getSettings()).capturePaused).toBe(false);
  });

  it("creates and caches an installation id in local storage", async () => {
    const sync = createStorageArea();
    const local = createStorageArea();
    vi.stubGlobal("chrome", {
      storage: {
        sync,
        local
      }
    });
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => "install-123")
    });

    const { getInstallationId } = await import("../src/shared/storage");
    const first = await getInstallationId();
    const second = await getInstallationId();

    expect(first).toBe("install-123");
    expect(second).toBe("install-123");
    expect(local.set).toHaveBeenCalledTimes(1);
    expect(local.set).toHaveBeenCalledWith({
      "savemycontext.installation-id": "install-123"
    });
  });
});
