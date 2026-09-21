import { describe, expect, it, vi } from "vitest";

import {
  ALL_REGULAR_PAGE_ORIGINS,
  acquireOptionalHostPermissions,
  backendOriginPermission,
  optionalHostPermissionsForSettings,
  safelyRemovableHostPermissions,
  type HostPermissionsApi
} from "../src/shared/host-permissions";

function permissionsApi(granted: Set<string>, allowRequest: boolean): HostPermissionsApi {
  return {
    contains: vi.fn(async ({ origins }: { origins: string[] }) =>
      origins.every((origin: string) => granted.has(origin))
    ),
    request: vi.fn(async ({ origins }: { origins: string[] }) => {
      if (allowRequest) {
        origins.forEach((origin: string) => granted.add(origin));
      }
      return allowRequest;
    }),
    remove: vi.fn(async ({ origins }: { origins: string[] }) => {
      origins.forEach((origin: string) => granted.delete(origin));
      return true;
    })
  };
}

describe("optional host permissions", () => {
  it("requests all-page access together with a remote backend origin", () => {
    expect(optionalHostPermissionsForSettings("https://notes.example.com:8443", "all_pages")).toEqual([
      ...ALL_REGULAR_PAGE_ORIGINS,
      "https://notes.example.com:8443/*"
    ]);
    expect(backendOriginPermission("http://127.0.0.1:18888")).toBeNull();
  });

  it("fails closed when the user denies any required origin", async () => {
    const granted = new Set<string>();
    const api = permissionsApi(granted, false);

    const result = await acquireOptionalHostPermissions(ALL_REGULAR_PAGE_ORIGINS, api);

    expect(result).toEqual({ granted: false, newlyGrantedOrigins: [] });
    expect(api.request).toHaveBeenCalledWith({ origins: [...ALL_REGULAR_PAGE_ORIGINS] });
  });

  it("reports exactly the origins newly granted by the user", async () => {
    const granted = new Set<string>(["https://*/*"]);
    const api = permissionsApi(granted, true);

    const result = await acquireOptionalHostPermissions(ALL_REGULAR_PAGE_ORIGINS, api);

    expect(result).toEqual({ granted: true, newlyGrantedOrigins: ["http://*/*"] });
  });

  it("removes obsolete specific origins and broad access only when safe", () => {
    expect(
      safelyRemovableHostPermissions(
        "https://old.example.com",
        "ai_providers",
        "https://new.example.com",
        "ai_providers"
      )
    ).toEqual(["https://old.example.com/*"]);
    expect(
      safelyRemovableHostPermissions(
        "http://127.0.0.1:18888",
        "all_pages",
        "http://127.0.0.1:18888",
        "ai_providers"
      )
    ).toEqual([...ALL_REGULAR_PAGE_ORIGINS]);
    expect(
      safelyRemovableHostPermissions(
        "https://notes.example.com",
        "all_pages",
        "https://notes.example.com",
        "ai_providers"
      )
    ).toEqual([]);
  });
});
