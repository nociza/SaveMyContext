import type { CapturedNetworkEvent, NormalizedMessage, NormalizedSessionSnapshot } from "../shared/types";
import type { IProviderScraper } from "./provider";
import {
  coerceOccurredAt,
  collectStrings,
  dedupeMessages,
  extractStructuredCandidates,
  findStringByKeys,
  flattenText,
  normalizeRole,
  pickLikelyText,
  resolveCapturedUrl,
  sessionIdFromPageUrl,
  sortMessages,
  stableId
} from "./helpers";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function isGrokHostname(hostname: string): boolean {
  return hostname === "grok.com" || hostname.endsWith(".grok.com");
}

function isGrokConversationCaptureRoute(url: URL): boolean {
  const pathname = url.pathname.replace(/\/$/, "");
  return (
    /^\/rest\/app-chat\/conversations\/[^/]+\/(responses|load-responses|user-responses|model-responses)$/.test(pathname) ||
    pathname === "/rest/app-chat/conversations/new" ||
    /^\/rest\/app-chat\/read-response\/[^/]+$/.test(pathname) ||
    /^\/rest\/app-chat\/conversations\/reconnect-response(?:-v2)?\/[^/]+$/.test(pathname)
  );
}

function conversationIdFromCapturedUrl(url: URL): string | undefined {
  const conversationScopedMatch = url.pathname.match(/^\/rest\/app-chat\/conversations\/([^/]+)\//);
  const conversationId = conversationScopedMatch?.[1] ? decodeURIComponent(conversationScopedMatch[1]) : undefined;
  if (conversationId && !["new", "exists", "inflight-response", "reconnect-response", "reconnect-response-v2"].includes(conversationId)) {
    return conversationId;
  }

  const pageScopedMatch = url.pathname.match(/^\/c\/([^/]+)/);
  return pageScopedMatch?.[1] ? decodeURIComponent(pageScopedMatch[1]) : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = flattenText(value);
    if (text) {
      return text;
    }
  }
  return "";
}

function isGrokConversationListPayload(value: unknown): boolean {
  const record = asRecord(value);
  return Boolean(record && Array.isArray(record.conversations) && !Array.isArray(record.messages) && !Array.isArray(record.responses));
}

function buildExplicitMessage(item: unknown, index: number, externalSessionId: string): NormalizedMessage | null {
  const record = asRecord(item);
  if (!record) {
    return null;
  }

  const role = normalizeRole(record.role ?? record.sender ?? record.author);
  const content =
    role === "user"
      ? firstText(record.content, record.query, record.message, record.text, record.body)
      : firstText(record.content, record.message, record.query, record.text, record.body);
  if (!content) {
    return null;
  }

  const explicitId = firstString(record.id, record.responseId);
  const parentId =
    typeof record.parentId === "string" && record.parentId.trim()
      ? record.parentId.trim()
      : typeof record.parentResponseId === "string" && record.parentResponseId.trim()
        ? record.parentResponseId.trim()
        : typeof record.parent_id === "string" && record.parent_id.trim()
          ? record.parent_id.trim()
          : typeof record.threadParentId === "string" && record.threadParentId.trim()
            ? record.threadParentId.trim()
            : undefined;

  return {
    id: explicitId ?? stableId("grok-msg", `${externalSessionId}:${role}:${index}:${content}`),
    parentId,
    role,
    content,
    occurredAt: coerceOccurredAt(record.occurredAt ?? record.occurred_at ?? record.createdAt ?? record.createTime),
    raw: record
  };
}

function buildGenericMessage(value: unknown): NormalizedMessage | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const role = normalizeRole(record.role ?? record.sender ?? record.author);
  const content = flattenText(record.content ?? record.text ?? record.body ?? record.message);
  if (!content) {
    return null;
  }

  return {
    id:
      firstString(record.id, record.responseId) ??
      stableId("grok-msg", `${role}:${content}`),
    parentId:
      (typeof record.parentId === "string" ? record.parentId : undefined) ??
      (typeof record.parent_id === "string" ? record.parent_id : undefined),
    role,
    content,
    occurredAt:
      typeof record.createdAt === "string"
        ? record.createdAt
        : typeof record.created_at === "string"
          ? record.created_at
          : typeof record.createTime === "string"
            ? record.createTime
            : undefined,
    raw: record
  };
}

