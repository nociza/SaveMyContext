/** Bounded, ephemeral acknowledgements; the durable queue lives in the extension.
 * History workers await these, so provider downloads cannot outrun local storage. */
export class CaptureHandoffError extends Error {}

export class CaptureReceipts {
  private pending = new Map<string, { finish: (error?: string) => void }>();
  constructor(private timeoutMs = 30_000, private limit = 8) {}
  wait(id: string, send: () => void): Promise<void> {
    if (this.pending.size >= this.limit || this.pending.has(id)) return Promise.reject(new CaptureHandoffError("Capture handoff busy; retry history later."));
    return new Promise((resolve, reject) => {
      const finish = (error?: string) => {
        clearTimeout(timer);
        this.pending.delete(id);
        error ? reject(new CaptureHandoffError(error)) : resolve();
      };
      const timer = setTimeout(() => finish("Capture was not acknowledged by local storage."), this.timeoutMs);
      this.pending.set(id, { finish });
      try { send(); } catch { finish("Capture bridge unavailable."); }
    });
  }
  acknowledge(id: string, ok: boolean): void {
    this.pending.get(id)?.finish(ok ? undefined : "Capture could not be persisted; history remains retryable.");
  }
  cancel(): void {
    for (const entry of [...this.pending.values()]) entry.finish("Capture paused.");
  }
}
