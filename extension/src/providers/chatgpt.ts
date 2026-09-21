import type { CapturedNetworkEvent, NormalizedMessage, NormalizedSessionSnapshot } from "../shared/types";
import { normalizeProviderAccount, scopeExternalSessionIdByAccount } from "../shared/accounts";
import type { IProviderScraper } from "./provider";
import { chatGPTProject } from "./chatgpt-project";
import {
  coerceOccurredAt,
  dedupeMessages,
  extractStructuredCandidates,
  findStringByKeys,
  flattenText,
  normalizeRole,
  resolveCapturedUrl,
  sessionIdFromPageUrl,
  stableId
} from "./helpers";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function isChatGPTHostname(hostname: string): boolean {
  return hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com") || hostname === "chat.openai.com";
}

function isChatGPTConversationCaptureRoute(url: URL): boolean {
  const pathname = url.pathname.replace(/\/$/, "");
  return pathname === "/backend-api/conversation" || /^\/backend-api\/conversation\/[^/]+$/.test(pathname);
}

function conversationIdFromCapturedUrl(url: URL): string | undefined {
  const apiMatch = url.pathname.match(/^\/backend-api\/conversation\/([^/]+)$/);
  if (apiMatch?.[1]) {
    return decodeURIComponent(apiMatch[1]);
  }

  const pageMatch = url.pathname.match(/^\/c\/([^/]+)/);
  return pageMatch?.[1] ? decodeURIComponent(pageMatch[1]) : undefined;
}

function accountCandidateFromStructured(values: unknown[]): { key?: string; label?: string } {
  const label =
    findStringByKeys(values, ["email", "emailAddress", "email_address", "username", "displayName", "display_name"]) ??
    undefined;
  const key =
    findStringByKeys(values, [
      "account_id",
      "accountId",
      "user_id",
      "userId",
      "workspace_id",
      "workspaceId",
      "organization_id",
      "organizationId"
    ]) ?? label;
  return { key, label };
}

function chatGPTContentType(record: JsonRecord): string | undefined {
  const content = asRecord(record.content);
  return typeof content?.content_type === "string" ? content.content_type : undefined;
}

function chatGPTContentText(value: unknown): string {
  if (typeof value === "string") {
    return flattenText(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === "string" ? flattenText(part) : chatGPTContentText(part)))
      .filter(Boolean)
      .join("\n");
  }

  const record = asRecord(value);
  if (!record) {
    return "";
  }

  const parts = record.parts;
  if (Array.isArray(parts)) {
    return parts
      .map((part) => {
        if (typeof part === "string") {
          return flattenText(part);
        }
        const partRecord = asRecord(part);
        return typeof partRecord?.text === "string" ? flattenText(partRecord.text) : "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (typeof record.text === "string") {
    return flattenText(record.text);
  }
  if (typeof record.content === "string") {
    return flattenText(record.content);
  }

  return "";
}

function isVisibleChatGPTMessage(record: JsonRecord): boolean {
  const author = asRecord(record.author);
  const role = normalizeRole(author?.role ?? record.role);
  if (role !== "user" && role !== "assistant") {
    return false;
  }

  const metadata = asRecord(record.metadata);
  if (metadata?.is_visually_hidden_from_conversation === true) {
    return false;
  }

  const contentType = chatGPTContentType(record);
  if (contentType && ["reasoning_recap", "thoughts", "model_editable_context"].includes(contentType)) {
    return false;
  }

  const recipient = typeof record.recipient === "string" ? record.recipient : undefined;
  if (role === "assistant" && recipient && recipient !== "all" && recipient !== "assistant") {
    return false;
  }

  return true;
}

function buildMessage(record: JsonRecord, fallbackParent?: string): NormalizedMessage | null {
  if (!isVisibleChatGPTMessage(record)) {
    return null;
  }

  const content = chatGPTContentText(record.content ?? record.parts ?? record.text ?? record.message);
  if (!content) {
    return null;
  }

  const author = asRecord(record.author);
  const metadata = asRecord(record.metadata);
  const role = normalizeRole(author?.role ?? record.role);
  const id = typeof record.id === "string" ? record.id : stableId("chatgpt-msg", `${role}:${content}`);
  const parentId =
    (typeof record.parent === "string" ? record.parent : undefined) ??
    (typeof record.parent_id === "string" ? record.parent_id : undefined) ??
    (typeof metadata?.parent_id === "string" ? metadata.parent_id : undefined) ??
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

function extractFromMapping(mapping: JsonRecord, currentNode?: string): NormalizedMessage[] {
  return extractFromMappingPath(mapping, currentNode).flatMap(({ message, parent }) => {
    const parentMessageId = parent ? asRecord(asRecord(mapping[parent])?.message)?.id : undefined;
    const built = buildMessage(message, typeof parentMessageId === "string" ? parentMessageId : parent);
    return built ? [built] : [];
  });
}

function extractFromMappingPath(mapping: JsonRecord, currentNode?: string): Array<{ message: JsonRecord; parent?: string }> {
  if (!currentNode) {
    // A single connected branch can be recovered without guessing. Never join
    // sibling answers/regenerations into one invented conversation.
    const aliases = new Map<string, string>();
    for (const [key, value] of Object.entries(mapping)) {
      const id = asRecord(asRecord(value)?.message)?.id;
      if (typeof id === "string") aliases.set(id, key);
    }
    const normalized = Object.fromEntries(Object.entries(mapping).map(([key, value]) => {
      const node = asRecord(value);
      const parent = typeof node?.parent === "string" ? aliases.get(node.parent) ?? node.parent : undefined;
      return [key, { ...node, parent }];
    }));
    const parents = new Set(Object.values(normalized).map((node) => node.parent));
    const leaves = Object.keys(normalized).filter((key) => !parents.has(key));
    return leaves.length === 1 ? extractFromMappingPath(normalized, leaves[0]) : [];
  }
  if (currentNode && asRecord(mapping[currentNode])) {
    const path: Array<{ node: JsonRecord; parent?: string }> = [];
    const seen = new Set<string>();
    let cursor: string | undefined = currentNode;

    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const node = asRecord(mapping[cursor]);
      if (!node) {
        break;
      }
      path.push({
        node,
        parent: typeof node.parent === "string" ? node.parent : undefined
      });
      cursor = typeof node.parent === "string" ? node.parent : undefined;
    }

    return path.reverse().flatMap(({ node, parent }) => {
      const message = asRecord(node.message);
      return message ? [{ message, parent }] : [];
    });
  }

  return [];
}

function hasCompletePath(value: unknown): boolean {
  const record = asRecord(value);
  const mapping = asRecord(record?.mapping);
  let cursor = typeof record?.current_node === "string" ? record.current_node : undefined;
  if (!mapping || !cursor) return false;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    const node = asRecord(mapping[cursor]);
    if (!node) return false;
    if (node.parent === null) return true;
    if (typeof node.parent !== "string") return false;
    cursor = node.parent;
  }
  return true;
}

