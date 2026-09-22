import { BRIDGE_CONNECT_SOURCE, MAIN_WORLD_READY_ATTRIBUTE } from "../shared/bridge";
import { detectProviderFromUrl } from "../shared/provider";
import type {
  BridgeToExtensionMessage,
  HistorySyncTriggerPayload,
  MainWorldControlPayload,
  PingProviderTabResponse,
  RuntimeMessage
} from "../shared/types";
import { extractPageChatContext } from "./chat-context-dump";
import { createContextSuggestionController } from "./context-suggestions";
import { createQuickSearchPalette } from "./quick-search";
import { createSelectionCaptureController } from "./selection-capture";

const BRIDGE_CONNECT_TIMEOUT_MS = 5_000;
const BRIDGE_CONNECT_ATTEMPT_TIMEOUT_MS = 400;
const BRIDGE_CONNECT_RETRY_INTERVAL_MS = 50;
const RUNTIME_MESSAGE_RETRY_ATTEMPTS = 4;
const RUNTIME_MESSAGE_RETRY_INTERVAL_MS = 150;

let bridgePort: MessagePort | null = null;
let bridgeReadyPromise: Promise<void> | null = null;
let runtimeDispatchQueue = Promise.resolve();
const quickSearchPalette = createQuickSearchPalette(async <TResponse>(message: RuntimeMessage) => {
  return chrome.runtime.sendMessage(message) as Promise<TResponse>;
});
const selectionCaptureController = createSelectionCaptureController(async <TResponse>(message: RuntimeMessage) => {
  return chrome.runtime.sendMessage(message) as Promise<TResponse>;
});
const contextSuggestionController = createContextSuggestionController(async <TResponse>(message: RuntimeMessage) => {
  return chrome.runtime.sendMessage(message) as Promise<TResponse>;
});

function enqueueRuntimeMessage(message: RuntimeMessage): void {
  const dispatch = async (): Promise<void> => {
    for (let attempt = 0; attempt < RUNTIME_MESSAGE_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const response = await chrome.runtime.sendMessage(message);
        if (response?.ok === false) throw new Error("Capture not acknowledged");
        return;
      } catch {
        if (attempt >= RUNTIME_MESSAGE_RETRY_ATTEMPTS - 1) {
          console.warn("SaveMyContext could not persist a capture. Check extension status before leaving this page.");
          return;
        }
        await sleep(RUNTIME_MESSAGE_RETRY_INTERVAL_MS);
      }
    }
  };

  runtimeDispatchQueue = runtimeDispatchQueue.then(dispatch, dispatch);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function isMainWorldReady(): boolean {
  return bridgePort !== null || document.documentElement?.getAttribute(MAIN_WORLD_READY_ATTRIBUTE) === "1";
}

function handleBridgeMessage(message: BridgeToExtensionMessage): void {
  if (message.type === "NETWORK_CAPTURE") {
    enqueueRuntimeMessage({
      type: "NETWORK_CAPTURE",
      payload: message.payload
    });
    return;
  }

  if (message.type === "HISTORY_SYNC_STATUS") {
    enqueueRuntimeMessage({
      type: "HISTORY_SYNC_STATUS",
      payload: message.payload
    });
    return;
  }
}

function attachBridgePort(port: MessagePort): void {
  bridgePort = port;
  bridgePort.onmessage = (event: MessageEvent<BridgeToExtensionMessage>) => {
    if (!event.data) {
      return;
    }
    handleBridgeMessage(event.data);
  };
  bridgePort.start();
}

async function connectMainWorldBridgeOnce(): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => {
      channel.port1.close();
      reject(new Error("Timed out connecting to the main-world bridge."));
    }, BRIDGE_CONNECT_ATTEMPT_TIMEOUT_MS);

    channel.port1.onmessage = (event: MessageEvent<BridgeToExtensionMessage>) => {
      if (event.data?.type !== "BRIDGE_READY") {
        return;
      }
      window.clearTimeout(timeout);
      attachBridgePort(channel.port1);
      resolve();
    };
    channel.port1.start();

    window.postMessage(
      {
        source: BRIDGE_CONNECT_SOURCE
      },
      window.location.origin,
      [channel.port2]
    );
  });
}

