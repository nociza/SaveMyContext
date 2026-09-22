import {
  DEFAULT_PAGE_SURFACE_SCOPE,
  normalizePageSurfaceScope
} from "./page-surfaces";
import {
  normalizeProviderRefreshIntervalMinutes,
  PROVIDER_REFRESH_DEFAULT_INTERVAL_MINUTES
} from "./provider-refresh";
import type {
  BackendCapabilities,
  BrowserProviderName,
  ExtensionSettings,
  ProviderHistorySyncState,
  ProviderName,
  SessionSyncState,
  SyncStatus
} from "./types";

const SETTINGS_KEY = "savemycontext.settings";
const SECRET_SETTINGS_KEY = "savemycontext.settings.secrets";
const SETTINGS_CACHE_KEY = "savemycontext.settings.cache";
const SYNC_STATE_KEY = "savemycontext.sync-state";
const STATUS_KEY = "savemycontext.status";
const HISTORY_SYNC_KEY = "savemycontext.history-sync";
const INSTALLATION_ID_KEY = "savemycontext.installation-id";
const CONSENT_KEY = "savemycontext.capture-consent";
const CONSENT_VERSION = 1;

export async function acceptCaptureConsent(backendUrl: string): Promise<void> {
  const current = await getSettings();
  if (current.backendUrl !== backendUrl) throw new Error("Destination changed. Review it before enabling capture.");
  await chrome.storage.local.set({ [CONSENT_KEY]: { version: CONSENT_VERSION, backendUrl, acceptedAt: new Date().toISOString() } });
  await saveSettings({ capturePaused: false });
}

const storageWrites = new Map<string, Promise<void>>();
async function lockedStorage<T>(key: string, operation: () => Promise<T>): Promise<T> {
  // Web Locks cover the worker and options UI; the queue covers test/older runtimes.
  if (typeof navigator !== "undefined" && navigator.locks) {
    return await navigator.locks.request(`smc-storage:${key}`, operation);
  }
  const result = (storageWrites.get(key) ?? Promise.resolve()).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  storageWrites.set(key, tail);
  void tail.then(() => { if (storageWrites.get(key) === tail) storageWrites.delete(key); });
  return result;
}

export const defaultSettings: ExtensionSettings = {
  workspaceUrl: "",
  capturePaused: true,
  captureConsentGranted: false,
  backendUrl: "http://127.0.0.1:18888",
  backendToken: "",
  enabledProviders: {
    chatgpt: true,
    gemini: true,
    grok: true
  },
  autoSyncHistory: false,
  scheduledProviderRefreshEnabled: false,
  scheduledProviderRefreshIntervalMinutes: PROVIDER_REFRESH_DEFAULT_INTERVAL_MINUTES,
  indexingMode: "all",
  triggerWords: [],
  blacklistWords: [],
  discardWordsEnabled: false,
  discardWords: [],
  selectionCaptureEnabled: false,
  contextSuggestionsEnabled: false,
  contextSuggestionsFloatingButtonEnabled: true,
  pageSurfaceScope: DEFAULT_PAGE_SURFACE_SCOPE,
  accountCaptureMode: "all",
  enabledAccountKeys: {}
};

