import { providerDisplayName } from "./accounts";
import type {
  ActiveChatContextSnapshot,
  ContextMigrationImportPayload,
  MessageRole
} from "./types";

const SCHEMA_VERSION = "savemycontext.context.v1" as const;

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function safeTitle(snapshot: ActiveChatContextSnapshot): string {
  return snapshot.title?.trim() || `${providerDisplayName(snapshot.provider)} chat`;
}

function roleHeading(role: MessageRole): string {
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  if (role === "tool") return "Tool";
  if (role === "system") return "System";
  return "Unknown";
}

export function renderActiveChatMarkdown(snapshot: ActiveChatContextSnapshot): string {
  const lines = [
    "---",
    `schema: ${SCHEMA_VERSION}`,
    `source_provider: ${snapshot.provider}`,
    `source_interface: ${snapshot.provider}-webpage`,
    `source_session_id: ${snapshot.externalSessionId}`,
    `captured_at: ${snapshot.capturedAt}`,
    "---",
    "",
    `# ${safeTitle(snapshot)}`,
    "",
    "## Source",
    "",
    `- Provider: ${providerDisplayName(snapshot.provider)}`,
    `- Source URL: ${snapshot.sourceUrl}`,
    `- Page URL: ${snapshot.pageUrl}`,
    `- Session: ${snapshot.externalSessionId}`,
    `- Account: ${snapshot.accountLabel ?? snapshot.accountKey ?? `${snapshot.provider}:web`}`,
    `- Captured: ${snapshot.capturedAt}`,
    "",
    "## Conversation",
    ""
  ];

  snapshot.messages.forEach((message, index) => {
    lines.push(`### ${index + 1}. ${roleHeading(message.role)}`);
    if (message.occurredAt) {
      lines.push("");
      lines.push(`_Time: ${message.occurredAt}_`);
    }
    lines.push("");
    lines.push(message.content.trim());
    lines.push("");
  });

  return `${lines.join("\n").trim()}\n`;
}

export function markdownDumpExternalSessionId(snapshot: ActiveChatContextSnapshot, markdown: string): string {
  return `${snapshot.provider}-web-markdown-${hashString(`${snapshot.sourceUrl}\n${markdown}`)}`;
}

export function buildMarkdownContextImportPayload(
  snapshot: ActiveChatContextSnapshot,
  markdown: string
): ContextMigrationImportPayload {
  const externalSessionId = markdownDumpExternalSessionId(snapshot, markdown);
  const title = safeTitle(snapshot);
  return {
    schema_version: SCHEMA_VERSION,
    provider: snapshot.provider,
    external_session_id: externalSessionId,
    source_interface: `${snapshot.provider}-webpage`,
    account_key: `${snapshot.provider}:webpage-dump`,
    account_label: `${providerDisplayName(snapshot.provider)} Webpage Dump`,
    title,
    source_url: snapshot.sourceUrl,
    captured_at: snapshot.capturedAt,
    custom_tags: ["markdown-handoff", `${snapshot.provider}-webpage-dump`],
    metadata: {
      page_url: snapshot.pageUrl,
      source_external_session_id: snapshot.externalSessionId,
      source_account_key: snapshot.accountKey ?? null,
      source_account_label: snapshot.accountLabel ?? null,
      handoff_format: "markdown",
      handoff_author: snapshot.provider
    },
    artifacts: [
      {
        kind: "handoff_markdown",
        name: `${externalSessionId}.md`,
        uri: snapshot.sourceUrl,
        content_type: "text/markdown",
        content: markdown
      }
    ],
    messages: [
      {
        id: `${externalSessionId}-markdown`,
        role: "assistant",
        content: markdown,
        occurred_at: snapshot.capturedAt,
        metadata: {
          source: "webpage-markdown-dump",
          source_interface: `${snapshot.provider}-webpage`,
          source_external_session_id: snapshot.externalSessionId
        }
      }
    ],
    handoff_markdown: markdown,
    raw_transcript: {
      source: "savemycontext-webpage-markdown-dump",
      snapshot
    }
  };
}
