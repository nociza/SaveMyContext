import type { BackendSearchResult } from "../shared/types";

function resultPriority(result: BackendSearchResult): number {
  if (result.kind === "entity") {
    return 0;
  }
  if (result.category === "factual") {
    return 1;
  }
  if (result.kind === "todo_list" || result.category === "todo") {
    return 2;
  }
  if (result.category === "ideas") {
    return 3;
  }
  if (result.category === "journal") {
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
  if (result.category === "factual") {
    return "Fact";
  }
  if (result.category === "ideas") {
    return "Idea";
  }
  if (result.category === "journal") {
    return "Journal";
  }
  if (result.category === "todo") {
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
  if (result.category === "factual") {
    return "Saved factual note";
  }
  if (result.category === "ideas") {
    return "Saved idea note";
  }
  if (result.category === "journal") {
    return "Saved journal note";
  }
  if (result.category === "todo") {
    return "Saved checklist update";
  }
  return "Saved session note";
}
