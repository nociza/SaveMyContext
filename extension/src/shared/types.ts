export type ProviderName = "chatgpt" | "gemini" | "grok";
export type MessageRole = "user" | "assistant" | "system" | "tool" | "unknown";

export interface CapturedBody {
  text?: string;
  json?: unknown;
}

export interface CapturedNetworkEvent {
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

export interface NormalizedMessage {
  id: string;
  parentId?: string;
  role: MessageRole;
  content: string;
  occurredAt?: string;
  raw?: unknown;
}

export interface NormalizedSessionSnapshot {
  provider: ProviderName;
  externalSessionId: string;
  title?: string;
  sourceUrl: string;
  capturedAt: string;
  messages: NormalizedMessage[];
}

export interface SessionSyncState {
  seenMessageIds: string[];
  lastSyncedAt?: string;
}

export interface ExtensionSettings {
  backendUrl: string;
  enabledProviders: Record<ProviderName, boolean>;
}

export interface SyncStatus {
  lastSuccessAt?: string;
  lastError?: string | null;
  lastProvider?: ProviderName;
  lastSessionKey?: string;
  lastSyncedMessageCount?: number;
  backendUrl?: string;
}

export interface BackendIngestMessage {
  external_message_id: string;
  parent_external_message_id?: string;
  role: MessageRole;
  content: string;
  occurred_at?: string;
  raw_payload?: unknown;
}

export interface BackendIngestPayload {
  provider: ProviderName;
  external_session_id: string;
  title?: string;
  source_url: string;
  captured_at: string;
  custom_tags: string[];
  raw_capture: CapturedNetworkEvent;
  messages: BackendIngestMessage[];
}

export type RuntimeMessage =
  | { type: "NETWORK_CAPTURE"; payload: CapturedNetworkEvent }
  | { type: "GET_SETTINGS" }
  | { type: "SAVE_SETTINGS"; payload: Partial<ExtensionSettings> }
  | { type: "GET_STATUS" };

