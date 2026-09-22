import { resolveApiBase } from "./workspace.js";

/** Mount one isolated view. The host owns authentication and API routing. */
export function mountWorkspace(container, { apiBase = "/api/v1/workspace", token = "", view = "inbox", query = "" } = {}) {
  if (!(container instanceof HTMLElement)) throw new TypeError("A workspace container element is required.");
  if (!["inbox", "memory", "tasks", "projects"].includes(view)) throw new Error("Invalid initial workspace view.");
  const workspace = document.createElement("smc-workspace");
  workspace.setAttribute("api-base", resolveApiBase(apiBase));
  workspace.setAttribute("view", view);
  workspace.setAttribute("query", query);
  // Set credentials before connecting, avoiding an initial unauthenticated request.
  workspace.token = token;
  container.append(workspace);
  return workspace;
}
