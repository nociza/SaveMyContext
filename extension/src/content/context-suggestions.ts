import type {
  ActiveChatContextResponse,
  BackendSearchResult,
  ExtensionSettings,
  KnowledgeSearchResponse,
  ProviderName,
  RuntimeMessage
} from "../shared/types";
import { detectProviderFromUrl } from "../shared/provider";
import { providerDomAdapters } from "../shared/provider-dom";
import { pageSurfaceScopeAllowsUrl } from "../shared/page-surfaces";
import type { EditableTarget } from "./editable-target";
import { insertIntoTarget, isEditableElement, readEditableText } from "./editable-target";
import { buildContextSuggestionQueries, rankContextualSuggestions } from "./context-suggestions-model";
import { buildInsertionText, resultKindLabel } from "./quick-search-model";

type RuntimeRequester = <TResponse>(message: RuntimeMessage) => Promise<TResponse>;

type ContextSuggestionController = {
  handleLocationChange(): void;
};

type ContextSuggestionFramePositionInput = {
  targetRect: Pick<DOMRectReadOnly, "top" | "right" | "bottom">;
  viewportWidth: number;
  viewportHeight: number;
};

export type ContextSuggestionFramePosition = {
  left: number;
  top: number;
  placement: "above" | "below";
  panelMaxBlockSize: number;
};

const SETTINGS_CACHE_KEY = "savemycontext.settings.cache";
const SETTINGS_SYNC_KEY = "savemycontext.settings";
const HOST_ID = "savemycontext-context-suggestions-root";
const REFRESH_DEBOUNCE_MS = 280;
const REFRESH_INTERVAL_MS = 5_000;
const MAX_RESULT_COUNT = 3;
const PANEL_MAX_WIDTH_PX = 360;
const PANEL_MAX_HEIGHT_PX = 440;
const PANEL_GAP_PX = 10;
const VIEWPORT_MARGIN_PX = 12;
const LAUNCHER_HEIGHT_PX = 32;
const LAUNCHER_BLOCK_SIZE_PX = 44;
const STYLE = `
:host {
  all: initial;
}

*, *::before, *::after {
  box-sizing: border-box;
}

.frame {
  --panel-width: min(360px, calc(100vw - 24px));
  --panel-max-block-size: min(440px, calc(100vh - 24px));
  position: fixed;
  z-index: 2147483646;
  display: grid;
  inline-size: var(--panel-width);
  justify-items: end;
  pointer-events: none;
  font-family: "Avenir Next", "Segoe UI", sans-serif;
  color: #11263a;
}

.launcher,
.panel button {
  pointer-events: auto;
}

.launcher {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid rgba(17, 38, 58, 0.12);
  border-radius: 999px;
  background: rgba(255, 252, 246, 0.98);
  box-shadow: 0 8px 28px rgba(17, 38, 58, 0.16);
  color: #11263a;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}

.launcher:hover {
  border-color: rgba(17, 38, 58, 0.22);
}

.count {
  display: inline-flex;
  min-width: 18px;
  height: 18px;
  align-items: center;
  justify-content: center;
  padding: 0 5px;
  border-radius: 999px;
  background: #11263a;
  color: white;
  font-size: 11px;
  line-height: 1;
}

.panel {
  position: absolute;
  inline-size: var(--panel-width);
  display: grid;
  gap: 12px;
  padding: 14px;
  border: 1px solid rgba(17, 38, 58, 0.12);
  border-radius: 8px;
  background: rgba(255, 252, 246, 0.98);
  box-shadow: 0 20px 48px rgba(17, 38, 58, 0.18);
  max-block-size: var(--panel-max-block-size);
  overflow: auto;
  pointer-events: auto;
}

.frame[data-placement="above"] .panel {
  right: 0;
  bottom: calc(100% + ${PANEL_GAP_PX}px);
}

.frame[data-placement="below"] .panel {
  right: 0;
  top: calc(100% + ${PANEL_GAP_PX}px);
}

.panel[hidden] {
  display: none;
}

.header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
}

.eyebrow {
  margin: 0;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: rgba(17, 38, 58, 0.56);
}

.title {
  margin: 4px 0 0;
  font-size: 16px;
  line-height: 1.2;
}

.summary,
.status,
.snippet,
.source {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: rgba(17, 38, 58, 0.72);
}

.dismiss {
  border: 0;
  background: transparent;
  color: rgba(17, 38, 58, 0.62);
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  padding: 2px 0;
}

.results {
  display: grid;
  gap: 10px;
}

.result {
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid rgba(17, 38, 58, 0.08);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.72);
}

.result-head,
.result-actions {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 10px;
}

.result-title {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  line-height: 1.35;
}

.badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.badge {
  display: inline-flex;
  align-items: center;
  padding: 3px 6px;
  border-radius: 999px;
  background: rgba(17, 38, 58, 0.08);
  font-size: 10px;
  font-weight: 700;
  color: rgba(17, 38, 58, 0.84);
}

.insert {
  border: 0;
  border-radius: 8px;
  background: #11263a;
  color: white;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  padding: 8px 10px;
}

.insert:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
`;

