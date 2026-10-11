import { createCaptureKey, openCapture, sealCapture, type SealedCapture } from "./capture-cipher";
import type { CaptureStore, PendingCapture } from "./outbox";

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_ITEMS = 1000;
const TOTALS = "queue-totals-v3";
interface Totals { count: number; bytes: number }
interface Metadata { id: string; createdAt: number; bytes: number; runId: string; destination: string }
type Stored = PendingCapture | SealedCapture;
const request = <T>(value: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error ?? new Error("Capture database request failed."));
});
const destinationKey = async (url: string) => Array.from(new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url))
), b => b.toString(16).padStart(2, "0")).join("");

/** Ciphertext is read one record at a time. Metadata contains only opaque IDs,
 * counters, timestamps, and hashed destinations, never conversation text/tokens.
 * The v1/v2 migration is restartable and never clears or replaces a saved key.
 */
export class IndexedCaptureStore implements CaptureStore {
  constructor(private readonly readBatchLimit = 16) {
    if (!Number.isInteger(readBatchLimit) || readBatchLimit < 1 || readBatchLimit > 16) throw new RangeError("Read batch must be between 1 and 16 records.");
  }
  private keyPromise?: Promise<CryptoKey>;
  private ready?: Promise<void>;
  private connection?: Promise<IDBDatabase>;

