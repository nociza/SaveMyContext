import type { CapturedNetworkEvent, RuntimeMessage } from "../shared/types";

const INJECTED_SCRIPT_ID = "tsmc-network-observer-script";

function injectScript(): void {
  if (document.getElementById(INJECTED_SCRIPT_ID)) {
    return;
  }

  const script = document.createElement("script");
  script.id = INJECTED_SCRIPT_ID;
  script.type = "module";
  script.src = chrome.runtime.getURL("assets/injected.js");
  script.onload = () => script.remove();
  script.onerror = () => script.remove();
  (document.head ?? document.documentElement).appendChild(script);
}

window.addEventListener("message", (event: MessageEvent<{ source?: string; payload?: CapturedNetworkEvent }>) => {
  if (event.source !== window) {
    return;
  }

  if (event.data?.source !== "tsmc-network-observer" || !event.data.payload) {
    return;
  }

  const message: RuntimeMessage = {
    type: "NETWORK_CAPTURE",
    payload: event.data.payload
  };
  void chrome.runtime.sendMessage(message).catch(() => undefined);
});

injectScript();

