import { getSettings } from "./storage";
import { workspaceUrl } from "./workspace-link";

// Bookmarked legacy screens remain small redirects, not duplicate applications.
const params = new URLSearchParams(location.search);
location.replace(workspaceUrl(await getSettings(), params.get("pile") === "todo" ? "tasks" : "memory"));
