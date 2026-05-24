import { describe, expect, it } from "vitest";

import { normalizePageSurfaceScope, pageSurfaceScopeAllowsUrl } from "../src/shared/page-surfaces";

describe("page surface scope", () => {
  it("defaults to supported AI provider pages", () => {
    expect(normalizePageSurfaceScope(undefined)).toBe("ai_providers");
    expect(pageSurfaceScopeAllowsUrl(undefined, "https://chatgpt.com/c/123")).toBe(true);
    expect(pageSurfaceScopeAllowsUrl(undefined, "https://example.com/article")).toBe(false);
  });

  it("allows all regular pages when explicitly configured", () => {
    expect(normalizePageSurfaceScope("all_pages")).toBe("all_pages");
    expect(pageSurfaceScopeAllowsUrl("all_pages", "https://example.com/article")).toBe(true);
  });
});
