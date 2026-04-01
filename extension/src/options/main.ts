import "./styles.css";

import type { ExtensionSettings, RuntimeMessage, SyncStatus } from "../shared/types";

const form = document.querySelector<HTMLFormElement>("#settings-form");
const backendUrlInput = document.querySelector<HTMLInputElement>("#backend-url");
const providerInputs = {
  chatgpt: document.querySelector<HTMLInputElement>("#provider-chatgpt"),
  gemini: document.querySelector<HTMLInputElement>("#provider-gemini"),
  grok: document.querySelector<HTMLInputElement>("#provider-grok")
};
const saveStatus = document.querySelector<HTMLParagraphElement>("#save-status");
const lastSuccess = document.querySelector<HTMLParagraphElement>("#last-success");
const lastSession = document.querySelector<HTMLParagraphElement>("#last-session");
const lastError = document.querySelector<HTMLParagraphElement>("#last-error");

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

  if (backendUrlInput) {
    backendUrlInput.value = settings.backendUrl;
  }

  for (const [provider, input] of Object.entries(providerInputs)) {
    if (input) {
      input.checked = settings.enabledProviders[provider as keyof typeof settings.enabledProviders];
    }
  }

  if (lastSuccess) {
    lastSuccess.textContent = formatDate(status.lastSuccessAt);
  }
  if (lastSession) {
    lastSession.textContent = status.lastSessionKey ?? "n/a";
  }
  if (lastError) {
    lastError.textContent = status.lastError ?? "None";
  }
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!backendUrlInput) {
    return;
  }

  const nextSettings: Partial<ExtensionSettings> = {
    backendUrl: backendUrlInput.value.trim(),
    enabledProviders: {
      chatgpt: providerInputs.chatgpt?.checked ?? true,
      gemini: providerInputs.gemini?.checked ?? true,
      grok: providerInputs.grok?.checked ?? true
    }
  };

  await sendMessage<ExtensionSettings>({
    type: "SAVE_SETTINGS",
    payload: nextSettings
  });

  if (saveStatus) {
    saveStatus.textContent = "Settings saved.";
  }
  await load();
});

void load();

