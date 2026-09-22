import { resolveApiBase } from "./workspace.js";
export { resolveApiBase } from "./workspace.js";

/** Configuration is deployment-owned. Never read credentials or endpoints from URL parameters. */
export function parseConfig(value, pageUrl) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["apiBase", "view"].includes(key))) {
    throw new Error("Workspace config accepts only apiBase and view; credentials must not be stored here.");
  }
  const view = value.view ?? "inbox";
  if (!["inbox", "memory", "tasks", "projects"].includes(view)) throw new Error("Invalid initial workspace view.");
  return { apiBase: resolveApiBase(value.apiBase, pageUrl), view };
}
