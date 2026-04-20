import type { BackendSearchResult } from "../shared/types";

function resultPriority(result: BackendSearchResult): number {
  if (result.kind === "entity") {
    return 0;
  }
  if (result.pile_slug === "factual") {
    return 1;
  }
  if (result.kind === "todo_list" || result.pile_slug === "todo") {
    return 2;
  }
  if (result.pile_slug === "ideas") {
    return 3;
  }
  if (result.pile_slug === "journal") {
    return 4;
  }
  return 5;
}

export function prioritizeKnowledgeResults(results: BackendSearchResult[]): BackendSearchResult[] {
  return [...results].sort((left, right) => {
    const priorityDelta = resultPriority(left) - resultPriority(right);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    return left.title.localeCompare(right.title);
  });
}

export function buildInsertionText(result: BackendSearchResult): string {
  const title = result.title.trim();
  const snippet = result.snippet.trim();
  if (!snippet) {
    return title;
  }

  if (result.kind === "entity") {
    return snippet;
  }

  if (result.kind === "todo_list") {
    return `${title}\n${snippet}`;
  }

  const normalizedTitle = title.toLowerCase();
  const normalizedSnippet = snippet.toLowerCase();
  if (normalizedSnippet.startsWith(normalizedTitle)) {
    return snippet;
  }
  return `${title}: ${snippet}`;
}

export function resultKindLabel(result: BackendSearchResult): string {
  if (result.kind === "entity") {
    return "Entity";
  }
  if (result.kind === "source_capture") {
    return "Source";
  }
  if (result.kind === "todo_list") {
    return "To-Do";
  }
  if (result.pile_slug === "factual") {
    return "Fact";
  }
  if (result.pile_slug === "ideas") {
    return "Idea";
  }
  if (result.pile_slug === "journal") {
    return "Journal";
  }
  if (result.pile_slug === "todo") {
    return "To-Do";
  }
  return "Session";
}

export function resultSourceLabel(result: BackendSearchResult): string {
  if (result.kind === "entity") {
    return "Knowledge graph entity";
  }
  if (result.kind === "source_capture") {
    return "Saved source capture";
  }
  if (result.kind === "todo_list") {
    return "Shared checklist";
  }
  if (result.pile_slug === "factual") {
    return "Saved factual note";
  }
  if (result.pile_slug === "ideas") {
    return "Saved idea note";
  }
  if (result.pile_slug === "journal") {
    return "Saved journal note";
  }
  if (result.pile_slug === "todo") {
    return "Saved checklist update";
  }
  return "Saved session note";
}
