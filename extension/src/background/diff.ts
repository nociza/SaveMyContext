import type {
  BackendIngestPayload,
  CapturedNetworkEvent,
  NormalizedMessage,
  NormalizedSessionSnapshot,
  SessionSyncState
} from "../shared/types";

const MAX_SEEN_MESSAGE_IDS = 4000;

export function buildIngestPayload(
  snapshot: NormalizedSessionSnapshot,
  rawCapture: CapturedNetworkEvent,
  syncState: SessionSyncState
): BackendIngestPayload | null {
  const seen = new Set(syncState.seenMessageIds);
  const messages = snapshot.messages.filter((message) => !seen.has(message.id));
  if (!messages.length) {
    return null;
  }

  return {
    provider: snapshot.provider,
    external_session_id: snapshot.externalSessionId,
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

