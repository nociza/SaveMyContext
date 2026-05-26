import { detectProviderFromUrl } from "../shared/provider";
import type {
  ActiveChatContextMessage,
  ActiveChatContextResponse,
  ActiveChatContextSnapshot,
  MessageRole,
  ProviderName
} from "../shared/types";

type Candidate = {
  element: HTMLElement;
  role?: MessageRole;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function stableId(provider: ProviderName, role: MessageRole, index: number, content: string): string {
  let hash = 2166136261;
  const input = `${provider}:${role}:${index}:${content}`;
  for (let offset = 0; offset < input.length; offset += 1) {
    hash ^= input.charCodeAt(offset);
    hash = Math.imul(hash, 16777619);
  }
  return `${provider}-dom-${(hash >>> 0).toString(16)}`;
}

function sessionIdFromUrl(provider: ProviderName, url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const patterns = [
      /^\/c\/([^/]+)/,
      /^\/app\/([^/]+)/,
      /^\/chat\/([^/]+)/,
      /^\/u\/\d+\/app\/([^/]+)/
    ];
    for (const pattern of patterns) {
      const match = path.match(pattern);
      if (match?.[1]) {
        return decodeURIComponent(match[1]);
      }
    }
  } catch {
    // Fall through to a hash-based id below.
  }
  return stableId(provider, "unknown", 0, url);
}

function visibleText(element: HTMLElement): string {
  const clone = element.cloneNode(true);
  if (clone instanceof HTMLElement) {
    clone.querySelectorAll("script, style, noscript, svg, canvas, button, nav, aside").forEach((node) => node.remove());
    return normalizeWhitespace(clone.innerText || clone.textContent || "");
  }
  return normalizeWhitespace(element.innerText || element.textContent || "");
}

function isNestedCandidate(element: HTMLElement, selected: HTMLElement[]): boolean {
  return selected.some((candidate) => candidate !== element && candidate.contains(element));
}

function collectBySelector(selector: string, role?: MessageRole): Candidate[] {
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).map((element) => ({ element, role }));
}

function inferRole(element: HTMLElement, index: number): MessageRole {
  const markers = [
    element.getAttribute("data-message-author-role"),
    element.getAttribute("data-testid"),
    element.getAttribute("aria-label"),
    element.className,
    element.parentElement?.getAttribute("data-testid"),
    element.parentElement?.getAttribute("aria-label")
  ]
    .map((value) => String(value ?? "").toLowerCase())
    .join(" ");
  if (/user|human|you/.test(markers)) {
    return "user";
  }
  if (/assistant|model|response|answer|claude|chatgpt|gemini|grok/.test(markers)) {
    return "assistant";
  }
  return index % 2 === 0 ? "user" : "assistant";
}

function candidatesForProvider(provider: ProviderName): Candidate[] {
  if (provider === "chatgpt") {
    return [
      ...collectBySelector("[data-message-author-role='user']", "user"),
      ...collectBySelector("[data-message-author-role='assistant']", "assistant")
    ];
  }
  if (provider === "gemini") {
    return [
      ...collectBySelector("user-query", "user"),
      ...collectBySelector("model-response", "assistant"),
      ...collectBySelector("message-content", "assistant")
    ];
  }
  if (provider === "claude") {
    return [
      ...collectBySelector("[data-testid*='user']", "user"),
      ...collectBySelector("[data-testid*='assistant']", "assistant"),
      ...collectBySelector("main article")
    ];
  }
  if (provider === "grok") {
    return [
      ...collectBySelector("[data-testid*='user']", "user"),
      ...collectBySelector("[data-testid*='assistant']", "assistant"),
      ...collectBySelector("[data-testid*='message']"),
      ...collectBySelector("main article")
    ];
  }
  return [
    ...collectBySelector("[data-testid*='message']"),
    ...collectBySelector("main article")
  ];
}

export function extractPageChatContext(): ActiveChatContextResponse {
  const provider = detectProviderFromUrl(window.location.href);
  if (!provider) {
    return {
      ok: false,
      error: "This page is not a supported AI chat provider."
    };
  }

  const selectedElements: HTMLElement[] = [];
  const messages: ActiveChatContextMessage[] = [];
  for (const candidate of candidatesForProvider(provider)) {
    if (isNestedCandidate(candidate.element, selectedElements)) {
      continue;
    }
    const content = visibleText(candidate.element);
    if (content.length < 2) {
      continue;
    }
    const role = candidate.role ?? inferRole(candidate.element, messages.length);
    selectedElements.push(candidate.element);
    messages.push({
      id: candidate.element.id || stableId(provider, role, messages.length, content),
      role,
      content
    });
  }

  if (!messages.length) {
    const main = document.querySelector<HTMLElement>("main") ?? document.body;
    const content = visibleText(main);
    if (content) {
      messages.push({
        id: stableId(provider, "unknown", 0, content),
        role: "unknown",
        content
      });
    }
  }

  if (!messages.length) {
    return {
      ok: false,
      error: "Could not extract chat text from this page."
    };
  }

  const now = new Date().toISOString();
  const snapshot: ActiveChatContextSnapshot = {
    provider,
    externalSessionId: sessionIdFromUrl(provider, window.location.href),
    accountKey: `${provider}:webpage`,
    accountLabel: `${provider} webpage`,
    title: document.title.trim() || `${provider} chat`,
    sourceUrl: window.location.href,
    pageUrl: window.location.href,
    capturedAt: now,
    messages
  };
  return {
    ok: true,
    snapshot
  };
}
