import { describe, expect, it } from "vitest";
import { defaultSettings } from "../src/shared/storage";
import { compactDate, popupPresentation } from "../src/popup/presentation";

const active = { ...defaultSettings, captureConsentGranted: true, capturePaused: false };

describe("popup presentation", () => {
  it("requires consent even if a stale preference says unpaused", () => {
    const view = popupPresentation({ ...active, captureConsentGranted: false }, {}, "https://chatgpt.com/c/test");
    expect(view.canImport).toBe(false);
    expect(view.canSave).toBe(false);
    expect(view.canPause).toBe(false);
    expect(view.headline).toBe("You're in control");
  });

  it("explains paused capture without hiding retained evidence", () => {
    const view = popupPresentation({ ...active, capturePaused: true }, {}, "https://gemini.google.com/app");
    expect(view.headline).toBe("Capture paused");
    expect(view.detail).toContain("queued stays here");
    expect(view.canImport).toBe(false);
    expect(view.canSave).toBe(false);
    expect(view.canPause).toBe(true);
  });

  it.each(["chrome://settings", "chrome-extension://abc/popup.html", "file:///private/test", "https-not-a-url", undefined])(
    "does not offer page saving for %s", url => {
      expect(popupPresentation(active, {}, url).canSave).toBe(false);
    }
  );

  it("offers manual saving on ordinary web pages but not history import", () => {
    const view = popupPresentation(active, {}, "https://example.org/article");
    expect(view.canSave).toBe(true);
    expect(view.canImport).toBe(false);
    expect(view.hint).toContain("open ChatGPT");
  });

  it("respects provider filters and accounts in its copy", () => {
    const disabled = popupPresentation({ ...active, enabledProviders: { chatgpt: false, gemini: true, grok: true } }, {}, "https://chatgpt.com");
    expect(disabled.canImport).toBe(false);
    expect(disabled.headline).toBe("Provider switched off");
    const enabled = popupPresentation(active, {}, "https://chatgpt.com/g/g-p-project/project");
    expect(enabled.canImport).toBe(true);
    expect(enabled.detail).toContain("account and indexing filters apply");
  });

  it("does not describe capture as ready when every provider is disabled", () => {
    const view = popupPresentation({ ...active, enabledProviders: { chatgpt: false, gemini: false, grok: false } }, {}, "https://example.org");
    expect(view.headline).toBe("Providers switched off");
    expect(view.state).toBe("paused");
    expect(view.canSave).toBe(true);
  });

  it("disables duplicate history imports and surfaces connection failures", () => {
    const view = popupPresentation(active, { historySyncInProgress: true, backendValidationError: "Offline" }, "https://grok.com");
    expect(view.canImport).toBe(false);
    expect(view.hint).toContain("safely close");
    expect(view.state).toBe("warning");
  });

  it("handles absent and malformed timestamps", () => {
    expect(compactDate()).toBe("Nothing saved yet");
    expect(compactDate("invalid")).toBe("Unknown time");
    expect(compactDate("2026-09-22T10:30:00Z")).not.toContain("Invalid");
  });
});
