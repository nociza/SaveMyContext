import type { BackendSessionListItem, BuiltInPileSlug, PileSlug, ProviderName } from "./types";

export const pileOrder: BuiltInPileSlug[] = ["factual", "ideas", "journal", "todo", "discarded"];

export const pileLabels: Record<BuiltInPileSlug, string> = {
  factual: "Factual",
  ideas: "Ideas",
  journal: "Journal",
  todo: "To-Do",
  discarded: "Discarded"
};

export const pileDescriptions: Record<BuiltInPileSlug, string> = {
  factual: "Verified notes, extracted facts, and the knowledge graph.",
  ideas: "Concepts, proposals, and next-step thinking.",
  journal: "Daily reflections, summaries, and action items.",
  todo: "Task updates and notes that changed the shared list.",
  discarded: "Captured but shelved. Not summarized, not on the dashboard, but recoverable."
};

export const pilePalette: Record<BuiltInPileSlug, { accent: string; soft: string; ink: string }> = {
  factual: { accent: "#0f8a84", soft: "#e2f1ef", ink: "#076b66" },
  ideas: { accent: "#d18425", soft: "#faecd4", ink: "#8a561a" },
  journal: { accent: "#4968ab", soft: "#e3ebf8", ink: "#2f4a85" },
  todo: { accent: "#c15a40", soft: "#f7e4dd", ink: "#8a3b27" },
  discarded: { accent: "#736e63", soft: "#ebe7df", ink: "#4a463e" }
};

export const pileGlyphs: Record<BuiltInPileSlug, string> = {
  factual: "§",
  ideas: "✦",
  journal: "¶",
  todo: "✓",
  discarded: "⊘"
};

export const providerLabels: Record<ProviderName, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  grok: "Grok"
};

export const providerColors: Record<ProviderName, string> = {
  chatgpt: "#0f8a84",
  gemini: "#d18425",
  grok: "#4968ab"
};

export type PileSortMode = "recent" | "title";
export type PileWorkspaceView = "atlas" | "story" | "ops";

export function titleFromSession(session: Pick<BackendSessionListItem, "title" | "provider" | "external_session_id">): string {
  return session.title?.trim() || `${providerLabels[session.provider]} · ${session.external_session_id}`;
}

export function isBuiltInPileSlug(value?: string | null): value is BuiltInPileSlug {
  return Boolean(value) && pileOrder.includes(value as BuiltInPileSlug);
}

export function displayPileLabel(value?: string | null, fallback = "Unknown pile"): string {
  if (isBuiltInPileSlug(value)) {
    return pileLabels[value];
  }
  return value?.trim() || fallback;
}

export function pilePageUrl(state: {
  pile: BuiltInPileSlug;
  q?: string;
  provider?: ProviderName | null;
  sort?: PileSortMode | null;
  view?: PileWorkspaceView | null;
  bucket?: string | null;
  note?: string | null;
  extraPile?: string | null;
}): string {
  const url = new URL(chrome.runtime.getURL("pile.html"));
  url.searchParams.set("pile", state.pile);
  if (state.q?.trim()) {
    url.searchParams.set("q", state.q.trim());
  }
  if (state.provider) {
    url.searchParams.set("provider", state.provider);
  }
  if (state.sort && state.sort !== "recent") {
    url.searchParams.set("sort", state.sort);
  }
  if (state.view && state.view !== "atlas") {
    url.searchParams.set("view", state.view);
  }
  if (state.bucket?.trim()) {
    url.searchParams.set("bucket", state.bucket.trim());
  }
  if (state.note) {
    url.searchParams.set("note", state.note);
  }
  if (state.extraPile?.trim()) {
    url.searchParams.set("extraPile", state.extraPile.trim());
  }
  return url.toString();
}

export function notePageUrl(state: {
  id: string;
  pile?: PileSlug | null;
  q?: string;
  provider?: ProviderName | null;
  sort?: PileSortMode | null;
  extraPile?: string | null;
}): string {
  const url = new URL(chrome.runtime.getURL("note.html"));
  url.searchParams.set("id", state.id);
  if (state.pile) {
    url.searchParams.set("pile", state.pile);
  }
  if (state.q?.trim()) {
    url.searchParams.set("q", state.q.trim());
  }
  if (state.provider) {
    url.searchParams.set("provider", state.provider);
  }
  if (state.sort && state.sort !== "recent") {
    url.searchParams.set("sort", state.sort);
  }
  if (state.extraPile?.trim()) {
    url.searchParams.set("extraPile", state.extraPile.trim());
  }
  return url.toString();
}

export function formatCompactDate(value?: string | null, fallback = "No data"): string {
  if (!value) {
    return fallback;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

export function formatLongDate(value?: string | null, fallback = "No data"): string {
  if (!value) {
    return fallback;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

export function parsePile(value: string | null): BuiltInPileSlug {
  if (value && pileOrder.includes(value as BuiltInPileSlug)) {
    return value as BuiltInPileSlug;
  }
  return "factual";
}

export function parseProvider(value: string | null): ProviderName | null {
  return value === "chatgpt" || value === "gemini" || value === "grok" ? value : null;
}

export function parseSortMode(value: string | null): PileSortMode {
  return value === "title" ? "title" : "recent";
}

export function parsePileWorkspaceView(value: string | null): PileWorkspaceView {
  return value === "story" || value === "ops" ? value : "atlas";
}
