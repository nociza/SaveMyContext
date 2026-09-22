import { providerRegistry } from "../providers/registry";
import { parseConnectionString } from "../shared/connection";
import {
  buildMarkdownContextImportPayload,
  renderActiveChatMarkdown
} from "../shared/context-markdown";
import {
  ALL_REGULAR_PAGE_ORIGINS,
  hasOptionalHostPermissions
} from "../shared/host-permissions";
import { evaluateDiscardWords, evaluateIndexingRules, indexingRulesFingerprint } from "../shared/indexing-rules";
import {
  normalizePageSurfaceScope,
  pageSurfaceScopeAllowsUrl
} from "../shared/page-surfaces";
import { detectProviderFromUrl, supportsProactiveHistorySync } from "../shared/provider";
import { createSourceCaptureKey } from "../shared/source-capture";
import {
  clearProviderHistorySyncStates,
  getInstallationId,
  getProviderHistorySyncState,
  getProviderSessionSyncStates,
  getSessionSyncState,
  getSettings,
  getStatus,
  initializeStorage,
  saveBackendValidation,
  saveProviderHistorySyncState,
  saveSessionSyncState,
  saveSettings,
  setStatus
} from "../shared/storage";
import type {
  ActiveChatContextResponse,
  ActiveChatContextSnapshot,
  ActiveChatMarkdownDumpResponse,
  BackendSearchResult,
  CapturedNetworkEvent,
  ExtensionSettings,
  HistorySyncUpdate,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse,
  NormalizedSessionSnapshot,
  PingProviderTabResponse,
  ProviderDriftAlert,
  ProviderHistorySyncState,
  ProviderName,
  RuntimeMessage,
  SaveConnectionBundleResponse,
  SaveSettingsResponse,
  SourceCapturePayload,
  SourceCaptureResponse,
  SyncStatus
} from "../shared/types";
import { validateWorkspaceUrl } from "../shared/workspace-link";
import {
  buildBackendHeaders,
  fetchContextMigrationBundle,
  fetchKnowledgeSearch,
  fetchSessions,
  importContextMigrationBundle,
  redeemConnectionBundle,
  saveSourceCaptureToBackend,
  validateBackendConfiguration
} from "./backend";
import { buildIngestPayload, mergeMessageFingerprints, mergeSeenMessageIds } from "./diff";
import { activeHistoryWatermarks, shouldCommitHistoryWatermark } from "./history-watermark";
import { IndexedCaptureStore, OUTBOX_ALARM, drainCaptures, enqueueCapture, indexingAllowsCapture, requireCaptureReceipt } from "./outbox";
import { acceptCaptureConsent } from "../shared/storage";
import {
  buildProviderRefreshAlarmPlan,
  providerFromRefreshAlarmName,
  providerRefreshAlarmName
} from "./provider-refresh";
import { bestEffortTabCleanup } from "./tab-cleanup";

let queue = Promise.resolve();
const captureOutbox = new IndexedCaptureStore();
let captureDrain: Promise<void> | null = null;
const HISTORY_SYNC_STALE_AFTER_MS = 15 * 60 * 1000;
const BACKEND_VALIDATION_TTL_MS = 30 * 1000;
const historySyncRunErrors = new Map<string, string>();
let backendValidationInFlight: Promise<SyncStatus> | null = null;
let backendValidationInFlightKey = "";
let backendValidationLastCompletedAt = 0;
let backendValidationLastKey = "";
let backendValidationGeneration = 0;
const activeChatContextsByTabId = new Map<number, ActiveChatContextSnapshot>();
const TAB_MESSAGE_RETRY_MS = 4_000;
const TAB_MESSAGE_RETRY_INTERVAL_MS = 150;
const PROVIDER_TAB_READY_TIMEOUT_MS = 10_000;
const PROVIDER_TAB_READY_INTERVAL_MS = 250;
const PROVIDER_REFRESH_TAB_LOAD_TIMEOUT_MS = 30_000;
const CONTENT_SCRIPT_FILE = "assets/content.js";
const PAGE_SURFACE_SCRIPT_ID = "savemycontext-page-surfaces-all-pages";
const PAGE_SURFACE_CLEANUP_FLAG = "data-savemycontext-page-surfaces-cleanup";
const PAGE_SURFACE_HOST_IDS = [
  "savemycontext-selection-capture-root",
  "savemycontext-context-suggestions-root",
  "savemycontext-quick-search-host"
];
const ALL_REGULAR_PAGE_MATCHES = [...ALL_REGULAR_PAGE_ORIGINS];
const AI_PROVIDER_PAGE_MATCHES = [
  "https://chatgpt.com/*",
  "https://chat.openai.com/*",
  "https://gemini.google.com/*",
  "https://grok.com/*"
];
const HISTORY_SYNC_PROVIDERS: ProviderName[] = ["chatgpt", "gemini", "grok"];
const scheduledProviderRefreshesInFlight = new Set<ProviderName>();
const ACTION_ICON_PATHS: Record<number, string> = {
  16: "icons/icon-16.png",
  32: "icons/icon-32.png",
  48: "icons/icon-48.png",
  128: "icons/icon-128.png"
};
const ACTION_ICON_SIZES = [16, 32, 48, 128] as const;
const syncIconImageData = new Map<number, ImageData>();
let actionIconMode: "default" | "syncing" = "default";
let actionBadgeUpdateSequence = 0;

const PROVIDER_START_URLS: Record<ProviderName, string> = {
  chatgpt: "https://chatgpt.com/",
  gemini: "https://gemini.google.com/app",
  grok: "https://grok.com/",
  codex: "https://codex.openai.com/",
  claude: "https://claude.ai/"
};

function formatProviderName(provider: ProviderName): string {
  if (provider === "chatgpt") {
    return "ChatGPT";
  }
  if (provider === "gemini") {
    return "Gemini";
  }
  if (provider === "grok") {
    return "Grok";
  }
  if (provider === "codex") {
    return "Codex";
  }
  return "Claude";
}

function formatProviderList(providers: ProviderName[] | undefined, fallback: ProviderName | undefined): string {
  const names = (providers?.length ? providers : fallback ? [fallback] : []).map(formatProviderName);
  return names.length ? names.join(", ") : "provider";
}

function normalizeAccountFilterValue(value: string): string {
  return value.trim().toLowerCase();
}

function accountAllowedBySettings(
  settings: ExtensionSettings,
  snapshot: NormalizedSessionSnapshot
): { allowed: boolean; reason: string } {
  if (settings.accountCaptureMode !== "include") {
    return { allowed: true, reason: `Captured from ${snapshot.accountLabel}.` };
  }

  const allowedValues = (settings.enabledAccountKeys?.[snapshot.provider] ?? [])
    .map(normalizeAccountFilterValue)
    .filter(Boolean);
  if (!allowedValues.length) {
    return { allowed: true, reason: `Account filter is enabled, but no ${formatProviderName(snapshot.provider)} accounts are listed.` };
  }

  const accountKey = normalizeAccountFilterValue(snapshot.accountKey);
  const accountSuffix = accountKey.includes(":") ? accountKey.split(":").slice(1).join(":") : accountKey;
  const accountLabel = normalizeAccountFilterValue(snapshot.accountLabel);
  const candidates = new Set([accountKey, accountSuffix, accountLabel].filter(Boolean));
  const allowed = allowedValues.some((value) => candidates.has(value) || candidates.has(`${snapshot.provider}:${value}`));
  return {
    allowed,
    reason: allowed
      ? `Captured from allowed account ${snapshot.accountLabel}.`
      : `Skipped because ${snapshot.accountLabel} is not in the allowed ${formatProviderName(snapshot.provider)} account list.`
  };
}

function rememberActiveChatContext(tabId: number, snapshot: NormalizedSessionSnapshot, pageUrl: string): void {
  const messages = snapshot.messages
    .slice(Math.max(snapshot.messages.length - 10, 0))
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content.slice(0, 2_000),
      occurredAt: message.occurredAt
    }));

  activeChatContextsByTabId.set(tabId, {
    provider: snapshot.provider,
    externalSessionId: snapshot.externalSessionId,
    accountKey: snapshot.accountKey,
    accountLabel: snapshot.accountLabel,
    title: snapshot.title,
    sourceUrl: snapshot.sourceUrl,
    pageUrl,
    capturedAt: snapshot.capturedAt,
    messages
  });
}

function clearActiveChatContext(tabId: number | undefined): void {
  if (typeof tabId === "number") {
    activeChatContextsByTabId.delete(tabId);
  }
}

