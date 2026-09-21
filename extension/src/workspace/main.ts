// Shared standard web component; the extension owns no separate workspace state.
import { getSettings } from "../shared/storage";
import "./page.css";

const settings = await getSettings();
const workspace = document.querySelector("smc-workspace") as HTMLElement & {
  token: string;
  load: () => Promise<void>;
};
workspace.setAttribute(
  "api-base",
  `${settings.backendUrl.replace(/\/$/, "")}/api/v1/workspace`,
);
const params = new URLSearchParams(location.search);
const view = params.get("view") || "inbox";
if (["inbox", "tasks", "memory", "projects"].includes(view))
  workspace.setAttribute("view", view);
if (params.get("q")) workspace.setAttribute("query", params.get("q")!);
await import("../../../backend/app/workspace/web/workspace.js");
workspace.token = settings.backendToken || "";
