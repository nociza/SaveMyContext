import type { ParsedConnectionBundle } from "./types";

export const CONNECTION_STRING_PREFIX = "smc_conn_1_";

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return atob(`${normalized}${padding}`);
}

export function parseConnectionString(value: string): ParsedConnectionBundle {
  const candidate = value.trim();
  if (!candidate.startsWith(CONNECTION_STRING_PREFIX)) {
    throw new Error("Connection string has an unexpected prefix.");
  }

  const encoded = candidate.slice(CONNECTION_STRING_PREFIX.length);
  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Url(encoded));
  } catch (error) {
    throw new Error("Connection string could not be decoded.");
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("Connection string payload is invalid.");
  }

  const record = payload as Record<string, unknown>;
  const version = record.v;
  const baseUrl = record.u;
  const grantId = record.g;
  const secret = record.s;
  const securityLevel = record.l;

  if (version !== 1) {
    throw new Error("Connection string version is not supported.");
  }
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    throw new Error("Connection string is missing a backend URL.");
  }
  if (typeof grantId !== "string" || !grantId.trim()) {
    throw new Error("Connection string is missing a grant id.");
  }
  if (typeof secret !== "string" || !secret.trim()) {
    throw new Error("Connection string is missing a secret.");
  }
  if (securityLevel !== "shared" && securityLevel !== "per_device" && securityLevel !== "per_device_code") {
    throw new Error("Connection string security level is not supported.");
  }

  return {
    version: 1,
    baseUrl: baseUrl.trim().replace(/\/$/, ""),
    grantId,
    secret,
    securityLevel
  };
}
