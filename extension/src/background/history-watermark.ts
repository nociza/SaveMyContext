import type { HistorySyncUpdate, ProviderDriftAlert, ProviderHistorySyncState, ProviderName, SessionSyncState } from "../shared/types";

/** Do not expire a saved prefix during a long/offline first import: doing so
 * can repeatedly download the head and starve the oldest conversations. */
export function historyResumeFingerprints(states: Record<string, SessionSyncState>, incomplete: boolean, now = Date.now()): Record<string, string> {
  return Object.fromEntries(Object.values(states)
    .filter(s => s.lastSyncedAt && (incomplete || now - Date.parse(s.lastSyncedAt) < 7 * 24 * 60 * 60 * 1000))
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
