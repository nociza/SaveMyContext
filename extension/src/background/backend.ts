import { createSourceCaptureKey } from "../shared/source-capture";
import type {
  BackendCapabilities,
  BackendSearchResponse,
  BackendSessionListItem,
  ConnectionRedeemResponse,
  ContextMigrationBundle,
  ContextMigrationImportPayload,
  ContextMigrationImportResponse,
  ExtensionSettings,
  ParsedConnectionBundle,
  ProviderName,
  SourceCapturePayload,
  SourceCaptureResponse
} from "../shared/types";

const REQUIRED_EXTENSION_SCOPES = ["ingest", "read"] as const;
const SOURCE_CAPTURE_MAX_ATTEMPTS = 2;
const SOURCE_CAPTURE_MAX_RETRY_DELAY_MS = 5_000;

function retryAfterDelayMs(value: string | null): number {
  if (!value) {
    return 0;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, SOURCE_CAPTURE_MAX_RETRY_DELAY_MS);
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return 0;
  }
  return Math.min(
    Math.max(timestamp - Date.now(), 0),
    SOURCE_CAPTURE_MAX_RETRY_DELAY_MS
  );
}

async function waitForRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  });
}

function normalizeBackendUrl(rawUrl: string): string {
  return rawUrl.trim().replace(/\/$/, "");
}

export function isLocalBackendUrl(candidate: URL): boolean {
  return candidate.hostname === "127.0.0.1" || candidate.hostname === "localhost" || candidate.hostname === "[::1]";
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }
  return 0;
}

function authorizationHeader(token?: string): Record<string, string> {
  if (!token) {
    return {};
  }
  return { Authorization: `Bearer ${token}` };
}

function hasScope(scopes: string[], requiredScope: (typeof REQUIRED_EXTENSION_SCOPES)[number]): boolean {
  return scopes.includes("*") || scopes.includes(requiredScope);
}

function apiPrefix(capabilities?: BackendCapabilities): string {
  return capabilities?.api_prefix ?? "/api/v1";
}

function backendApiUrl(settings: ExtensionSettings, path: string, capabilities?: BackendCapabilities): string {
  return `${normalizeBackendUrl(settings.backendUrl)}${apiPrefix(capabilities)}${path}`;
}

async function fetchBackendJson<TResponse>(
  settings: ExtensionSettings,
  path: string,
  capabilities?: BackendCapabilities
): Promise<TResponse> {
  const response = await fetch(backendApiUrl(settings, path, capabilities), {
    headers: authorizationHeader(settings.backendToken)
  });
  if (!response.ok) {
    throw new Error(`Backend request failed with ${response.status}.`);
  }
  return (await response.json()) as TResponse;
}

function arrayOrEmpty<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function normalizeSessionListItem<TSession extends BackendSessionListItem>(session: TSession): TSession {
  return {
    ...session,
    account_key: session.account_key ?? `${session.provider}:default`,
    account_label: session.account_label ?? `${session.provider} account`,
    custom_tags: arrayOrEmpty(session.custom_tags),
    extra_piles: arrayOrEmpty(session.extra_piles)
  };
}

function normalizeSearchResponse(response: BackendSearchResponse): BackendSearchResponse {
  const results = arrayOrEmpty(response.results).map((result) => ({
    ...result,
    extra_piles: arrayOrEmpty(result.extra_piles)
  }));
  return {
    ...response,
    count: response.count ?? results.length,
    results
  };
}

export function buildBackendHeaders(settings: ExtensionSettings): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...authorizationHeader(settings.backendToken)
  };
}

