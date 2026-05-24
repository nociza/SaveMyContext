import { detectProviderFromUrl } from "./provider";
import type { PageSurfaceScope } from "./types";

export const DEFAULT_PAGE_SURFACE_SCOPE: PageSurfaceScope = "ai_providers";

export function normalizePageSurfaceScope(value?: string | null): PageSurfaceScope {
  return value === "all_pages" ? "all_pages" : DEFAULT_PAGE_SURFACE_SCOPE;
}

export function pageSurfaceScopeAllowsUrl(scope: PageSurfaceScope | undefined, url: string): boolean {
  if (normalizePageSurfaceScope(scope) === "all_pages") {
    return true;
  }
  return Boolean(detectProviderFromUrl(url));
}
