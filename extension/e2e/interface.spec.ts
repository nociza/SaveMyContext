import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, test as base, type Page } from "@playwright/test";
import { defaultSettings } from "../src/shared/storage";

// Exercise the packaged pages with deterministic Chrome API responses. The
// companion/provider suites separately exercise the real service worker.
const test = base.extend<{ ui: Page }>({
  ui: async ({}, use) => {
    const profile = await mkdtemp(join(tmpdir(), "smc-interface-"));
    const dist = resolve("dist");
    const context = await chromium.launchPersistentContext(profile, {
      channel: "chromium", headless: true, colorScheme: "light",
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    });
    try {
      await context.route(/^https?:/, route => route.abort());
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
      const origin = `chrome-extension://${new URL(worker.url()).host}`;
      const page = await context.newPage();
      await page.addInitScript(({ defaults, origin }) => {
        const state = {
          origin, settings: { ...defaults, captureConsentGranted: true, capturePaused: false },
          status: { backendValidatedAt: "2026-09-22T10:00:00Z", lastSuccessAt: "2026-09-22T10:30:00Z" } as Record<string, unknown>,
          pending: 0, url: "https://chatgpt.com/c/fixture", failRead: false, permissionGranted: true,
          calls: [] as string[], delayed: [] as string[],
          waiting: {} as Record<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>,
          emit: () => {},
        };
        (window as any).__smcUi = state;
        const listeners: ((changes: object, area: string) => void)[] = [];
        chrome.storage.onChanged.addListener = ((listener: any) => listeners.push(listener)) as any;
        state.emit = () => listeners.forEach(fn => fn({ "savemycontext.status": { newValue: state.status } }, "local"));
        chrome.tabs.query = (async () => [{ id: 123, url: state.url }]) as any;
        chrome.tabs.create = (async () => ({})) as any;
        chrome.runtime.openOptionsPage = (async () => {}) as any;
        chrome.permissions.contains = (async () => state.permissionGranted) as any;
        chrome.permissions.request = (async () => state.permissionGranted) as any;
        chrome.permissions.remove = (async () => true) as any;
        chrome.runtime.sendMessage = (async (message: any) => {
          state.calls.push(message.type);
          if (state.failRead && message.type.startsWith("GET_")) throw Error("Worker unavailable");
          if (state.delayed.includes(message.type)) {
            return await new Promise((resolve, reject) => { state.waiting[message.type] = { resolve, reject }; });
          }
          switch (message.type) {
            case "GET_SETTINGS": return { ...state.settings };
            case "GET_STATUS": return { ...state.status };
            case "GET_DELIVERY_STATUS": return { pending: state.pending };
            case "SAVE_SETTINGS": state.settings = { ...state.settings, ...message.payload }; return { ok: true };
            case "SET_CAPTURE_PAUSED": state.settings.capturePaused = message.paused; return { ok: true, paused: message.paused };
            case "ACCEPT_CAPTURE_CONSENT": state.settings.captureConsentGranted = true; state.settings.capturePaused = false; return { ok: true };
            case "SAVE_CURRENT_PAGE_SOURCE": return { ok: true };
            case "IMPORT_ACTIVE_HISTORY": return { triggered: true };
            default: throw Error("Unexpected fixture message: " + message.type);
          }
        }) as any;
      }, { defaults: defaultSettings, origin });
      await page.goto(`${origin}/popup.html`);
      await expect(page.locator("#connection")).toHaveText("Connected");
      await use(page);
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
});

test("popup retains action locks through storage updates and recovers from errors", async ({ ui }) => {
  await ui.evaluate(() => { (window as any).__smcUi.delayed = ["SAVE_CURRENT_PAGE_SOURCE"]; });
  await ui.locator("#save-page").click();
  await expect(ui.locator("#save-page")).toHaveAttribute("aria-busy", "true");
  await ui.evaluate(() => (window as any).__smcUi.emit());
  await expect(ui.locator("#save-page")).toBeDisabled();
  await expect(ui.locator("#pause")).toBeDisabled();
  await ui.locator("#save-page").evaluate((button: HTMLButtonElement) => button.click());
  expect(await ui.evaluate(() => (window as any).__smcUi.calls.filter((type: string) => type === "SAVE_CURRENT_PAGE_SOURCE").length)).toBe(1);
  await ui.evaluate(() => (window as any).__smcUi.waiting.SAVE_CURRENT_PAGE_SOURCE.reject(Error("Page could not be saved. Try again.")));
  await expect(ui.locator("#action-status")).toHaveAttribute("data-tone", "error");
  await expect(ui.locator("#save-page")).toBeEnabled();
  await ui.evaluate(() => { (window as any).__smcUi.delayed = []; });
  await ui.locator("#save-page").click();
  await expect(ui.locator("#action-status")).toHaveText("Page saved.");
});

test("consent, cancellations, unsupported tabs, and status failures are explicit", async ({ ui }) => {
  await ui.evaluate(() => {
    const state = (window as any).__smcUi;
    state.settings.captureConsentGranted = false;
    state.pending = 2;
    state.emit();
  });
  await expect(ui.locator("#consent")).toBeVisible();
  await expect(ui.locator("#save-page")).toBeDisabled();
  await expect(ui.locator("#import-history")).toBeDisabled();
  await ui.getByRole("button", { name: "Agree and enable capture" }).click();
  await expect(ui.locator("#consent")).toBeHidden();
  await expect(ui.locator("#save-page")).toBeEnabled();
  ui.on("dialog", dialog => dialog.dismiss());
  await ui.locator("#import-history").click();
  await expect(ui.locator("#action-status")).toHaveText("Import cancelled.");
  await ui.locator("summary").click();
  await ui.locator("#clear-queue").click();
  await expect(ui.locator("#action-status")).toHaveText("Nothing discarded.");
  expect(await ui.evaluate(() => (window as any).__smcUi.calls.includes("CLEAR_CAPTURE_QUEUE"))).toBe(false);
  await ui.evaluate(() => { const s = (window as any).__smcUi; s.url = "chrome://settings"; s.emit(); });
  await expect(ui.locator("#save-page")).toBeDisabled();
  await expect(ui.locator("#page-hint")).toContainText("Open a website");
  await ui.evaluate(() => { const s = (window as any).__smcUi; s.failRead = true; s.emit(); });
  await expect(ui.locator("#capture-state")).toHaveText("Let's reconnect");
  await expect(ui.locator("#open-dashboard")).toBeDisabled();
  await expect(ui.locator("#setup-connection")).toBeVisible();
});

test("settings preserve drafts, lock saves, and recover from denied permissions and transport errors", async ({ ui }) => {
  await ui.goto(new URL("options.html", ui.url()).href);
  await expect(ui.locator("#save-status")).toHaveText("Your settings are up to date.");
  await expect(ui.locator("#connection-string")).toBeHidden();
  await ui.getByText("Use a connection string instead").click();
  await expect(ui.locator("#connection-string")).toBeVisible();
  await expect(ui.locator("#connection-string")).toHaveAttribute("type", "password");
  await expect(ui.locator("#account-fields")).toBeHidden();
  await ui.locator("#account-capture-include").check();
  await ui.locator("#account-allow-chatgpt").fill("test@example.invalid");
  await ui.locator("#account-capture-include").uncheck();
  await expect(ui.locator("#account-fields")).toBeHidden();
  await ui.locator("#account-capture-include").check();
  await expect(ui.locator("#account-allow-chatgpt")).toHaveValue("test@example.invalid");
  await ui.locator("#account-capture-include").uncheck();
  await ui.locator("#workspace-url").fill("https://workspace.example/memory");
  await expect(ui.locator("#save-status")).toHaveText("You have unsaved changes.");
  await ui.evaluate(() => (window as any).__smcUi.emit());
  await expect(ui.locator("#workspace-url")).toHaveValue("https://workspace.example/memory");
  await ui.evaluate(() => { (window as any).__smcUi.delayed = ["SAVE_SETTINGS"]; });
  await ui.locator("#save-settings").click();
  await expect(ui.locator("#workspace-url")).toBeDisabled();
  await expect(ui.locator("#save-settings")).toHaveAttribute("aria-busy", "true");
  await ui.evaluate(() => (window as any).__smcUi.emit());
  await expect(ui.locator("#save-settings")).toBeDisabled();
  await ui.locator("#settings-form").evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect(await ui.evaluate(() => (window as any).__smcUi.calls.filter((type: string) => type === "SAVE_SETTINGS").length)).toBe(1);
  await ui.evaluate(() => (window as any).__smcUi.waiting.SAVE_SETTINGS.reject(Error("Transport disconnected")));
  await expect(ui.locator("#save-status")).toContainText("Could not confirm");
  await expect(ui.locator("#workspace-url")).toBeEnabled();
  await expect(ui.locator("#workspace-url")).toHaveValue("https://workspace.example/memory");
  await ui.evaluate(() => { const s = (window as any).__smcUi; s.delayed = []; s.permissionGranted = false; });
  await ui.locator("#backend-url").fill("https://new-backend.example");
  await ui.locator("#save-settings").click();
  await expect(ui.locator("#save-status")).toContainText("needs access");
  await expect(ui.locator("#save-status")).toHaveAttribute("data-tone", "error");
  await ui.evaluate(() => { (window as any).__smcUi.permissionGranted = true; });
  await ui.locator("#save-settings").click();
  await expect(ui.locator("#save-status")).toHaveText("Settings saved.");
  await expect(ui.locator("#workspace-url")).toHaveValue("https://workspace.example/memory");
  await expect(ui.locator("#last-error-card")).toBeHidden();
});

test("light and dark layouts fit popup and narrow settings with keyboard focus", async ({ ui }, testInfo) => {
  await ui.setViewportSize({ width: 380, height: 600 });
  await expect(ui.locator("#capture-state")).toHaveText("Ready to capture");
  expect(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await ui.locator("body").evaluate(body => body.scrollHeight)).toBeLessThanOrEqual(600);
  await ui.keyboard.press("Tab");
  await expect(ui.locator("#settings")).toBeFocused();
  await ui.screenshot({ path: testInfo.outputPath("popup-light.png") });
  await ui.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await ui.screenshot({ path: testInfo.outputPath("popup-dark.png") });
  await ui.goto(new URL("options.html", ui.url()).href);
  await expect(ui.locator("#save-settings")).toBeEnabled();
  expect(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await ui.getByRole("link", { name: "Providers & accounts" }).click();
  await expect(ui.locator("#provider-chatgpt")).toBeInViewport();
  await ui.screenshot({ path: testInfo.outputPath("settings-mobile-dark.png") });
  await ui.setViewportSize({ width: 1280, height: 900 });
  await ui.emulateMedia({ colorScheme: "light" });
  await ui.getByRole("link", { name: "Connection", exact: true }).click();
  await ui.evaluate(() => window.scrollTo(0, 0));
  await ui.screenshot({ path: testInfo.outputPath("settings-desktop-light.png") });
});
