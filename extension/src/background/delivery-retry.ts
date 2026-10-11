import { OUTBOX_ALARM } from "./outbox";
const RETRY_KEY = "savemycontext.delivery-retry";
let alarmWork: Promise<unknown> = Promise.resolve();
export function withDeliveryAlarm<T>(operation: () => Promise<T>): Promise<T> {
  const next = alarmWork.then(operation, operation);
  alarmWork = next.catch(() => undefined);
  return next;
}

export function retryDelayMinutes(attempt: number, random = Math.random()): number {
  return Math.min(60, 2 ** Math.min(6, Math.max(0, attempt))) * (0.9 + Math.max(0, Math.min(1, random)) * 0.1);
}

/** One-shot retry, no perpetual empty-queue wakeup. The next delivery schedules
 * its successor; persisted attempts survive service-worker suspension. */
export async function scheduleDeliveryRetry(pending: number, paused: boolean): Promise<void> {
  if (!pending || paused) {
    await chrome.alarms.clear(OUTBOX_ALARM);
    await chrome.storage.local.remove(RETRY_KEY);
    return;
  }
  const attempt = Number((await chrome.storage.local.get(RETRY_KEY))[RETRY_KEY] ?? 0);
  const bounded = Number.isFinite(attempt) ? Math.min(6, Math.max(0, attempt)) : 0;
  await chrome.alarms.create(OUTBOX_ALARM, { delayInMinutes: retryDelayMinutes(bounded) });
  await chrome.storage.local.set({ [RETRY_KEY]: bounded + 1 });
}

/** Arm recovery before acknowledging persistence; do not postpone an existing
 * retry when new captures arrive or a service worker restarts. */
export async function ensureDeliveryRetry(): Promise<void> {
  await withDeliveryAlarm(async () => {
    if (!(await chrome.alarms.get(OUTBOX_ALARM))) await chrome.alarms.create(OUTBOX_ALARM, { delayInMinutes: 1 });
  });
}
