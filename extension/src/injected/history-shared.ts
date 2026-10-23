import type { ProviderName } from "../shared/types";

export type { HistorySyncControlPayload } from "../shared/types";

/** A changing cursor is not proof of progress. Bound empty/repeated pages
 * without putting a ceiling on the number of distinct conversations. */
export class HistoryPageProgress {
  private stalled = 0;
  observe(newItems: number, hasNext: boolean): void {
    this.stalled = newItems || !hasNext ? 0 : this.stalled + 1;
    if (this.stalled >= 3) throw new Error("History pagination made no progress; sync remains incomplete.");
  }
}

/** Hash one bounded list entry, including provider revision fields we do not
 * interpret. Receipts are only committed after durable backend delivery. */
export async function historyMetadataReceipt(provider: ProviderName, id: string, metadata: unknown): Promise<Record<string, string>> {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
    return value;
  };
  const bytes = new TextEncoder().encode(JSON.stringify(stable(metadata)));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  return { [JSON.stringify([provider, "metadata-v1", id])]: digest };
}

export function hasHistoryReceipt(known: Record<string, string>, receipt: Record<string, string>): boolean {
  return Object.entries(receipt).every(([key, value]) => known[key] === value);
}

export function normalizeHistorySessionIds(
  provider: ProviderName,
  sessionIds: string[] | undefined,
  normalizeProviderSessionId?: (sessionId: string) => string | null
): Set<string> {
  const normalized = sessionIds
    ?.map((sessionId) => {
      if (typeof sessionId !== "string") {
        return null;
      }

      const trimmed = sessionId.trim();
      if (!trimmed) {
        return null;
      }

      if (provider !== "gemini" || !normalizeProviderSessionId) {
        return trimmed;
      }

      return normalizeProviderSessionId(trimmed);
    })
    .filter((sessionId): sessionId is string => Boolean(sessionId));

  return new Set(normalized ?? []);
}

export function dedupeIds(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}

export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (!failed) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        if (currentIndex >= items.length) {
          return;
        }

        try {
          await worker(items[currentIndex], currentIndex);
        } catch (error) {
          // Stop new work immediately, but join active workers before returning.
          // Otherwise a restarted import can race a rejected run still capturing.
          if (!failed) failure = error;
          failed = true;
        }
      }
    })
  );
  if (failed) throw failure;
}

export function countRetryableHistoryFailures(attemptedCount: number, syncedCount: number): number {
  return Math.max(0, attemptedCount - syncedCount);
}
