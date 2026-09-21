/** Cosmetic cleanup must never block settings saves or the capture queue.
 * Sleeping tabs can leave executeScript pending until the user opens them.
 * A timed-out injection may still finish later; it only removes obsolete UI.
 */
export async function bestEffortTabCleanup(
  tab: { discarded?: boolean; frozen?: boolean },
  cleanup: () => Promise<unknown>,
  timeoutMs = 2_000
): Promise<void> {
  if (tab.discarded || tab.frozen) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(cleanup),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })
    ]);
  } catch {
    // Inaccessible/closed pages cannot be cleaned and must not stop capture.
  } finally {
    clearTimeout(timer);
  }
}
