import type { ProviderName } from "./types";

export function detectProviderFromUrl(url: string): ProviderName | null {
  try {
    const hostname = new URL(url).hostname;
    if (hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com") || hostname === "chat.openai.com") {
      return "chatgpt";
    }
    if (/gemini\.google\.com/.test(hostname)) {
      return "gemini";
    }
    if (hostname === "grok.com" || hostname.endsWith(".grok.com")) {
      return "grok";
    }
    if (hostname === "claude.ai" || hostname.endsWith(".claude.ai")) {
      return "claude";
    }
    if (hostname === "codex.openai.com" || hostname.endsWith(".codex.openai.com")) {
      return "codex";
    }
  } catch {
    return null;
  }
  return null;
}

export function supportsProactiveHistorySync(provider: ProviderName): boolean {
  return provider === "chatgpt" || provider === "gemini" || provider === "grok";
}
