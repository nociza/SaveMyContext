import { buildIngestPayload, mergeSeenMessageIds } from "./diff";
import { providerRegistry } from "../providers/registry";
import { supportsProactiveHistorySync } from "../shared/provider";
import {
  getProviderHistorySyncState,
  getSessionSyncState,
  getSettings,
  getStatus,
  initializeStorage,
  saveProviderHistorySyncState,
  saveSessionSyncState,
  saveSettings,
  setStatus
} from "../shared/storage";
import type { CapturedNetworkEvent, HistorySyncUpdate, ProviderName, RuntimeMessage } from "../shared/types";

let queue = Promise.resolve();
const HISTORY_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;

chrome.runtime.onInstalled.addListener(() => {
  void initializeStorage();
});

chrome.runtime.onStartup.addListener(() => {
  void initializeStorage();
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type === "NETWORK_CAPTURE") {
    queue = queue.then(() => handleCapture(message.payload)).catch((error) => {
      console.error("TSMC capture failed", error);
    });
    sendResponse({ queued: true });
    return false;
  }

  if (message.type === "PAGE_VISIT") {
    void handlePageVisit(message.payload, _sender.tab?.id).then(sendResponse);
    return true;
  }

  if (message.type === "HISTORY_SYNC_STATUS") {
    void handleHistorySyncStatus(message.payload).then(sendResponse);
    return true;
  }

  if (message.type === "GET_SETTINGS") {
    void getSettings().then(sendResponse);
    return true;
  }

  if (message.type === "SAVE_SETTINGS") {
    void saveSettings(message.payload).then(sendResponse);
    return true;
  }

  if (message.type === "GET_STATUS") {
    void getStatus().then(sendResponse);
    return true;
  }

  return false;
});

function findMatchingProvider(event: CapturedNetworkEvent) {
  for (const provider of providerRegistry) {
    try {
      if (provider.matches(event)) {
        return provider;
      }
    } catch (error) {
      console.warn(`TSMC provider matcher failed for ${provider.provider}`, error);
    }
  }

  return null;
}

async function handlePageVisit(
  payload: { provider: ProviderName; pageUrl: string },
  tabId: number | undefined
): Promise<{ triggered: boolean; reason?: string }> {
  const settings = await getSettings();
  if (!settings.enabledProviders[payload.provider]) {
    return { triggered: false, reason: "provider-disabled" };
  }
  if (!settings.autoSyncHistory) {
    return { triggered: false, reason: "auto-sync-disabled" };
  }
  if (!supportsProactiveHistorySync(payload.provider)) {
    await setStatus({
      autoSyncHistory: settings.autoSyncHistory,
      historySyncInProgress: false,
      historySyncProvider: payload.provider,
      historySyncLastPageUrl: payload.pageUrl,
      historySyncLastResult: "unsupported"
    });
    return { triggered: false, reason: "provider-unsupported" };
  }
  if (typeof tabId !== "number") {
    return { triggered: false, reason: "missing-tab-id" };
  }

  const currentState = await getProviderHistorySyncState(payload.provider);
  const lastCompletedAt = currentState.lastCompletedAt ? Date.parse(currentState.lastCompletedAt) : Number.NaN;
  const recentlyCompleted =
    !Number.isNaN(lastCompletedAt) && Date.now() - lastCompletedAt < HISTORY_SYNC_MIN_INTERVAL_MS;
  if (currentState.inProgress) {
    return { triggered: false, reason: "already-in-progress" };
  }
  if (recentlyCompleted) {
    return { triggered: false, reason: "recently-completed" };
  }

  const now = new Date().toISOString();
  await saveProviderHistorySyncState(payload.provider, {
    ...currentState,
    inProgress: true,
    lastStartedAt: now,
    lastPageUrl: payload.pageUrl
  });
  await setStatus({
    autoSyncHistory: settings.autoSyncHistory,
    historySyncInProgress: true,
    historySyncProvider: payload.provider,
    historySyncLastStartedAt: now,
    historySyncLastPageUrl: payload.pageUrl,
    historySyncLastResult: undefined,
    historySyncLastError: null
  });

  await chrome.tabs.sendMessage(tabId, {
    type: "TRIGGER_HISTORY_SYNC",
    payload: { provider: payload.provider }
  } satisfies RuntimeMessage);

  return { triggered: true };
}

