import { BRIDGE_CONNECT_SOURCE, MAIN_WORLD_READY_ATTRIBUTE } from "../shared/bridge";
import type {
  BridgeToExtensionMessage,
  BridgeToPageMessage,
  CapturedBody,
  CapturedNetworkEvent,
  HistorySyncControlPayload,
  HistorySyncUpdate,
  MainWorldControlPayload,
  ProviderDriftAlert,
  ProviderName
} from "../shared/types";
import { chatGPTReader, discoverChatGPTProjects } from "./chatgpt-projects";
import { discoverChatGPTHistory } from "./chatgpt-history";
import { CaptureReceipts } from "./capture-receipts";
import { MAX_CAPTURE_BYTES, observeResponse, readBoundedResponse } from "./response-observer";
import { authorizedHistoryFetch, setHistoryCaptureEnabled } from "./capture-permission";

import { buildProviderDriftAlert, createProviderDriftError, isProviderDriftError } from "./drift";
import { maybeUpdateGeminiRuntimeContext, runGeminiHistorySync } from "./gemini-history";
import { runGrokHistorySync } from "./grok-history";
import {
  countRetryableHistoryFailures,
  dedupeIds,
  normalizeHistorySessionIds,
  runWithConcurrency
} from "./history-shared";

const OBSERVER_FLAG = "__SAVEMYCONTEXT_NETWORK_OBSERVER__";
let captureEnabled = false;
const captureReceipts = new CaptureReceipts();
function handleControlPayload(payload: MainWorldControlPayload): void {
  if (payload.type === "SET_CAPTURE_ENABLED") {
    captureEnabled = payload.enabled === true;
    setHistoryCaptureEnabled(captureEnabled);
    if (!captureEnabled) { pendingBridgeMessages.length = 0; captureReceipts.cancel(); }
  }
  if (payload.type === "START_HISTORY_SYNC" && captureEnabled) void runHistorySync(payload);
}
const INTERESTING_PATH =
  /backend-api|conversation|conversations|BardFrontendService|StreamGenerate|batchexecute|app-chat|grok|chat/i;
const CHATGPT_HISTORY_DETAIL_CONCURRENCY = 4;
const CHATGPT_ORIGIN = "https://chatgpt.com";
const nativeFetch = window.fetch.bind(window);
let bridgePort: MessagePort | null = null;
const pendingBridgeMessages: BridgeToExtensionMessage[] = [];

interface TrackedXHR extends XMLHttpRequest {
  __savemycontextMethod?: string;
  __savemycontextUrl?: string;
}

type JsonRecord = Record<string, unknown>;

const activeHistorySyncs = new Set<ProviderName>();