function searchResultIdentity(result: BackendSearchResult): string {
  if (result.entity_id) {
    return `entity:${result.entity_id.toLowerCase()}`;
  }
  if (result.source_id) {
    return `source:${result.source_id}`;
  }
  if (result.session_id) {
    return `session:${result.session_id}`;
  }
  if (result.markdown_path) {
    return `${result.kind}:${result.markdown_path}`;
  }
  return `${result.kind}:${result.title.toLowerCase()}`;
}

function mergeSearchResults(results: BackendSearchResult[]): BackendSearchResult[] {
  const merged = new Map<string, BackendSearchResult>();
  for (const result of results) {
    const identity = searchResultIdentity(result);
    if (!merged.has(identity)) {
      merged.set(identity, result);
    }
  }
  return [...merged.values()];
}

function normalizeKnowledgeSearchQueries(payload: KnowledgeSearchRequest): string[] {
  return [...new Set([payload.query ?? "", ...(payload.queries ?? [])].map((value) => value.trim()).filter((value) => value.length >= 2))].slice(
    0,
    8
  );
}

async function extensionClientName(): Promise<string> {
  const platform = await chrome.runtime.getPlatformInfo();
  return `Chrome ${platform.os}`;
}

function isFreshHistorySyncInProgress(state: ProviderHistorySyncState): boolean {
  const lastStartedAt = state.lastStartedAt ? Date.parse(state.lastStartedAt) : Number.NaN;
  const staleInProgress =
    state.inProgress &&
    !Number.isNaN(lastStartedAt) &&
    Date.now() - lastStartedAt >= HISTORY_SYNC_STALE_AFTER_MS;
  return Boolean(state.inProgress && !staleInProgress);
}

function createSyncActionIcon(size: number): ImageData {
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext("2d");
  if (!context) {
    return new ImageData(size, size);
  }

  const center = size / 2;
  const outerRadius = size * 0.45;
  const ringRadius = size * 0.28;
  const lineWidth = Math.max(1.4, size * 0.1);
  const arrowSize = Math.max(2.2, size * 0.14);

  context.clearRect(0, 0, size, size);
  context.fillStyle = "#08090a";
  context.beginPath();
  context.arc(center, center, outerRadius, 0, Math.PI * 2);
  context.fill();

  context.lineWidth = lineWidth;
  context.lineCap = "round";
  context.strokeStyle = "#ffffff";
  context.beginPath();
  context.arc(center, center, ringRadius, Math.PI * 0.25, Math.PI * 1.2);
  context.stroke();

  context.strokeStyle = "#5e6ad2";
  context.beginPath();
  context.arc(center, center, ringRadius, Math.PI * 1.28, Math.PI * 2.08);
  context.stroke();

  const arrowAngle = Math.PI * 2.08;
  const arrowX = center + Math.cos(arrowAngle) * ringRadius;
  const arrowY = center + Math.sin(arrowAngle) * ringRadius;
  context.fillStyle = "#5e6ad2";
  context.beginPath();
  context.moveTo(arrowX, arrowY);
  context.lineTo(arrowX - arrowSize, arrowY - arrowSize * 0.2);
  context.lineTo(arrowX - arrowSize * 0.25, arrowY + arrowSize);
  context.closePath();
  context.fill();

  context.fillStyle = "#ffffff";
  context.beginPath();
  context.arc(center, center, Math.max(1.4, size * 0.09), 0, Math.PI * 2);
  context.fill();

  return context.getImageData(0, 0, size, size);
}

function getSyncActionIcon(size: number): ImageData {
  const existing = syncIconImageData.get(size);
  if (existing) {
    return existing;
  }
  const created = createSyncActionIcon(size);
  syncIconImageData.set(size, created);
  return created;
}

async function syncActionIcon(status: SyncStatus): Promise<void> {
  if (status.historySyncInProgress) {
    if (actionIconMode === "syncing") {
      return;
    }
    const imageData = Object.fromEntries(
      ACTION_ICON_SIZES.map((size) => [size, getSyncActionIcon(size)])
    ) as Record<number, ImageData>;
    await chrome.action.setIcon({ imageData });
    actionIconMode = "syncing";
    return;
  }

  if (actionIconMode === "default") {
    return;
  }
  await chrome.action.setIcon({ path: ACTION_ICON_PATHS });
  actionIconMode = "default";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

async function syncActionBadge(status: SyncStatus): Promise<void> {
  const sequence = (actionBadgeUpdateSequence += 1);
  try {
    await syncActionIcon(status);
  } catch (error) {
    console.warn("SaveMyContext action icon update failed", error);
  }
  if (sequence !== actionBadgeUpdateSequence) {
    return;
  }

  if (status.providerDriftAlert) {
    await chrome.action.setBadgeBackgroundColor({ color: "#BD5D38" });
    if (sequence !== actionBadgeUpdateSequence) {
      return;
    }
    await chrome.action.setBadgeText({ text: "!" });
    if (sequence !== actionBadgeUpdateSequence) {
      return;
    }
    await chrome.action.setTitle({
      title: `SaveMyContext: Provider drift suspected for ${status.providerDriftAlert.provider}. Open the extension for details.`
    });
    return;
  }

  if (status.historySyncInProgress) {
    await chrome.action.setBadgeBackgroundColor({ color: "#0B8C88" });
    if (sequence !== actionBadgeUpdateSequence) {
      return;
    }
    await chrome.action.setBadgeText({ text: "…" });
    if (sequence !== actionBadgeUpdateSequence) {
      return;
    }
    await chrome.action.setTitle({
      title: `SaveMyContext: History sync running for ${formatProviderList(
        status.historySyncActiveProviders,
        status.historySyncProvider
      )}.`
    });
    return;
  }

  await chrome.action.setBadgeText({ text: "" });
  if (sequence !== actionBadgeUpdateSequence) {
    return;
  }
  await chrome.action.setTitle({ title: "SaveMyContext" });
}

async function setExtensionStatus(update: Partial<SyncStatus>): Promise<SyncStatus> {
  const status = await setStatus(update);
  try {
    await syncActionBadge(status);
  } catch (error) {
    console.warn("SaveMyContext action badge update failed", error);
  }
  return status;
}

function sameProviderList(left: ProviderName[] | undefined, right: ProviderName[]): boolean {
  const resolvedLeft = left ?? [];
  return (
    resolvedLeft.length === right.length &&
    resolvedLeft.every((provider, index) => provider === right[index])
  );
}

async function getActiveHistorySyncProviders(
  overrides: Partial<Record<ProviderName, boolean>> = {}
): Promise<ProviderName[]> {
  const states = await Promise.all(
    HISTORY_SYNC_PROVIDERS.map(async (provider) => {
      const override = overrides[provider];
      if (typeof override === "boolean") {
        return [provider, override] as const;
      }

      const state = await getProviderHistorySyncState(provider);
      const inProgress = isFreshHistorySyncInProgress(state);
      if (state.inProgress && !inProgress) {
        await saveProviderHistorySyncState(provider, {
          ...state,
          inProgress: false
        });
      }
      return [provider, inProgress] as const;
    })
  );
  return states.filter(([, inProgress]) => inProgress).map(([provider]) => provider);
}

async function reconcileHistorySyncStatus(status: SyncStatus): Promise<SyncStatus> {
  const activeProviders = await getActiveHistorySyncProviders();
  const historySyncInProgress = activeProviders.length > 0;
  if (
    status.historySyncInProgress === historySyncInProgress &&
    sameProviderList(status.historySyncActiveProviders, activeProviders)
  ) {
    return status;
  }

  return await setExtensionStatus({
    historySyncInProgress,
    historySyncActiveProviders: activeProviders
  });
}

function clearRecoveredProviderDriftAlert(
  currentAlert: ProviderDriftAlert | null | undefined,
  provider: ProviderName
): ProviderDriftAlert | null | undefined {
  if (!currentAlert || currentAlert.provider !== provider) {
    return currentAlert;
  }

  return null;
}

function enqueueTask<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task);
  queue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function backendValidationCacheKey(settings: ExtensionSettings): string {
  return `${settings.backendUrl.trim()}::${settings.backendToken ?? ""}`;
}

function tabMatchesProviderUrl(url: string | undefined, provider: ProviderName): boolean {
  if (!url) {
    return false;
  }

  try {
    const hostname = new URL(url).hostname;
    if (provider === "chatgpt") {
      return hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com") || hostname === "chat.openai.com";
    }
    if (provider === "gemini") {
      return /gemini\.google\.com/.test(hostname);
    }
    return hostname === "grok.com" || hostname.endsWith(".grok.com");
  } catch {
    return false;
  }
}

