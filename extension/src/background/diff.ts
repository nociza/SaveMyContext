import type {
  BackendIngestPayload,
  CapturedNetworkEvent,
  NormalizedMessage,
  NormalizedSessionSnapshot,
  SessionSyncState
} from "../shared/types";

const MAX_SEEN_MESSAGE_IDS = 4000;

export async function messageFingerprint(message: NormalizedMessage): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([
    message.role, message.content, message.parentId ?? null, message.occurredAt ?? null
  ]));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function mergeMessageFingerprints(
  existing: Record<string, string> = {}, messages: NormalizedMessage[]
): Promise<Record<string, string>> {
  const merged = new Map(Object.entries(existing));
  for (const message of messages) {
    merged.delete(message.id);
    merged.set(message.id, await messageFingerprint(message));
  }
  return Object.fromEntries([...merged].slice(-MAX_SEEN_MESSAGE_IDS));
}

export async function buildIngestPayload(
  snapshot: NormalizedSessionSnapshot,
  rawCapture: CapturedNetworkEvent,
  syncState: SessionSyncState
): Promise<BackendIngestPayload | null> {
  const syncMode = rawCapture.captureMode === "full_snapshot" ? "full_snapshot" : "incremental";
  const fingerprints = await mergeMessageFingerprints({}, snapshot.messages);
  const messages =
    syncMode === "full_snapshot"
      ? snapshot.messages
      : snapshot.messages.filter((message) =>
          syncState.messageFingerprints?.[message.id] !== fingerprints[message.id]);
  if (!messages.length) {
    return null;
  }

  return {
    capture_completeness: snapshot.completeness ?? "partial",
    extraction_method: snapshot.extractionMethod ?? "structured",
    parser_version: "capture-v2",
    provider: snapshot.provider,
    external_session_id: snapshot.externalSessionId,
    account_key: snapshot.accountKey,
    account_label: snapshot.accountLabel,
    sync_mode: syncMode,
    title: snapshot.title,
    source_url: snapshot.sourceUrl,
    captured_at: snapshot.capturedAt,
    custom_tags: [],
    raw_capture: rawCapture,
    messages: messages.map((message) => ({
      external_message_id: message.id,
      parent_external_message_id: message.parentId,
      role: message.role,
      content: message.content,
      occurred_at: message.occurredAt,
      raw_payload: message.raw
    }))
  };
}

export function mergeSeenMessageIds(
  existingIds: string[],
  newMessages: NormalizedMessage[],
  limit = MAX_SEEN_MESSAGE_IDS
): string[] {
  const merged = [...existingIds];
  const seen = new Set(existingIds);
  for (const message of newMessages) {
    if (seen.has(message.id)) {
      continue;
    }
    seen.add(message.id);
    merged.push(message.id);
  }
  return merged.slice(-limit);
}
