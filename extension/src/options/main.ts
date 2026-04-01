import "./styles.css";

import type { ExtensionSettings, RuntimeMessage, SyncStatus } from "../shared/types";

const form = document.querySelector<HTMLFormElement>("#settings-form");
const backendUrlInput = document.querySelector<HTMLInputElement>("#backend-url");
const autoSyncHistoryInput = document.querySelector<HTMLInputElement>("#auto-sync-history");
const providerInputs = {
  chatgpt: document.querySelector<HTMLInputElement>("#provider-chatgpt"),
  gemini: document.querySelector<HTMLInputElement>("#provider-gemini"),
  grok: document.querySelector<HTMLInputElement>("#provider-grok")
};
const saveStatus = document.querySelector<HTMLParagraphElement>("#save-status");
const lastSuccess = document.querySelector<HTMLParagraphElement>("#last-success");
const lastSession = document.querySelector<HTMLParagraphElement>("#last-session");
const lastError = document.querySelector<HTMLParagraphElement>("#last-error");
const historySync = document.querySelector<HTMLParagraphElement>("#history-sync");

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
  if (autoSyncHistoryInput) {
    autoSyncHistoryInput.checked = settings.autoSyncHistory;
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
  if (historySync) {
    if (status.historySyncInProgress) {
      historySync.textContent = `Running ${status.historySyncProvider ?? ""}`.trim();
    } else if (status.historySyncLastCompletedAt) {
      const count =
        typeof status.historySyncLastConversationCount === "number"
          ? `, ${status.historySyncLastConversationCount} conversations`
          : "";
      historySync.textContent = `${status.historySyncLastResult ?? "success"} ${formatDate(
        status.historySyncLastCompletedAt
      )}${count}`;
    } else {
      historySync.textContent = settings.autoSyncHistory ? "Idle" : "Disabled";
    }
  }
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!backendUrlInput) {
    return;
  }

  const nextSettings: Partial<ExtensionSettings> = {
    backendUrl: backendUrlInput.value.trim(),
    autoSyncHistory: autoSyncHistoryInput?.checked ?? true,
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