function explicitMessagesFromCandidate(candidate: unknown, externalSessionId: string): NormalizedMessage[] {
  const record = asRecord(candidate);
  if (!record) {
    return [];
  }

  const messages: NormalizedMessage[] = [];
  for (const key of ["messages", "responses", "modelResponses", "userResponses"]) {
    const value = record[key];
    if (!Array.isArray(value)) {
      continue;
    }

    messages.push(
      ...value
        .map((message, index) => buildExplicitMessage(message, index, externalSessionId))
        .filter((message): message is NormalizedMessage => Boolean(message))
    );
  }

  const direct = buildExplicitMessage(record.response ?? record, 0, externalSessionId);
  if (direct) {
    messages.push(direct);
  }

  return messages;
}

export class GrokScraper implements IProviderScraper {
  readonly provider = "grok" as const;

  matches(event: CapturedNetworkEvent): boolean {
    const url = resolveCapturedUrl(event.url, event.pageUrl);
    if (!url) {
      return false;
    }

    return isGrokHostname(url.hostname) && isGrokConversationCaptureRoute(url);
  }

  parse(event: CapturedNetworkEvent): NormalizedSessionSnapshot | null {
    const capturedUrl = resolveCapturedUrl(event.url, event.pageUrl);
    if (!capturedUrl || !isGrokHostname(capturedUrl.hostname) || !isGrokConversationCaptureRoute(capturedUrl)) {
      return null;
    }

    const requestCandidates = [event.requestBody?.json, ...extractStructuredCandidates(event.requestBody?.text)].filter(Boolean);
    const responseCandidates = [event.response.json, ...extractStructuredCandidates(event.response.text)].filter(Boolean);
    const structured = [...requestCandidates, ...responseCandidates];
    if (responseCandidates.some(isGrokConversationListPayload)) {
      return null;
    }

    const messages: NormalizedMessage[] = [];
    let title = findStringByKeys(structured, ["title", "conversationTitle"]);
    const externalSessionId =
      findStringByKeys(structured, ["conversationId", "conversation_id"]) ??
      conversationIdFromCapturedUrl(capturedUrl) ??
      sessionIdFromPageUrl(event.pageUrl) ??
      stableId("grok-session", event.pageUrl);

    const explicitMessages = dedupeMessages(
      responseCandidates.flatMap((candidate) => explicitMessagesFromCandidate(candidate, externalSessionId))
    );
    if (explicitMessages.length) {
      return {
        provider: this.provider,
        externalSessionId,
        title,
        sourceUrl: event.pageUrl,
        capturedAt: event.capturedAt,
        messages: sortMessages(explicitMessages)
      };
    }

    for (const candidate of structured) {
      const record = asRecord(candidate);
      if (!record) {
        continue;
      }

      title ??= findStringByKeys(record, ["title", "conversationTitle"]);
      for (const key of ["messages", "responses"]) {
        const value = record[key];
        if (Array.isArray(value)) {
          for (const item of value) {
            const built = buildGenericMessage(item);
            if (built) {
              messages.push(built);
            }
          }
        }
      }

      const direct = buildGenericMessage(record.message ?? record);
      if (direct) {
        messages.push(direct);
      }
    }

    if (!messages.length) {
      const prompt = pickLikelyText(requestCandidates.flatMap((value) => collectStrings(value)), false);
      const reply = pickLikelyText(responseCandidates.flatMap((value) => collectStrings(value)), true);
      if (prompt) {
        messages.push({
          id: stableId("grok-user", `${event.requestId}:${prompt}`),
          role: "user",
          content: prompt,
          occurredAt: event.capturedAt,
          raw: requestCandidates[0]
        });
      }
      if (reply) {
        messages.push({
          id: stableId("grok-assistant", `${event.requestId}:${reply}`),
          role: "assistant",
          content: reply,
          occurredAt: event.capturedAt,
          raw: responseCandidates[0]
        });
      }
    }

    const normalized = sortMessages(dedupeMessages(messages));
    if (!normalized.length) {
      return null;
    }

    return {
      provider: this.provider,
      externalSessionId,
      title,
      sourceUrl: event.pageUrl,
      capturedAt: event.capturedAt,
      messages: normalized
    };
  }
}
