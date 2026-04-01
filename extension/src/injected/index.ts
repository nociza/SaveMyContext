type ProviderName = "chatgpt" | "gemini" | "grok";

const OBSERVER_FLAG = "__TSMC_NETWORK_OBSERVER__";
const CONTROL_SOURCE = "tsmc-history-control";
const CONTROL_READY_SOURCE = "tsmc-history-control-ready";
const MAIN_WORLD_READY_ATTRIBUTE = "data-tsmc-main-world-ready";
const MAX_CAPTURE_SIZE = 1_500_000;
const INTERESTING_PATH =
  /backend-api|conversation|conversations|BardFrontendService|StreamGenerate|batchexecute|app-chat|grok|chat/i;
const CHATGPT_HISTORY_PAGE_LIMIT = 100;
const CHATGPT_HISTORY_MAX_OFFSET = 5_000;
const GEMINI_HISTORY_PAGE_LIMIT = 5_000;
const GEMINI_BATCH_PATH = "/_/BardChatUi/data/batchexecute";
const GEMINI_LIST_RPC_ID = "MaZiqc";
const GEMINI_READ_RPC_ID = "hNvQHb";
const GEMINI_CONTEXT_WAIT_TIMEOUT_MS = 10_000;
const GEMINI_CONTEXT_WAIT_POLL_MS = 200;
const nativeFetch = window.fetch.bind(window);
let geminiReqIdCounter = Math.floor(Math.random() * 10_000);

interface CapturedBody {
  text?: string;
  json?: unknown;
}

interface CapturedNetworkEvent {
  source: "tsmc-network-observer";
  providerHint?: ProviderName;
  pageUrl: string;
  requestId: string;
  method: string;
  url: string;
  capturedAt: string;
  requestBody?: CapturedBody;
  response: {
    status: number;
    ok: boolean;
    contentType?: string;
    text: string;
    json?: unknown;
  };
}

interface HistorySyncUpdate {
  provider: ProviderName;
  phase: "started" | "completed" | "failed" | "unsupported";
  conversationCount?: number;
  pageUrl: string;
  message?: string;
}

interface TrackedXHR extends XMLHttpRequest {
  __tsmcMethod?: string;
  __tsmcUrl?: string;
}

interface GeminiRuntimeContext {
  at?: string;
  hl?: string;
  bl?: string;
  fSid?: string;
  sourcePath?: string;
  basePrefix?: string;
}

interface GeminiConversationEntry {
  conversationId: string;
  title?: string;
}

interface GeminiConversationBlock {
  userText: string;
  assistantText: string;
  occurredAt?: string;
}

type JsonRecord = Record<string, unknown>;

const activeHistorySyncs = new Set<ProviderName>();
const geminiRuntimeContext: GeminiRuntimeContext = {};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

