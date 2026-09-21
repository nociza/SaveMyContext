import type { CapturedNetworkEvent, ProviderProject } from "../shared/types";

export const projectId = (value: unknown): value is string =>
  typeof value === "string" && /^g-p-[a-zA-Z0-9]{1,100}$/.test(value);

/** Root fields only: a quoted ID in a user's message is not membership evidence. */
export function chatGPTProject(event: CapturedNetworkEvent, candidates: unknown[]): ProviderProject | null | undefined {
  if (!event.response.ok) return undefined;
  for (const value of candidates) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const root = value as Record<string, unknown>;
    if (projectId(root.gizmo_id)) {
      return event.project?.id === root.gizmo_id ? event.project : { id: root.gizmo_id };
    }
    if (event.method === "GET" && Object.hasOwn(root, "gizmo_id") && root.gizmo_id === null) return null;
  }
  if (event.project !== undefined) return event.project;
  // Only apply a page route to a matching detail response, never a background chat.
  let page: URL;
  try { page = new URL(event.pageUrl); } catch { return undefined; }
  const route = page.pathname.match(/^\/g\/(g-p-[a-zA-Z0-9]+)(?:-[^/]+)?\/c\/([^/]+)\/?$/);
  const api = new URL(event.url, event.pageUrl).pathname.match(/^\/backend-api\/conversation\/([^/]+)$/);
  return route && api && route[2] === api[1] ? { id: route[1] } : undefined;
}
