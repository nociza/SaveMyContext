import type { ProviderName, SessionSyncState } from "./types";

const LEGACY_KEY = "savemycontext.sync-state";
const read = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
});
type Row = { key: string; state: SessionSyncState };

/** One conversation per record; the provider index contains only small sync
 * summaries. Updating one chat never serializes the full wallet of histories. */
export class SyncStateStore {
  private ready?: Promise<void>;
  private async database(): Promise<IDBDatabase> {
    const req = indexedDB.open("smc-sync-state", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("states", { keyPath: "key" });
      const summaries = db.createObjectStore("summaries", { keyPath: "key" });
      summaries.createIndex("provider", "provider");
      db.createObjectStore("migration");
    };
    const db = await read(req);
    db.onversionchange = () => db.close();
    return db;
  }
  private async transaction<T>(mode: IDBTransactionMode, action: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await this.database();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(["states", "summaries", "migration"], mode);
        let result: T, failure: unknown;
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => reject(failure ?? tx.error);
        void action(tx).then(value => { result = value; }).catch(error => {
          failure = error; try { tx.abort(); } catch { reject(error); }
        });
      });
    } finally { db.close(); }
  }
  private put(tx: IDBTransaction, key: string, state: SessionSyncState): void {
    const { seenMessageIds: _ids, messageFingerprints: _messages, ...summary } = state;
    tx.objectStore("states").put({ key, state });
    tx.objectStore("summaries").put({ key, provider: key.split(":", 1)[0], state: { ...summary, seenMessageIds: [] } });
  }
  private prepare(): Promise<void> {
    this.ready ??= (async () => {
      await navigator.locks.request(`smc-storage:${LEGACY_KEY}`, async () => {
        const done = await this.transaction("readonly", tx => read(tx.objectStore("migration").get("done")));
        if (done === "cleaned") return;
        if (!done) {
          const old = (await chrome.storage.local.get(LEGACY_KEY))[LEGACY_KEY] as Record<string, SessionSyncState> | undefined;
          await this.transaction("readwrite", async tx => {
            for (const [key, state] of Object.entries(old ?? {})) this.put(tx, key, state);
            await read(tx.objectStore("migration").put(true, "done"));
          });
        }
        // Only release browser-local quota after the complete copy commits.
        // If cleanup failed after copying, retry cleanup without overwriting newer rows.
        await chrome.storage.local.remove(LEGACY_KEY);
        await this.transaction("readwrite", tx => read(tx.objectStore("migration").put("cleaned", "done")));
      });
    })().catch(error => { this.ready = undefined; throw error; });
    return this.ready;
  }
  async get(key: string): Promise<SessionSyncState> {
    await this.prepare();
    const row: Row | undefined = await this.transaction("readonly", tx => read(tx.objectStore("states").get(key)));
    return row?.state ?? { seenMessageIds: [] };
  }
  async set(key: string, state: SessionSyncState): Promise<void> {
    await this.prepare();
    await this.transaction("readwrite", async tx => { this.put(tx, key, state); });
  }
  async all(provider?: ProviderName): Promise<Record<string, SessionSyncState>> {
    await this.prepare();
    const rows: Row[] = await this.transaction("readonly", tx => provider
      ? read(tx.objectStore("summaries").index("provider").getAll(provider))
      : read(tx.objectStore("states").getAll()));
    return Object.fromEntries(rows.map(row => [row.key, row.state]));
  }
}
