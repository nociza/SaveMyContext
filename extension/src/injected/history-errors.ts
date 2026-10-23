/** Provider-wide errors stop the batch; a single missing/malformed chat does not. */
export class HistoryTransportError extends Error {
  readonly retryAfter: string;
  constructor(status: number, retryAfter?: string | null) {
    super(`History provider unavailable (${status || "network/timeout"}); saved progress is retained. Retry after the provider recovers or sign in again.`);
    const now = Date.now();
    const parsed = retryAfter && /^\d+$/.test(retryAfter) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter ?? "");
    this.retryAfter = new Date(Math.max(now + 15 * 60_000, Number.isFinite(parsed) ? Math.min(parsed, 8.64e15) : now)).toISOString();
  }
}

export function throwHistoryHttpError(response: Response): never {
  if ([401, 403, 429].includes(response.status) || response.status >= 500) {
    throw new HistoryTransportError(response.status, response.headers.get("retry-after"));
  }
  throw new Error(`History request failed (${response.status}); conversation remains retryable.`);
}
