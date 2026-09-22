import { detectProviderFromUrl, supportsProactiveHistorySync } from "../shared/provider";
import type { ExtensionSettings, SyncStatus } from "../shared/types";

const providerLabels: Record<string, string> = { chatgpt: "ChatGPT", gemini: "Gemini", grok: "Grok", claude: "Claude", codex: "Codex" };

export function popupPresentation(settings: ExtensionSettings, status: SyncStatus, url?: string) {
  const consented = Boolean(settings.captureConsentGranted);
  const paused = Boolean(settings.capturePaused);
  const provider = url ? detectProviderFromUrl(url) : null;
  const supported = Boolean(provider && supportsProactiveHistorySync(provider));
  const enabled = Boolean(provider && settings.enabledProviders[provider]);
  const canCapture = consented && !paused;
  const webPage = Boolean(url && /^https?:\/\//i.test(url));
  const providerName = provider ? providerLabels[provider] || provider : "";
  const enabledNames = Object.entries(settings.enabledProviders)
    .filter(([, active]) => active).map(([name]) => providerLabels[name] || name);
  const headline = !consented ? "You're in control" : paused ? "Capture paused" :
    supported && !enabled ? "Provider switched off" : enabledNames.length ? "Ready to capture" : "Providers switched off";
  const detail = !consented ? "Review what is saved before enabling capture." : paused ?
    "New captures are stopped. Anything queued stays here." :
    supported ? enabled ? `${providerName} capture is on. Your account and indexing filters apply.` :
      `Enable ${providerName} in Settings to capture conversations.` :
    enabledNames.length ? `Conversations on ${enabledNames.join(", ")} are saved as you browse, subject to your filters.` :
      "Choose a provider in Settings, or save a page manually.";
  const hint = !consented ? "Enable capture to save pages and import history." : paused ?
    "Resume capture to save pages or import history." : status.historySyncInProgress ?
    "History import is running. You can safely close this popup." : supported && !enabled ?
    `History import is off for ${providerName}. Change this in Settings.` : supported ?
    `Import ${providerName} history, or save just this page.` : webPage ?
    "Save this page. For history import, open ChatGPT, Gemini, or Grok." :
    "Open a website to save a page, or an AI provider to import history.";
  return {
    headline, detail, hint,
    state: status.backendValidationError || status.lastError ? "warning" : canCapture && enabledNames.length ? "active" : "paused",
    canSave: canCapture && webPage,
    canImport: canCapture && supported && enabled && !status.historySyncInProgress,
    canPause: consented,
  };
}

export function compactDate(value?: string): string {
  if (!value) return "Nothing saved yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
