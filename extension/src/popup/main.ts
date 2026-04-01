import "./styles.css";

import type { ExtensionSettings, RuntimeMessage, SyncStatus } from "../shared/types";

const backendUrl = document.querySelector<HTMLParagraphElement>("#backend-url");
const lastSuccess = document.querySelector<HTMLParagraphElement>("#last-success");
const lastSession = document.querySelector<HTMLParagraphElement>("#last-session");
const providers = document.querySelector<HTMLParagraphElement>("#providers");
const lastError = document.querySelector<HTMLParagraphElement>("#last-error");
const openOptionsButton = document.querySelector<HTMLButtonElement>("#open-options");

function formatDate(value?: string): string {
  if (!value) {
    return "No sync yet";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

async function sendMessage<TResponse>(message: RuntimeMessage): Promise<TResponse> {
  return chrome.runtime.sendMessage(message) as Promise<TResponse>;
}

async function load(): Promise<void> {
  const [settings, status] = await Promise.all([
    sendMessage<ExtensionSettings>({ type: "GET_SETTINGS" }),
    sendMessage<SyncStatus>({ type: "GET_STATUS" })
  ]);

  if (backendUrl) {
    backendUrl.textContent = settings.backendUrl;
  }
  if (lastSuccess) {
    lastSuccess.textContent = formatDate(status.lastSuccessAt);
  }
  if (lastSession) {
    lastSession.textContent = status.lastSessionKey ?? "n/a";
  }
  if (providers) {
    providers.textContent = Object.entries(settings.enabledProviders)
      .filter(([, enabled]) => enabled)
      .map(([provider]) => provider)
      .join(", ");
  }
  if (lastError) {
    lastError.textContent = status.lastError ?? "None";
  }
}

openOptionsButton?.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

void load();

