// Shared by provider history readers. Pausing stops outstanding reads as well as delivery.
const originalFetch = window.fetch.bind(window);
let enabled = false;
let controller = new AbortController();

export function setHistoryCaptureEnabled(value: boolean): void {
  if (enabled === value) return;
  enabled = value;
  if (!value) controller.abort();
  else controller = new AbortController();
}

export const authorizedHistoryFetch: typeof fetch = (input, init) => {
  if (!enabled) return Promise.reject(new Error("Capture paused"));
  const signals = [controller.signal, AbortSignal.timeout(30_000)];
  if (init?.signal) signals.push(init.signal);
  if (input instanceof Request) signals.push(input.signal);
  return originalFetch(input, { ...init, signal: AbortSignal.any(signals), redirect: "error" });
};