function mergeSettings(
  current: Partial<ExtensionSettings>,
  secrets: Pick<ExtensionSettings, "backendToken">
): ExtensionSettings {
  return {
    backendUrl: current.backendUrl ?? defaultSettings.backendUrl,
    workspaceUrl: current.workspaceUrl ?? "",
    capturePaused: current.capturePaused ?? false,
    backendToken: secrets.backendToken ?? defaultSettings.backendToken,
    enabledProviders: {
      ...defaultSettings.enabledProviders,
      ...(current.enabledProviders ?? {})
    },
    autoSyncHistory: current.autoSyncHistory ?? defaultSettings.autoSyncHistory,
    scheduledProviderRefreshEnabled:
      current.scheduledProviderRefreshEnabled ?? defaultSettings.scheduledProviderRefreshEnabled,
    scheduledProviderRefreshIntervalMinutes: normalizeProviderRefreshIntervalMinutes(
      current.scheduledProviderRefreshIntervalMinutes ?? defaultSettings.scheduledProviderRefreshIntervalMinutes
    ),
    indexingMode: current.indexingMode ?? defaultSettings.indexingMode,
    triggerWords: current.triggerWords ?? defaultSettings.triggerWords,
    blacklistWords: current.blacklistWords ?? defaultSettings.blacklistWords,
    discardWordsEnabled: current.discardWordsEnabled ?? defaultSettings.discardWordsEnabled,
    discardWords: current.discardWords ?? defaultSettings.discardWords,
    selectionCaptureEnabled: current.selectionCaptureEnabled ?? defaultSettings.selectionCaptureEnabled,
    contextSuggestionsEnabled:
      current.contextSuggestionsEnabled ?? defaultSettings.contextSuggestionsEnabled,
    contextSuggestionsFloatingButtonEnabled:
      current.contextSuggestionsFloatingButtonEnabled ?? defaultSettings.contextSuggestionsFloatingButtonEnabled,
    pageSurfaceScope: normalizePageSurfaceScope(current.pageSurfaceScope),
    accountCaptureMode: current.accountCaptureMode ?? defaultSettings.accountCaptureMode,
    enabledAccountKeys: {
      ...(current.enabledAccountKeys ?? defaultSettings.enabledAccountKeys)
    }
  };
}

function shouldPersistSettings(current: Partial<ExtensionSettings>): boolean {
  if (
    !current.backendUrl ||
    current.autoSyncHistory === undefined ||
    current.scheduledProviderRefreshEnabled === undefined ||
    current.scheduledProviderRefreshIntervalMinutes === undefined ||
    !current.enabledProviders ||
    !current.indexingMode ||
    !current.triggerWords ||
    !current.blacklistWords ||
    current.discardWordsEnabled === undefined ||
    !current.discardWords ||
    current.selectionCaptureEnabled === undefined ||
    current.contextSuggestionsEnabled === undefined ||
    current.contextSuggestionsFloatingButtonEnabled === undefined ||
    current.pageSurfaceScope === undefined ||
    current.accountCaptureMode === undefined ||
    current.enabledAccountKeys === undefined
  ) {
    return true;
  }

  return (Object.keys(defaultSettings.enabledProviders) as BrowserProviderName[]).some(
    (provider) => current.enabledProviders?.[provider] === undefined
  );
}

function publicSettings(settings: ExtensionSettings | Partial<ExtensionSettings>) {
  return {
    workspaceUrl: settings.workspaceUrl ?? "",
    capturePaused: settings.capturePaused ?? false,
    backendUrl: settings.backendUrl ?? defaultSettings.backendUrl,
    enabledProviders: {
      ...defaultSettings.enabledProviders,
      ...(settings.enabledProviders ?? {})
    },
    autoSyncHistory: settings.autoSyncHistory ?? defaultSettings.autoSyncHistory,
    scheduledProviderRefreshEnabled:
      settings.scheduledProviderRefreshEnabled ?? defaultSettings.scheduledProviderRefreshEnabled,
    scheduledProviderRefreshIntervalMinutes: normalizeProviderRefreshIntervalMinutes(
      settings.scheduledProviderRefreshIntervalMinutes ?? defaultSettings.scheduledProviderRefreshIntervalMinutes
    ),
    indexingMode: settings.indexingMode ?? defaultSettings.indexingMode,
    triggerWords: settings.triggerWords ?? defaultSettings.triggerWords,
    blacklistWords: settings.blacklistWords ?? defaultSettings.blacklistWords,
    discardWordsEnabled: settings.discardWordsEnabled ?? defaultSettings.discardWordsEnabled,
    discardWords: settings.discardWords ?? defaultSettings.discardWords,
    selectionCaptureEnabled: settings.selectionCaptureEnabled ?? defaultSettings.selectionCaptureEnabled,
    contextSuggestionsEnabled:
      settings.contextSuggestionsEnabled ?? defaultSettings.contextSuggestionsEnabled,
    contextSuggestionsFloatingButtonEnabled:
      settings.contextSuggestionsFloatingButtonEnabled ?? defaultSettings.contextSuggestionsFloatingButtonEnabled,
    pageSurfaceScope: normalizePageSurfaceScope(settings.pageSurfaceScope),
    accountCaptureMode: settings.accountCaptureMode ?? defaultSettings.accountCaptureMode,
    enabledAccountKeys: {
      ...(settings.enabledAccountKeys ?? defaultSettings.enabledAccountKeys)
    }
  };
}