function truncate(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length > MAX_CAPTURE_SIZE ? value.slice(0, MAX_CAPTURE_SIZE) : value;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function providerHintFromUrl(url: string): ProviderName | undefined {
  try {
    const hostname = new URL(url, location.href).hostname;
    if (/chatgpt\.com|chat\.openai\.com/.test(hostname)) {
      return "chatgpt";
    }
    if (/gemini\.google\.com/.test(hostname)) {
      return "gemini";
    }
    if (/grok\.com|x\.com/.test(hostname)) {
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
    return INTERESTING_PATH.test(resolved.pathname + resolved.search);
  } catch {
    return false;
  }
}

function postCapture(capture: Omit<CapturedNetworkEvent, "source">): void {
  window.postMessage(
    {
      source: "tsmc-network-observer",
      payload: {
        ...capture,
        source: "tsmc-network-observer"
      } satisfies CapturedNetworkEvent
    },
    window.location.origin
  );
}

function postHistorySyncStatus(update: HistorySyncUpdate): void {
  window.postMessage(
    {
      source: "tsmc-history-sync",
      payload: update
    },
    window.location.origin
  );
}

async function serializeBody(body: unknown): Promise<CapturedBody | undefined> {
  if (!body) {
    return undefined;
  }

  if (typeof body === "string") {
    const text = truncate(body);
    return {
      text,
      json: safeJsonParse(text)
    };
  }

  if (body instanceof URLSearchParams) {
    return serializeBody(body.toString());
  }

  if (body instanceof Blob) {
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
    return serializeBody(new TextDecoder().decode(new Uint8Array(body)));
  }

  if (ArrayBuffer.isView(body)) {
    return serializeBody(new TextDecoder().decode(body));
  }

  return undefined;
}

async function readFetchRequestBody(input: RequestInfo | URL, init?: RequestInit): Promise<CapturedBody | undefined> {
  if (init?.body) {
    return serializeBody(init.body);
  }

  if (input instanceof Request) {
    try {
      return serializeBody(await input.clone().text());
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function parseGeminiRoute(
  url = location.href
): {
  basePrefix: string;
  sourcePath: string;
  currentConversationId?: string;
} {
  try {
    const parsed = new URL(url, location.href);
    const segments = parsed.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    let basePrefix = "";
    let index = 0;

    if (segments[0] === "u" && /^\d+$/.test(segments[1] ?? "")) {
      basePrefix = `/u/${segments[1]}`;
      index = 2;
    }

    if (segments[index] === "app") {
      const currentConversationId = normalizeGeminiConversationId(segments[index + 1]) ?? undefined;
      return {
        basePrefix,
        sourcePath: currentConversationId ? `${basePrefix}/app/${currentConversationId}` : `${basePrefix}/app`,
        currentConversationId
      };
    }

    if (segments[index] === "gem" && segments[index + 1]) {
      const gemId = segments[index + 1];
      const currentConversationId = normalizeGeminiConversationId(segments[index + 2]) ?? undefined;
      return {
        basePrefix,
        sourcePath: currentConversationId
          ? `${basePrefix}/gem/${gemId}/${currentConversationId}`
          : `${basePrefix}/gem/${gemId}`,
        currentConversationId
      };
    }

    return {
      basePrefix,
      sourcePath: `${basePrefix}/app`
    };
  } catch {
    return {
      basePrefix: "",
      sourcePath: "/app"
    };
  }
}

function normalizeGeminiConversationId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.startsWith("c_") ? trimmed.slice(2) : trimmed;
}

function toGeminiApiConversationId(conversationId: string): string {
  return conversationId.startsWith("c_") ? conversationId : `c_${conversationId}`;
}

function isLikelyGeminiConversationId(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return /^c_[A-Za-z0-9_-]{6,}$/.test(trimmed) || /^[A-Za-z0-9_-]{12,}$/.test(trimmed);
}

function sourcePathToBasePrefix(sourcePath?: string): string {
  if (!sourcePath) {
    return "";
  }
  const match = sourcePath.match(/^\/u\/\d+/);
  return match?.[0] ?? "";
}

function decodeGeminiToken(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

function readGeminiAtTokenFromDom(): string | null {
  const input = document.querySelector<HTMLInputElement>('input[name="at"]');
  if (input?.value.trim()) {
    return input.value.trim();
  }

  const windowRecord = window as unknown as Record<string, unknown>;
  const wizGlobalData = asRecord(windowRecord.WIZ_global_data);
  if (typeof wizGlobalData?.SNlM0e === "string" && wizGlobalData.SNlM0e.trim()) {
    return wizGlobalData.SNlM0e.trim();
  }

  const html = document.documentElement?.innerHTML;
  const match = html?.match(/"SNlM0e":"([^"]+)"/);
  if (match?.[1]) {
    return decodeGeminiToken(match[1]).trim();
  }

  return null;
}

function collectGeminiRuntimeContext(): GeminiRuntimeContext {
  const route = parseGeminiRoute(location.href);
  const hl = document.documentElement?.lang?.trim() || geminiRuntimeContext.hl || "en";
  const at = readGeminiAtTokenFromDom() ?? geminiRuntimeContext.at;
  const sourcePath = geminiRuntimeContext.sourcePath ?? route.sourcePath;
  const basePrefix = geminiRuntimeContext.basePrefix ?? sourcePathToBasePrefix(sourcePath) ?? route.basePrefix;

  return {
    at: at ?? undefined,
    hl,
    bl: geminiRuntimeContext.bl,
    fSid: geminiRuntimeContext.fSid,
    sourcePath,
    basePrefix
  };
}

async function waitForGeminiRuntimeContext(): Promise<GeminiRuntimeContext> {
  const deadline = Date.now() + GEMINI_CONTEXT_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const context = collectGeminiRuntimeContext();
    if (context.at && context.sourcePath) {
      Object.assign(geminiRuntimeContext, context);
      return context;
    }
    await sleep(GEMINI_CONTEXT_WAIT_POLL_MS);
  }

  const finalContext = collectGeminiRuntimeContext();
  if (!finalContext.at) {
    throw new Error('Could not find Gemini session token "at" on the page.');
  }
  if (!finalContext.sourcePath) {
    throw new Error("Could not determine Gemini source-path.");
  }

  Object.assign(geminiRuntimeContext, finalContext);
  return finalContext;
}

function maybeUpdateGeminiRuntimeContext(url: string, requestBody?: CapturedBody): void {
  const provider = providerHintFromUrl(url);
  if (provider !== "gemini") {
    return;
  }

  let resolved: URL;
  try {
    resolved = new URL(url, location.href);
  } catch {
    return;
  }

  const searchParams = resolved.searchParams;
  const requestParams =
    requestBody?.text && requestBody.text.includes("=")
      ? new URLSearchParams(requestBody.text.endsWith("&") ? requestBody.text.slice(0, -1) : requestBody.text)
      : null;

  const nextContext: GeminiRuntimeContext = {
    at: requestParams?.get("at")?.trim() || undefined,
    hl: searchParams.get("hl")?.trim() || undefined,
    bl: searchParams.get("bl")?.trim() || undefined,
    fSid: searchParams.get("f.sid")?.trim() || undefined,
    sourcePath: searchParams.get("source-path")?.trim() || undefined
  };

  nextContext.basePrefix = sourcePathToBasePrefix(nextContext.sourcePath);

  Object.assign(
    geminiRuntimeContext,
    Object.fromEntries(Object.entries(nextContext).filter(([, value]) => Boolean(value)))
  );
}

function patchFetch(): void {
  window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = request.url;
    if (!shouldCapture(url)) {
      return nativeFetch(input, init);
    }

    const requestBody = await readFetchRequestBody(input, init);
    maybeUpdateGeminiRuntimeContext(url, requestBody);

    const response = await nativeFetch(input, init);

    try {
      const clone = response.clone();
      const text = truncate(await clone.text()) ?? "";
      postCapture({
        providerHint: providerHintFromUrl(url),
        pageUrl: location.href,
        requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        method: request.method,
        url,
        capturedAt: new Date().toISOString(),
        requestBody,
        response: {
          status: response.status,
          ok: response.ok,
          contentType: clone.headers.get("content-type") ?? undefined,
          text,
          json: safeJsonParse(text)
        }
      });
    } catch {
      // Streaming and opaque responses can fail to clone or decode.
    }

    return response;
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
    this.__tsmcMethod = method;
    this.__tsmcUrl = String(url);
    return nativeOpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
  };

  XMLHttpRequest.prototype.send = function patchedSend(this: TrackedXHR, body?: Document | XMLHttpRequestBodyInit | null): void {
    const url = this.__tsmcUrl;
    const method = this.__tsmcMethod ?? "GET";
    const requestBodyPromise = serializeBody(body);

    if (url && shouldCapture(url)) {
      this.addEventListener(
        "loadend",
        () => {
          void requestBodyPromise.then((requestBody) => {
            maybeUpdateGeminiRuntimeContext(url, requestBody);

            const text =
              this.responseType === "" || this.responseType === "text"
                ? truncate(this.responseText) ?? ""
                : "";
            postCapture({
              providerHint: providerHintFromUrl(url),
              pageUrl: location.href,
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
  const response = await nativeFetch(url, init);
  const text = truncate(await response.text()) ?? "";
  return {
    response,
    text,
    json: safeJsonParse(text)
  };
}

function normalizeChatGPTConversationIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const record = payload as JsonRecord;
  const items = Array.isArray(record.items) ? record.items : [];
  const ids = items
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const itemRecord = item as JsonRecord;
      return typeof itemRecord.id === "string" ? itemRecord.id : null;
    })
    .filter((value): value is string => Boolean(value));
  return [...new Set(ids)];
}

function buildHistoryPageUrl(provider: ProviderName, conversationId: string): string {
  if (provider === "chatgpt") {
    return new URL(`/c/${conversationId}`, location.origin).toString();
  }

  if (provider === "gemini") {
    const route = parseGeminiRoute(location.href);
    return new URL(`${route.basePrefix}/app/${normalizeGeminiConversationId(conversationId) ?? conversationId}`, location.origin).toString();
  }

  return location.href;
}

async function runChatGPTHistorySync(): Promise<void> {
  const provider: ProviderName = "chatgpt";
  if (activeHistorySyncs.has(provider)) {
    return;
  }

  activeHistorySyncs.add(provider);
  postHistorySyncStatus({
    provider,
    phase: "started",
    pageUrl: location.href
  });

  try {
    const sessionResult = await fetchJsonWithText("/api/auth/session", {
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

    const conversationIds = new Set<string>();

    for (let offset = 0; offset < CHATGPT_HISTORY_MAX_OFFSET; offset += CHATGPT_HISTORY_PAGE_LIMIT) {
      const listUrl = new URL("/backend-api/conversations", location.origin);
      listUrl.searchParams.set("offset", String(offset));
      listUrl.searchParams.set("limit", String(CHATGPT_HISTORY_PAGE_LIMIT));
      listUrl.searchParams.set("order", "updated");

      const listResult = await fetchJsonWithText(listUrl.toString(), {
        method: "GET",
        credentials: "include",
        headers
      });

      if (!listResult.response.ok) {
        throw new Error(`ChatGPT list request failed with ${listResult.response.status}.`);
      }

      const pageConversationIds = normalizeChatGPTConversationIds(listResult.json);
      if (!pageConversationIds.length) {
        break;
      }

      for (const conversationId of pageConversationIds) {
        conversationIds.add(conversationId);
      }

      if (pageConversationIds.length < CHATGPT_HISTORY_PAGE_LIMIT) {
        break;
      }
    }

    for (const conversationId of conversationIds) {
      const detailUrl = new URL(`/backend-api/conversation/${conversationId}`, location.origin);
      const detailResult = await fetchJsonWithText(detailUrl.toString(), {
        method: "GET",
        credentials: "include",
        headers
      });

      if (!detailResult.response.ok) {
        continue;
      }

      postCapture({
        providerHint: provider,
        pageUrl: buildHistoryPageUrl(provider, conversationId),
        requestId: `history-${provider}-${conversationId}-${Date.now()}`,
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
    }

    postHistorySyncStatus({
      provider,
      phase: "completed",
      conversationCount: conversationIds.size,
      pageUrl: location.href
    });
  } catch (error) {
    postHistorySyncStatus({
      provider,
      phase: "failed",
      pageUrl: location.href,
      message: error instanceof Error ? error.message : String(error)
    });
  } finally {
    activeHistorySyncs.delete(provider);
  }
}

function nextGeminiReqId(): string {
  geminiReqIdCounter += 1;
  return String(geminiReqIdCounter);
}

function parseBatchExecute(text: string, targetRpcId: string): unknown[] {
  let currentText = text;
  if (currentText.startsWith(")]}'\n")) {
    currentText = currentText.slice(5);
  }

  const lines = currentText.split("\n").filter((line) => line.trim().length > 0);
  const payloads: unknown[] = [];

  for (let index = 0; index < lines.length; ) {
    const lengthLine = lines[index++];
    if (!lengthLine || !Number.isFinite(Number.parseInt(lengthLine, 10))) {
      break;
    }

    const segmentLine = lines[index++] ?? "";
    let segment: unknown;
    try {
      segment = JSON.parse(segmentLine);
    } catch {
      continue;
    }

    if (!Array.isArray(segment)) {
      continue;
    }

    for (const entry of segment) {
      if (!Array.isArray(entry) || entry[0] !== "wrb.fr" || entry[1] !== targetRpcId) {
        continue;
      }

      const payload = entry[2];
      if (typeof payload !== "string") {
        continue;
      }

      try {
        payloads.push(JSON.parse(payload));
      } catch {
        // Ignore malformed inner segments and continue scanning the rest.
      }
    }
  }

  return payloads;
}

async function executeGeminiBatchCall(
  context: GeminiRuntimeContext,
  rpcId: string,
  innerArgs: unknown,
  sourcePath: string
): Promise<{
  url: string;
  requestBody: string;
  response: Response;
  text: string;
  payloads: unknown[];
}> {
  if (!context.at) {
    throw new Error("Gemini request context is missing the at token.");
  }

  const basePrefix = context.basePrefix ?? sourcePathToBasePrefix(sourcePath);
  const url = new URL(`${basePrefix}${GEMINI_BATCH_PATH}`, location.origin);
  url.searchParams.set("rpcids", rpcId);
  url.searchParams.set("source-path", sourcePath);
  url.searchParams.set("hl", context.hl ?? "en");
  url.searchParams.set("rt", "c");
  url.searchParams.set("_reqid", nextGeminiReqId());
  if (context.bl) {
    url.searchParams.set("bl", context.bl);
  }
  if (context.fSid) {
    url.searchParams.set("f.sid", context.fSid);
  }

  const fReq = JSON.stringify([[[rpcId, innerArgs == null ? null : JSON.stringify(innerArgs), null, "generic"]]]);
  const bodyParams = new URLSearchParams({
    "f.req": fReq,
    at: context.at
  });
  const requestBody = `${bodyParams.toString()}&`;

  const response = await nativeFetch(url.toString(), {
    method: "POST",
    credentials: "include",
    headers: {
      accept: "*/*",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "x-same-domain": "1"
    },
    body: requestBody
  });

  const text = truncate(await response.text()) ?? "";
  if (!response.ok) {
    throw new Error(`Gemini ${rpcId} request failed with ${response.status}.`);
  }

  const payloads = parseBatchExecute(text, rpcId);
  return {
    url: url.toString(),
    requestBody,
    response,
    text,
    payloads
  };
}

function extractGeminiConversationEntries(payloads: unknown[]): GeminiConversationEntry[] {
  const entries = new Map<string, GeminiConversationEntry>();

  const scan = (node: unknown): void => {
    if (!Array.isArray(node)) {
      if (node && typeof node === "object") {
        for (const value of Object.values(node as JsonRecord)) {
          scan(value);
        }
      }
      return;
    }

    if (node.length >= 2 && isLikelyGeminiConversationId(node[0]) && typeof node[1] === "string") {
      const conversationId = normalizeGeminiConversationId(node[0]);
      const title = node[1].trim();
      if (conversationId) {
        const current = entries.get(conversationId);
        entries.set(conversationId, {
          conversationId,
          title: title || current?.title
        });
      }
    }

    for (const child of node) {
      scan(child);
    }
  };

  for (const payload of payloads) {
    scan(payload);
  }

  return [...entries.values()];
}

function isGeminiUserMessageNode(node: unknown): node is unknown[] {
  return (
    Array.isArray(node) &&
    node.length >= 2 &&
    Array.isArray(node[0]) &&
    node[0].length >= 1 &&
    node[0].every((part) => typeof part === "string") &&
    (node[1] === 1 || node[1] === 2)
  );
}

function isGeminiAssistantNode(node: unknown): node is unknown[] {
  return (
    Array.isArray(node) &&
    node.length >= 2 &&
    typeof node[0] === "string" &&
    node[0].startsWith("rc_") &&
    Array.isArray(node[1]) &&
    typeof node[1][0] === "string"
  );
}

function isGeminiAssistantContainer(node: unknown): node is unknown[] {
  return Array.isArray(node) && Array.isArray(node[0]) && node[0].length >= 1 && isGeminiAssistantNode(node[0][0]);
}

function isGeminiTimestampPair(node: unknown): node is [number, number] {
  return (
    Array.isArray(node) &&
    node.length === 2 &&
    typeof node[0] === "number" &&
    typeof node[1] === "number" &&
    node[0] > 1_600_000_000
  );
}

function timestampPairToIso(pair: [number, number] | null): string | undefined {
  if (!pair) {
    return undefined;
  }
  return new Date(pair[0] * 1000).toISOString();
}

function offsetIsoTimestamp(value: string, milliseconds: number): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }
  return new Date(timestamp + milliseconds).toISOString();
}

function extractGeminiBlock(node: unknown): GeminiConversationBlock | null {
  if (!Array.isArray(node)) {
    return null;
  }

  let userNode: unknown[] | null = null;
  let assistantContainer: unknown[] | null = null;
  let timestampPair: [number, number] | null = null;

  for (const child of node) {
    if (!userNode && isGeminiUserMessageNode(child)) {
      userNode = child;
      continue;
    }
    if (!assistantContainer && isGeminiAssistantContainer(child)) {
      assistantContainer = child;
      continue;
    }
    if (isGeminiTimestampPair(child)) {
      timestampPair = child;
    }
  }

  if (!userNode || !assistantContainer) {
    return null;
  }

  const assistantNode = (assistantContainer[0] as unknown[])[0] as unknown[];
  const userParts = userNode[0] as unknown[];
  const assistantParts = Array.isArray(assistantNode[1]) ? (assistantNode[1] as unknown[]) : [];
  const userText = userParts.filter((part): part is string => typeof part === "string").join("\n").trim();
  const assistantText = typeof assistantParts[0] === "string" ? assistantParts[0].trim() : "";

  if (!userText || !assistantText) {
    return null;
  }

  return {
    userText,
    assistantText,
    occurredAt: timestampPairToIso(timestampPair)
  };
}

function getNestedArrayValue(root: unknown, path: number[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!Array.isArray(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function flattenGeminiText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => flattenGeminiText(item))
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (value && typeof value === "object") {
    return Object.values(value as JsonRecord)
      .map((item) => flattenGeminiText(item))
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return "";
}

function extractGeminiFallbackBlocks(payloads: unknown[]): GeminiConversationBlock[] {
  const blocks: GeminiConversationBlock[] = [];
  const seen = new Set<string>();

  const scan = (node: unknown): void => {
    if (!Array.isArray(node)) {
      if (node && typeof node === "object") {
        for (const value of Object.values(node as JsonRecord)) {
          scan(value);
        }
      }
      return;
    }

    const userText = flattenGeminiText(getNestedArrayValue(node, [2, 0, 0]));
    const assistantText =
      flattenGeminiText(getNestedArrayValue(node, [3, 0, 1, 0])) ||
      flattenGeminiText(getNestedArrayValue(node, [3, 0, 22, 0]));

    if (userText && assistantText) {
      const composite = `${userText}\n---\n${assistantText}`;
      if (!seen.has(composite)) {
        seen.add(composite);
        blocks.push({
          userText,
          assistantText
        });
      }
    }

    for (const child of node) {
      scan(child);
    }
  };

  for (const payload of payloads) {
    scan(payload);
  }

  return blocks;
}

function extractGeminiConversationBlocks(payloads: unknown[]): GeminiConversationBlock[] {
  const blocks: GeminiConversationBlock[] = [];
  const seen = new Set<string>();

  const scan = (node: unknown): void => {
    if (!Array.isArray(node)) {
      if (node && typeof node === "object") {
        for (const value of Object.values(node as JsonRecord)) {
          scan(value);
        }
      }
      return;
    }

    const block = extractGeminiBlock(node);
    if (block) {
      const composite = `${block.userText}\n---\n${block.assistantText}\n---\n${block.occurredAt ?? ""}`;
      if (!seen.has(composite)) {
        seen.add(composite);
        blocks.push(block);
      }
    }

    for (const child of node) {
      scan(child);
    }
  };

  for (const payload of payloads) {
    scan(payload);
  }

  if (blocks.length) {
    return blocks.sort((left, right) => {
      const leftTime = left.occurredAt ? Date.parse(left.occurredAt) : Number.MAX_SAFE_INTEGER;
      const rightTime = right.occurredAt ? Date.parse(right.occurredAt) : Number.MAX_SAFE_INTEGER;
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return left.userText.localeCompare(right.userText);
    });
  }

  return extractGeminiFallbackBlocks(payloads);
}

function buildGeminiSyntheticMessages(
  conversationId: string,
  blocks: GeminiConversationBlock[],
  capturedAt: string
): Array<{
  id: string;
  parentId?: string;
  role: "user" | "assistant";
  content: string;
  occurredAt: string;
}> {
  const messages: Array<{
    id: string;
    parentId?: string;
    role: "user" | "assistant";
    content: string;
    occurredAt: string;
  }> = [];

  let previousAssistantId: string | undefined;
  for (const [index, block] of blocks.entries()) {
    const occurredAt = block.occurredAt ?? capturedAt;
    const userId = `gemini-${conversationId}-user-${index}`;
    messages.push({
      id: userId,
      parentId: previousAssistantId,
      role: "user",
      content: block.userText,
      occurredAt
    });

    const assistantId = `gemini-${conversationId}-assistant-${index}`;
    messages.push({
      id: assistantId,
      parentId: userId,
      role: "assistant",
      content: block.assistantText,
      occurredAt: offsetIsoTimestamp(occurredAt, 1)
    });
    previousAssistantId = assistantId;
  }

  return messages;
}

async function fetchGeminiConversationEntries(context: GeminiRuntimeContext): Promise<GeminiConversationEntry[]> {
  const sourcePath = context.sourcePath ?? parseGeminiRoute(location.href).sourcePath;
  const entries = new Map<string, GeminiConversationEntry>();
  const requestShapes: Array<unknown> = [
    [GEMINI_HISTORY_PAGE_LIMIT, null, [0, null, 1]],
    [GEMINI_HISTORY_PAGE_LIMIT, null, [1, null, 1]],
    [200, null, [0, null, 1]],
    [200, null, [1, null, 1]],
    null
  ];

  for (const innerArgs of requestShapes) {
    try {
      const result = await executeGeminiBatchCall(context, GEMINI_LIST_RPC_ID, innerArgs, sourcePath);
      for (const entry of extractGeminiConversationEntries(result.payloads)) {
        const current = entries.get(entry.conversationId);
        entries.set(entry.conversationId, {
          conversationId: entry.conversationId,
          title: entry.title || current?.title
        });
      }
    } catch {
      // Some list argument variants fail on certain Gemini surfaces. Continue with the next one.
    }
  }

  return [...entries.values()];
}

async function fetchGeminiConversationCapture(
  context: GeminiRuntimeContext,
  entry: GeminiConversationEntry
): Promise<{
  requestBody: string;
  response: {
    status: number;
    ok: boolean;
    contentType?: string;
    text: string;
    json: {
      conversationId: string;
      title?: string;
      messages: Array<{
        id: string;
        parentId?: string;
        role: "user" | "assistant";
        content: string;
        occurredAt: string;
      }>;
    };
  };
  url: string;
}> {
  const conversationId = normalizeGeminiConversationId(entry.conversationId) ?? entry.conversationId;
  const sourcePath = `${context.basePrefix ?? ""}/app/${conversationId}`;
  const result = await executeGeminiBatchCall(
    context,
    GEMINI_READ_RPC_ID,
    [toGeminiApiConversationId(conversationId), 1_000, null, 1, [1], [4], null, 1],
    sourcePath
  );

  const capturedAt = new Date().toISOString();
  const blocks = extractGeminiConversationBlocks(result.payloads);
  if (!blocks.length) {
    throw new Error(`Gemini conversation ${conversationId} did not yield readable message blocks.`);
  }

  return {
    requestBody: result.requestBody,
    response: {
      status: result.response.status,
      ok: result.response.ok,
      contentType: result.response.headers.get("content-type") ?? undefined,
      text: result.text,
      json: {
        conversationId,
        title: entry.title,
        messages: buildGeminiSyntheticMessages(conversationId, blocks, capturedAt)
      }
    },
    url: result.url
  };
}

async function runGeminiHistorySync(): Promise<void> {
  const provider: ProviderName = "gemini";
  if (activeHistorySyncs.has(provider)) {
    return;
  }

  activeHistorySyncs.add(provider);
  postHistorySyncStatus({
    provider,
    phase: "started",
    pageUrl: location.href
  });

  try {
    const context = await waitForGeminiRuntimeContext();
    const conversations = await fetchGeminiConversationEntries(context);

    let syncedConversationCount = 0;
    for (const entry of conversations) {
      try {
        const capture = await fetchGeminiConversationCapture(context, entry);
        postCapture({
          providerHint: provider,
          pageUrl: buildHistoryPageUrl(provider, entry.conversationId),
          requestId: `history-${provider}-${entry.conversationId}-${Date.now()}`,
          method: "POST",
          url: capture.url,
          capturedAt: new Date().toISOString(),
          requestBody: {
            text: capture.requestBody,
            json: safeJsonParse(capture.requestBody)
          },
          response: capture.response
        });
        syncedConversationCount += 1;
      } catch {
        // Skip individual conversations so one malformed history entry does not abort the entire sync.
      }
    }

    postHistorySyncStatus({
      provider,
      phase: "completed",
      conversationCount: syncedConversationCount,
      pageUrl: location.href
    });
  } catch (error) {
    postHistorySyncStatus({
      provider,
      phase: "failed",
      pageUrl: location.href,
      message: error instanceof Error ? error.message : String(error)
    });
  } finally {
    activeHistorySyncs.delete(provider);
  }
}

async function runHistorySync(): Promise<void> {
  const provider = currentProvider();
  if (provider === "chatgpt") {
    await runChatGPTHistorySync();
    return;
  }

  if (provider === "gemini") {
    await runGeminiHistorySync();
    return;
  }

  if (!provider) {
    return;
  }

  postHistorySyncStatus({
    provider,
    phase: "unsupported",
    pageUrl: location.href,
    message: `${provider} auto history sync is not wired yet.`
  });
}

window.addEventListener("message", (event: MessageEvent<{ source?: string; payload?: { type?: string } }>) => {
  if (event.source !== window) {
    return;
  }
  if (event.data?.source !== CONTROL_SOURCE || event.data.payload?.type !== "START_HISTORY_SYNC") {
    return;
  }
  void runHistorySync();
});

const windowFlags = window as unknown as Record<string, unknown>;

if (!windowFlags[OBSERVER_FLAG]) {
  windowFlags[OBSERVER_FLAG] = true;
  patchFetch();
  patchXHR();
}

document.documentElement?.setAttribute(MAIN_WORLD_READY_ATTRIBUTE, "1");
window.postMessage(
  {
    source: CONTROL_READY_SOURCE
  },
  window.location.origin
);
