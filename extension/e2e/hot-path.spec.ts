import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
const require = createRequire(import.meta.url);
const esbuild = createRequire(realpathSync(require.resolve("vite/package.json")))("esbuild");
const bundle = await esbuild.build({ stdin: { contents: readFileSync("src/injected/index.ts", "utf8") + '\nexport {handleControlPayload, attachBridgePort};', resolveDir: resolve("src/injected"), loader: "ts" }, bundle: true, write: false, format: "iife", globalName: "HookTest" });

test("bridge sends exact response and request text without duplicate JSON trees", async ({ page }) => {
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "Synthetic memory fixture" }));
  await page.goto("https://chatgpt.com/c/synthetic");
  await page.evaluate(() => { window.fetch = async () => new Response('{ "messages": [{"content":"🌱\\n    code()"}], "evidence": true }'); });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    const channel = new MessageChannel();
    const captured = new Promise<any>(resolve => { channel.port1.onmessage = event => { if (event.data.type === "NETWORK_CAPTURE") resolve(event.data.payload); }; });
    channel.port1.start();
    (window as any).HookTest.attachBridgePort(channel.port2);
    (window as any).HookTest.handleControlPayload({ type: "SET_CAPTURE_ENABLED", enabled: true });
    const requestText = '{ "messages": ["question"] }';
    const response = await fetch("/backend-api/conversation", { method: "POST", body: requestText });
    const original = await response.text(), event = await captured;
    channel.port1.close();
    return { original, event, requestText };
  });
  expect(result.event.response.text).toBe(result.original);
  expect(result.event.requestBody).toEqual({ text: result.requestText });
  expect(result.event.response).not.toHaveProperty("json");
  expect(JSON.parse(result.event.response.text).evidence).toBe(true);
});

test("fetch hook preserves the native promise and dispatches before parsing captured request bodies", async ({ page }) => {
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "Synthetic hot path" }));
  await page.goto("https://chatgpt.com/c/synthetic");
  await page.evaluate(() => {
    const state = (window as any).hookState = { calls: [] as string[], promise: Promise.resolve(new Response("{}")), requestConstructions: 0 };
    window.fetch = () => { state.calls.push("native"); return state.promise; };
    window.Request = new Proxy(Request, { construct(target, args) { state.requestConstructions++; return Reflect.construct(target, args); } });
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    const state = (window as any).hookState;
    const pausedPromise = fetch("/backend-api/me");
    const pausedNative = pausedPromise === state.promise;
    await pausedPromise;
    (window as any).HookTest.handleControlPayload({ type: "SET_CAPTURE_ENABLED", enabled: true });
    state.calls.length = 0;
    const parse = JSON.parse;
    JSON.parse = (...args) => { state.calls.push("parse"); return parse(...args); };
    const capturedPromise = fetch("/backend-api/conversation", { method: "POST", body: '{"synthetic":"question"}' });
    const dispatchOrder = [...state.calls];
    await capturedPromise;
    JSON.parse = parse;
    return { pausedNative, capturedNative: capturedPromise === state.promise, dispatchOrder, requestConstructions: state.requestConstructions };
  });
  expect(result).toEqual({ pausedNative: true, capturedNative: true, dispatchOrder: ["native"], requestConstructions: 0 });
});