export async function initializeStorage(): Promise<void> {
  const [stored, local] = await Promise.all([
    chrome.storage.sync.get(SETTINGS_KEY),
    chrome.storage.local.get(SECRET_SETTINGS_KEY)
  ]);
  const current = (stored[SETTINGS_KEY] ?? {}) as Partial<ExtensionSettings>;
  if (shouldPersistSettings(current)) {
    await chrome.storage.sync.set({
      [SETTINGS_KEY]: publicSettings(current)
    });
  }
  const merged = mergeSettings(
    current,
    (local[SECRET_SETTINGS_KEY] ?? {}) as Pick<ExtensionSettings, "backendToken">
  );
  await chrome.storage.local.set({
    [SETTINGS_CACHE_KEY]: publicSettings(merged)
  });
  await getSettings();
  await getStatus();
}

export async function getSettings(): Promise<ExtensionSettings> {
  const [stored, local] = await Promise.all([
    chrome.storage.sync.get(SETTINGS_KEY),
    chrome.storage.local.get([SECRET_SETTINGS_KEY, SETTINGS_CACHE_KEY, CONSENT_KEY])
  ]);
  const current =
    ((local[SETTINGS_CACHE_KEY] ?? stored[SETTINGS_KEY] ?? {}) as Partial<ExtensionSettings>);
  const secretSettings = (local[SECRET_SETTINGS_KEY] ?? {}) as Pick<ExtensionSettings, "backendToken">;
  const settings = mergeSettings(current, secretSettings);
  const consent = local[CONSENT_KEY] as { version?: number; backendUrl?: string } | undefined;
  settings.captureConsentGranted = consent?.version === CONSENT_VERSION && consent?.backendUrl === settings.backendUrl;
  settings.capturePaused = !settings.captureConsentGranted || settings.capturePaused;
  return settings;
}

export async function saveSettings(update: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  return lockedStorage(SETTINGS_KEY, () => saveSettingsUnlocked(update));
}

async function saveSettingsUnlocked(update: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const current = await getSettings();
  const next: ExtensionSettings = {
    workspaceUrl: update.workspaceUrl ?? current.workspaceUrl ?? "",
    capturePaused: update.capturePaused ?? current.capturePaused ?? false,
    backendUrl: update.backendUrl ?? current.backendUrl,
    backendToken: update.backendToken ?? current.backendToken,
    enabledProviders: {
      ...current.enabledProviders,
      ...(update.enabledProviders ?? {})
    },
    autoSyncHistory: update.autoSyncHistory ?? current.autoSyncHistory,
    scheduledProviderRefreshEnabled:
      update.scheduledProviderRefreshEnabled ?? current.scheduledProviderRefreshEnabled,
    scheduledProviderRefreshIntervalMinutes: normalizeProviderRefreshIntervalMinutes(
      update.scheduledProviderRefreshIntervalMinutes ?? current.scheduledProviderRefreshIntervalMinutes
    ),
    indexingMode: update.indexingMode ?? current.indexingMode,
    triggerWords: update.triggerWords ?? current.triggerWords,
    blacklistWords: update.blacklistWords ?? current.blacklistWords,
    discardWordsEnabled: update.discardWordsEnabled ?? current.discardWordsEnabled,
    discardWords: update.discardWords ?? current.discardWords,
    selectionCaptureEnabled: update.selectionCaptureEnabled ?? current.selectionCaptureEnabled,
    contextSuggestionsEnabled: update.contextSuggestionsEnabled ?? current.contextSuggestionsEnabled,
    contextSuggestionsFloatingButtonEnabled:
      update.contextSuggestionsFloatingButtonEnabled ?? current.contextSuggestionsFloatingButtonEnabled,
    pageSurfaceScope: normalizePageSurfaceScope(update.pageSurfaceScope ?? current.pageSurfaceScope),
    accountCaptureMode: update.accountCaptureMode ?? current.accountCaptureMode,
    enabledAccountKeys: update.enabledAccountKeys ?? current.enabledAccountKeys
  };
  await chrome.storage.sync.set({
    [SETTINGS_KEY]: publicSettings(next)
  });
  await chrome.storage.local.set({
    [SETTINGS_CACHE_KEY]: publicSettings(next),
    [SECRET_SETTINGS_KEY]: {
      backendToken: next.backendToken ?? ""
    }
  });
  await setStatus({
    backendUrl: next.backendUrl,
    autoSyncHistory: next.autoSyncHistory
  });
  return getSettings();
}

