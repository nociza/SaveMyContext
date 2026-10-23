import type { HistorySyncUpdate, ProviderDriftAlert, ProviderHistorySyncState, ProviderName, SessionSyncState } from "../shared/types";

/** Anchor expiry to the start of this reconciliation, not each retry. New
 * receipts survive long imports; stale receipts cannot resurrect on resume.
 * Live captures must not extend the age of a full-history verification. */
export function historyResumeFingerprints(states: Record<string, SessionSyncState>, referenceTime = Date.now()): Record<string, string> {
  return Object.fromEntries(Object.values(states)
    .filter(s => s.lastSyncedAt && referenceTime - Date.parse(s.lastFullHistorySyncedAt ?? s.lastSyncedAt) < 7 * 24 * 60 * 60 * 1000)
    .flatMap(s => s.historyFingerprints ? Object.entries(s.historyFingerprints)
      : s.historyItemKey && s.historyFingerprint ? [[s.historyItemKey, s.historyFingerprint]] : []));
}

export function shouldCommitHistoryWatermark(update: HistorySyncUpdate, runError?: string): boolean {
  return (
    update.phase === "completed" &&
    !runError &&
    !update.providerDriftAlert &&
    (update.retryableFailureCount ?? 0) === 0
  );
}

export function activeHistoryWatermarks(
  provider: ProviderName,
  state: ProviderHistorySyncState,
  currentAlert?: ProviderDriftAlert | null
): string[] | undefined {
  if (state.lastDriftAlert?.provider === provider || currentAlert?.provider === provider) {
    return undefined;
  }

  return state.lastTopSessionIds ?? (state.lastTopSessionId ? [state.lastTopSessionId] : undefined);
}
