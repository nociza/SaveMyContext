import { parseConfig } from "./config.js";
import { mountWorkspace } from "./embed.js";

const status = document.getElementById("workspace-status");
try {
  const response = await fetch(new URL("./config.json", import.meta.url), { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error("Could not load workspace configuration. Check assets/config.json on your frontend host.");
  const config = parseConfig(await response.json(), location.href);
  mountWorkspace(document.getElementById("workspace"), config);
  status.remove();
} catch (error) {
  status.textContent = error.message || "Could not start the workspace.";
  status.setAttribute("role", "alert");
}
