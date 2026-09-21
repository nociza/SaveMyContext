/** Observe a clone without ever delaying or consuming the application's stream. */
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

export async function readBoundedResponse(response: Response, maxBytes = MAX_CAPTURE_BYTES, timeoutMs = 120_000): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Capture stream timed out")), timeoutMs);
  });
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Capture stream too large");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    clearTimeout(timer!);
    // Cancelling a tee branch can wait for its sibling: never await it.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function observeResponse(response: Response, accept: (text: string) => void): void {
  try {
    void readBoundedResponse(response.clone()).then(accept).catch(() => undefined);
  } catch {
    // Observer failure must not change provider behavior.
  }
}
