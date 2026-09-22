import { SMCWorkspace } from "./workspace.js";
export interface WorkspaceOptions {
  apiBase?: string;
  token?: string;
  view?: "inbox" | "memory" | "tasks" | "projects";
  query?: string;
}
/** Remove the returned element to unmount and stop polling. Tokens stay in memory. */
export function mountWorkspace(container: HTMLElement, options?: WorkspaceOptions): SMCWorkspace;
