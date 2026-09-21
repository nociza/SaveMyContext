import type { PageSurfaceScope } from "./types";

export const ALL_REGULAR_PAGE_ORIGINS = ["https://*/*", "http://*/*"] as const;

export interface HostPermissionsApi {
  contains(permissions: { origins: string[] }): Promise<boolean>;
  request(permissions: { origins: string[] }): Promise<boolean>;
  remove(permissions: { origins: string[] }): Promise<boolean>;
}

export interface HostPermissionAcquisition {
  granted: boolean;
  newlyGrantedOrigins: string[];
}

function resolvedPermissionsApi(api?: HostPermissionsApi): HostPermissionsApi {
  return api ?? chrome.permissions;
}

export function backendOriginPermission(backendUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(backendUrl);
  } catch {
    throw new Error("Backend URL is invalid.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Backend URL must use HTTP or HTTPS.");
  }
  if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
    return null;
  }
  return `${parsed.origin}/*`;
}

export function optionalHostPermissionsForSettings(
  backendUrl: string,
  pageSurfaceScope: PageSurfaceScope | undefined
): string[] {
  const origins: string[] = pageSurfaceScope === "all_pages" ? [...ALL_REGULAR_PAGE_ORIGINS] : [];
  const backendOrigin = backendOriginPermission(backendUrl);
  if (backendOrigin) {
    origins.push(backendOrigin);
  }
  return [...new Set(origins)];
}

export async function hasOptionalHostPermissions(
  origins: readonly string[],
  api?: HostPermissionsApi
): Promise<boolean> {
  if (!origins.length) {
    return true;
  }
  return resolvedPermissionsApi(api).contains({ origins: [...origins] });
}

export async function acquireOptionalHostPermissions(
  origins: readonly string[],
  api?: HostPermissionsApi
): Promise<HostPermissionAcquisition> {
  const permissionsApi = resolvedPermissionsApi(api);
  const uniqueOrigins = [...new Set(origins)];
  const missingOrigins: string[] = [];
  for (const origin of uniqueOrigins) {
    if (!(await permissionsApi.contains({ origins: [origin] }))) {
      missingOrigins.push(origin);
    }
  }
  if (!missingOrigins.length) {
    return { granted: true, newlyGrantedOrigins: [] };
  }

  await permissionsApi.request({ origins: missingOrigins });
  const newlyGrantedOrigins: string[] = [];
  for (const origin of missingOrigins) {
    if (await permissionsApi.contains({ origins: [origin] })) {
      newlyGrantedOrigins.push(origin);
    }
  }
  return {
    granted: newlyGrantedOrigins.length === missingOrigins.length,
    newlyGrantedOrigins
  };
}

export async function removeOptionalHostPermissions(
  origins: readonly string[],
  api?: HostPermissionsApi
): Promise<boolean> {
  const uniqueOrigins = [...new Set(origins)];
  if (!uniqueOrigins.length) {
    return true;
  }
  return resolvedPermissionsApi(api).remove({ origins: uniqueOrigins });
}

export function safelyRemovableHostPermissions(
  previousBackendUrl: string,
  previousPageSurfaceScope: PageSurfaceScope | undefined,
  nextBackendUrl: string,
  nextPageSurfaceScope: PageSurfaceScope | undefined
): string[] {
  const removable: string[] = [];
  const previousBackendOrigin = backendOriginPermission(previousBackendUrl);
  const nextBackendOrigin = backendOriginPermission(nextBackendUrl);

  if (previousBackendOrigin && previousBackendOrigin !== nextBackendOrigin) {
    removable.push(previousBackendOrigin);
  }

  // Removing a broad grant is safe when the new configuration needs no remote
  // backend permission. When it does, Chrome may have represented a previous
  // specific grant only through the broad grant, so retain it rather than
  // accidentally disconnecting the backend.
  if (
    previousPageSurfaceScope === "all_pages" &&
    nextPageSurfaceScope !== "all_pages" &&
    nextBackendOrigin === null
  ) {
    removable.push(...ALL_REGULAR_PAGE_ORIGINS);
  }

  return [...new Set(removable)];
}
