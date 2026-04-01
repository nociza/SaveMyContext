import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { chromium, expect, test } from "@playwright/test";

const currentDir = fileURLToPath(new URL(".", import.meta.url));
const extensionRoot = resolve(currentDir, "..");
const projectRoot = resolve(extensionRoot, "..");
const backendRoot = resolve(projectRoot, "backend");
const extensionDist = resolve(extensionRoot, "dist");
const backendPython = resolve(backendRoot, ".venv/bin/python");
const HEALTHCHECK_TIMEOUT_MS = 15_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function buildBatchExecuteResponseBody(rpcId: string, payload: unknown): string {
  const innerPayload = JSON.stringify(payload);
  return `)]}'\n${innerPayload.length}\n${JSON.stringify([["wrb.fr", rpcId, innerPayload, null, null, null, "generic"]])}\n`;
}

function configuredBackendBaseUrl(): string | null {
  const value = globalThis.process.env.TSMC_E2E_BACKEND_URL?.trim();
  return value ? value.replace(/\/$/, "") : null;
}

async function waitForBackendUrlHealthy(backendBaseUrl: string): Promise<void> {
  const deadline = Date.now() + HEALTHCHECK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${backendBaseUrl}/api/v1/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // The server is still starting.
    }

    await wait(250);
  }

  throw new Error(`Backend did not become healthy at ${backendBaseUrl}.`);
}

function extractBackendBaseUrl(logs: string[]): string | null {
  const match = logs.join("").match(/Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/);
  return match?.[1] ?? null;
}

async function waitForBackendHealthy(logs: string[]): Promise<string> {
  const deadline = Date.now() + HEALTHCHECK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const backendBaseUrl = extractBackendBaseUrl(logs);
    if (backendBaseUrl) {
      try {
        const response = await fetch(`${backendBaseUrl}/api/v1/health`);
        if (response.ok) {
          return backendBaseUrl;
        }
      } catch {
        // The server picked a port but is still starting.
      }
    }

    await wait(250);
  }

  throw new Error(`Backend did not become healthy.\n${logs.join("")}`);
}

async function stopBackend(process: ReturnType<typeof spawn> | undefined): Promise<void> {
  if (!process || process.killed) {
    return;
  }

  process.kill("SIGTERM");

  await Promise.race([
    new Promise<void>((resolvePromise) => {
      process.once("exit", () => resolvePromise());
    }),
    wait(5_000).then(() => {
      process.kill("SIGKILL");
    })
  ]);
}