function createHistorySyncRunId(provider: ProviderName): string {
  return `${provider}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeJsonParse(text?: string): unknown {
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function isChatGPTHostname(hostname: string): boolean {
  return hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com") || hostname === "chat.openai.com";
}

function providerHintFromUrl(url: string): ProviderName | undefined {
  try {
    const hostname = new URL(url, location.href).hostname;
    if (isChatGPTHostname(hostname)) {
      return "chatgpt";
    }
    if (/gemini\.google\.com/.test(hostname)) {
      return "gemini";
    }
    if (hostname === "grok.com" || hostname.endsWith(".grok.com")) {
      return "grok";
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function currentProvider(): ProviderName | null {
  return providerHintFromUrl(location.href) ?? null;
}

function shouldCapture(url: string): boolean {
  try {
    const resolved = new URL(url, location.href);
    if (!providerHintFromUrl(resolved.href)) return false;
    if (isChatGPTHostname(resolved.hostname)) {
      return /^\/backend-api\/conversation(?:\/[^/]+)?\/?$/.test(resolved.pathname);
    }
    return INTERESTING_PATH.test(resolved.pathname + resolved.search);
  } catch {
    return false;
  }
}

function flushPendingBridgeMessages(): void {
  if (!bridgePort || !pendingBridgeMessages.length) {
    return;
  }
  while (pendingBridgeMessages.length) {
    bridgePort.postMessage(pendingBridgeMessages.shift()!);
  }
}

function postToExtension(message: BridgeToExtensionMessage): void {
  if (!bridgePort) {
    pendingBridgeMessages.push(message);
    return;
  }
  bridgePort.postMessage(message);
}

function attachBridgePort(port: MessagePort): void {
  bridgePort = port;
  bridgePort.onmessage = (event: MessageEvent<BridgeToPageMessage>) => {
    if (event.data?.type === "CAPTURE_RECEIPT") {
      captureReceipts.acknowledge(event.data.requestId, event.data.ok === true);
      return;
    }
    if (event.data?.type !== "CONTROL") {
      return;
    }
    handleControlPayload(event.data.payload);
  };
  bridgePort.start();
  document.documentElement?.setAttribute(MAIN_WORLD_READY_ATTRIBUTE, "1");
  bridgePort.postMessage({ type: "BRIDGE_READY" });
  flushPendingBridgeMessages();
}

function postCapture(capture: Omit<CapturedNetworkEvent, "source">): void {
  if (!captureEnabled) return;
  const payload = {
    ...capture,
    source: "savemycontext-network-observer"
  } satisfies CapturedNetworkEvent;
  postToExtension({
    type: "NETWORK_CAPTURE",
    payload
  });
}

async function postCaptureDurably(capture: Omit<CapturedNetworkEvent, "source">): Promise<void> {
  if (!captureEnabled) throw new Error("Capture paused.");
  await captureReceipts.wait(capture.requestId, () => postCapture(capture));
}

function postHistorySyncStatus(update: HistorySyncUpdate): void {
  postToExtension({
    type: "HISTORY_SYNC_STATUS",
    payload: update
  });
}

function postHistorySyncProgress(
  provider: ProviderName,
  runId: string,
  processedCount: number,
  totalCount: number,
  skippedCount: number,
  topSessionId?: string,
  message?: string
): void {
  postHistorySyncStatus({
    provider,
    phase: "started",
    runId,
    processedCount,
    totalCount,
    skippedCount,
    topSessionId,
    pageUrl: location.href,
    message
  });
}

async function serializeBody(body: unknown): Promise<CapturedBody | undefined> {
  if (!body) {
    return undefined;
  }

  if (typeof body === "string") {
    if (body.length > MAX_CAPTURE_BYTES) return undefined;
    return {
      text: body,
      json: safeJsonParse(body)
    };
  }

  if (body instanceof URLSearchParams) {
    return serializeBody(body.toString());
  }

  if (body instanceof Blob) {
    if (body.size > MAX_CAPTURE_BYTES) return undefined;
    return serializeBody(await body.text());
  }

  if (body instanceof FormData) {
    const json: Record<string, string[]> = {};
    body.forEach((value, key) => {
      const nextValue = typeof value === "string" ? value : value.name;
      json[key] = [...(json[key] ?? []), nextValue];
    });
    return {
      text: JSON.stringify(json),
      json
    };
  }

  if (body instanceof ArrayBuffer) {
    if (body.byteLength > MAX_CAPTURE_BYTES) return undefined;
    return serializeBody(new TextDecoder().decode(new Uint8Array(body)));
  }

  if (ArrayBuffer.isView(body)) {
    if (body.byteLength > MAX_CAPTURE_BYTES) return undefined;
    return serializeBody(new TextDecoder().decode(body));
  }

  return undefined;
}

async function readFetchRequestBody(input: RequestInfo | URL, init?: RequestInit): Promise<CapturedBody | undefined> {
  if (init?.body) {
    // Schedule parsing after native fetch has been dispatched.
    return Promise.resolve().then(() => serializeBody(init.body));
  }

  if (input instanceof Request) {
    try {
      return serializeBody(await readBoundedResponse(new Response(input.clone().body)));
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function patchFetch(): void {
  window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // Preserve the native promise and avoid constructing Requests on the hot path.
    if (!captureEnabled) return nativeFetch(input, init);
    const candidate = input instanceof Request ? input.url : String(input);
    if (!shouldCapture(candidate)) return nativeFetch(input, init);

    const url = new URL(candidate, location.href).href;
    const pageUrl = location.href;
    const requestBodyPromise = readFetchRequestBody(input, init).catch(() => undefined);
    const responsePromise = nativeFetch(input, init);
    void responsePromise.then(response => {
      if (!captureEnabled) return;
      observeResponse(response, text => { void requestBodyPromise.then(requestBody => {
        if (!captureEnabled) return;
        maybeUpdateGeminiRuntimeContext(url, requestBody);
        postCapture({
          providerHint: providerHintFromUrl(url), pageUrl,
          requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          method: init?.method ?? (input instanceof Request ? input.method : "GET"),
          url, capturedAt: new Date().toISOString(), requestBody,
          response: { status: response.status, ok: response.ok,
            contentType: response.headers.get("content-type") ?? undefined, text, json: safeJsonParse(text) }
        });
      }).catch(() => undefined); }, () => postToExtension({ type: "CAPTURE_WARNING" }));
    }).catch(() => undefined); // Observation must never create an unhandled rejection.
    return responsePromise;
  };
}

function patchXHR(): void {
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(
    this: TrackedXHR,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ): void {
    this.__savemycontextMethod = method;
    this.__savemycontextUrl = String(url);
    return nativeOpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
  };

  XMLHttpRequest.prototype.send = function patchedSend(
    this: TrackedXHR,
    body?: Document | XMLHttpRequestBodyInit | null
  ): void {
    const url = this.__savemycontextUrl;
    const method = this.__savemycontextMethod ?? "GET";
    const pageUrl = location.href;

    if (captureEnabled && url && shouldCapture(url)) {
      const requestBodyPromise = serializeBody(body);
      this.addEventListener(
        "loadend",
        () => {
          void requestBodyPromise.then((requestBody) => {
            if (!captureEnabled) return;
            maybeUpdateGeminiRuntimeContext(url, requestBody);

            const text = this.responseType === "" || this.responseType === "text" ? this.responseText : "";
            if (new TextEncoder().encode(text).byteLength > MAX_CAPTURE_BYTES) return;
            postCapture({
              providerHint: providerHintFromUrl(url),
              pageUrl,
              requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
              method,
              url,
              capturedAt: new Date().toISOString(),
              requestBody,
              response: {
                status: this.status,
                ok: this.status >= 200 && this.status < 300,
                contentType: this.getResponseHeader("content-type") ?? undefined,
                text,
                json: safeJsonParse(text)
              }
            });
          });
        },
        { once: true }
      );
    }

    return nativeSend.call(this, body);
  };
}

async function fetchJsonWithText(
  url: string,
  init?: RequestInit
): Promise<{
  response: Response;
  text: string;
  json: unknown;
}> {
  const response = await authorizedHistoryFetch(url, init);
  const text = await readBoundedResponse(response, undefined, 30_000);
  return {
    response,
    text,
    json: safeJsonParse(text)
  };
}

function assertChatGPTPageOrigin(): void {
  if (!isChatGPTHostname(location.hostname)) {
    throw new Error(`ChatGPT history sync must run on chatgpt.com, not ${location.hostname || "an unknown host"}.`);
  }
}

function buildChatGPTUrl(path: string): URL {
  return new URL(path, CHATGPT_ORIGIN);
}

function buildChatGPTHistoryPageUrl(conversationId: string): string {
  return buildChatGPTUrl(`/c/${conversationId}`).toString();
}

function hasChatGPTConversationPayload(payload: unknown): boolean {
  const record = asRecord(payload);
  return Boolean(record && (asRecord(record.mapping) || Array.isArray(record.messages) || asRecord(record.message)));
}

async function withHistorySyncGuard(
  provider: ProviderName,
  runner: (runId: string) => Promise<void>
): Promise<void> {
  if (activeHistorySyncs.has(provider)) {
    return;
  }

  activeHistorySyncs.add(provider);
  const runId = createHistorySyncRunId(provider);
  try {
    await runner(runId);
  } finally {
    activeHistorySyncs.delete(provider);
  }
}

async function runChatGPTHistorySync(control?: HistorySyncControlPayload): Promise<void> {
  await withHistorySyncGuard("chatgpt", async (runId) => {
    postHistorySyncStatus({
      provider: "chatgpt",
      phase: "started",
      runId,
      pageUrl: location.href
    });

    try {
      assertChatGPTPageOrigin();

      const sessionResult = await fetchJsonWithText(buildChatGPTUrl("/api/auth/session").toString(), {
        method: "GET",
        credentials: "include",
        headers: {
          Accept: "application/json"
        }
      });
      const sessionJson = (sessionResult.json ?? {}) as JsonRecord;
      const accessToken =
        typeof sessionJson.accessToken === "string" && sessionJson.accessToken.trim()
          ? sessionJson.accessToken.trim()
          : null;

      const headers: HeadersInit = {
        Accept: "application/json"
      };
      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
      }

      const read = chatGPTReader(authorizedHistoryFetch, headers);
      const accountScope = asRecord(sessionJson.user)?.id;
      const account = typeof accountScope === "string" ? accountScope : undefined;
      const refreshSessionIds = normalizeHistorySessionIds("chatgpt", control?.refreshSessionIds);
      const ordinary = await discoverChatGPTHistory(read, account, control?.historyFingerprints, refreshSessionIds);
      const { topSessionId, pending: normalPending } = ordinary;
      const normalTotal = ordinary.items.size;
      const normalSkipped = normalTotal - normalPending.length;
      let projectFailure: unknown;
      const projectChats = await discoverChatGPTProjects(read, typeof accountScope === "string" ? accountScope : undefined).catch((error) => {
        projectFailure = error;
        return new Map<string, import("./chatgpt-projects").ProjectConversation>();
      });
      const projectPending = [...projectChats].filter(([id, item]) => refreshSessionIds.has(id) ||
        typeof accountScope !== "string" || !item.fingerprint || control?.historyFingerprints?.[item.key] !== item.fingerprint).map(([id]) => id);
      const pendingSessionIds = dedupeIds([...normalPending, ...projectPending]);
      const skippedCount = normalSkipped + projectChats.size - projectPending.length;
      const totalCount = Math.max(normalTotal, pendingSessionIds.length + skippedCount);

      let processedCount = skippedCount;
      let syncedConversationCount = 0;
      let driftFailureCount = 0;
      let firstDriftFailure: ProviderDriftAlert | null = null;
      postHistorySyncProgress("chatgpt", runId, processedCount, totalCount, skippedCount, topSessionId);

      await runWithConcurrency(pendingSessionIds, CHATGPT_HISTORY_DETAIL_CONCURRENCY, async (conversationId) => {
        try {
          const detailUrl = buildChatGPTUrl(`/backend-api/conversation/${conversationId}`);
          const detailResult = await read(detailUrl.toString());
          if (!detailResult.response.ok) {
            return;
          }
          if (!hasChatGPTConversationPayload(detailResult.json)) {
            throw createProviderDriftError(
              "chatgpt",
              "ChatGPT conversation detail no longer exposes a mapping or messages payload.",
              `conversationId=${conversationId}`
            );
          }

          await postCaptureDurably({
            historyFingerprints: Object.fromEntries([ordinary.items.get(conversationId), projectChats.get(conversationId)]
              .filter(item => item?.fingerprint).map(item => [item!.key, item!.fingerprint])),
            project: projectChats.get(conversationId)?.project,
            historyItemKey: projectChats.get(conversationId)?.key ?? ordinary.items.get(conversationId)?.key,
            historyFingerprint: projectChats.get(conversationId)?.fingerprint ?? ordinary.items.get(conversationId)?.fingerprint,
            providerHint: "chatgpt",
            captureMode: "full_snapshot",
            historySyncRunId: runId,
            pageUrl: buildChatGPTHistoryPageUrl(conversationId),
            requestId: `history-chatgpt-${conversationId}-${Date.now()}`,
            method: "GET",
            url: detailUrl.toString(),
            capturedAt: new Date().toISOString(),
            response: {
              status: detailResult.response.status,
              ok: detailResult.response.ok,
              contentType: detailResult.response.headers.get("content-type") ?? undefined,
              text: detailResult.text,
              json: detailResult.json
            }
          });
          syncedConversationCount += 1;
        } catch (error) {
          if (isProviderDriftError(error)) {
            driftFailureCount += 1;
            firstDriftFailure ??= buildProviderDriftAlert("chatgpt", location.href, error.message, error.evidence);
          }
          // Skip malformed individual conversations without aborting the whole run.
        } finally {
          processedCount += 1;
          postHistorySyncProgress("chatgpt", runId, processedCount, totalCount, skippedCount, topSessionId);
        }
      });

      const attemptedConversationCount = pendingSessionIds.length;
      if (projectFailure) throw projectFailure;
      const retryableFailureCount = countRetryableHistoryFailures(attemptedConversationCount, syncedConversationCount);
      let providerDriftAlert: ProviderDriftAlert | null = null;
      if (
        firstDriftFailure &&
        driftFailureCount > 0 &&
        (syncedConversationCount === 0 || driftFailureCount >= Math.max(2, Math.ceil(attemptedConversationCount / 2)))
      ) {
        const driftFailure = firstDriftFailure as ProviderDriftAlert;
        providerDriftAlert = buildProviderDriftAlert(
          "chatgpt",
          location.href,
          `ChatGPT history sync encountered provider drift symptoms in ${driftFailureCount} of ${attemptedConversationCount} conversations.`,
          driftFailure.evidence ?? driftFailure.message
        );
      }

      postHistorySyncStatus({
        provider: "chatgpt",
        phase: "completed",
        runId,
        conversationCount: syncedConversationCount,
        retryableFailureCount,
        processedCount: totalCount,
        totalCount,
        skippedCount,
        topSessionId,
        pageUrl: location.href,
        providerDriftAlert
      });
    } catch (error) {
      postHistorySyncStatus({
        provider: "chatgpt",
        phase: "failed",
        runId,
        pageUrl: location.href,
        message: error instanceof Error ? error.message : String(error),
        providerDriftAlert: isProviderDriftError(error)
          ? buildProviderDriftAlert("chatgpt", location.href, error.message, error.evidence)
          : null
      });
    }
  });
}

async function runManagedGeminiHistorySync(control?: HistorySyncControlPayload): Promise<void> {
  await withHistorySyncGuard("gemini", async (runId) => {
    await runGeminiHistorySync(control, {
      runId,
      postCapture: postCaptureDurably,
      postStatus: postHistorySyncStatus
    });
  });
}

async function runManagedGrokHistorySync(control?: HistorySyncControlPayload): Promise<void> {
  await withHistorySyncGuard("grok", async (runId) => {
    await runGrokHistorySync(control, {
      runId,
      postCapture: postCaptureDurably,
      postStatus: postHistorySyncStatus
    });
  });
}

async function runHistorySync(control?: HistorySyncControlPayload): Promise<void> {
  const provider = currentProvider();
  if (!provider) {
    return;
  }

  if (provider === "chatgpt") {
    await runChatGPTHistorySync(control);
    return;
  }

  if (provider === "gemini") {
    await runManagedGeminiHistorySync(control);
    return;
  }

  if (provider === "grok") {
    await runManagedGrokHistorySync(control);
  }
}

window.addEventListener("message", (event: MessageEvent<{ source?: string }>) => {
  if (event.source !== window) {
    return;
  }
  if (event.data?.source !== BRIDGE_CONNECT_SOURCE) {
    return;
  }
  const [port] = event.ports;
  if (!port) {
    return;
  }
  if (bridgePort) {
    port.close();
    return;
  }
  attachBridgePort(port);
});

const windowFlags = window as unknown as Record<string, unknown>;

if (!windowFlags[OBSERVER_FLAG]) {
  windowFlags[OBSERVER_FLAG] = true;
  patchFetch();
  patchXHR();
}
