// Shared standard web component; the extension owns no separate workspace state.
import { getSettings } from "../shared/storage";
import "./page.css";

const settings = await getSettings();
const params = new URLSearchParams(location.search);
const view = params.get("view") || "inbox";
const { mountWorkspace } = await import("@savemycontext/ui/embed");
mountWorkspace(document.getElementById("workspace")!, {
  apiBase: `${settings.backendUrl.replace(/\/$/, "")}/api/v1/workspace`,
  token: settings.backendToken || "",
  view: ["inbox", "tasks", "memory", "projects"].includes(view)
    ? view as "inbox" | "tasks" | "memory" | "projects" : "inbox",
  query: params.get("q") || "",
});
