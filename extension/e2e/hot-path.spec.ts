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

test("a delayed older response keeps its request timestamp even after a newer response arrives", async ({ page }) => {
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "Out-of-order synthetic responses" }));
  await page.goto("https://chatgpt.com/c/synthetic");
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.evaluate(() => {
    (window as any).pendingFetches = [];
    window.fetch = () => new Promise(resolve => (window as any).pendingFetches.push(resolve));
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => {
    const w = window as any, channel = new MessageChannel();
    w.captures = [];
    channel.port1.onmessage = event => { if (event.data.type === "NETWORK_CAPTURE") w.captures.push(event.data.payload); };
    channel.port1.start();
    w.HookTest.attachBridgePort(channel.port2);
    w.HookTest.handleControlPayload({ type: "SET_CAPTURE_ENABLED", enabled: true });
    void fetch("/backend-api/conversation/older");
  });
  await page.clock.fastForward(1000);
  await page.evaluate(() => {
    void fetch("/backend-api/conversation/newer");
    (window as any).pendingFetches[1](new Response('{"title":"new"}'));
  });
  await expect.poll(() => page.evaluate(() => (window as any).captures.length)).toBe(1);
  await page.clock.fastForward(1000);
  await page.evaluate(() => (window as any).pendingFetches[0](new Response('{"title":"old"}')));
  await expect.poll(() => page.evaluate(() => (window as any).captures.length)).toBe(2);
  const captures = await page.evaluate(() => (window as any).captures);
  expect(captures[0].url).toContain("newer");
  expect(captures[1].url).toContain("older");
  expect(Date.parse(captures[1].capturedAt)).toBeLessThan(Date.parse(captures[0].capturedAt));
});