test("auto-syncs ChatGPT history on provider visit", async ({ request }, testInfo) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "tsmc-extension-e2e-"));
  const backendDataDir = await mkdtemp(join(tmpdir(), "tsmc-backend-e2e-"));
  const sessionId = `e2e-chatgpt-${Date.now()}`;
  const backendLogs: string[] = [];
  let backendProcess: ReturnType<typeof spawn> | undefined;
  let backendBaseUrl = configuredBackendBaseUrl();

  try {
    if (backendBaseUrl) {
      await waitForBackendUrlHealthy(backendBaseUrl);
    } else {
      const backendChild = spawn(
        backendPython,
        ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "0"],
        {
          cwd: backendRoot,
          env: {
            ...globalThis.process.env,
            PYTHONUNBUFFERED: "1",
            TSMC_DATABASE_URL: `sqlite+aiosqlite:///${join(backendDataDir, "tsmc.db")}`,
            TSMC_MARKDOWN_DIR: join(backendDataDir, "markdown"),
            TSMC_LLM_BACKEND: "heuristic"
          },
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      backendProcess = backendChild;

      backendChild.stdout?.on("data", (chunk: Buffer) => {
        backendLogs.push(chunk.toString());
      });
      backendChild.stderr?.on("data", (chunk: Buffer) => {
        backendLogs.push(chunk.toString());
      });

      backendBaseUrl = await waitForBackendHealthy(backendLogs);
    }

    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: testInfo.project.use.headless ?? true,
      args: [`--disable-extensions-except=${extensionDist}`, `--load-extension=${extensionDist}`]
    });

    try {
      let [serviceWorker] = context.serviceWorkers();
      if (!serviceWorker) {
        serviceWorker = await context.waitForEvent("serviceworker");
      }
      const extensionId = serviceWorker.url().split("/")[2] ?? "";
      expect(extensionId).not.toHaveLength(0);

      const optionsPage = await context.newPage();
      await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: "domcontentloaded" });
      await optionsPage.locator("#backend-url").fill(backendBaseUrl);
      await optionsPage.locator("#auto-sync-history").setChecked(true);
      await optionsPage.locator("#settings-form").evaluate((form) => {
        (form as HTMLFormElement).requestSubmit();
      });
      await expect(optionsPage.locator("#save-status")).toHaveText("Settings saved.");

      const conversationUrl = "https://chatgpt.com/";
      const sessionApiUrl = "https://chatgpt.com/api/auth/session";
      const listApiUrl = "https://chatgpt.com/backend-api/conversations?offset=0&limit=100&order=updated";
      const detailApiUrl = `https://chatgpt.com/backend-api/conversation/${sessionId}`;

      await context.route(sessionApiUrl, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            accessToken: "e2e-token"
          })
        });
      });

      await context.route(listApiUrl, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            items: [
              {
                id: sessionId,
                title: "E2E ChatGPT Sync"
              }
            ],
            total: 1
          })
        });
      });

      await context.route(detailApiUrl, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            conversation_id: sessionId,
            title: "E2E ChatGPT Sync",
            mapping: {
              root: {
                id: "root"
              },
              userNode: {
                id: "userNode",
                parent: "root",
                message: {
                  id: "msg-user",
                  author: { role: "user" },
                  create_time: 1711842000,
                  content: { parts: ["Explain how FastAPI uses uvloop in an async backend."] }
                }
              },
              assistantNode: {
                id: "assistantNode",
                parent: "msg-user",
                message: {
                  id: "msg-assistant",
                  author: { role: "assistant" },
                  create_time: 1711842060,
                  content: { parts: ["FastAPI uses uvloop to run the event loop with high-performance async I/O."] }
                }
              }
            }
          })
        });
      });

      const page = await context.newPage();
      await page.goto(conversationUrl, { waitUntil: "domcontentloaded" });

      await expect
        .poll(
          async () =>
            serviceWorker.evaluate(async () => {
              const stored = await chrome.storage.local.get("tsmc.status");
              return (
                (stored["tsmc.status"] as { historySyncLastResult?: string } | undefined)?.historySyncLastResult ??
                null
              );
            }),
          {
            message: "Waiting for the extension to finish ChatGPT history sync."
          }
        )
        .toBe("success");

      await expect
        .poll(
          async () => {
            const response = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=chatgpt`);
            if (!response.ok()) {
              return null;
            }
            const sessions = (await response.json()) as Array<{ external_session_id: string }>;
            return sessions.find((session) => session.external_session_id === sessionId)?.external_session_id ?? null;
          },
          {
            message: "Waiting for the backend to persist the auto-synced ChatGPT session."
          }
        )
        .toBe(sessionId);

      const sessionsResponse = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=chatgpt`);
      expect(sessionsResponse.ok()).toBeTruthy();
      const sessions = (await sessionsResponse.json()) as Array<{
        id: string;
        external_session_id: string;
        title: string | null;
      }>;
      const matchedSession = sessions.find((session) => session.external_session_id === sessionId);
      expect(matchedSession?.title).toBe("E2E ChatGPT Sync");

      const sessionResponse = await request.get(`${backendBaseUrl}/api/v1/sessions/${matchedSession?.id}`);
      expect(sessionResponse.ok()).toBeTruthy();
      const persisted = (await sessionResponse.json()) as {
        external_session_id: string;
        messages: Array<{ content: string }>;
        triplets: Array<{ subject: string }>;
      };

      expect(persisted.external_session_id).toBe(sessionId);
      expect(persisted.messages).toHaveLength(2);
      expect(persisted.messages.map((message) => message.content)).toEqual([
        "Explain how FastAPI uses uvloop in an async backend.",
        "FastAPI uses uvloop to run the event loop with high-performance async I/O."
      ]);
      expect(persisted.triplets.length).toBeGreaterThan(0);

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
      await expect(popup.locator("#history-sync")).toContainText("success");
      await expect(popup.locator("#last-session")).toHaveText(`chatgpt:${sessionId}`);
    } finally {
      await context.close();
    }
  } finally {
    await stopBackend(backendProcess);
    await rm(userDataDir, { recursive: true, force: true });
    await rm(backendDataDir, { recursive: true, force: true });
  }
});