export async function getInstallationId(): Promise<string> {
  const stored = await chrome.storage.local.get(INSTALLATION_ID_KEY);
  const current = stored[INSTALLATION_ID_KEY];
  if (typeof current === "string" && current.trim()) {
    return current;
  }
  const next = crypto.randomUUID();
  await chrome.storage.local.set({
    [INSTALLATION_ID_KEY]: next
  });
  return next;
}

export async function getSessionSyncState(sessionKey: string): Promise<SessionSyncState> {
  const allStates = await getAllSessionSyncStates();
  return allStates[sessionKey] ?? { seenMessageIds: [] };
}

export async function getAllSessionSyncStates(): Promise<Record<string, SessionSyncState>> {
  const stored = await chrome.storage.local.get(SYNC_STATE_KEY);
  return (stored[SYNC_STATE_KEY] ?? {}) as Record<string, SessionSyncState>;
}

export async function saveSessionSyncState(sessionKey: string, state: SessionSyncState): Promise<void> {
  await lockedStorage(SYNC_STATE_KEY, async () => {
    const allStates = await getAllSessionSyncStates();
    allStates[sessionKey] = state;
    await chrome.storage.local.set({ [SYNC_STATE_KEY]: allStates });
  });
}

export async function getProviderSessionSyncStates(
  provider: ProviderName
): Promise<Record<string, SessionSyncState>> {
  const prefix = `${provider}:`;
  const allStates = await getAllSessionSyncStates();
  return Object.fromEntries(Object.entries(allStates).filter(([sessionKey]) => sessionKey.startsWith(prefix)));
}

export async function getStatus(): Promise<SyncStatus> {
  const stored = await chrome.storage.local.get(STATUS_KEY);
  const current = (stored[STATUS_KEY] ?? {}) as SyncStatus;
  if (!current.backendUrl || current.autoSyncHistory === undefined) {
    const settings = await getSettings();
    current.backendUrl = settings.backendUrl;
    current.autoSyncHistory = settings.autoSyncHistory;
  }
  return current;
}

export async function setStatus(update: Partial<SyncStatus>): Promise<SyncStatus> {
  return lockedStorage(STATUS_KEY, async () => {
    const current = await getStatus();
    const next = { ...current, ...update } satisfies SyncStatus;
    await chrome.storage.local.set({ [STATUS_KEY]: next });
    return next;
  });
}

export async function saveBackendValidation(
  capabilities: BackendCapabilities | null,
  error: string | null
): Promise<SyncStatus> {
  return setStatus({
    backendValidatedAt: capabilities ? new Date().toISOString() : undefined,
    backendProduct: capabilities?.product,
    backendVersion: capabilities?.version,
    backendAuthMode: capabilities?.auth.mode,
    backendMarkdownRoot: capabilities?.storage.markdown_root ?? undefined,
    backendVaultRoot: capabilities?.storage.vault_root ?? undefined,
    backendValidationError: error
  });
}

export async function getProviderHistorySyncState(provider: ProviderName): Promise<ProviderHistorySyncState> {
  const stored = await chrome.storage.local.get(HISTORY_SYNC_KEY);
  const states = (stored[HISTORY_SYNC_KEY] ?? {}) as Record<ProviderName, ProviderHistorySyncState>;
  return states[provider] ?? {};
}

export async function saveProviderHistorySyncState(
  provider: ProviderName,
  state: ProviderHistorySyncState
): Promise<void> {
  await lockedStorage(HISTORY_SYNC_KEY, async () => {
    const stored = await chrome.storage.local.get(HISTORY_SYNC_KEY);
    const states = (stored[HISTORY_SYNC_KEY] ?? {}) as Record<ProviderName, ProviderHistorySyncState>;
    states[provider] = state;
    await chrome.storage.local.set({ [HISTORY_SYNC_KEY]: states });
  });
}

export async function clearProviderHistorySyncStates(): Promise<void> {
  await lockedStorage(HISTORY_SYNC_KEY, () => chrome.storage.local.set({ [HISTORY_SYNC_KEY]: {} }));
}
