/** Subscribe before reading status so a load completing during tabs.get cannot
 * strand a refresh forever. Never reload a user's conversation to reach it. */
export async function waitForTabComplete(tabId: number, timeoutMs = 30_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
      error ? reject(error) : resolve();
    };
    const updated = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === "complete") finish();
    };
    const removed = (id: number) => { if (id === tabId) finish(new Error("Provider tab was closed.")); };
    const timeout = setTimeout(() => finish(new Error("Provider tab did not finish loading.")), timeoutMs);
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    void chrome.tabs.get(tabId).then(tab => {
      if (tab.status === "complete") finish();
    }).catch(error => finish(error instanceof Error ? error : new Error("Provider tab unavailable.")));
  });
}
