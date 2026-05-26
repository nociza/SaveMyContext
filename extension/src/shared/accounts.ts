import type { ProviderName } from "./types";

export function providerDisplayName(provider: ProviderName): string {
  if (provider === "chatgpt") {
    return "ChatGPT";
  }
  if (provider === "gemini") {
    return "Gemini";
  }
  if (provider === "grok") {
    return "Grok";
  }
  if (provider === "codex") {
    return "Codex";
  }
  return "Claude";
}

export function normalizeAccountKey(provider: ProviderName, rawKey?: string | null): string {
  const cleaned = (rawKey ?? "").trim().toLowerCase();
  if (!cleaned) {
    return `${provider}:default`;
  }
  return cleaned.includes(":") ? cleaned : `${provider}:${cleaned}`;
}

export function accountKeySuffix(accountKey?: string | null): string {
  const cleaned = (accountKey ?? "").trim();
  return cleaned.includes(":") ? cleaned.split(":").slice(1).join(":") : cleaned;
}

export function accountLabelForKey(provider: ProviderName, accountKey?: string | null): string {
  const suffix = accountKeySuffix(accountKey);
  if (!suffix || suffix === "default") {
    return `${providerDisplayName(provider)} account`;
  }
  if (provider === "gemini" && /^u\d+$/.test(suffix)) {
    return `${providerDisplayName(provider)} ${suffix}`;
  }
  return suffix;
}

export function normalizeAccountLabel(provider: ProviderName, accountKey: string, rawLabel?: string | null): string {
  const cleaned = (rawLabel ?? "").trim();
  return cleaned || accountLabelForKey(provider, accountKey);
}

export function normalizeProviderAccount(
  provider: ProviderName,
  rawKey?: string | null,
  rawLabel?: string | null
): { accountKey: string; accountLabel: string } {
  const accountKey = normalizeAccountKey(provider, rawKey);
  return {
    accountKey,
    accountLabel: normalizeAccountLabel(provider, accountKey, rawLabel)
  };
}

export function scopeExternalSessionIdByAccount(externalSessionId: string, accountKey: string): string {
  const suffix = accountKeySuffix(accountKey);
  if (!suffix || suffix === "default") {
    return externalSessionId;
  }
  return externalSessionId.startsWith(`${suffix}__`) ? externalSessionId : `${suffix}__${externalSessionId}`;
}
