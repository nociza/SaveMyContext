import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("extension manifest", () => {
  it("keeps standalone distributions licensed identically", () => {
    for (const file of ["LICENSE", "NOTICE"]) {
      const canonical = readFileSync(resolve("..", file), "utf8");
      for (const component of ["backend", "frontend"]) expect(readFileSync(resolve("..", component, file), "utf8")).toBe(canonical);
    }
  });
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

  it("does not request obsolete clipboard or blanket tab metadata access", () => {
    const manifest = JSON.parse(readFileSync(resolve("public/manifest.json"), "utf8"));

    expect(manifest.permissions).not.toContain("clipboardWrite");
    expect(manifest.permissions).not.toContain("tabs");
  });

  it("requests arbitrary backend origins only when the user connects one", () => {
    const manifest = JSON.parse(readFileSync(resolve("public/manifest.json"), "utf8"));

    expect(manifest.host_permissions).not.toContain("https://*/*");
    expect(manifest.host_permissions).not.toContain("http://*/*");
    expect(manifest.optional_host_permissions).toEqual(["https://*/*", "http://*/*"]);
  });
});