function extractMessagesFromCandidate(candidate: unknown): NormalizedMessage[] {
  const record = asRecord(candidate);
  if (!record) {
    return [];
  }

  const messages: NormalizedMessage[] = [];
  const mapping = asRecord(record.mapping);
  if (mapping) {
    messages.push(...extractFromMapping(mapping, typeof record.current_node === "string" ? record.current_node : undefined));
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

  return messages;
}

export class ChatGPTScraper implements IProviderScraper {
  readonly provider = "chatgpt" as const;

  matches(event: CapturedNetworkEvent): boolean {
    const url = resolveCapturedUrl(event.url, event.pageUrl);
    if (!url) {
      return false;
    }

    return isChatGPTHostname(url.hostname) && isChatGPTConversationCaptureRoute(url);
  }

  parse(event: CapturedNetworkEvent): NormalizedSessionSnapshot | null {
    const capturedUrl = resolveCapturedUrl(event.url, event.pageUrl);
    if (!capturedUrl || !isChatGPTHostname(capturedUrl.hostname) || !isChatGPTConversationCaptureRoute(capturedUrl)) {
      return null;
    }

    const requestCandidates = [event.requestBody?.json, ...extractStructuredCandidates(event.requestBody?.text)].filter(Boolean);
    const responseCandidates = [event.response.json, ...extractStructuredCandidates(event.response.text)].filter(Boolean);
    const structured = [...requestCandidates, ...responseCandidates];
    const messages: NormalizedMessage[] = [];
    let title: string | undefined;
    let externalSessionId: string | undefined =
      findStringByKeys(structured, ["conversation_id", "conversationId"]) ??
      conversationIdFromCapturedUrl(capturedUrl) ??
      sessionIdFromPageUrl(event.pageUrl) ??
      stableId("chatgpt-session", event.pageUrl);

    for (const candidate of structured) {
      const record = asRecord(candidate);
      if (!record) {
        continue;
      }

      title ??= findStringByKeys(record, ["title"]);
      externalSessionId ||= findStringByKeys(record, ["conversation_id", "conversationId"]);
      messages.push(...extractMessagesFromCandidate(record));
    }

    const normalized = dedupeMessages(messages);
    if (!normalized.length) {
      return null;
    }

    const accountCandidate = accountCandidateFromStructured(structured);
    const account = normalizeProviderAccount(this.provider, accountCandidate.key, accountCandidate.label);
    const resolvedSessionId = scopeExternalSessionIdByAccount(
      externalSessionId ?? stableId("chatgpt-session", event.pageUrl),
      account.accountKey
    );

    return {
      project: chatGPTProject(event, responseCandidates),
      completeness: event.response.ok && event.method === "GET" && responseCandidates.some(hasCompletePath)
        ? "complete" : "partial",
      provider: this.provider,
      externalSessionId: resolvedSessionId,
      accountKey: account.accountKey,
      accountLabel: account.accountLabel,
      title,
      sourceUrl: event.pageUrl,
      capturedAt: event.capturedAt,
      messages: normalized
    };
  }
}
