import { detectProviderFromUrl,supportsProactiveHistorySync } from "../shared/provider";
import type { ExtensionSettings,SyncStatus } from "../shared/types";
import { workspaceUrl } from "../shared/workspace-link";
import "./styles.css";

const text = (id: string, value: string) => { document.getElementById(id)!.textContent = value; };
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
let settings: ExtensionSettings;
let loading = false;
let refreshQueued = false;

async function refresh() {
  if (loading) { refreshQueued = true; return; }
  loading = true;
  try {
    const [configuration, status, delivery] = await Promise.all([
      chrome.runtime.sendMessage({ type: "GET_SETTINGS" }) as Promise<ExtensionSettings>,
      chrome.runtime.sendMessage({ type: "GET_STATUS" }) as Promise<SyncStatus>,
      chrome.runtime.sendMessage({ type: "GET_DELIVERY_STATUS" }) as Promise<{ pending: number }>,
    ]);
    settings = configuration;
    document.getElementById("consent")!.hidden = Boolean(settings.captureConsentGranted);
    text("consent-destination", settings.backendUrl);
    button("open-dashboard").disabled = false;
    text("connection", status.backendValidationError ? "Connection needs attention" : status.backendValidatedAt ? "Connected" : "Not connected yet");
    text("last-success", status.lastSuccessAt ? new Date(status.lastSuccessAt).toLocaleString() : "Nothing saved yet");
    text("last-session", status.lastSessionKey || "None");
    text("last-error", status.lastError || status.backendValidationError || "None");
    text("capture-warning", status.lastError || "");
    document.getElementById("capture-warning")!.hidden = !status.lastError;
    text("pending", `${delivery.pending} waiting to send`);
    text("history-sync", status.historySyncInProgress
      ? `Importing · ${status.historySyncProcessedCount || 0} conversations`
      : `${status.historySyncLastResult || "Not imported"}${status.historySyncLastConversationCount === undefined ? "" : ` · ${status.historySyncLastConversationCount} conversations`}`);
    text("provider-drift", status.providerDriftAlert ? `${status.providerDriftAlert.provider}: ${status.providerDriftAlert.message}` : "");
    document.getElementById("provider-drift-card")!.hidden = !status.providerDriftAlert;
    button("pause").textContent = settings.capturePaused ? "Resume capture" : "Pause capture";
    button("pause").disabled = !settings.captureConsentGranted;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const provider = tab?.url ? detectProviderFromUrl(tab.url) : null;
    const supported = Boolean(provider && supportsProactiveHistorySync(provider));
    text("capture-state", settings.capturePaused ? "Capture paused" : supported ? `${provider} · capture ${settings.enabledProviders[provider!] ? "enabled" : "disabled"}` : "Open a supported AI conversation to import history");
    button("import-history").disabled = !supported || !settings.enabledProviders[provider!] || Boolean(settings.capturePaused) || Boolean(status.historySyncInProgress);
    button("save-page").disabled = !tab?.url?.startsWith("http") || Boolean(settings.capturePaused);
  } catch {
    text("connection", "Could not read extension status. Reload the extension and try again.");
  } finally {
    loading = false;
    if (refreshQueued) { refreshQueued = false; void refresh(); }
  }
}

function action(id: string, operation: () => Promise<void>) {
  button(id).addEventListener("click", async () => {
    button(id).disabled = true;
    text("action-status", "Working…");
    try { await operation(); } catch (error) {
      text("action-status", error instanceof Error ? error.message : "Action failed. Please retry.");
    } finally { button(id).disabled = false; await refresh(); }
  });
}

action("pause", async () => {
  const result = await chrome.runtime.sendMessage({ type: "SET_CAPTURE_PAUSED", paused: !settings.capturePaused });
  if (!result?.ok) throw new Error(result?.error || "Could not change capture state");
  text("action-status", result.paused ? "Paused. Existing queued evidence is retained." : "Capture resumed.");
});
action("enable-capture", async () => {
  const result = await chrome.runtime.sendMessage({ type: "ACCEPT_CAPTURE_CONSENT", backendUrl: settings.backendUrl });
  if (!result?.ok) throw new Error(result?.error || "Could not enable capture");
  text("action-status", "Capture enabled. Reload an already-open conversation if needed.");
});
action("clear-queue", async () => {
  if (!confirm("Permanently discard all unsent captures from this browser and pause capture? This cannot be undone. Already delivered data will not be deleted.")) return;
  const result = await chrome.runtime.sendMessage({ type: "CLEAR_CAPTURE_QUEUE" });
  if (!result?.ok) throw new Error(result?.error || "Could not clear the queue");
  text("action-status", "Queued captures discarded. Capture is paused.");
});
action("import-history", async () => {
  if (!confirm("Import conversation history from the active provider into your private workspace? Your provider/account filters still apply.")) {
    text("action-status", "Import cancelled."); return;
  }
  const result = await chrome.runtime.sendMessage({ type: "IMPORT_ACTIVE_HISTORY" });
  if (!result?.triggered) throw new Error(result?.reason || "Could not start import");
  text("action-status", "Import started. You can close this popup.");
});
action("save-page", async () => {
  const result = await chrome.runtime.sendMessage({ type: "SAVE_CURRENT_PAGE_SOURCE", payload: { saveMode: "raw" } });
  if (!result?.ok) throw new Error(result?.error || "Could not save this page");
  text("action-status", "Page saved.");
});
action("open-dashboard", async () => {
  await chrome.tabs.create({ url: workspaceUrl(settings) }); window.close();
});
button("settings").addEventListener("click", () => void chrome.runtime.openOptionsPage());
chrome.storage.onChanged.addListener(() => void refresh());
void refresh();