  private database(): Promise<IDBDatabase> {
    this.connection ??= new Promise<IDBDatabase>((resolve, reject) => {
      let blocked = false;
      const open = indexedDB.open("smc-capture-outbox", 3);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("captures")) db.createObjectStore("captures", { keyPath: "id" });
        if (!db.objectStoreNames.contains("keys")) db.createObjectStore("keys");
        if (!db.objectStoreNames.contains("metadata")) {
          const meta = db.createObjectStore("metadata", { keyPath: "id" });
          meta.createIndex("order", ["createdAt", "id"]);
          meta.createIndex("runId", "runId");
          meta.createIndex("destination", "destination");
        }
      };
      open.onsuccess = () => {
        if (blocked) { open.result.close(); return; }
        const invalidate = () => { this.connection = undefined; this.keyPromise = undefined; this.ready = undefined; };
        open.result.onversionchange = () => { open.result.close(); invalidate(); };
        open.result.onclose = invalidate;
        resolve(open.result);
      };
      open.onerror = () => reject(new Error(`Cannot open capture outbox (${open.error?.name ?? "storage error"}). Queued data was not removed.`));
      open.onblocked = () => {
        blocked = true;
        reject(new Error("Capture database upgrade blocked. Close older SaveMyContext pages and reload the extension; do not clear its data."));
      };
    }).catch(error => { this.connection = undefined; throw error; });
    return this.connection;
  }

  private async transaction<T>(names: string[], mode: IDBTransactionMode, action: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await this.database();
    return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(names, mode);
        let result: T;
        let failure: unknown;
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error("Capture outbox transaction failed; data retained."));
        void action(tx).then(value => { result = value; }).catch(error => {
          failure = error;
          try { tx.abort(); } catch { reject(error); }
        });
    });
  }
  private read<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
    return this.transaction([store], "readonly", tx => request(tx.objectStore(store).get(key)));
  }

  private key(): Promise<CryptoKey> {
    this.keyPromise ??= (async () => {
      const saved = await this.read<CryptoKey>("keys", "aes-gcm-v1");
      if (saved) return saved;
      const first = await this.transaction(["captures"], "readonly", tx => request(tx.objectStore("captures").openCursor()));
      if (first?.value && "ciphertext" in first.value) throw new Error("Capture encryption key is missing. Existing ciphertext was preserved; do not reset the queue.");
      const key = await createCaptureKey();
      return this.transaction(["keys"], "readwrite", async tx => {
        const store = tx.objectStore("keys");
        const winner = await request(store.get("aes-gcm-v1"));
        if (winner) return winner as CryptoKey;
        await request(store.add(key, "aes-gcm-v1"));
        return key;
      });
    })().catch(error => { this.keyPromise = undefined; throw error; });
    return this.keyPromise;
  }

  private async metadata(item: PendingCapture): Promise<Metadata> {
    const bytes = Number.isSafeInteger(item.bytes) && item.bytes >= 0 ? item.bytes
      : new TextEncoder().encode(JSON.stringify([item.backendUrl, item.payload])).byteLength;
    return { id: item.id, createdAt: item.createdAt, bytes,
      runId: item.payload.raw_capture?.historySyncRunId ?? "", destination: await destinationKey(item.backendUrl) };
  }

  private prepare(): Promise<void> {
    this.ready ??= (async () => { await navigator.locks.request("smc-capture-migration-v3", async () => {
      if (await this.read<Totals>("keys", TOTALS)) return;
      const ids = await this.transaction(["captures"], "readonly", tx => request(tx.objectStore("captures").getAllKeys()));
      const rows: Metadata[] = [];
      for (const id of ids) {
        const stored = await this.read<Stored>("captures", id);
        if (!stored) continue;
        const item = "ciphertext" in stored ? await openCapture(stored, await this.key()) : stored;
        rows.push(await this.metadata(item));
        if (!("ciphertext" in stored)) {
          const sealed = await sealCapture(item, await this.key());
          await this.transaction(["captures"], "readwrite", tx => request(tx.objectStore("captures").put(sealed)));
        }
      }
      await this.transaction(["metadata", "keys"], "readwrite", async tx => {
        const meta = tx.objectStore("metadata");
        await request(meta.clear());
        for (const row of rows) meta.put(row);
        await request(tx.objectStore("keys").put({ count: rows.length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0) }, TOTALS));
      });
    }); })().catch(error => { this.ready = undefined; throw error; });
    return this.ready;
  }

  async put(item: PendingCapture): Promise<void> {
    await this.prepare();
    // Optimistic duplicate check avoids encryption work, but the write transaction
    // rechecks identity and capacity to serialize concurrent writers correctly.
    if (await this.read<Metadata>("metadata", item.id)) return;
    const [sealed, meta] = await Promise.all([sealCapture(item, await this.key()), this.metadata(item)]);
    await this.transaction(["captures", "metadata", "keys"], "readwrite", async tx => {
      if (await request(tx.objectStore("metadata").get(item.id))) return;
      const stats = await request(tx.objectStore("keys").get(TOTALS)) as Totals;
      if (stats.count >= MAX_ITEMS || stats.bytes + meta.bytes > MAX_BYTES) {
        throw new Error("Capture outbox is full. Restore connectivity; queued captures have not been discarded.");
      }
      tx.objectStore("captures").add(sealed);
      tx.objectStore("metadata").add(meta);
      await request(tx.objectStore("keys").put({ count: stats.count + 1, bytes: stats.bytes + meta.bytes }, TOTALS));
    });
  }

  async count(): Promise<number> {
    return this.transaction(["captures"], "readonly", tx => request(tx.objectStore("captures").count()));
  }
  async pendingRuns(): Promise<Set<string>> {
    await this.prepare();
    const rows: Metadata[] = await this.transaction(["metadata"], "readonly", tx => request(tx.objectStore("metadata").getAll()));
    return new Set(rows.map(row => row.runId).filter(Boolean));
  }
  async *iterate(backendUrl?: string): AsyncGenerator<PendingCapture> {
    await this.prepare();
    const destination = backendUrl === undefined ? undefined : await destinationKey(backendUrl);
    const rows: Metadata[] = await this.transaction(["metadata"], "readonly", tx => destination === undefined
      ? request(tx.objectStore("metadata").index("order").getAll())
      : request(tx.objectStore("metadata").index("destination").getAll(destination)));
    rows.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    for (let offset = 0; offset < rows.length;) {
      // Amortize IndexedDB IPC without preloading an unbounded encrypted queue.
      // A single oversized record is read alone; plaintext is still one-at-a-time.
      const batch: Metadata[] = [];
      let bytes = 0;
      while (offset < rows.length && batch.length < this.readBatchLimit) {
        const row = rows[offset];
        if (batch.length && bytes + row.bytes > 256 * 1024) break;
        batch.push(row); bytes += row.bytes; offset++;
      }
      const records: (Stored | undefined)[] = await this.transaction(["captures"], "readonly", tx =>
        Promise.all(batch.map(row => request(tx.objectStore("captures").get(row.id)))));
      for (let index = 0; index < records.length; index++) {
        const stored = records[index];
        records[index] = undefined;
        if (stored) yield "ciphertext" in stored ? await openCapture(stored, await this.key()) : stored;
      }
    }
  }
  /** Diagnostic/export compatibility; production delivery uses the bounded iterator. */
  async list(): Promise<PendingCapture[]> {
    const items: PendingCapture[] = [];
    for await (const item of this.iterate()) items.push(item);
    return items;
  }
  async remove(id: string): Promise<void> {
    await this.prepare();
    await this.transaction(["captures", "metadata", "keys"], "readwrite", async tx => {
      const meta = await request(tx.objectStore("metadata").get(id)) as Metadata | undefined;
      if (!meta) return;
      const stats = await request(tx.objectStore("keys").get(TOTALS)) as Totals;
      tx.objectStore("captures").delete(id);
      tx.objectStore("metadata").delete(id);
      await request(tx.objectStore("keys").put({ count: stats.count - 1, bytes: stats.bytes - meta.bytes }, TOTALS));
    });
  }
  async clear(): Promise<void> {
    await this.prepare();
    await this.transaction(["captures", "metadata", "keys"], "readwrite", async tx => {
      tx.objectStore("captures").clear(); tx.objectStore("metadata").clear();
      await request(tx.objectStore("keys").put({ count: 0, bytes: 0 }, TOTALS));
    });
  }
}
