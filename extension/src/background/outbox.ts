import type { BackendIngestPayload } from "../shared/types";

export const OUTBOX_ALARM = "smc-capture-outbox-v1";
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_ITEMS = 1000;

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
  private async database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("smc-capture-outbox", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("captures", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Cannot open capture outbox"));
      request.onblocked = () => reject(new Error("Capture outbox upgrade blocked"));
    });
  }

  private async transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.database();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction("captures", mode);
        const request = action(tx.objectStore("captures"));
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = tx.onerror = () => reject(new Error("Capture outbox transaction failed"));
      });
    } finally { db.close(); }
  }

  async list(): Promise<PendingCapture[]> {
    const items = await this.transaction("readonly", (store) => store.getAll());
    return items.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  async put(item: PendingCapture): Promise<void> {
    await this.transaction("readwrite", (store) => store.put(item));
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