export async function validateBackendConfiguration(settings: ExtensionSettings): Promise<{
  normalizedUrl: string;
  capabilities: BackendCapabilities;
}> {
  const normalizedUrl = normalizeBackendUrl(settings.backendUrl);
  const parsedUrl = new URL(normalizedUrl);
  const isLocal = isLocalBackendUrl(parsedUrl);
  if (!isLocal && parsedUrl.protocol !== "https:") {
    throw new Error("Remote backends must use https://.");
  }

  const capabilityResponse = await fetch(`${normalizedUrl}/api/v1/meta/capabilities`, {
    headers: authorizationHeader(settings.backendToken)
  });
  if (!capabilityResponse.ok) {
    throw new Error(`Compatibility check failed with ${capabilityResponse.status}.`);
  }

  const capabilities = (await capabilityResponse.json()) as BackendCapabilities;
  if (capabilities.product !== "savemycontext") {
    throw new Error("The configured backend is not a SaveMyContext server.");
  }

  const extensionVersion = chrome.runtime.getManifest().version;
  if (compareVersions(extensionVersion, capabilities.extension.min_version) < 0) {
    throw new Error(
      `This extension is too old for the backend. Minimum required version: ${capabilities.extension.min_version}.`
    );
  }

  if (!isLocal && capabilities.auth.mode !== "app_token") {
    throw new Error("Remote SaveMyContext backends must be provisioned with an app token first.");
  }

  if (capabilities.auth.mode === "app_token" && !settings.backendToken) {
    throw new Error("A backend app token with ingest and read scopes is required.");
  }

  if (settings.backendToken) {
    const verifyResponse = await fetch(`${normalizedUrl}${capabilities.auth.token_verify_path}`, {
      headers: authorizationHeader(settings.backendToken)
    });
    if (!verifyResponse.ok) {
      throw new Error("The backend token is invalid or missing required access.");
    }
    const verification = (await verifyResponse.json()) as { valid?: boolean; scopes?: string[] };
    if (!verification.valid) {
      throw new Error("The backend token is invalid.");
    }
    const scopes = Array.isArray(verification.scopes) ? verification.scopes : [];
    const missingScopes = REQUIRED_EXTENSION_SCOPES.filter((scope) => !hasScope(scopes, scope));
    if (missingScopes.length) {
      throw new Error(`The backend token is missing required scopes: ${missingScopes.join(", ")}.`);
    }
  }

  return {
    normalizedUrl,
    capabilities
  };
}

export async function redeemConnectionBundle(
  bundle: ParsedConnectionBundle,
  payload: {
    installationId: string;
    clientName?: string;
    verificationCode?: string;
  }
): Promise<ConnectionRedeemResponse> {
  const response = await fetch(`${bundle.baseUrl}/api/v1/auth/connections/redeem`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      grant_id: bundle.grantId,
      secret: bundle.secret,
      installation_id: payload.installationId,
      client_name: payload.clientName,
      verification_code: payload.verificationCode?.trim() || undefined
    })
  });
  if (!response.ok) {
    let detail = `Connection enrollment failed with ${response.status}.`;
    try {
      const payload = (await response.json()) as { detail?: string };
      if (payload.detail) {
        detail = payload.detail;
      }
    } catch {
      // ignore non-json failures and keep the status-based message
    }
    throw new Error(detail);
  }
  return (await response.json()) as ConnectionRedeemResponse;
}

export async function fetchSessions(
  settings: ExtensionSettings,
  filters?: {
    provider?: ProviderName;
    accountKey?: string;
    pile?: string;
    extraPile?: string;
  },
  capabilities?: BackendCapabilities
): Promise<BackendSessionListItem[]> {
  const search = new URLSearchParams();
  if (filters?.provider) {
    search.set("provider", filters.provider);
  }
  if (filters?.accountKey) {
    search.set("account_key", filters.accountKey);
  }
  if (filters?.pile) {
    search.set("pile", filters.pile);
  }
  if (filters?.extraPile) {
    search.set("extra_pile", filters.extraPile);
  }
  const query = search.toString();
  const sessions = await fetchBackendJson<BackendSessionListItem[]>(settings, `/sessions${query ? `?${query}` : ""}`, capabilities);
  return arrayOrEmpty(sessions).map(normalizeSessionListItem);
}