async function ensureBridgeReady(): Promise<void> {
  if (bridgePort) {
    return;
  }
  if (bridgeReadyPromise) {
    return await bridgeReadyPromise;
  }

  bridgeReadyPromise = (async () => {
    const deadline = Date.now() + BRIDGE_CONNECT_TIMEOUT_MS;
    let lastError: Error | null = null;

    while (!bridgePort && Date.now() < deadline) {
      try {
        await connectMainWorldBridgeOnce();
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (Date.now() >= deadline) {
          break;
        }
        await sleep(BRIDGE_CONNECT_RETRY_INTERVAL_MS);
      }
    }

    throw lastError ?? new Error("Could not connect to the main-world bridge.");
  })().finally(() => {
    bridgeReadyPromise = null;
  });

  return await bridgeReadyPromise;
}

async function postControlMessage(payload: MainWorldControlPayload): Promise<void> {
  await ensureBridgeReady();
  bridgePort?.postMessage({
    type: "CONTROL",
    payload
  });
}

function notifyPageVisit(): void {
  const provider = detectProviderFromUrl(window.location.href);
  if (!provider) {
    return;
  }

  const message: RuntimeMessage = {
    type: "PAGE_VISIT",
    payload: {
      provider,
      pageUrl: window.location.href
    }
  };
  enqueueRuntimeMessage(message);
}

function installNavigationObserver(): void {
  let lastUrl = window.location.href;
  const notifyIfChanged = (): void => {
    if (window.location.href === lastUrl) {
      return;
    }
    lastUrl = window.location.href;
    notifyPageVisit();
    selectionCaptureController.handleLocationChange();
    contextSuggestionController.handleLocationChange();
  };

  const nativePushState = history.pushState;
  history.pushState = function patchedPushState(...args) {
    nativePushState.apply(this, args);
    notifyIfChanged();
  };

  const nativeReplaceState = history.replaceState;
  history.replaceState = function patchedReplaceState(...args) {
    nativeReplaceState.apply(this, args);
    notifyIfChanged();
  };

  window.addEventListener("popstate", notifyIfChanged);
  window.addEventListener("hashchange", notifyIfChanged);
}

function installPageVisitObserver(): void {
  const notify = (): void => {
    notifyPageVisit();
  };

  document.addEventListener("DOMContentLoaded", notify, { once: true });
  window.addEventListener("pageshow", notify);
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type === "TOGGLE_QUICK_SEARCH") {
    quickSearchPalette.toggle();
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "SAVE_CURRENT_PAGE_SOURCE") {
    void selectionCaptureController.handleRuntimeMessage(message).then((response) => {
      sendResponse(response ?? { ok: false, error: "Unsupported page capture message." });
    });
    return true;
  }
  if (message.type === "GET_PAGE_CHAT_CONTEXT") {
    sendResponse(extractPageChatContext());
    return false;
  }
  if (message.type === "TRIGGER_HISTORY_SYNC") {
    const payload: HistorySyncTriggerPayload = message.payload;
    void postControlMessage({
      type: "START_HISTORY_SYNC",
      historyFingerprints: payload.historyFingerprints,
      syncedSessionIds: payload.syncedSessionIds,
      previousTopSessionId: payload.previousTopSessionId,
      previousTopSessionIds: payload.previousTopSessionIds,
      refreshSessionIds: payload.refreshSessionIds
    })
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    return true;
  }
  if (message.type === "PING_PROVIDER_TAB") {
    sendResponse({
      ok: true,
      provider: detectProviderFromUrl(window.location.href) ?? undefined,
      pageUrl: window.location.href,
      mainWorldReady: isMainWorldReady()
    } satisfies PingProviderTabResponse);
    return false;
  }
  return false;
});

window.addEventListener("beforeunload", () => {
  bridgePort?.close();
  bridgePort = null;
});

void ensureBridgeReady().catch(() => undefined);
installNavigationObserver();
installPageVisitObserver();
notifyPageVisit();
