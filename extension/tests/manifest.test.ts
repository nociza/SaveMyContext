import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("extension manifest", () => {
  it("injects the default content script only on supported AI provider pages", () => {
    const manifest = JSON.parse(readFileSync(resolve("public/manifest.json"), "utf8"));
    const [contentScript] = manifest.content_scripts;

    expect(contentScript.js).toEqual(["assets/content.js"]);
    expect(contentScript.matches).toEqual([
      "https://chatgpt.com/*",
      "https://chat.openai.com/*",
      "https://gemini.google.com/*",
      "https://grok.com/*"
    ]);
  });

  it("can write dumped markdown to the clipboard", () => {
    const manifest = JSON.parse(readFileSync(resolve("public/manifest.json"), "utf8"));

    expect(manifest.permissions).toContain("clipboardWrite");
  });

  it("requests arbitrary backend origins only when the user connects one", () => {
    const manifest = JSON.parse(readFileSync(resolve("public/manifest.json"), "utf8"));

    expect(manifest.host_permissions).not.toContain("https://*/*");
    expect(manifest.host_permissions).not.toContain("http://*/*");
    expect(manifest.optional_host_permissions).toEqual(["https://*/*", "http://*/*"]);
  });
});
