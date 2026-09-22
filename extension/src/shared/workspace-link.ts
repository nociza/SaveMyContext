import type { ExtensionSettings } from "./types";

export function validateWorkspaceUrl(raw: string): string {
  if (!raw.trim()) return "";
  const url = new URL(raw.trim());
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTPS workspace URL (or local HTTP), without credentials, query, or fragment.");
  }
  return url.toString();
}

export function workspaceUrl(settings: ExtensionSettings, view = "memory"): string {
  // The optional external UI owns its authentication. Never append the API token.
  const external = validateWorkspaceUrl(settings.workspaceUrl || "");
  if (external) return external;
  const url = new URL(chrome.runtime.getURL("workspace.html"));
  url.searchParams.set("view", ["inbox", "memory", "tasks", "projects"].includes(view) ? view : "memory");
  return url.toString();
}