async function findReusableProviderTab(
  provider: ProviderName,
  targetUrl: string,
  preferExistingConversation: boolean
): Promise<number | null> {
  const tabs = await chrome.tabs.query({});
  const matchingTabs = tabs.filter((tab) => typeof tab.id === "number" && tabMatchesProviderUrl(tab.url, provider));
  if (!matchingTabs.length) {
    return null;
  }

  if (preferExistingConversation) {
    const exactTab = matchingTabs.find((tab) => tab.url === targetUrl);
    if (exactTab?.id) {
      return exactTab.id;
    }
  }

  if (!preferExistingConversation) {
    const activeTab = matchingTabs.find((tab) => tab.active);
    if (activeTab?.id) {
      return activeTab.id;
    }
  }

  return matchingTabs[0]?.id ?? null;
}

async function waitForTabComplete(tabId: number): Promise<void> {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") {
    return;
  }

  await new Promise<void>((resolve) => {
    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") {
        return;
      }
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function findProviderRefreshTab(provider: ProviderName): Promise<number | null> {
  const tabs = await chrome.tabs.query({});
  const matchingTabs = tabs.filter((tab) => typeof tab.id === "number" && tabMatchesProviderUrl(tab.url, provider));
  return matchingTabs.find((tab) => !tab.active)?.id ?? matchingTabs[0]?.id ?? null;
}

async function reloadTabAndWaitForComplete(tabId: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      chrome.tabs.onUpdated.removeListener(listener);
      globalThis.clearTimeout(timeout);
    };
    const finish = (error?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };
    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    };
    const timeout = globalThis.setTimeout(() => {
      finish(new Error("Timed out waiting for the provider refresh tab to load."));
    }, PROVIDER_REFRESH_TAB_LOAD_TIMEOUT_MS);

    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.reload(tabId).catch(finish);
  });
}

async function ensureProviderRefreshTab(provider: ProviderName): Promise<chrome.tabs.Tab & { id: number }> {
  const existingTabId = await findProviderRefreshTab(provider);
  if (typeof existingTabId === "number") {
    await reloadTabAndWaitForComplete(existingTabId);
    const tab = await chrome.tabs.get(existingTabId);
    if (typeof tab.id === "number") {
      return tab as chrome.tabs.Tab & { id: number };
    }
  }

  const tab = await chrome.tabs.create({
    url: PROVIDER_START_URLS[provider],
    active: false
  });
  if (typeof tab.id !== "number") {
    throw new Error(`Could not open a ${provider} refresh tab.`);
  }
  await waitForTabComplete(tab.id);
  return (await chrome.tabs.get(tab.id)) as chrome.tabs.Tab & { id: number };
}

function isRetriableTabMessageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Receiving end does not exist|Could not establish connection/i.test(message);
}

async function sendMessageToTabWithRetry<TResponse>(tabId: number, message: RuntimeMessage): Promise<TResponse> {
  const deadline = Date.now() + TAB_MESSAGE_RETRY_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return (await chrome.tabs.sendMessage(tabId, message)) as TResponse;
    } catch (error) {
      lastError = error;
      if (!isRetriableTabMessageError(error)) {
        throw error;
      }
      await sleep(TAB_MESSAGE_RETRY_INTERVAL_MS);
    }
  }

  throw (lastError instanceof Error ? lastError : new Error(String(lastError ?? "Timed out sending a tab message.")));
}

function tabSupportsInteractivePage(tab: chrome.tabs.Tab | undefined): tab is chrome.tabs.Tab & { id: number; url: string } {
  return Boolean(tab && typeof tab.id === "number" && typeof tab.url === "string" && /^https?:\/\//i.test(tab.url));
}

function pageSurfaceScopeError(action: string): string {
  return `SaveMyContext ${action} is limited to supported AI provider pages. Change Page surfaces in Settings to use it on all web pages.`;
}

async function settingsAllowPageSurface(tabUrl: string): Promise<boolean> {
  const settings = await getSettings();
  return pageSurfaceScopeAllowsUrl(settings.pageSurfaceScope, tabUrl);
}

function installPageSurfaceCleanupGuard(hostIds: string[], flagAttribute: string): void {
  const cleanup = () => {
    for (const id of hostIds) {
      document.getElementById(id)?.remove();
    }
  };
  cleanup();

  if (document.documentElement.getAttribute(flagAttribute) === "1") {
    return;
  }
  document.documentElement.setAttribute(flagAttribute, "1");

  const scheduleCleanup = () => {
    cleanup();
    window.setTimeout(cleanup, 120);
    window.setTimeout(cleanup, 300);
  };
  for (const eventName of ["selectionchange", "mouseup", "mousedown", "focusin"]) {
    document.addEventListener(eventName, scheduleCleanup, true);
  }
  window.addEventListener("scroll", scheduleCleanup, true);
}

async function ensureQuickSearchContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [CONTENT_SCRIPT_FILE]
  });
}

