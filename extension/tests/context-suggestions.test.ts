import { describe, expect, it } from "vitest";

import { computeContextSuggestionFramePosition } from "../src/content/context-suggestions";

describe("context suggestion positioning", () => {
  it("keeps the panel inside the left viewport edge", () => {
    const position = computeContextSuggestionFramePosition({
      targetRect: { top: 460, right: 120, bottom: 500 },
      viewportWidth: 960,
      viewportHeight: 720
    });

    expect(position.left).toBe(12);
    expect(position.left + 360).toBeLessThanOrEqual(960 - 12);
  });

  it("keeps the panel inside the right viewport edge", () => {
    const position = computeContextSuggestionFramePosition({
      targetRect: { top: 460, right: 950, bottom: 500 },
      viewportWidth: 960,
      viewportHeight: 720
    });

    expect(position.left).toBe(960 - 360 - 12);
  });

  it("uses the available width on narrow viewports", () => {
    const position = computeContextSuggestionFramePosition({
      targetRect: { top: 80, right: 80, bottom: 120 },
      viewportWidth: 320,
      viewportHeight: 640
    });

    expect(position.left).toBe(12);
    expect(position.left + (320 - 24)).toBe(320 - 12);
  });

  it("caps an above panel so the close control stays inside a short viewport", () => {
    const position = computeContextSuggestionFramePosition({
      targetRect: { top: 170, right: 300, bottom: 210 },
      viewportWidth: 960,
      viewportHeight: 320
    });

    expect(position.placement).toBe("above");
    expect(position.top - 10 - position.panelMaxBlockSize).toBe(12);
  });

  it("falls back below when there is no usable room above", () => {
    const position = computeContextSuggestionFramePosition({
      targetRect: { top: 20, right: 300, bottom: 120 },
      viewportWidth: 960,
      viewportHeight: 240
    });

    expect(position.placement).toBe("below");
    expect(position.panelMaxBlockSize).toBeGreaterThan(0);
  });
});