test("auto-syncs Gemini history on provider visit", async ({ request }, testInfo) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "tsmc-extension-e2e-"));
  const backendDataDir = await mkdtemp(join(tmpdir(), "tsmc-backend-e2e-"));
  const sessionId = "gemini-e2e-123456789";
  const backendLogs: string[] = [];
  let backendProcess: ReturnType<typeof spawn> | undefined;
  let backendBaseUrl = configuredBackendBaseUrl();

  try {
    if (backendBaseUrl) {
      await waitForBackendUrlHealthy(backendBaseUrl);
    } else {
      const backendChild = spawn(
        backendPython,
        ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "0"],
        {
          cwd: backendRoot,
          env: {
            ...globalThis.process.env,
            PYTHONUNBUFFERED: "1",
            TSMC_DATABASE_URL: `sqlite+aiosqlite:///${join(backendDataDir, "tsmc.db")}`,
            TSMC_MARKDOWN_DIR: join(backendDataDir, "markdown"),
            TSMC_LLM_BACKEND: "heuristic"
          },
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      backendProcess = backendChild;

      backendChild.stdout?.on("data", (chunk: Buffer) => {
        backendLogs.push(chunk.toString());
      });
      backendChild.stderr?.on("data", (chunk: Buffer) => {
        backendLogs.push(chunk.toString());
      });

      backendBaseUrl = await waitForBackendHealthy(backendLogs);
    }

    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: testInfo.project.use.headless ?? true,
      args: [`--disable-extensions-except=${extensionDist}`, `--load-extension=${extensionDist}`]
    });

    try {
      let [serviceWorker] = context.serviceWorkers();
      if (!serviceWorker) {
        serviceWorker = await context.waitForEvent("serviceworker");
      }
      const extensionId = serviceWorker.url().split("/")[2] ?? "";
      expect(extensionId).not.toHaveLength(0);

      const optionsPage = await context.newPage();
      await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: "domcontentloaded" });
      await optionsPage.locator("#backend-url").fill(backendBaseUrl);
      await optionsPage.locator("#auto-sync-history").setChecked(true);
      await optionsPage.locator("#settings-form").evaluate((form) => {
        (form as HTMLFormElement).requestSubmit();
      });
      await expect(optionsPage.locator("#save-status")).toHaveText("Settings saved.");

      await context.route("https://gemini.google.com/app", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Gemini</title>
  </head>
  <body>
    <input name="at" value="e2e-gemini-token" />
    <script>window.WIZ_global_data = { SNlM0e: "e2e-gemini-token" };</script>
  </body>
</html>`
        });
      });

      await context.route("https://gemini.google.com/_/BardChatUi/data/batchexecute*", async (route) => {
        const url = new URL(route.request().url());
        const rpcId = url.searchParams.get("rpcids");

        if (rpcId === "MaZiqc") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: buildBatchExecuteResponseBody("MaZiqc", [
              ["c_gemini-e2e-123456789", "Gemini E2E Sync"]
            ])
          });
          return;
        }

        if (rpcId === "hNvQHb") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: buildBatchExecuteResponseBody("hNvQHb", [
              [
                [["Explain proactive backfill on Gemini."], 2],
                [[["rc_1", ["Proactive backfill imports your saved Gemini conversations automatically."]]]],
                [1711842000, 1]
              ],
              [
                [["How is incremental sync different?"], 2],
                [[["rc_2", ["Incremental sync only sends newly observed messages after the initial import."]]]],
                [1711842060, 1]
              ]
            ])
          });
          return;
        }

        await route.fulfill({
          status: 404,
          contentType: "text/plain",
          body: `Unexpected rpcids=${rpcId ?? "missing"}`
        });
      });

      const page = await context.newPage();
      await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" });

      await expect
        .poll(
          async () =>
            serviceWorker.evaluate(async () => {
              const stored = await chrome.storage.local.get("tsmc.status");
              return (
                (stored["tsmc.status"] as { historySyncLastResult?: string } | undefined)?.historySyncLastResult ??
                null
              );
            }),
          {
            message: "Waiting for the extension to finish Gemini history sync."
          }
        )
        .toBe("success");

      await expect
        .poll(
          async () => {
            const response = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=gemini`);
            if (!response.ok()) {
              return null;
            }
            const sessions = (await response.json()) as Array<{ external_session_id: string }>;
            return sessions.find((session) => session.external_session_id === sessionId)?.external_session_id ?? null;
          },
          {
            message: "Waiting for the backend to persist the auto-synced Gemini session."
          }
        )
        .toBe(sessionId);

      const sessionsResponse = await request.get(`${backendBaseUrl}/api/v1/sessions?provider=gemini`);
      expect(sessionsResponse.ok()).toBeTruthy();
      const sessions = (await sessionsResponse.json()) as Array<{
        id: string;
        external_session_id: string;
        title: string | null;
      }>;
      const matchedSession = sessions.find((session) => session.external_session_id === sessionId);
      expect(matchedSession?.title).toBe("Gemini E2E Sync");

      const sessionResponse = await request.get(`${backendBaseUrl}/api/v1/sessions/${matchedSession?.id}`);
      expect(sessionResponse.ok()).toBeTruthy();
      const persisted = (await sessionResponse.json()) as {
        external_session_id: string;
        messages: Array<{ content: string }>;
      };

      expect(persisted.external_session_id).toBe(sessionId);
      expect(persisted.messages.map((message) => message.content)).toEqual([
        "Explain proactive backfill on Gemini.",
        "Proactive backfill imports your saved Gemini conversations automatically.",
        "How is incremental sync different?",
        "Incremental sync only sends newly observed messages after the initial import."
      ]);

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
      await expect(popup.locator("#history-sync")).toContainText("success");
      await expect(popup.locator("#last-session")).toHaveText(`gemini:${sessionId}`);
    } finally {
      await context.close();
    }
  } finally {
    await stopBackend(backendProcess);
    await rm(userDataDir, { recursive: true, force: true });
    await rm(backendDataDir, { recursive: true, force: true });
  }
});
