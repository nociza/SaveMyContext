import type { ExtensionSettings, SyncStatus } from "../shared/types";
import { workspaceUrl } from "../shared/workspace-link";
import { compactDate, popupPresentation } from "./presentation";
import "./styles.css";

const element = (id: string) => document.getElementById(id)!;
const text = (id: string, value: string) => { element(id).textContent = value; };
const button = (id: string) => element(id) as HTMLButtonElement;
const actionIds = ["pause", "enable-capture", "clear-queue", "import-history", "save-page", "open-dashboard"];
let settings: ExtensionSettings | undefined;
let loading = false;
let refreshQueued = false;
let busy: string | null = null;
let available: Record<string, boolean> = {};

function syncButtons() {
  for (const id of actionIds) {
    button(id).disabled = Boolean(busy) || !available[id];
    button(id).setAttribute("aria-busy", String(busy === id));
  }
}
function feedback(message: string, tone = "success") {
  text("action-status", message);
  element("action-status").dataset.tone = tone;
}

async function refresh() {
  if (loading) { refreshQueued = true; return; }
  loading = true;
  try {
    const [configuration, status, delivery, tabs] = await Promise.all([
      chrome.runtime.sendMessage({ type: "GET_SETTINGS" }) as Promise<ExtensionSettings>,
      chrome.runtime.sendMessage({ type: "GET_STATUS" }) as Promise<SyncStatus>,
      chrome.runtime.sendMessage({ type: "GET_DELIVERY_STATUS" }) as Promise<{ pending: number }>,
      chrome.tabs.query({ active: true, currentWindow: true }),
    ]);
    settings = configuration;
    const view = popupPresentation(settings, status, tabs[0]?.url);
    element("consent").hidden = Boolean(settings.captureConsentGranted);
    text("consent-destination", settings.backendUrl || "Choose a backend in Settings");
    text("connection", status.backendValidationError ? "Connection needs attention" : status.backendValidatedAt ? "Connected" : "Not connected yet");
    button("setup-connection").hidden = Boolean(status.backendValidatedAt && !status.backendValidationError);
    button("setup-connection").textContent = status.backendValidationError ? "Review connection" : "Set up connection";
    text("capture-state", view.headline);
    text("capture-detail", view.detail);
    text("page-hint", view.hint);
    element("capture-card").dataset.state = view.state;
    text("last-success", compactDate(status.lastSuccessAt));
    element("last-success").title = status.lastSuccessAt ? new Date(status.lastSuccessAt).toLocaleString() : "";
    text("last-session", status.lastSessionKey || "None");
    text("last-error", status.lastError || status.backendValidationError || "None");
    text("capture-warning", status.lastError || "");
    element("capture-warning").hidden = !status.lastError;
    text("pending", delivery.pending ? `${delivery.pending} waiting to send` : "No pending captures");
    text("history-sync", status.historySyncInProgress
      ? `Importing · ${status.historySyncProcessedCount || 0}${status.historySyncTotalCount == null ? "" : ` / ${status.historySyncTotalCount}`} conversations`
      : `${status.historySyncLastResult || "Not imported"}${status.historySyncLastConversationCount === undefined ? "" : ` · ${status.historySyncLastConversationCount} conversations`}`);
    text("provider-drift", status.providerDriftAlert ? `${status.providerDriftAlert.provider}: ${status.providerDriftAlert.message}` : "");
    element("provider-drift-card").hidden = !status.providerDriftAlert;
    text("pause", settings.capturePaused ? "Resume capture" : "Pause capture");
    available = {
      "open-dashboard": true, "pause": view.canPause,
      "enable-capture": !settings.captureConsentGranted && Boolean(settings.backendUrl),
      "clear-queue": delivery.pending > 0, "save-page": view.canSave, "import-history": view.canImport,
    };
  } catch {
    available = {};
    text("connection", "Status unavailable");
    text("capture-state", "Let's reconnect");
    text("capture-detail", "Reopen this popup or check Settings to try again.");
    element("capture-card").dataset.state = "warning";
    button("setup-connection").hidden = false;
    button("setup-connection").textContent = "Open settings";
  } finally {
    loading = false;
    syncButtons();
    if (refreshQueued) { refreshQueued = false; void refresh(); }
  }
}

function action(id: string, operation: () => Promise<string | void>) {
  button(id).addEventListener("click", async () => {
    if (busy || !available[id]) return;
    busy = id;
    syncButtons();
    feedback("Working…", "working");
    try {
      const result = await operation();
      if (result) feedback(result);
    } catch (error) {
      feedback(error instanceof Error ? error.message : "Action failed. Please retry.", "error");
    } finally {
      // Keep the lock during the status read; storage events must not re-enable an in-flight action.
      await refresh();
      busy = null;
      syncButtons();
    }
  });
}

action("pause", async () => {
  const result = await chrome.runtime.sendMessage({ type: "SET_CAPTURE_PAUSED", paused: !settings!.capturePaused });
  if (!result?.ok) throw new Error(result?.error || "Could not change capture state");
  return result.paused ? "Paused. Existing queued evidence is retained." : "Capture resumed.";
});
action("enable-capture", async () => {
  const result = await chrome.runtime.sendMessage({ type: "ACCEPT_CAPTURE_CONSENT", backendUrl: settings!.backendUrl });
  if (!result?.ok) throw new Error(result?.error || "Could not enable capture");
  return "Capture enabled. Reload an already-open conversation if needed.";
});
action("clear-queue", async () => {
  if (!confirm("Permanently discard all unsent captures from this browser and pause capture? This cannot be undone. Already delivered data will not be deleted.")) return "Nothing discarded.";
  const result = await chrome.runtime.sendMessage({ type: "CLEAR_CAPTURE_QUEUE" });
  if (!result?.ok) throw new Error(result?.error || "Could not clear the queue");
  return "Queued captures discarded. Capture is paused.";
});
action("import-history", async () => {
  if (!confirm("Import conversation history from the active provider into your private workspace? Your provider/account filters still apply.")) return "Import cancelled.";
  const result = await chrome.runtime.sendMessage({ type: "IMPORT_ACTIVE_HISTORY" });
  if (!result?.triggered) throw new Error(result?.reason || "Could not start import");
  return "Import started. You can close this popup.";
});
action("save-page", async () => {
  const result = await chrome.runtime.sendMessage({ type: "SAVE_CURRENT_PAGE_SOURCE", payload: { saveMode: "raw" } });
  if (!result?.ok) throw new Error(result?.error || "Could not save this page");
  return "Page saved.";
});
action("open-dashboard", async () => {
  await chrome.tabs.create({ url: workspaceUrl(settings!) });
  window.close();
});
for (const id of ["settings", "setup-connection"]) {
  button(id).addEventListener("click", () => {
    void chrome.runtime.openOptionsPage().catch(() => feedback("Could not open Settings. Please reopen the extension.", "error"));
  });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "local" || area === "sync") && Object.keys(changes).some(key => key.startsWith("savemycontext."))) void refresh();
});
void refresh();
