import { providerRegistry } from "../providers/registry";
import { evaluateIndexingRules } from "../shared/indexing-rules";
import type { BackendIngestPayload,ExtensionSettings } from "../shared/types";
import { createCaptureKey, openCapture, sealCapture, type SealedCapture } from "./capture-cipher";

export const OUTBOX_ALARM = "smc-capture-outbox-v1";
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_ITEMS = 1000;

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
  put(item: PendingCapture): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Private extension-origin IndexedDB, not sync storage and never provider localStorage. */
export class IndexedCaptureStore implements CaptureStore {
  private keyPromise?: Promise<CryptoKey>;
  private async database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("smc-capture-outbox", 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("captures")) db.createObjectStore("captures", { keyPath: "id" });
        if (!db.objectStoreNames.contains("keys")) db.createObjectStore("keys");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Cannot open capture outbox"));
      request.onblocked = () => reject(new Error("Capture outbox upgrade blocked"));
    });
  }

  private async transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>, storeName = "captures"): Promise<T> {
    const db = await this.database();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const request = action(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = tx.onerror = () => reject(new Error("Capture outbox transaction failed"));
      });
    } finally { db.close(); }
  }

  private key(): Promise<CryptoKey> {
    this.keyPromise ??= (async () => {
      const existing = await this.transaction("readonly", store => store.get("aes-gcm-v1"), "keys");
      if (existing) return existing as CryptoKey;
      const key = await createCaptureKey();
      try { await this.transaction("readwrite", store => store.add(key, "aes-gcm-v1"), "keys"); }
      catch {
        // Another extension context may have won the first-use race. Never replace its key.
        const winner = await this.transaction("readonly", store => store.get("aes-gcm-v1"), "keys");
        if (winner) return winner as CryptoKey;
        throw new Error("Cannot persist capture encryption key");
      }
      return key;
    })().catch(error => { this.keyPromise = undefined; throw error; });
    return this.keyPromise;
  }

  async list(): Promise<PendingCapture[]> {
    const records: (PendingCapture | SealedCapture)[] = await this.transaction("readonly", (store) => store.getAll());
    const key = await this.key();
    const items: PendingCapture[] = [];
    for (const record of records) {
      if ("ciphertext" in record) items.push(await openCapture(record, key));
      else {
        // Legacy data is replaced only after encryption succeeds. A failed migration
        // retains the original, never silently drops an undelivered conversation.
        const sealed = await sealCapture(record, key);
        await this.transaction("readwrite", store => {
          const request = store.get(record.id);
          request.onsuccess = () => { if (request.result && !("ciphertext" in request.result)) store.put(sealed); };
          return request;
        });
        items.push(record);
      }
    }
    return items.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  async put(item: PendingCapture): Promise<void> {
    const sealed = await sealCapture(item, await this.key());
    await this.transaction("readwrite", (store) => store.put(sealed));
  }
  async count(): Promise<number> {
    return (await this.list()).length;
  }
  async clear(): Promise<void> {
    await this.transaction("readwrite", store => store.clear());
  }
  async remove(id: string): Promise<void> {
    await this.transaction("readwrite", (store) => store.delete(id));
  }
}

export async function enqueueCapture(store: CaptureStore, backendUrl: string, payload: BackendIngestPayload): Promise<void> {
  const encoded = new TextEncoder().encode(JSON.stringify([backendUrl, payload]));
  const id = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoded)),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
  const items = await store.list();
  if (items.some((item) => item.id === id)) return;
  if (items.length >= MAX_ITEMS || items.reduce((sum, item) => sum + item.bytes, encoded.byteLength) > MAX_BYTES) {
    throw new Error("Capture outbox is full. Restore backend connectivity; queued captures have not been discarded.");
  }
  await store.put({ id, backendUrl, payload, createdAt: Date.now(), bytes: encoded.byteLength });
}

/** Ack callback must succeed before removal; crash/restart safely replays the same capture. */
export async function drainCaptures(
  store: CaptureStore,
  backendUrl: string,
  deliver: (item: PendingCapture) => Promise<void>
): Promise<number> {
  let delivered = 0;
  for (const item of await store.list()) {
    if (item.backendUrl !== backendUrl) continue; // Never send old private data to a new destination.
    await deliver(item);
    await store.remove(item.id);
    delivered += 1;
  }
  return delivered;
}
