import { providerRegistry } from "../providers/registry";
import { evaluateIndexingRules } from "../shared/indexing-rules";
import type { BackendIngestPayload,ExtensionSettings } from "../shared/types";
export { IndexedCaptureStore } from "./capture-store";

export const OUTBOX_ALARM = "smc-capture-outbox-v1";

export function requireCaptureReceipt(payload: BackendIngestPayload, value: unknown): void {
  const receipt = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const quarantined = receipt.disposition === "quarantined" && typeof receipt.receipt_id === "string" && receipt.receipt_id.length > 0;
  if (!quarantined && !(typeof receipt.session_id === "string" && receipt.session_id.length > 0)) {
    throw new Error("Backend did not acknowledge durable capture storage.");
  }
  if (payload.provider_project !== undefined && !quarantined && receipt.provider_project_ack !== true) {
    throw new Error("Backend update required for ChatGPT Projects; capture retained for retry.");
  }
}

export function indexingAllowsCapture(settings: ExtensionSettings, payload: BackendIngestPayload): boolean {
  // Delivery may contain only an edited answer. Apply opening-request rules to
  // the original captured context, not that delta, or valid replies get stuck.
  const snapshot = providerRegistry.find((parser) => parser.matches(payload.raw_capture))?.parse(payload.raw_capture);
  return Boolean(snapshot && evaluateIndexingRules(settings, snapshot).shouldIndex);
}

export interface PendingCapture {
  id: string;
  backendUrl: string;
  payload: BackendIngestPayload;
  createdAt: number;
  bytes: number;
}

export interface CaptureStore {
  list(): Promise<PendingCapture[]>;
  iterate(backendUrl?: string): AsyncIterable<PendingCapture>;
  put(item: PendingCapture): Promise<void>;
  remove(id: string): Promise<void>;
}

export async function enqueueCapture(store: CaptureStore, backendUrl: string, payload: BackendIngestPayload): Promise<void> {
  const encoded = new TextEncoder().encode(JSON.stringify([backendUrl, payload]));
  const id = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoded)),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
  await store.put({ id, backendUrl, payload, createdAt: Date.now(), bytes: encoded.byteLength });
}

/** Ack callback must succeed before removal; crash/restart safely replays the same capture. */
export async function drainCaptures(
  store: CaptureStore,
  backendUrl: string,
  deliver: (item: PendingCapture) => Promise<void | boolean>
): Promise<number> {
  let delivered = 0;
  for await (const item of store.iterate(backendUrl)) {
    if (item.backendUrl !== backendUrl) continue; // Never send old private data to a new destination.
    if (await deliver(item) === false) continue; // Policy-deferred evidence stays queued without blocking other accounts.
    await store.remove(item.id);
    delivered += 1;
  }
  return delivered;
}