function isVisible(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
}

function findFirstVisible(selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (isVisible(element)) {
        return element as HTMLElement;
      }
    }
  }
  return null;
}

function isInsideHost(target: EventTarget | null, host: HTMLDivElement | null, shadow: ShadowRoot | null): boolean {
  return target instanceof Node && Boolean((host && host.contains(target)) || (shadow && shadow.contains(target)));
}

function matchesProviderInput(target: EditableTarget | null, provider: ProviderName): boolean {
  if (!target) {
    return false;
  }
  return providerDomAdapters[provider].inputSelectors.some((selector) => {
    try {
      return target.matches(selector);
    } catch {
      return false;
    }
  });
}

function contextProvider(): ProviderName | null {
  return detectProviderFromUrl(window.location.href);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function computeVerticalFramePosition(
  placement: ContextSuggestionFramePosition["placement"],
  targetRect: ContextSuggestionFramePositionInput["targetRect"],
  viewportHeight: number
): Pick<ContextSuggestionFramePosition, "placement" | "top" | "panelMaxBlockSize"> {
  const preferredTop =
    placement === "above" ? targetRect.top - LAUNCHER_BLOCK_SIZE_PX : targetRect.bottom + VIEWPORT_MARGIN_PX;
  const maxTop = Math.max(VIEWPORT_MARGIN_PX, viewportHeight - LAUNCHER_HEIGHT_PX - VIEWPORT_MARGIN_PX);
  const top = clamp(preferredTop, VIEWPORT_MARGIN_PX, maxTop);
  const availableBlockSize =
    placement === "above"
      ? top - PANEL_GAP_PX - VIEWPORT_MARGIN_PX
      : viewportHeight - top - LAUNCHER_HEIGHT_PX - PANEL_GAP_PX - VIEWPORT_MARGIN_PX;

  return {
    placement,
    top,
    panelMaxBlockSize: Math.max(0, Math.min(PANEL_MAX_HEIGHT_PX, availableBlockSize))
  };
}

export function computeContextSuggestionFramePosition({
  targetRect,
  viewportWidth,
  viewportHeight
}: ContextSuggestionFramePositionInput): ContextSuggestionFramePosition {
  const preferredPlacement = targetRect.top > 210 || viewportHeight - targetRect.bottom < 220 ? "above" : "below";
  const fallbackPlacement = preferredPlacement === "above" ? "below" : "above";
  const preferredVerticalPosition = computeVerticalFramePosition(preferredPlacement, targetRect, viewportHeight);
  const fallbackVerticalPosition = computeVerticalFramePosition(fallbackPlacement, targetRect, viewportHeight);
  const verticalPosition =
    preferredVerticalPosition.panelMaxBlockSize < 160 &&
    fallbackVerticalPosition.panelMaxBlockSize > preferredVerticalPosition.panelMaxBlockSize
      ? fallbackVerticalPosition
      : preferredVerticalPosition;
  const panelWidth = Math.min(PANEL_MAX_WIDTH_PX, Math.max(0, viewportWidth - VIEWPORT_MARGIN_PX * 2));
  const maxLeft = Math.max(VIEWPORT_MARGIN_PX, viewportWidth - panelWidth - VIEWPORT_MARGIN_PX);
  const left = clamp(targetRect.right - panelWidth, VIEWPORT_MARGIN_PX, maxLeft);

  return {
    left,
    ...verticalPosition
  };
}

export function createContextSuggestionController(sendMessage: RuntimeRequester): ContextSuggestionController {
  let enabled = false;
  let floatingButtonEnabled = true;
  let host: HTMLDivElement | null = null;
  let shadow: ShadowRoot | null = null;
  let frame: HTMLDivElement | null = null;
  let launcher: HTMLButtonElement | null = null;
  let countBadge: HTMLSpanElement | null = null;
  let panel: HTMLDivElement | null = null;
  let resultsRoot: HTMLDivElement | null = null;
  let statusLine: HTMLParagraphElement | null = null;
  let lastFocusedEditable: EditableTarget | null = null;
  let suggestions: BackendSearchResult[] = [];
  let refreshTimer: number | null = null;
  let refreshInterval: number | null = null;
  let requestSequence = 0;
  let panelOpen = false;
  let loading = false;
  let lastContextSignature = "";

  async function refreshSettings(): Promise<void> {
    try {
      const settings = await sendMessage<
        Pick<ExtensionSettings, "contextSuggestionsEnabled" | "contextSuggestionsFloatingButtonEnabled" | "pageSurfaceScope">
      >({ type: "GET_SETTINGS" });
      enabled =
        Boolean(settings.contextSuggestionsEnabled) &&
        pageSurfaceScopeAllowsUrl(settings.pageSurfaceScope, window.location.href);
      floatingButtonEnabled = settings.contextSuggestionsFloatingButtonEnabled !== false;
    } catch {
      enabled = false;
      floatingButtonEnabled = false;
    }

    if (!enabled || !floatingButtonEnabled || !contextProvider()) {
      hide();
      return;
    }

    scheduleRefresh(true);
  }

  function ensureDom(): void {
    if (host && shadow && frame && launcher && panel && resultsRoot && statusLine && countBadge) {
      return;
    }

    host = document.createElement("div");
    host.id = HOST_ID;
    host.hidden = true;
    shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = STYLE;

    frame = document.createElement("div");
    frame.className = "frame";
    frame.dataset.placement = "above";

    launcher = document.createElement("button");
    launcher.className = "launcher";
    launcher.type = "button";
    launcher.addEventListener("click", () => {
      if (!suggestions.length) {
        return;
      }
      panelOpen = !panelOpen;
      render();
    });

    const launcherLabel = document.createElement("span");
    launcherLabel.textContent = "Relevant notes";
    countBadge = document.createElement("span");
    countBadge.className = "count";
    launcher.append(launcherLabel, countBadge);

    panel = document.createElement("div");
    panel.className = "panel";

    const header = document.createElement("div");
    header.className = "header";

    const heading = document.createElement("div");
    const eyebrow = document.createElement("p");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "SaveMyContext";
    const title = document.createElement("h2");
    title.className = "title";
    title.textContent = "Relevant notes";
    const summary = document.createElement("p");
    summary.className = "summary";
    summary.textContent = "Insert saved facts or ideas into this chat.";
    heading.append(eyebrow, title, summary);

    const dismiss = document.createElement("button");
    dismiss.className = "dismiss";
    dismiss.type = "button";
    dismiss.textContent = "Close";
    const dismissPanel = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    };
    dismiss.addEventListener("pointerdown", dismissPanel);
    dismiss.addEventListener("click", dismissPanel);

    panel.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      closePanel();
    });

    header.append(heading, dismiss);

    statusLine = document.createElement("p");
    statusLine.className = "status";

    resultsRoot = document.createElement("div");
    resultsRoot.className = "results";

    panel.append(header, statusLine, resultsRoot);
    frame.append(launcher, panel);
    shadow.append(style, frame);
    document.documentElement.append(host);
  }

  function activeProviderTarget(provider: ProviderName): EditableTarget | null {
    const activeElement =
      isEditableElement(document.activeElement) && matchesProviderInput(document.activeElement, provider)
        ? document.activeElement
        : null;
    if (activeElement) {
      return activeElement;
    }

    if (lastFocusedEditable && lastFocusedEditable.isConnected && matchesProviderInput(lastFocusedEditable, provider)) {
      return lastFocusedEditable;
    }

    const visibleTarget = findFirstVisible(providerDomAdapters[provider].inputSelectors);
    return isEditableElement(visibleTarget) ? visibleTarget : null;
  }

  function hide(): void {
    suggestions = [];
    panelOpen = false;
    loading = false;
    lastContextSignature = "";
    if (host) {
      host.hidden = true;
    }
  }

  function closePanel(): void {
    panelOpen = false;
    if (panel) {
      panel.hidden = true;
    }
    render();
  }

  function positionFrame(target: EditableTarget | null): void {
    if (!frame || !target) {
      return;
    }
    const rect = target.getBoundingClientRect();
    const position = computeContextSuggestionFramePosition({
      targetRect: rect,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    });
    frame.style.left = `${position.left}px`;
    frame.style.top = `${position.top}px`;
    frame.style.setProperty("--panel-max-block-size", `${position.panelMaxBlockSize}px`);
    frame.dataset.placement = position.placement;
  }

  function renderResults(provider: ProviderName): void {
    if (!resultsRoot) {
      return;
    }
    const root = resultsRoot;
    root.replaceChildren();

    suggestions.forEach((result) => {
      const article = document.createElement("article");
      article.className = "result";

      const head = document.createElement("div");
      head.className = "result-head";

      const title = document.createElement("p");
      title.className = "result-title";
      title.textContent = result.title;

      const badges = document.createElement("div");
      badges.className = "badges";
      for (const label of [resultKindLabel(result), result.provider, result.pile_slug].filter(Boolean)) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = String(label);
        badges.append(badge);
      }

      const snippet = document.createElement("p");
      snippet.className = "snippet";
      snippet.textContent = result.snippet;

      const actions = document.createElement("div");
      actions.className = "result-actions";

      const source = document.createElement("p");
      source.className = "source";
      source.textContent = result.markdown_path ? "Saved note" : "Saved context";

      const insert = document.createElement("button");
      insert.className = "insert";
      insert.type = "button";
      insert.textContent = "Insert";
      insert.disabled = !activeProviderTarget(provider);
      insert.addEventListener("click", () => {
        const target = activeProviderTarget(provider);
        if (!target) {
          if (statusLine) {
            statusLine.textContent = "Focus the chat composer to insert a note.";
          }
          return;
        }
        const inserted = insertIntoTarget(target, buildInsertionText(result));
        if (!inserted) {
          if (statusLine) {
            statusLine.textContent = "Could not insert into the current chat field.";
          }
          return;
        }
        panelOpen = false;
        render();
        window.setTimeout(() => {
          void refreshSuggestions(true);
        }, 600);
      });

      head.append(title, badges);
      actions.append(source, insert);
      article.append(head, snippet, actions);
      root.append(article);
    });
  }

  function render(): void {
    ensureDom();
    if (!host || !frame || !launcher || !countBadge || !panel || !statusLine) {
      return;
    }

    const provider = contextProvider();
    const target = provider ? activeProviderTarget(provider) : null;
    const visible = Boolean(enabled && floatingButtonEnabled && provider && target && suggestions.length);
    host.hidden = !visible;
    if (!visible || !provider || !target) {
      panelOpen = false;
      return;
    }

    positionFrame(target);
    countBadge.textContent = String(suggestions.length);
    panel.hidden = !panelOpen;
    statusLine.textContent = loading
      ? "Checking your saved notes…"
      : "Pick a note to place it in the composer.";
    renderResults(provider);
  }

  async function refreshSuggestions(force = false): Promise<void> {
    const provider = contextProvider();
    if (!enabled || !floatingButtonEnabled || !provider) {
      hide();
      return;
    }

    const target = activeProviderTarget(provider);
    if (!target) {
      hide();
      return;
    }

    const draftText = readEditableText(target).slice(0, 1_200);
    const contextResponse = await sendMessage<ActiveChatContextResponse>({
      type: "GET_ACTIVE_CHAT_CONTEXT",
      payload: {
        pageUrl: window.location.href
      }
    });

    const context = {
      provider,
      title: contextResponse.snapshot?.title ?? document.title,
      draftText,
      messages: contextResponse.snapshot?.messages ?? []
    };
    const queries = buildContextSuggestionQueries(context);
    if (!queries.length) {
      hide();
      return;
    }

    const contextSignature = JSON.stringify({
      provider,
      pageUrl: window.location.href,
      draftText,
      queries,
      capturedAt: contextResponse.snapshot?.capturedAt ?? "",
      externalSessionId: contextResponse.snapshot?.externalSessionId ?? ""
    });
    if (!force && contextSignature === lastContextSignature) {
      render();
      return;
    }

    lastContextSignature = contextSignature;
    requestSequence += 1;
    const requestId = requestSequence;
    loading = true;
    render();

    try {
      const response = await sendMessage<KnowledgeSearchResponse>({
        type: "SEARCH_KNOWLEDGE",
        payload: {
          queries,
          limit: 18,
          kinds: ["entity", "session", "source_capture", "todo_list"]
        }
      });
      if (requestId !== requestSequence) {
        return;
      }

      loading = false;
      if (!response.ok) {
        hide();
        return;
      }

      suggestions = rankContextualSuggestions(context, response.results, MAX_RESULT_COUNT);
      if (!suggestions.length) {
        hide();
        return;
      }
      render();
    } catch {
      if (requestId !== requestSequence) {
        return;
      }
      loading = false;
      hide();
    }
  }

  function scheduleRefresh(force = false): void {
    if (refreshTimer !== null) {
      window.clearTimeout(refreshTimer);
    }
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      void refreshSuggestions(force);
    }, force ? 40 : REFRESH_DEBOUNCE_MS);
  }

  document.addEventListener(
    "focusin",
    (event) => {
      if (isInsideHost(event.target, host, shadow) || !isEditableElement(event.target)) {
        return;
      }
      lastFocusedEditable = event.target;
      scheduleRefresh();
    },
    true
  );

  document.addEventListener(
    "input",
    (event) => {
      if (isInsideHost(event.target, host, shadow) || !isEditableElement(event.target)) {
        return;
      }
      lastFocusedEditable = event.target;
      scheduleRefresh();
    },
    true
  );

  document.addEventListener(
    "mousedown",
    (event) => {
      if (!panelOpen || isInsideHost(event.target, host, shadow)) {
        return;
      }
      panelOpen = false;
      render();
    },
    true
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (!panelOpen || event.key !== "Escape") {
        return;
      }
      panelOpen = false;
      render();
    },
    true
  );

  window.addEventListener("scroll", () => {
    render();
  });
  window.addEventListener("resize", () => {
    render();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" && areaName !== "sync") {
      return;
    }
    if (changes[SETTINGS_CACHE_KEY] || changes[SETTINGS_SYNC_KEY]) {
      void refreshSettings();
    }
  });

  refreshInterval = window.setInterval(() => {
    if (!panelOpen && !host?.hidden) {
      void refreshSuggestions();
      return;
    }
    if (enabled && floatingButtonEnabled && contextProvider()) {
      void refreshSuggestions();
    }
  }, REFRESH_INTERVAL_MS);

  void refreshSettings();

  return {
    handleLocationChange(): void {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      if (refreshInterval === null) {
        refreshInterval = window.setInterval(() => {
          void refreshSuggestions();
        }, REFRESH_INTERVAL_MS);
      }
      hide();
      scheduleRefresh(true);
    }
  };
}
