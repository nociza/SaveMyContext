import { describe, expect, it } from "vitest";

import { buildInsertionText, prioritizeKnowledgeResults, resultKindLabel } from "../src/content/quick-search-model";

describe("quick search model", () => {
  it("prioritizes entity and factual results ahead of other result types", () => {
    const ordered = prioritizeKnowledgeResults([
      {
        kind: "session",
        title: "Journal note",
        snippet: "Personal reflection",
        pile_slug: "journal",
        extra_piles: []
      },
      {
        kind: "todo_list",
        title: "To-Do List",
        snippet: "Buy milk",
        extra_piles: []
      },
      {
        kind: "session",
        title: "Rust session",
        snippet: "Rust uses ownership",
        pile_slug: "factual",
        extra_piles: []
      },
      {
        kind: "entity",
        title: "Rust",
        snippet: "Rust | uses | ownership",
        extra_piles: []
      }
    ]);

    expect(ordered.map((item) => item.title)).toEqual(["Rust", "Rust session", "To-Do List", "Journal note"]);
  });

  it("builds concise insertion text for entities and sessions", () => {
    expect(
      buildInsertionText({
        kind: "entity",
        title: "Rust",
        snippet: "Rust | uses | ownership",
        extra_piles: []
      })
    ).toBe("Rust | uses | ownership");

    expect(
      buildInsertionText({
        kind: "session",
        title: "Rust session",
        snippet: "Rust uses ownership to manage memory safely.",
        extra_piles: []
      })
    ).toBe("Rust session: Rust uses ownership to manage memory safely.");
  });

  it("maps result types to readable labels", () => {
    expect(
      resultKindLabel({
        kind: "session",
        title: "Fact note",
        snippet: "Rust uses ownership.",
        pile_slug: "factual",
        extra_piles: []
      })
    ).toBe("Fact");
    expect(
      resultKindLabel({
        kind: "entity",
        title: "Rust",
        snippet: "Rust | uses | ownership",
        extra_piles: []
      })
    ).toBe("Entity");
  });
});
