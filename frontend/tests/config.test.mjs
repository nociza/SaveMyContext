import assert from "node:assert/strict";
import test from "node:test";
import { resolveApiBase, parseConfig } from "../src/config.js";

test("same-origin dashboard paths and separate HTTPS APIs", () => {
  assert.equal(resolveApiBase("/api/memory", "https://dashboard.example/memory"), "https://dashboard.example/api/memory");
  assert.equal(resolveApiBase("https://api.example/api/v1/workspace/", "https://ui.example/"), "https://api.example/api/v1/workspace");
  assert.equal(resolveApiBase("http://127.0.0.1:18888/api/v1/workspace", "http://localhost:8080/"), "http://127.0.0.1:18888/api/v1/workspace");
});
for (const value of ["javascript:alert(1)", "//api.example/path", "http://api.example/path", "https://user:secret@api.example/path", "https://api.example/path?token=secret", "https://api.example/path#token", "../api", "", null, 123]) {
  test(`reject unsafe API destination: ${String(value)}`, () => assert.throws(() => resolveApiBase(value, "https://ui.example/")));
}
test("runtime configuration contains no credentials and defaults to same-origin", () => {
  assert.deepEqual(parseConfig({}, "https://ui.example/"), { apiBase: "https://ui.example/api/v1/workspace", view: "inbox" });
  assert.equal(parseConfig({ view: "projects" }, "https://ui.example/").view, "projects");
  for (const value of [{ token: "secret" }, { apiKey: "secret" }, { view: "graph" }, null, []]) {
    assert.throws(() => parseConfig(value, "https://ui.example/"));
  }
});
