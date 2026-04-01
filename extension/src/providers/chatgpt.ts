import type { CapturedNetworkEvent, NormalizedMessage, NormalizedSessionSnapshot } from "../shared/types";
import type { IProviderScraper } from "./provider";
import {
  coerceOccurredAt,
  dedupeMessages,
  extractStructuredCandidates,
  findStringByKeys,
  flattenText,
  normalizeRole,
  sessionIdFromPageUrl,
  sortMessages,
  stableId
} from "./helpers";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function buildMessage(record: JsonRecord, fallbackParent?: string): NormalizedMessage | null {
  const content = flattenText(record.content ?? record.parts ?? record.text ?? record.message);
  if (!content) {
    return null;
  }

  const author = asRecord(record.author);
  const role = normalizeRole(author?.role ?? record.role);
  const id = typeof record.id === "string" ? record.id : stableId("chatgpt-msg", `${role}:${content}`);
  const parentId =
    (typeof record.parent === "string" ? record.parent : undefined) ??
    (typeof record.parent_id === "string" ? record.parent_id : undefined) ??
    fallbackParent;

  return {
    id,
    parentId,
    role,
    content,
    occurredAt: coerceOccurredAt(record.create_time ?? record.createTime ?? record.update_time),
    raw: record
  };
}

function extractFromMapping(mapping: JsonRecord): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  for (const node of Object.values(mapping)) {
    const record = asRecord(node);
    const message = asRecord(record?.message);
    const built = message ? buildMessage(message, typeof record?.parent === "string" ? record.parent : undefined) : null;
    if (built) {
      messages.push(built);
    }
  }
  return messages;
}

export class ChatGPTScraper implements IProviderScraper {
  readonly provider = "chatgpt" as const;

  matches(event: CapturedNetworkEvent): boolean {
    return /chatgpt\.com|chat\.openai\.com/.test(new URL(event.url).hostname) && /backend-api|conversation/.test(event.url);
  }

  parse(event: CapturedNetworkEvent): NormalizedSessionSnapshot | null {
    const structured = [event.response.json, ...extractStructuredCandidates(event.response.text)].filter(Boolean);
    const messages: NormalizedMessage[] = [];
    let title: string | undefined;
    let externalSessionId: string | undefined =
      findStringByKeys(structured, ["conversation_id", "conversationId"]) ??
      event.url.match(/conversations?\/([^/?]+)/)?.[1] ??
      sessionIdFromPageUrl(event.pageUrl) ??
      stableId("chatgpt-session", event.pageUrl);

    for (const candidate of structured) {
      const record = asRecord(candidate);
      if (!record) {
        continue;
      }

      title ??= findStringByKeys(record, ["title"]);
      externalSessionId ||= findStringByKeys(record, ["conversation_id", "conversationId"]);

      const mapping = asRecord(record.mapping);
      if (mapping) {
        messages.push(...extractFromMapping(mapping));
      }

      if (Array.isArray(record.messages)) {
        for (const item of record.messages) {
          const built = asRecord(item) ? buildMessage(item as JsonRecord) : null;
          if (built) {
            messages.push(built);
          }
        }
      }

      const messageRecord = asRecord(record.message);
      if (messageRecord) {
        const built = buildMessage(messageRecord, findStringByKeys(record, ["parent_message_id", "parent"]));
        if (built) {
          messages.push(built);
        }
      }
    }

    const normalized = sortMessages(dedupeMessages(messages));
    if (!normalized.length) {
      return null;
    }

    const resolvedSessionId = externalSessionId ?? stableId("chatgpt-session", event.pageUrl);

    return {
      provider: this.provider,
      externalSessionId: resolvedSessionId,
      title,
      sourceUrl: event.pageUrl,
      capturedAt: event.capturedAt,
      messages: normalized
    };
  }
}
