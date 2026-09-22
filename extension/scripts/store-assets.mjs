import { chromium } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "release/store-assets");
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "smc-store-artwork-"));
const backend = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ product: "savemycontext", version: "0.3.0", api_prefix: "/api/v1",
    auth: { mode: "bootstrap_local", local_unauthenticated_access: true, remote_requires_token: true },
    extension: { min_version: "0.1.0" }, features: { ingest: true, search: true }, storage: {} }));
});
await new Promise((resolve, reject) => { backend.once("error", reject); backend.listen(0, "127.0.0.1", resolve); });
const backendUrl = `http://127.0.0.1:${backend.address().port}`;
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: true, colorScheme: "light", viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${resolve(root, "dist")}`, `--load-extension=${resolve(root, "dist")}`]
});
try {
  // Every screenshot uses an isolated empty profile; no real conversations/accounts.
  await context.route(/^https?:/, route => route.request().url().startsWith(backendUrl + "/") ? route.continue() : route.abort());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  const popup = await context.newPage();
  await popup.goto(`${origin}/popup.html`);
  const configured = await popup.evaluate(backendUrl => chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", payload: { backendUrl } }), backendUrl);
  if (!configured.ok) throw Error("Could not connect the isolated screenshot fixture");
  await popup.reload();
  await popup.getByText("Connected", { exact: true }).waitFor();
  await popup.locator("#consent").waitFor({ state: "visible" });
  const consent = await popup.locator("body").screenshot();
  await popup.getByRole("button", { name: "Agree and enable capture" }).click();
  await popup.locator("#consent").waitFor({ state: "hidden" });
  const companion = await popup.locator("body").screenshot();
  const icon = `data:image/png;base64,${(await readFile(resolve(root, "public/icons/icon-128.png"))).toString("base64")}`;
  const artwork = await context.newPage();
  const common = `*{box-sizing:border-box}body{margin:0;background:#edf4ef;color:#1d382b;font-family:Arial,sans-serif}h1{font-size:62px;line-height:1.05;letter-spacing:-3px;margin:30px 0}p{font-size:24px;line-height:1.5;color:#486352}header{display:flex;align-items:center;gap:14px;font-size:23px;font-weight:bold}header img{width:48px}small{font-size:15px;color:#547060}`;
  async function screenshot(name, headline, details, bitmap) {
    await artwork.setViewportSize({ width: 1280, height: 800 });
    await artwork.setContent(`<style>${common}main{height:800px;display:grid;grid-template-columns:1fr 370px;align-items:center;gap:80px;padding:56px 100px}.preview{max-height:700px;max-width:370px;border:1px solid #cad8ce;border-radius:16px;box-shadow:0 20px 60px #163b2524}section{max-width:560px}</style><main><section><header><img src="${icon}" alt="">SaveMyContext</header><h1>${headline}</h1><p>${details}</p><small>Self-hosted backend required · Illustrative local setup</small></section><img class="preview" src="data:image/png;base64,${bitmap.toString("base64")}" alt="Actual extension popup"></main>`);
    await artwork.screenshot({ path: join(output, name) });
  }
  await screenshot("01-capture-companion.png", "Save the context.<br>Keep the control.", "Capture ChatGPT, Gemini and Grok conversations into a workspace you control. Import older history when you choose.", companion);
  await screenshot("02-privacy-controls.png", "Your destination.<br>Your decision.", "Review capture before enabling it. Pause anytime. Keep unsent conversations in an encrypted local queue.", consent);
  await artwork.setViewportSize({ width: 440, height: 280 });
  await artwork.setContent(`<style>${common}body{padding:35px}header{font-size:25px}header img{width:52px}h1{font-size:34px;letter-spacing:-1px;margin:22px 0 12px}p{font-size:16px;margin:0}</style><header><img src="${icon}" alt="">SaveMyContext</header><h1>Your AI conversations.<br>Your workspace.</h1><p>Capture · Search · Self-host</p>`);
  await artwork.screenshot({ path: join(output, "small-promo-440x280.png") });
  console.log(`Store images: ${output}`);
} finally {
  await context.close();
  backend.closeAllConnections();
  await new Promise(resolve => backend.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
