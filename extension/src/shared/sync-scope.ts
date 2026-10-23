import type { ProviderHistorySyncState, SessionSyncState } from "./types";

/** Serialize read/modify/write transitions, not just individual storage writes. */
export class SyncOperations {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.tails.set(key, next);
    void next.finally(() => { if (this.tails.get(key) === next) this.tails.delete(key); }).catch(() => undefined);
    return next;
  }
}

export function syncStateAtDestination(state: SessionSyncState, destination: string): SessionSyncState {
  // Legacy receipts have no provable destination. Reimport rather than guess.
  return state.destination === destination ? state : { seenMessageIds: [] };
}

export function isCurrentHistoryRun(state: ProviderHistorySyncState, runId: string | undefined, destination: string): boolean {
  return Boolean(runId && state.activeRunId === runId && state.destination === destination);
}

export function mayAdvanceSyncState(state: SessionSyncState, capturedAt: string): boolean {
  const next = Date.parse(capturedAt);
  const previous = Date.parse(state.lastCapturedAt ?? "");
  return Number.isFinite(next) && (!Number.isFinite(previous) || next >= previous);
}
