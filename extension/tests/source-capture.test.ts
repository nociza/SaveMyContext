import { describe, expect, it } from "vitest";

import {
  createSourceCaptureKey,
  SourceCaptureRetryLifecycle,
  sourceCapturePayloadFingerprint
} from "../src/shared/source-capture";
import type { SourceCapturePayload } from "../src/shared/types";

const rawPagePayload = (): Omit<SourceCapturePayload, "captureKey"> => ({
  captureKind: "page",
  saveMode: "raw",
  title: "Example",
  pageTitle: "Example",
  sourceUrl: "https://example.com/article",
  sourceText: "Saved body",
  sourceMarkdown: "Saved body",
  rawPayload: {
    textLength: 10,
    rootTag: "main"
  }
});

describe("source capture request keys", () => {
  it("creates a new namespaced key for each user capture action", () => {
    const generatedIds = ["first-request", "second-request"];
    const randomUuid = (): string => generatedIds.shift() ?? "unexpected-request";

    expect(createSourceCaptureKey(randomUuid)).toBe("smc_capture_first-request");
    expect(createSourceCaptureKey(randomUuid)).toBe("smc_capture_second-request");
  });

  it("reuses a pending key when the same page payload is retried after failure", () => {
    const generatedKeys = ["smc_capture_first", "smc_capture_second"];
    const lifecycle = new SourceCaptureRetryLifecycle(
      () => generatedKeys.shift() ?? "smc_capture_unexpected"
    );

    const firstAttempt = lifecycle.prepare(rawPagePayload());
    const retryAttempt = lifecycle.prepare(rawPagePayload());

    expect(firstAttempt.captureKey).toBe("smc_capture_first");
    expect(retryAttempt.captureKey).toBe(firstAttempt.captureKey);
    expect(generatedKeys).toEqual(["smc_capture_second"]);
  });

  it("starts a new lifecycle when any material capture field changes", () => {
    const generatedKeys = ["smc_capture_first", "smc_capture_second", "smc_capture_third"];
    const lifecycle = new SourceCaptureRetryLifecycle(
      () => generatedKeys.shift() ?? "smc_capture_unexpected"
    );

    const firstAttempt = lifecycle.prepare(rawPagePayload());
    const changedContent = lifecycle.prepare({
      ...rawPagePayload(),
      sourceText: "Materially changed body"
    });
    const changedMode = lifecycle.prepare({
      ...rawPagePayload(),
      sourceText: "Materially changed body",
      saveMode: "ai"
    });

    expect(firstAttempt.captureKey).toBe("smc_capture_first");
    expect(changedContent.captureKey).toBe("smc_capture_second");
    expect(changedMode.captureKey).toBe("smc_capture_third");
  });

  it("consumes a key only after the matching payload succeeds", () => {
    const generatedKeys = ["smc_capture_first", "smc_capture_second", "smc_capture_third"];
    const lifecycle = new SourceCaptureRetryLifecycle(
      () => generatedKeys.shift() ?? "smc_capture_unexpected"
    );
    const firstAttempt = lifecycle.prepare(rawPagePayload());
    const newerAttempt = lifecycle.prepare({
      ...rawPagePayload(),
      sourceText: "New body"
    });

    lifecycle.markSucceeded(firstAttempt);
    expect(
      lifecycle.prepare({
        ...rawPagePayload(),
        sourceText: "New body"
      }).captureKey
    ).toBe(newerAttempt.captureKey);

    lifecycle.markSucceeded(newerAttempt);
    expect(
      lifecycle.prepare({
        ...rawPagePayload(),
        sourceText: "New body"
      }).captureKey
    ).toBe("smc_capture_third");
  });

  it("canonicalizes raw-payload object key order when matching retries", () => {
    const left = rawPagePayload();
    const right = {
      ...rawPagePayload(),
      rawPayload: {
        rootTag: "main",
        textLength: 10
      }
    };

    expect(sourceCapturePayloadFingerprint(left)).toBe(
      sourceCapturePayloadFingerprint(right)
    );
  });
});
