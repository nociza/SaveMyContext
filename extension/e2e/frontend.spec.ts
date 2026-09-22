import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

// Build from only the public frontend package; no extension imports or Python runtime.
execFileSync(process.execPath, ["../frontend/scripts/build.mjs"]);
const dist = resolve("../frontend/dist");
const firstToken = "isolated-ui-test-token";
const secondToken = "isolated-second-api-token";
let api: Server, host: Server, apiOrigin: string, uiOrigin: string;
let configuration: unknown;
let requests: Array<{ path: string; authorization: string; origin: string }>;

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server failed");
  return `http://127.0.0.1:${address.port}`;
}

test.beforeEach(async () => {
  requests = [];
  api = createServer((request, response) => {
    const path = new URL(request.url!, "http://fixture").pathname;
    const origin = request.headers.origin || "";
    response.setHeader("Content-Type", "application/json");
    if (origin === uiOrigin) {
      response.setHeader("Access-Control-Allow-Origin", uiOrigin);
      response.setHeader("Access-Control-Allow-Headers", "authorization,content-type");
      response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
    }
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    const authorization = request.headers.authorization || "";
    requests.push({ path, authorization, origin });
    const expected = path.startsWith("/other/") ? secondToken : firstToken;
    if (authorization !== `Bearer ${expected}`) { response.writeHead(401); response.end('{}'); return; }
    const payload = path.endsWith("/overview")
      ? { counts: {}, settings: { timezone: "UTC" }, processing: { external_enabled: false } }
      : { items: [], tasks: [] };
    response.end(JSON.stringify(payload));
  });
  apiOrigin = await listen(api);
  configuration = { apiBase: `${apiOrigin}/api/v1/workspace`, view: "inbox" };
  host = createServer(async (request, response) => {
    try {
      const path = new URL(request.url!, "http://fixture").pathname;
      if (path === "/smc/assets/config.json") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(configuration)); return;
      }
      if (path === "/embed.html") {
        response.setHeader("Content-Type", "text/html");
        response.end('<style>p{color:rgb(255,0,0)}</style><p id="host-title">Independent dashboard</p><main id="host"></main>'); return;
      }
      const file = path === "/smc/" ? "index.html" : path.startsWith("/smc/assets/") ? path.slice(5) : "";
      if (!file || file.includes("..")) { response.writeHead(404); response.end(); return; }
      response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
      response.end(await readFile(resolve(dist, file)));
    } catch { response.writeHead(500); response.end(); }
  });
  uiOrigin = await listen(host);
});

test.afterEach(async () => {
  for (const server of [host, api]) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("standalone UI supports a separate API origin, subpath hosting, mobile, and memory-only authentication", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${uiOrigin}/smc/?token=must-not-be-used`);
  await expect(page.getByRole("heading", { name: "Connect your workspace" })).toBeVisible();
  expect(requests.every(request => !request.authorization)).toBe(true);
  await page.getByLabel("Application token").fill(firstToken);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Nothing to review" })).toBeVisible();
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What needs doing?" })).toBeVisible();
  expect(requests.some(request => request.origin === uiOrigin && request.authorization === `Bearer ${firstToken}`)).toBe(true);
  expect(requests.some(request => request.path.includes(firstToken))).toBe(false);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage, document.cookie]))).not.toContain(firstToken);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("standalone-mobile.png") });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Connect your workspace" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("embedded component isolates styles, clears credentials on endpoint changes, and stops polling on removal", async ({ page }) => {
  await page.clock.install();
  await page.goto(`${uiOrigin}/embed.html`);
  await page.evaluate(async ({ apiOrigin, token }) => {
    const entry = "/smc/assets/embed.js";
    const { mountWorkspace } = await import(entry);
    mountWorkspace(document.getElementById("host"), { apiBase: `${apiOrigin}/api/v1/workspace`, token, view: "memory" });
  }, { apiOrigin, token: firstToken });
  await expect(page.getByRole("heading", { name: "Room for your best thinking" })).toBeVisible();
  expect(requests.every(request => request.authorization === `Bearer ${firstToken}`)).toBe(true);
  expect(await page.locator("#host-title").evaluate(element => getComputedStyle(element).color)).toBe("rgb(255, 0, 0)");
  expect(await page.locator("smc-workspace").evaluate(element => getComputedStyle(element.shadowRoot!.querySelector(".subtitle")!).color)).not.toBe("rgb(255, 0, 0)");

  await page.locator("smc-workspace").evaluate((element, apiOrigin) => element.setAttribute("api-base", `${apiOrigin}/other/workspace`), apiOrigin);
  await expect(page.getByRole("heading", { name: "Connect your workspace" })).toBeVisible();
  expect(requests.filter(request => request.path.startsWith("/other/")).every(request => !request.authorization)).toBe(true);
  await page.getByLabel("Application token").fill(secondToken);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Room for your best thinking" })).toBeVisible();
  await page.locator("smc-workspace").evaluate(element => element.remove());
  const count = requests.length;
  await page.clock.fastForward(60_000);
  expect(requests).toHaveLength(count);
});

test("invalid runtime config fails visibly before making API requests", async ({ page }) => {
  configuration = { apiBase: `${apiOrigin}/api/v1/workspace`, token: "must-not-be-accepted" };
  await page.goto(`${uiOrigin}/smc/`);
  await expect(page.getByRole("alert")).toContainText("credentials must not be stored here");
  expect(requests).toHaveLength(0);
  await expect(page.locator("body")).not.toContainText("must-not-be-accepted");
});
