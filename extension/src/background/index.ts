import { buildIngestPayload, mergeSeenMessageIds } from "./diff";
import { providerRegistry } from "../providers/registry";
import {
  getSessionSyncState,
  getSettings,
  getStatus,
  initializeStorage,
  saveSessionSyncState,
  saveSettings,
  setStatus
} from "../shared/storage";
import type { CapturedNetworkEvent, RuntimeMessage } from "../shared/types";

let queue = Promise.resolve();

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

async function handleCapture(event: CapturedNetworkEvent): Promise<void> {
  const settings = await getSettings();
  const scraper = providerRegistry.find((provider) => provider.matches(event));
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
    lastSyncedMessageCount: payload.messages.length
  });
}