export async function fetchContextMigrationBundle(
  settings: ExtensionSettings,
  sessionId: string,
  capabilities?: BackendCapabilities
): Promise<ContextMigrationBundle> {
  return await fetchBackendJson<ContextMigrationBundle>(settings, `/context/export/${encodeURIComponent(sessionId)}`, capabilities);
}

export async function importContextMigrationBundle(
  settings: ExtensionSettings,
  payload: ContextMigrationImportPayload,
  capabilities?: BackendCapabilities
): Promise<ContextMigrationImportResponse> {
  const response = await fetch(backendApiUrl(settings, "/context/import", capabilities), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authorizationHeader(settings.backendToken)
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Context dump failed with ${response.status}: ${details.slice(0, 300)}`);
  }
  return (await response.json()) as ContextMigrationImportResponse;
}

export async function fetchKnowledgeSearch(
  settings: ExtensionSettings,
  query: string,
  limit = 8,
  options?: {
    provider?: ProviderName;
    accountKey?: string;
    kinds?: string[];
  },
  capabilities?: BackendCapabilities
): Promise<BackendSearchResponse> {
  const search = new URLSearchParams({
    q: query.trim(),
    limit: String(limit)
  });
  if (options?.provider) {
    search.set("provider", options.provider);
  }
  if (options?.accountKey) {
    search.set("account_key", options.accountKey);
  }
  for (const kind of options?.kinds ?? []) {
    search.append("kind", kind);
  }
  return normalizeSearchResponse(await fetchBackendJson<BackendSearchResponse>(settings, `/search?${search.toString()}`, capabilities));
}

export async function saveSourceCaptureToBackend(
  settings: ExtensionSettings,
  payload: SourceCapturePayload,
  capabilities?: BackendCapabilities
): Promise<SourceCaptureResponse> {
  const captureKey = payload.captureKey ?? createSourceCaptureKey();
  const requestBody = JSON.stringify({
    capture_key: captureKey,
    capture_kind: payload.captureKind,
    save_mode: payload.saveMode,
    title: payload.title,
    page_title: payload.pageTitle,
    source_url: payload.sourceUrl,
    selection_text: payload.selectionText,
    source_text: payload.sourceText,
    source_markdown: payload.sourceMarkdown,
    raw_payload: payload.rawPayload
  });
  let response: Response | null = null;
  for (let attempt = 0; attempt < SOURCE_CAPTURE_MAX_ATTEMPTS; attempt += 1) {
    response = await fetch(backendApiUrl(settings, "/capture/source", capabilities), {
      method: "POST",
      headers: buildBackendHeaders(settings),
      body: requestBody
    });
    if (response.status !== 503 || attempt === SOURCE_CAPTURE_MAX_ATTEMPTS - 1) {
      break;
    }
    await waitForRetry(retryAfterDelayMs(response.headers.get("Retry-After")));
  }
  if (response === null) {
    throw new Error("Source capture failed before receiving a backend response.");
  }
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Source capture failed with ${response.status}: ${details.slice(0, 300)}`);
  }

  const saved = (await response.json()) as {
    source_id: string;
    capture_key?: string | null;
    title: string;
    capture_kind: "selection" | "page";
    save_mode: "raw" | "ai";
    processed: boolean;
    pile_slug?: string | null;
    markdown_path?: string | null;
    raw_source_path?: string | null;
  };
  return {
    ok: true,
    sourceId: saved.source_id,
    captureKey: saved.capture_key ?? captureKey,
    title: saved.title,
    captureKind: saved.capture_kind,
    saveMode: saved.save_mode,
    processed: saved.processed,
    pile_slug: saved.pile_slug ?? null,
    markdownPath: saved.markdown_path ?? null,
    rawSourcePath: saved.raw_source_path ?? null
  };
}