async function handleHistorySyncStatus(update: HistorySyncUpdate): Promise<{ ok: true }> {
  const currentState = await getProviderHistorySyncState(update.provider);
  const patch = {
    ...currentState,
    lastPageUrl: update.pageUrl
  };

  if (update.phase === "started") {
    const startedAt = new Date().toISOString();
    await saveProviderHistorySyncState(update.provider, {
      ...patch,
      inProgress: true,
      lastStartedAt: startedAt
    });
    await setStatus({
      historySyncInProgress: true,
      historySyncProvider: update.provider,
      historySyncLastStartedAt: startedAt,
      historySyncLastPageUrl: update.pageUrl,
      historySyncLastResult: undefined,
      historySyncLastError: null
    });
    return { ok: true };
  }

  const completedAt = new Date().toISOString();
  if (update.phase === "completed") {
    await saveProviderHistorySyncState(update.provider, {
      ...patch,
      inProgress: false,
      lastCompletedAt: completedAt,
      lastConversationCount: update.conversationCount ?? currentState.lastConversationCount
    });
    await setStatus({
      historySyncInProgress: false,
      historySyncProvider: update.provider,
      historySyncLastCompletedAt: completedAt,
      historySyncLastConversationCount: update.conversationCount,
      historySyncLastPageUrl: update.pageUrl,
      historySyncLastResult: "success",
      historySyncLastError: null
    });
    return { ok: true };
  }

  if (update.phase === "unsupported") {
    await saveProviderHistorySyncState(update.provider, {
      ...patch,
      inProgress: false,
      lastCompletedAt: completedAt
    });
    await setStatus({
      historySyncInProgress: false,
      historySyncProvider: update.provider,
      historySyncLastCompletedAt: completedAt,
      historySyncLastPageUrl: update.pageUrl,
      historySyncLastResult: "unsupported",
      historySyncLastError: update.message ?? null
    });
    return { ok: true };
  }

  await saveProviderHistorySyncState(update.provider, {
    ...patch,
    inProgress: false,
    lastCompletedAt: completedAt
  });
  await setStatus({
    historySyncInProgress: false,
    historySyncProvider: update.provider,
    historySyncLastCompletedAt: completedAt,
    historySyncLastPageUrl: update.pageUrl,
    historySyncLastResult: "failed",
    historySyncLastError: update.message ?? "History sync failed."
  });
  return { ok: true };
}

async function handleCapture(event: CapturedNetworkEvent): Promise<void> {
  const settings = await getSettings();
  const scraper = findMatchingProvider(event);
  if (!scraper || !settings.enabledProviders[scraper.provider]) {
    return;
  }

  const snapshot = scraper.parse(event);
  if (!snapshot || !snapshot.messages.length) {
    return;
  }

  const sessionKey = `${snapshot.provider}:${snapshot.externalSessionId}`;
  const syncState = await getSessionSyncState(sessionKey);
  const payload = buildIngestPayload(snapshot, event, syncState);
  if (!payload) {
    return;
  }

  const backendUrl = settings.backendUrl.replace(/\/$/, "");
  const response = await fetch(`${backendUrl}/api/v1/ingest/diff`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const details = (await response.text()).slice(0, 400);
    await setStatus({
      backendUrl,
      lastError: `Backend responded ${response.status}: ${details}`
    });
    throw new Error(`TSMC sync failed: ${response.status}`);
  }

  await saveSessionSyncState(sessionKey, {
    seenMessageIds: mergeSeenMessageIds(syncState.seenMessageIds, snapshot.messages),
    lastSyncedAt: new Date().toISOString()
  });
  await setStatus({
    backendUrl,
    lastError: null,
    lastProvider: snapshot.provider,
    lastSessionKey: sessionKey,
    lastSuccessAt: new Date().toISOString(),
    lastSyncedMessageCount: payload.messages.length,
    autoSyncHistory: settings.autoSyncHistory
  });
}