async function openQuickSearchInActiveTab(): Promise<{ ok: boolean; error?: string }> {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabSupportsInteractivePage(activeTab)) {
    return {
      ok: false,
      error: "SaveMyContext quick search only works on regular http or https pages."
    };
  }
  if (!(await settingsAllowPageSurface(activeTab.url))) {
    return {
      ok: false,
      error: pageSurfaceScopeError("quick search")
    };
  }

  try {
    await chrome.tabs.sendMessage(activeTab.id, {
      type: "TOGGLE_QUICK_SEARCH"
    } satisfies RuntimeMessage);
    return { ok: true };
  } catch (error) {
    if (!isRetriableTabMessageError(error)) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  try {
    await ensureQuickSearchContentScript(activeTab.id);
    await sendMessageToTabWithRetry(activeTab.id, {
      type: "TOGGLE_QUICK_SEARCH"
    } satisfies RuntimeMessage);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function sendMessageToActivePage<TResponse>(
  message: RuntimeMessage,
  options: { actionName?: string; requirePageSurfaceScope?: boolean } = {}
): Promise<TResponse> {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabSupportsInteractivePage(activeTab)) {
    throw new Error("SaveMyContext page actions only work on regular http or https pages.");
  }
  if (options.requirePageSurfaceScope !== false && !(await settingsAllowPageSurface(activeTab.url))) {
    throw new Error(pageSurfaceScopeError(options.actionName ?? "page action"));
  }

  try {
    return await chrome.tabs.sendMessage(activeTab.id, message);
  } catch (error) {
    if (!isRetriableTabMessageError(error)) {
      throw error;
    }
  }

  await ensureQuickSearchContentScript(activeTab.id);
  return await sendMessageToTabWithRetry<TResponse>(activeTab.id, message);
}

async function handleKnowledgeSearch(payload: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse> {
  const queries = normalizeKnowledgeSearchQueries(payload);
  const queryLabel = queries.join(" | ");
  if (!queries.length) {
    return {
      ok: true,
      query: queryLabel,
      count: 0,
      results: []
    };
  }

  const settings = await getSettings();
  const status = await refreshBackendStatus(false);
  if (status.backendValidationError) {
    return {
      ok: false,
      query: queryLabel,
      count: 0,
      results: [],
      error: status.backendValidationError
    };
  }

  try {
    const perQueryLimit = queries.length > 1 ? Math.min(Math.max(payload.limit ?? 8, 6), 10) : payload.limit ?? 8;
    const responses = await Promise.all(
      queries.map((query) =>
        fetchKnowledgeSearch(
          {
            ...settings,
            backendUrl: status.backendUrl ?? settings.backendUrl
          },
          query,
          perQueryLimit,
          {
            provider: payload.provider,
            kinds: payload.kinds
          }
        )
      )
    );
    const results = mergeSearchResults(responses.flatMap((response) => response.results)).slice(0, payload.limit ?? 8);
    return {
      ok: true,
      query: queryLabel,
      count: results.length,
      results
    };
  } catch (error) {
    return {
      ok: false,
      query: queryLabel,
      count: 0,
      results: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function handleGetActiveChatContext(
  sender: chrome.runtime.MessageSender,
  payload?: { pageUrl?: string }
): ActiveChatContextResponse {
  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") {
    return {
      ok: true
    };
  }

  const snapshot = activeChatContextsByTabId.get(tabId);
  if (!snapshot) {
    return {
      ok: true
    };
  }

  const expectedProvider = detectProviderFromUrl(payload?.pageUrl ?? sender.tab?.url ?? "");
  if (expectedProvider && expectedProvider !== snapshot.provider) {
    return {
      ok: true
    };
  }

  return {
    ok: true,
    snapshot
  };
}

async function handleSaveSourceCapture(payload: SourceCapturePayload): Promise<SourceCaptureResponse> {
  const settings = await getSettings();
  if (settings.capturePaused) return { ok: false, error: "Capture paused" };
  const status = await refreshBackendStatus(false);
  if (status.backendValidationError) {
    return {
      ok: false,
      error: status.backendValidationError
    };
  }

  try {
    const requestPayload = payload.captureKey
      ? payload
      : {
          ...payload,
          captureKey: createSourceCaptureKey()
        };
    const response = await saveSourceCaptureToBackend(
      {
        ...settings,
        backendUrl: status.backendUrl ?? settings.backendUrl
      },
      requestPayload
    );
    await setExtensionStatus({
      lastError: null
    });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setExtensionStatus({
      lastError: message
    });
    return {
      ok: false,
      error: message
    };
  }
}

async function handleSaveCurrentPageSource(saveMode: "raw" | "ai" = "raw"): Promise<SourceCaptureResponse> {
  try {
    return await sendMessageToActivePage<SourceCaptureResponse>({
      type: "SAVE_CURRENT_PAGE_SOURCE",
      payload: {
        saveMode
      }
    }, {
      actionName: "page capture"
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function snapshotFromActiveProviderPage(
  activeTab: chrome.tabs.Tab & { id: number; url: string },
  activeProvider: ProviderName
): Promise<ActiveChatContextSnapshot | null> {
  const remembered = activeChatContextsByTabId.get(activeTab.id);
  if (remembered?.provider === activeProvider) {
    return remembered;
  }

  try {
    const response = await sendMessageToActivePage<ActiveChatContextResponse>(
      { type: "GET_PAGE_CHAT_CONTEXT" },
      { actionName: "chat markdown dump" }
    );
    if (response.ok && response.snapshot?.provider === activeProvider) {
      return response.snapshot;
    }
  } catch {
    // The caller will surface a clearer fallback error below.
  }

  return remembered?.provider === activeProvider ? remembered : null;
}

function matchingSavedSession(
  sessions: Awaited<ReturnType<typeof fetchSessions>>,
  snapshot: ActiveChatContextSnapshot
) {
  return sessions.find((session) => session.external_session_id === snapshot.externalSessionId)
    ?? sessions.find((session) => session.external_session_id.endsWith(`__${snapshot.externalSessionId}`))
    ?? sessions.find((session) => snapshot.sourceUrl && session.external_session_id && snapshot.sourceUrl.includes(session.external_session_id));
}

async function handleDumpActiveChatMarkdown(): Promise<ActiveChatMarkdownDumpResponse> {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabSupportsInteractivePage(activeTab)) {
    return {
      ok: false,
      error: "SaveMyContext chat dumps only work on regular http or https provider pages."
    };
  }

  const activeProvider = detectProviderFromUrl(activeTab.url);
  if (!activeProvider || activeProvider === "codex") {
    return {
      ok: false,
      error: "Open a ChatGPT, Gemini, Grok, or Claude chat page before dumping Markdown."
    };
  }

  const settings = await getSettings();
  const status = await refreshBackendStatus(false);
  const backendSettings = {
    ...settings,
    backendUrl: status.backendUrl ?? settings.backendUrl
  };

  const snapshot = await snapshotFromActiveProviderPage(activeTab, activeProvider);
  if (!snapshot?.messages.length) {
    return {
      ok: false,
      provider: activeProvider,
      error: "Could not find a captured or visible chat on this page yet."
    };
  }

  if (!status.backendValidationError) {
    try {
      const sessions = await fetchSessions(backendSettings, { provider: snapshot.provider });
      const savedSession = matchingSavedSession(sessions, snapshot);
      if (savedSession) {
        const bundle = await fetchContextMigrationBundle(backendSettings, savedSession.id);
        return {
          ok: true,
          markdown: bundle.handoff_markdown,
          title: bundle.title ?? savedSession.title,
          provider: snapshot.provider,
          sessionId: savedSession.id,
          source: "saved_session",
          backendStored: true
        };
      }
    } catch {
      // Fall back to a page-authored snapshot below. This still gives the user a clipboard dump.
    }
  }

  const markdown = renderActiveChatMarkdown(snapshot);
  if (!status.backendValidationError) {
    try {
      const imported = await importContextMigrationBundle(
        backendSettings,
        buildMarkdownContextImportPayload(snapshot, markdown)
      );
      return {
        ok: true,
        markdown,
        title: imported.bundle.title,
        provider: snapshot.provider,
        sessionId: imported.session_id,
        source: "page_snapshot",
        backendStored: true
      };
    } catch (error) {
      return {
        ok: true,
        markdown,
        title: snapshot.title,
        provider: snapshot.provider,
        source: "page_snapshot",
        backendStored: false,
        warning: error instanceof Error ? error.message : String(error)
      };
    }
  }

  return {
    ok: true,
    markdown,
    title: snapshot.title,
    provider: snapshot.provider,
    source: "page_snapshot",
    backendStored: false,
    warning: status.backendValidationError
  };
}

async function waitForProviderTabReady(tabId: number, provider: ProviderName): Promise<void> {
  const deadline = Date.now() + PROVIDER_TAB_READY_TIMEOUT_MS;
  let lastError: string | null = null;

  while (Date.now() < deadline) {
    try {
      const response = await sendMessageToTabWithRetry<PingProviderTabResponse>(tabId, {
        type: "PING_PROVIDER_TAB"
      } satisfies RuntimeMessage);
      if (response?.ok && response.provider === provider) {
        return;
      }
      lastError = response?.error ?? `The provider tab is not ready for ${provider}.`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(PROVIDER_TAB_READY_INTERVAL_MS);
  }

  throw new Error(lastError ?? `Timed out waiting for the ${provider} tab to become ready.`);
}

async function refreshBackendStatus(force = false): Promise<SyncStatus> {
  const settings = await getSettings();
  const validationKey = backendValidationCacheKey(settings);
  const now = Date.now();

  if (!force) {
    if (backendValidationInFlight && backendValidationInFlightKey === validationKey) {
      return backendValidationInFlight;
    }

    if (
      validationKey === backendValidationLastKey &&
      now - backendValidationLastCompletedAt < BACKEND_VALIDATION_TTL_MS
    ) {
      return await reconcileHistorySyncStatus(await getStatus());
    }
  }

  const validationGeneration = ++backendValidationGeneration;
  backendValidationInFlight = (async () => {
    const candidateBackendUrl = settings.backendUrl.trim().replace(/\/$/, "");

    try {
      const { normalizedUrl, capabilities } = await validateBackendConfiguration(settings);
      const latestSettings = await getSettings();
      if (
        validationGeneration !== backendValidationGeneration ||
        backendValidationCacheKey(latestSettings) !== validationKey
      ) {
        return await getStatus();
      }
      await saveBackendValidation(capabilities, null);
      const nextStatus = await setExtensionStatus({
        backendUrl: normalizedUrl,
        autoSyncHistory: settings.autoSyncHistory,
        backendValidatedAt: new Date().toISOString(),
        backendProduct: capabilities.product,
        backendVersion: capabilities.version,
        backendAuthMode: capabilities.auth.mode,
        backendValidationError: null,
        backendMarkdownRoot: capabilities.storage.markdown_root ?? undefined,
        backendVaultRoot: capabilities.storage.vault_root ?? undefined,
      });
      backendValidationLastKey = validationKey;
      backendValidationLastCompletedAt = Date.now();
      return await reconcileHistorySyncStatus(nextStatus);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const latestSettings = await getSettings();
      if (
        validationGeneration !== backendValidationGeneration ||
        backendValidationCacheKey(latestSettings) !== validationKey
      ) {
        return await getStatus();
      }
      await saveBackendValidation(null, message);
      const nextStatus = await setExtensionStatus({
        backendUrl: candidateBackendUrl || settings.backendUrl,
        autoSyncHistory: settings.autoSyncHistory,
        backendValidationError: message,
        backendMarkdownRoot: undefined,
        backendVaultRoot: undefined,
      });
      backendValidationLastKey = validationKey;
      backendValidationLastCompletedAt = Date.now();
      return await reconcileHistorySyncStatus(nextStatus);
    } finally {
      if (backendValidationInFlightKey === validationKey && validationGeneration === backendValidationGeneration) {
        backendValidationInFlight = null;
        backendValidationInFlightKey = "";
      }
    }
  })();
  backendValidationInFlightKey = validationKey;

  return backendValidationInFlight;
}

async function syncProviderRefreshAlarms(settings?: ExtensionSettings): Promise<void> {
  const resolvedSettings = settings ?? (await getSettings());
  const plan = buildProviderRefreshAlarmPlan(resolvedSettings);
  const plannedNames = new Set(plan.map((item) => item.alarmName));

  await Promise.all(
    (["chatgpt", "gemini", "grok"] as ProviderName[]).map(async (provider) => {
      const alarmName = providerRefreshAlarmName(provider);
      if (!plannedNames.has(alarmName)) {
        await chrome.alarms.clear(alarmName);
      }
    })
  );

  await Promise.all(
    plan.map(async (item) => {
      await chrome.alarms.create(item.alarmName, {
        delayInMinutes: item.delayInMinutes,
        periodInMinutes: item.periodInMinutes
      });
    })
  );
}

async function syncPageSurfaceContentScript(settings?: ExtensionSettings): Promise<void> {
  const resolvedSettings = settings ?? (await getSettings());
  const registered = await chrome.scripting.getRegisteredContentScripts({
    ids: [PAGE_SURFACE_SCRIPT_ID]
  });
  const registeredForAllPages = registered.length > 0;
  const shouldRegisterForAllPages = normalizePageSurfaceScope(resolvedSettings.pageSurfaceScope) === "all_pages";

  if (
    shouldRegisterForAllPages &&
    !(await hasOptionalHostPermissions(ALL_REGULAR_PAGE_MATCHES))
  ) {
    if (registeredForAllPages) {
      await chrome.scripting.unregisterContentScripts({
        ids: [PAGE_SURFACE_SCRIPT_ID]
      });
    }
    await cleanupDisallowedPageSurfaceTabs({
      ...resolvedSettings,
      pageSurfaceScope: "ai_providers"
    });
    throw new Error(
      "All-page surfaces require optional access to regular HTTP and HTTPS pages. Grant access in Settings."
    );
  }

  if (!shouldRegisterForAllPages) {
    if (registeredForAllPages) {
      await chrome.scripting.unregisterContentScripts({
        ids: [PAGE_SURFACE_SCRIPT_ID]
      });
    }
    await cleanupDisallowedPageSurfaceTabs(resolvedSettings);
    return;
  }

  if (registeredForAllPages) {
    return;
  }

  await chrome.scripting.registerContentScripts([
    {
      id: PAGE_SURFACE_SCRIPT_ID,
      js: [CONTENT_SCRIPT_FILE],
      matches: ALL_REGULAR_PAGE_MATCHES,
      excludeMatches: AI_PROVIDER_PAGE_MATCHES,
      runAt: "document_start"
    }
  ]);
}

async function cleanupDisallowedPageSurfaceTabs(settings: ExtensionSettings): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tabSupportsInteractivePage(tab) || pageSurfaceScopeAllowsUrl(settings.pageSurfaceScope, tab.url)) {
        return;
      }
      await bestEffortTabCleanup(tab, () =>
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          injectImmediately: true,
          func: installPageSurfaceCleanupGuard,
          args: [PAGE_SURFACE_HOST_IDS, PAGE_SURFACE_CLEANUP_FLAG]
        })
      );
    })
  );
}

async function handleScheduledProviderRefresh(provider: ProviderName): Promise<void> {
  if (scheduledProviderRefreshesInFlight.has(provider)) {
    return;
  }

  scheduledProviderRefreshesInFlight.add(provider);
  try {
    const settings = await getSettings();
    if (settings.capturePaused) return;
    if (!buildProviderRefreshAlarmPlan(settings).some((item) => item.provider === provider)) {
      await chrome.alarms.clear(providerRefreshAlarmName(provider));
      return;
    }

    if (isFreshHistorySyncInProgress(await getProviderHistorySyncState(provider))) {
      return;
    }

    const tab = await ensureProviderRefreshTab(provider);
    await handlePageVisit(
      {
        provider,
        pageUrl: tab.url ?? PROVIDER_START_URLS[provider]
      },
      tab.id
    );
  } catch (error) {
    console.warn(`SaveMyContext scheduled ${provider} refresh failed`, error);
  } finally {
    scheduledProviderRefreshesInFlight.delete(provider);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void initializeStorage().then(async () => {
    await chrome.alarms.create(OUTBOX_ALARM, { periodInMinutes: 1 });
    void flushCaptureOutbox();
    await syncProviderRefreshAlarms();
    try {
      await syncPageSurfaceContentScript();
    } catch (error) {
      console.warn("SaveMyContext page surfaces remain disabled", error);
    }
    await refreshBackendStatus(true);
  });
});

chrome.runtime.onStartup.addListener(() => {
  void initializeStorage().then(async () => {
    await chrome.alarms.create(OUTBOX_ALARM, { periodInMinutes: 1 });
    void flushCaptureOutbox();
    await syncProviderRefreshAlarms();
    try {
      await syncPageSurfaceContentScript();
    } catch (error) {
      console.warn("SaveMyContext page surfaces remain disabled", error);
    }
    await refreshBackendStatus(true);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearActiveChatContext(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" || typeof changeInfo.url === "string") {
    clearActiveChatContext(tabId);
  }

  if (changeInfo.status !== "complete") {
    return;
  }

  const pageUrl = changeInfo.url ?? tab.url;
  if (!pageUrl) {
    return;
  }

  const provider = detectProviderFromUrl(pageUrl);
  if (!provider) {
    return;
  }

  void enqueueTask(() =>
    handlePageVisit(
      {
        provider,
        pageUrl
      },
      tabId
    )
  );
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === OUTBOX_ALARM) {
    void flushCaptureOutbox();
    return;
  }
  const provider = providerFromRefreshAlarmName(alarm.name);
  if (!provider) {
    return;
  }
  void handleScheduledProviderRefresh(provider);
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "open-quick-search") {
    return;
  }
  void openQuickSearchInActiveTab();
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (["GET_DELIVERY_STATUS", "SET_CAPTURE_PAUSED", "IMPORT_ACTIVE_HISTORY", "ACCEPT_CAPTURE_CONSENT", "CLEAR_CAPTURE_QUEUE"].includes(message.type)) {
    // These controls belong to extension pages, never the provider page bridge.
    if (!_sender.url?.startsWith(chrome.runtime.getURL(""))) {
      sendResponse({ ok: false, error: "Extension page required" }); return false;
    }
    void (async () => {
      if (message.type === "GET_DELIVERY_STATUS") return { pending: await captureOutbox.count() };
      if (message.type === "ACCEPT_CAPTURE_CONSENT") {
        await acceptCaptureConsent(message.backendUrl);
        void flushCaptureOutbox();
        return { ok: true };
      }
      if (message.type === "CLEAR_CAPTURE_QUEUE") {
        await saveSettings({ capturePaused: true });
        await enqueueTask(async () => {
          await captureDrain;
          await captureOutbox.clear();
        });
        return { ok: true };
      }
      if (message.type === "SET_CAPTURE_PAUSED") {
        if (!message.paused && !(await getSettings()).captureConsentGranted) return { ok: false, error: "Review and enable capture first" };
        await saveSettings({ capturePaused: Boolean(message.paused) });
        if (!message.paused) void flushCaptureOutbox();
        return { ok: true, paused: Boolean(message.paused) };
      }
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const provider = tab?.url ? detectProviderFromUrl(tab.url) : null;
      if (!provider || !supportsProactiveHistorySync(provider)) return { triggered: false, reason: "Open a supported provider first" };
      return enqueueTask(() => handlePageVisit({ provider, pageUrl: tab.url! }, tab.id, true));
    })().then(sendResponse).catch(() => sendResponse({ ok: false, error: "Could not complete the extension action" }));
    return true;
  }
  if (message.type === "NETWORK_CAPTURE") {
    void enqueueTask(() => handleCapture(message.payload, _sender.tab?.id))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("SaveMyContext capture failed", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    return true;
  }

  if (message.type === "PAGE_VISIT") {
    void enqueueTask(() => handlePageVisit(message.payload, _sender.tab?.id)).then(sendResponse);
    return true;
  }

  if (message.type === "HISTORY_SYNC_STATUS") {
    void enqueueTask(() => handleHistorySyncStatus(message.payload))
      .then(sendResponse)
      .catch((error) => {
        console.error("SaveMyContext history sync status update failed", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    return true;
  }

  if (message.type === "GET_SETTINGS") {
    void getSettings().then(settings => sendResponse(_sender.url?.startsWith(chrome.runtime.getURL(""))
      ? settings : { ...settings, backendToken: "" }));
    return true;
  }

  if (message.type === "SAVE_SETTINGS") {
    if (!_sender.url?.startsWith(chrome.runtime.getURL(""))) {
      sendResponse({ ok: false, error: "Extension page required" }); return false;
    }
    void enqueueTask(() => handleSaveSettings(message.payload))
      .then(sendResponse)
      .catch((error) => {
        console.error("SaveMyContext settings save failed", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies SaveSettingsResponse);
      });
    return true;
  }

  if (message.type === "SAVE_CONNECTION_BUNDLE") {
    if (!_sender.url?.startsWith(chrome.runtime.getURL(""))) {
      sendResponse({ ok: false, error: "Extension page required" }); return false;
    }
    void enqueueTask(() => handleSaveConnectionBundle(message.payload))
      .then(sendResponse)
      .catch((error) => {
        console.error("SaveMyContext connection enrollment failed", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies SaveConnectionBundleResponse);
      });
    return true;
  }

  if (message.type === "GET_STATUS") {
    void refreshBackendStatus(false).then(sendResponse);
    return true;
  }

  if (message.type === "SAVE_SOURCE_CAPTURE") {
    void enqueueTask(() => handleSaveSourceCapture(message.payload))
      .then(sendResponse)
      .catch((error) => {
        console.error("SaveMyContext source capture failed", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies SourceCaptureResponse);
      });
    return true;
  }

  if (message.type === "SAVE_CURRENT_PAGE_SOURCE") {
    void enqueueTask(() => handleSaveCurrentPageSource(message.payload?.saveMode ?? "raw"))
      .then(sendResponse)
      .catch((error) => {
        console.error("SaveMyContext page capture failed", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies SourceCaptureResponse);
      });
    return true;
  }

  if (message.type === "DUMP_ACTIVE_CHAT_MARKDOWN") {
    void enqueueTask(() => handleDumpActiveChatMarkdown())
      .then(sendResponse)
      .catch((error) => {
        console.error("SaveMyContext chat markdown dump failed", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies ActiveChatMarkdownDumpResponse);
      });
    return true;
  }

  if (message.type === "OPEN_QUICK_SEARCH") {
    void openQuickSearchInActiveTab().then(sendResponse);
    return true;
  }

  if (message.type === "SEARCH_KNOWLEDGE") {
    void handleKnowledgeSearch(message.payload).then(sendResponse);
    return true;
  }

  if (message.type === "GET_ACTIVE_CHAT_CONTEXT") {
    sendResponse(handleGetActiveChatContext(_sender, message.payload));
    return false;
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
      console.warn(`SaveMyContext provider matcher failed for ${provider.provider}`, error);
    }
  }

  return null;
}

function extractExternalSessionIds(
  provider: ProviderName,
  sessionStates: Record<
    string,
    {
      seenMessageIds: string[];
      lastSyncedAt?: string;
      indexingRuleDecision?: "indexed" | "skipped" | "discarded";
      indexingRuleFingerprint?: string;
    }
  >,
  settings: ExtensionSettings
): string[] {
  const prefix = `${provider}:`;
  const fingerprint = indexingRulesFingerprint(settings);
  return Object.keys(sessionStates)
    .filter((sessionKey) => {
      if (!sessionKey.startsWith(prefix)) {
        return false;
      }
      const state = sessionStates[sessionKey];
      if (state?.lastSyncedAt) {
        return true;
      }
      return state?.indexingRuleDecision === "skipped" && state?.indexingRuleFingerprint === fingerprint;
    })
    .map((sessionKey) => sessionKey.slice(prefix.length))
    .filter(Boolean);
}

async function handlePageVisit(
  payload: { provider: ProviderName; pageUrl: string },
  tabId: number | undefined,
  explicit = false
): Promise<{ triggered: boolean; reason?: string }> {
  clearActiveChatContext(tabId);
  const settings = await getSettings();
  if (settings.capturePaused) return { triggered: false, reason: "Capture paused" };
  const backendStatus = await refreshBackendStatus(false);
  if (backendStatus.backendValidationError) {
    return { triggered: false, reason: "backend-unavailable" };
  }
  if (!settings.enabledProviders[payload.provider]) {
    return { triggered: false, reason: "provider-disabled" };
  }
  if (!settings.autoSyncHistory && !explicit) {
    return { triggered: false, reason: "auto-sync-disabled" };
  }
  if (!supportsProactiveHistorySync(payload.provider)) {
    const activeProviders = await getActiveHistorySyncProviders({ [payload.provider]: false });
    await setExtensionStatus({
      autoSyncHistory: settings.autoSyncHistory,
      historySyncInProgress: activeProviders.length > 0,
      historySyncActiveProviders: activeProviders,
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
  if (isFreshHistorySyncInProgress(currentState)) {
    return { triggered: false, reason: "already-in-progress" };
  }

  const activeWatermarks = activeHistoryWatermarks(payload.provider, currentState, backendStatus.providerDriftAlert);
  const hasExistingHistoryWatermark = Boolean(activeWatermarks?.length);
  const syncedSessionIds = hasExistingHistoryWatermark
    ? undefined
    : extractExternalSessionIds(payload.provider, await getProviderSessionSyncStates(payload.provider), settings);
  const previousTopSessionIds = activeWatermarks;
  const now = new Date().toISOString();
  await saveProviderHistorySyncState(payload.provider, {
    ...currentState,
    inProgress: true,
    lastStartedAt: now,
    lastPageUrl: payload.pageUrl,
    processedCount: 0,
    totalCount: undefined,
    skippedCount: 0
  });
  const activeProviders = await getActiveHistorySyncProviders({ [payload.provider]: true });
  await setExtensionStatus({
    autoSyncHistory: settings.autoSyncHistory,
    historySyncInProgress: activeProviders.length > 0,
    historySyncActiveProviders: activeProviders,
    historySyncProvider: payload.provider,
    historySyncLastStartedAt: now,
    historySyncLastPageUrl: payload.pageUrl,
    historySyncLastResult: undefined,
    historySyncLastError: null,
    historySyncProcessedCount: 0,
    historySyncTotalCount: undefined,
    historySyncSkippedCount: 0
  });

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "TRIGGER_HISTORY_SYNC",
      payload: {
        provider: payload.provider,
        syncedSessionIds,
        historyFingerprints: Object.fromEntries(Object.values(await getProviderSessionSyncStates(payload.provider))
          .filter((s) => s.historyItemKey && s.historyFingerprint && s.lastSyncedAt &&
            Date.now() - Date.parse(s.lastSyncedAt) < 24 * 60 * 60 * 1000)
          .map((s) => [s.historyItemKey!, s.historyFingerprint!])),
        previousTopSessionId: previousTopSessionIds?.[0],
        previousTopSessionIds
      }
    } satisfies RuntimeMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await saveProviderHistorySyncState(payload.provider, {
      ...currentState,
      inProgress: false,
      lastPageUrl: payload.pageUrl
    });
    const activeProviders = await getActiveHistorySyncProviders({ [payload.provider]: false });
    await setExtensionStatus({
      historySyncInProgress: activeProviders.length > 0,
      historySyncActiveProviders: activeProviders,
      historySyncProvider: payload.provider,
      historySyncLastPageUrl: payload.pageUrl,
      historySyncLastResult: "failed",
      historySyncLastError: `Could not reach the page context: ${message}`
    });
    return { triggered: false, reason: "message-delivery-failed" };
  }

  return { triggered: true };
}

async function handleHistorySyncStatus(update: HistorySyncUpdate): Promise<{ ok: true }> {
  if (update.phase === "started" && update.runId) {
    historySyncRunErrors.delete(update.runId);
  }

  const currentState = await getProviderHistorySyncState(update.provider);
  const currentStatus = await getStatus();
  const existingTopSessionIds =
    currentState.lastTopSessionIds ??
    (currentState.lastTopSessionId ? [currentState.lastTopSessionId] : undefined);
  const nextTopSessionIds = update.topSessionIds ?? (update.topSessionId ? [update.topSessionId] : existingTopSessionIds);
  const basePatch = {
    ...currentState,
    lastPageUrl: update.pageUrl,
    lastDriftAlert: update.providerDriftAlert ?? currentState.lastDriftAlert
  };
  const watermarkPatch = {
    lastTopSessionId: update.topSessionId ?? update.topSessionIds?.[0] ?? currentState.lastTopSessionId,
    lastTopSessionIds: nextTopSessionIds
  };

  if (update.phase === "started") {
    const startedAt = currentState.lastStartedAt ?? new Date().toISOString();
    await saveProviderHistorySyncState(update.provider, {
      ...basePatch,
      inProgress: true,
      lastStartedAt: startedAt,
      processedCount: update.processedCount ?? currentState.processedCount,
      totalCount: update.totalCount ?? currentState.totalCount,
      skippedCount: update.skippedCount ?? currentState.skippedCount
    });
    const activeProviders = await getActiveHistorySyncProviders({ [update.provider]: true });
    await setExtensionStatus({
      historySyncInProgress: activeProviders.length > 0,
      historySyncActiveProviders: activeProviders,
      historySyncProvider: update.provider,
      historySyncLastStartedAt: startedAt,
      historySyncLastPageUrl: update.pageUrl,
      historySyncLastResult: undefined,
      historySyncLastError: null,
      historySyncProcessedCount: update.processedCount ?? currentState.processedCount,
      historySyncTotalCount: update.totalCount ?? currentState.totalCount,
      historySyncSkippedCount: update.skippedCount ?? currentState.skippedCount
    });
    return { ok: true };
  }

  const completedAt = new Date().toISOString();
  if (update.phase === "completed") {
    await flushCaptureOutbox();
    // An earlier drain may have listed its batch before later captures arrived.
    if ((await captureOutbox.list()).some((item) => item.payload.raw_capture.historySyncRunId === update.runId)) {
      await flushCaptureOutbox();
    }
  }
  const pendingRun = update.runId && (await captureOutbox.list()).some(
    (item) => item.payload.raw_capture.historySyncRunId === update.runId
  );
  const runError = (update.runId ? historySyncRunErrors.get(update.runId) : undefined) ||
    (pendingRun ? "Delivery pending in durable outbox; history watermark was not advanced." : undefined);
  if (update.runId) {
    historySyncRunErrors.delete(update.runId);
  }

  if (update.phase === "completed") {
    if (runError) {
      await saveProviderHistorySyncState(update.provider, {
        ...basePatch,
        inProgress: false,
        lastCompletedAt: completedAt
      });
      const activeProviders = await getActiveHistorySyncProviders({ [update.provider]: false });
      await setExtensionStatus({
        historySyncInProgress: activeProviders.length > 0,
        historySyncActiveProviders: activeProviders,
        historySyncProvider: update.provider,
        historySyncLastCompletedAt: completedAt,
        historySyncLastPageUrl: update.pageUrl,
        historySyncLastResult: "failed",
        historySyncLastError: runError,
        providerDriftAlert: update.providerDriftAlert ?? currentStatus.providerDriftAlert
      });
      return { ok: true };
    }

    const processedCount = update.processedCount ?? update.totalCount ?? currentState.processedCount;
    const totalCount = update.totalCount ?? currentState.totalCount;
    const skippedCount = update.skippedCount ?? currentState.skippedCount;
    const providerDriftAlert =
      update.providerDriftAlert ?? clearRecoveredProviderDriftAlert(currentStatus.providerDriftAlert, update.provider);
    const providerStateDriftAlert =
      update.providerDriftAlert ?? clearRecoveredProviderDriftAlert(currentState.lastDriftAlert, update.provider);
    await saveProviderHistorySyncState(update.provider, {
      ...basePatch,
      ...(shouldCommitHistoryWatermark(update, runError) ? watermarkPatch : {}),
      inProgress: false,
      lastCompletedAt: completedAt,
      lastConversationCount: update.conversationCount ?? currentState.lastConversationCount,
      processedCount,
      totalCount,
      skippedCount,
      lastDriftAlert: providerStateDriftAlert
    });
    const activeProviders = await getActiveHistorySyncProviders({ [update.provider]: false });
    await setExtensionStatus({
      historySyncInProgress: activeProviders.length > 0,
      historySyncActiveProviders: activeProviders,
      historySyncProvider: update.provider,
      historySyncLastCompletedAt: completedAt,
      historySyncLastConversationCount: update.conversationCount,
      historySyncLastPageUrl: update.pageUrl,
      historySyncLastResult: "success",
      historySyncLastError: null,
      historySyncProcessedCount: processedCount,
      historySyncTotalCount: totalCount,
      historySyncSkippedCount: skippedCount,
      providerDriftAlert
    });
    return { ok: true };
  }

  if (update.phase === "unsupported") {
    const processedCount = update.processedCount ?? currentState.processedCount;
    const totalCount = update.totalCount ?? currentState.totalCount;
    const skippedCount = update.skippedCount ?? currentState.skippedCount;
    const providerStateDriftAlert = clearRecoveredProviderDriftAlert(currentState.lastDriftAlert, update.provider);
    await saveProviderHistorySyncState(update.provider, {
      ...basePatch,
      inProgress: false,
      lastCompletedAt: completedAt,
      processedCount,
      totalCount,
      skippedCount,
      lastDriftAlert: providerStateDriftAlert
    });
    const activeProviders = await getActiveHistorySyncProviders({ [update.provider]: false });
    await setExtensionStatus({
      historySyncInProgress: activeProviders.length > 0,
      historySyncActiveProviders: activeProviders,
      historySyncProvider: update.provider,
      historySyncLastCompletedAt: completedAt,
      historySyncLastPageUrl: update.pageUrl,
      historySyncLastResult: "unsupported",
      historySyncLastError: update.message ?? null,
      historySyncProcessedCount: processedCount,
      historySyncTotalCount: totalCount,
      historySyncSkippedCount: skippedCount,
      providerDriftAlert: clearRecoveredProviderDriftAlert(currentStatus.providerDriftAlert, update.provider)
    });
    return { ok: true };
  }

  const processedCount = update.processedCount ?? currentState.processedCount;
  const totalCount = update.totalCount ?? currentState.totalCount;
  const skippedCount = update.skippedCount ?? currentState.skippedCount;
  const providerDriftAlert = update.providerDriftAlert ?? currentStatus.providerDriftAlert;
  const providerStateDriftAlert = update.providerDriftAlert ?? currentState.lastDriftAlert;
  await saveProviderHistorySyncState(update.provider, {
    ...basePatch,
    inProgress: false,
    lastCompletedAt: completedAt,
    processedCount,
    totalCount,
    skippedCount,
    lastDriftAlert: providerStateDriftAlert
  });
  const activeProviders = await getActiveHistorySyncProviders({ [update.provider]: false });
  await setExtensionStatus({
    historySyncInProgress: activeProviders.length > 0,
    historySyncActiveProviders: activeProviders,
    historySyncProvider: update.provider,
    historySyncLastCompletedAt: completedAt,
    historySyncLastPageUrl: update.pageUrl,
    historySyncLastResult: "failed",
    historySyncLastError: update.message ?? "History sync failed.",
    historySyncProcessedCount: processedCount,
    historySyncTotalCount: totalCount,
    historySyncSkippedCount: skippedCount,
    providerDriftAlert
  });
  return { ok: true };
}

async function handleCapture(event: CapturedNetworkEvent, tabId?: number): Promise<void> {

  const settings = await getSettings();
  if (settings.capturePaused) {
    if (event.historySyncRunId) historySyncRunErrors.set(event.historySyncRunId, "Capture paused during import; retry after resuming.");
    return;
  }
  const scraper = findMatchingProvider(event);
  if (!scraper || !settings.enabledProviders[scraper.provider]) {
    return;
  }

  const snapshot = scraper.parse(event);
  if (!snapshot || !snapshot.messages.length) {
    if (event.captureMode === "full_snapshot") {
      const message = "History capture could not be decoded safely. Recapture or inspect provider drift; no transcript was replaced.";
      if (event.historySyncRunId) historySyncRunErrors.set(event.historySyncRunId, message);
      await setExtensionStatus({ lastError: message });
    }
    return;
  }
  if (typeof tabId === "number") {
    rememberActiveChatContext(tabId, snapshot, event.pageUrl);
  }

  const sessionKey = `${snapshot.provider}:${snapshot.externalSessionId}`;
  const accountDecision = accountAllowedBySettings(settings, snapshot);
  if (!accountDecision.allowed) {
    const syncState = await getSessionSyncState(sessionKey);
    await saveSessionSyncState(sessionKey, {
      ...syncState,
      indexingRuleDecision: "skipped",
      indexingRuleReason: accountDecision.reason
    });
    await setExtensionStatus({
      backendUrl: settings.backendUrl.replace(/\/$/, ""),
      lastProvider: snapshot.provider,
      lastSessionKey: sessionKey,
      lastIndexingDecision: "skipped",
      lastIndexingReason: accountDecision.reason,
      lastError: null,
      autoSyncHistory: settings.autoSyncHistory
    });
    return;
  }
  const syncState = await getSessionSyncState(sessionKey);
  const indexingDecision = evaluateIndexingRules(settings, snapshot);
  const indexingFingerprint = indexingRulesFingerprint(settings);
  if (!indexingDecision.shouldIndex) {
    await saveSessionSyncState(sessionKey, {
      ...syncState,
      indexingRuleDecision: "skipped",
      indexingRuleFingerprint: indexingFingerprint,
      indexingRuleReason: indexingDecision.reason
    });
    await setExtensionStatus({
      backendUrl: settings.backendUrl.replace(/\/$/, ""),
      lastProvider: snapshot.provider,
      lastSessionKey: sessionKey,
      lastIndexingDecision: "skipped",
      lastIndexingReason: indexingDecision.reason,
      lastError: null,
      autoSyncHistory: settings.autoSyncHistory
    });
    return;
  }
  const payload = await buildIngestPayload(snapshot, event, syncState);
  if (!payload) {
    return;
  }

  const discardDecision = evaluateDiscardWords(settings, snapshot);
  if (discardDecision.matched) {
    payload.route_to_discard = true;
    payload.discard_word_match = discardDecision.matchedWord;
  }

  const backendUrl = settings.backendUrl.replace(/\/$/, "");
  await enqueueCapture(captureOutbox, backendUrl, payload);
  await chrome.alarms.create(OUTBOX_ALARM, { periodInMinutes: 1 });
  await setExtensionStatus({ pendingCaptureCount: await captureOutbox.count() });
  void flushCaptureOutbox();
}

function flushCaptureOutbox(): Promise<void> {
  captureDrain ??= deliverCaptureOutbox().catch(async () => {
    await setExtensionStatus({ lastError: "Capture outbox unavailable; delivery will retry." });
  }).finally(() => { captureDrain = null; });
  return captureDrain;
}

async function deliverCaptureOutbox(): Promise<void> {
  const settings = await getSettings();
  if (settings.capturePaused) return;
  const backendUrl = settings.backendUrl.replace(/\/$/, "");
  try {
    await drainCaptures(captureOutbox, backendUrl, async ({ payload }) => {
      // Recheck between deliveries: pause, destination, token, and account filters
      // can change while a long import is draining. An in-flight request may finish.
      const settings = await getSettings();
      if (settings.capturePaused || settings.backendUrl.replace(/\/$/, "") !== backendUrl) {
        throw new Error("Capture delivery paused; queued evidence retained locally.");
      }
      const snapshot: NormalizedSessionSnapshot = {
        provider: payload.provider, externalSessionId: payload.external_session_id,
        accountKey: payload.account_key, accountLabel: payload.account_label,
        sourceUrl: payload.source_url, capturedAt: payload.captured_at, title: payload.title,
        messages: payload.messages.map((message) => ({
          id: message.external_message_id, role: message.role, content: message.content,
          parentId: message.parent_external_message_id, occurredAt: message.occurred_at
        }))
      };
      if (!settings.enabledProviders[payload.provider] || !accountAllowedBySettings(settings, snapshot).allowed ||
          !indexingAllowsCapture(settings, payload)) {
        throw new Error("Capture delivery paused by current provider/account settings; evidence retained locally.");
      }
      const response = await fetch(`${backendUrl}/api/v1/ingest/diff`, {
        method: "POST",
        headers: buildBackendHeaders(settings),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) throw new Error(`Backend responded ${response.status}; capture retained for retry.`);
      const receipt = await response.json();
      requireCaptureReceipt(payload, receipt);
      const sessionKey = `${payload.provider}:${payload.external_session_id}`;
      const syncState = await getSessionSyncState(sessionKey);
      if (receipt.disposition !== "quarantined") {
        await saveSessionSyncState(sessionKey, {
          ...syncState,
          seenMessageIds: mergeSeenMessageIds(syncState.seenMessageIds, snapshot.messages),
          projectFingerprint: payload.provider_project === undefined ? syncState.projectFingerprint : JSON.stringify(payload.provider_project),
          historyItemKey: payload.raw_capture.historyItemKey ?? syncState.historyItemKey,
          historyFingerprint: payload.raw_capture.historyFingerprint ?? syncState.historyFingerprint,
          messageFingerprints: await mergeMessageFingerprints(syncState.messageFingerprints, snapshot.messages),
          lastSyncedAt: new Date().toISOString(),
          indexingRuleDecision: payload.route_to_discard ? "discarded" : "indexed",
          indexingRuleFingerprint: indexingRulesFingerprint(settings),
          discardWordMatch: payload.discard_word_match
        });
      } else if (payload.raw_capture.historySyncRunId) {
        historySyncRunErrors.set(payload.raw_capture.historySyncRunId, "Capture needs repair; evidence preserved.");
      }
      await setExtensionStatus({
        backendUrl, lastProvider: payload.provider, lastSessionKey: sessionKey,
        lastSuccessAt: new Date().toISOString(), lastSyncedMessageCount: payload.messages.length,
        lastError: receipt.disposition === "quarantined" ? "Capture needs repair; original evidence preserved on backend." : null
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const item of await captureOutbox.list()) {
      if (item.payload.raw_capture.historySyncRunId) {
        historySyncRunErrors.set(item.payload.raw_capture.historySyncRunId, "Delivery pending in durable outbox.");
      }
    }
    await setExtensionStatus({ backendUrl, lastError: message });
  }
  await setExtensionStatus({ pendingCaptureCount: await captureOutbox.count() });
}

async function handleSaveSettings(update: Partial<ExtensionSettings>): Promise<SaveSettingsResponse> {
  if (update.workspaceUrl !== undefined) {
    try { update.workspaceUrl = validateWorkspaceUrl(update.workspaceUrl); }
    catch { return { ok: false, error: "Workspace URL must be HTTPS or local HTTP, without credentials, query, or fragment." }; }
  }
  const currentSettings = await getSettings();
  const candidateSettings: ExtensionSettings = {
    ...currentSettings,
    ...update
  };
  if (
    normalizePageSurfaceScope(candidateSettings.pageSurfaceScope) === "all_pages" &&
    !(await hasOptionalHostPermissions(ALL_REGULAR_PAGE_MATCHES))
  ) {
    return {
      ok: false,
      error: "Grant optional access to regular HTTP and HTTPS pages before enabling all-page surfaces."
    };
  }
  backendValidationGeneration += 1;
  backendValidationInFlight = null;
  backendValidationInFlightKey = "";

  try {
    const { normalizedUrl, capabilities } = await validateBackendConfiguration(candidateSettings);
    const saved = await saveSettings({
      ...update,
      backendUrl: normalizedUrl
    });
    if (indexingRulesFingerprint(currentSettings) !== indexingRulesFingerprint(saved)) {
      await clearProviderHistorySyncStates();
    }
    await syncProviderRefreshAlarms(saved);
    await syncPageSurfaceContentScript(saved);
    await saveBackendValidation(capabilities, null);
    backendValidationLastKey = backendValidationCacheKey(saved);
    backendValidationLastCompletedAt = Date.now();
    await setExtensionStatus({
      backendUrl: normalizedUrl,
      autoSyncHistory: saved.autoSyncHistory,
      backendValidatedAt: new Date().toISOString(),
      backendProduct: capabilities.product,
      backendVersion: capabilities.version,
      backendAuthMode: capabilities.auth.mode,
      backendValidationError: null,
      backendMarkdownRoot: capabilities.storage.markdown_root ?? undefined,
      backendVaultRoot: capabilities.storage.vault_root ?? undefined,
    });
    return {
      ok: true,
      settings: saved,
      capabilities
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await saveBackendValidation(null, message);
    await setExtensionStatus({
      backendUrl: candidateSettings.backendUrl.trim().replace(/\/$/, "") || candidateSettings.backendUrl,
      autoSyncHistory: candidateSettings.autoSyncHistory,
      backendValidationError: message,
      backendMarkdownRoot: undefined,
      backendVaultRoot: undefined,
    });
    return {
      ok: false,
      error: message
    };
  }
}

async function handleSaveConnectionBundle(payload: {
  connectionString: string;
  verificationCode?: string;
  settings: Partial<ExtensionSettings>;
}): Promise<SaveConnectionBundleResponse> {
  const bundle = parseConnectionString(payload.connectionString);
  const redeemed = await redeemConnectionBundle(bundle, {
    installationId: await getInstallationId(),
    clientName: await extensionClientName(),
    verificationCode: payload.verificationCode
  });
  const response = await handleSaveSettings({
    ...payload.settings,
    backendUrl: bundle.baseUrl,
    backendToken: redeemed.token
  });
  return {
    ...response,
    redeemed
  };
}
