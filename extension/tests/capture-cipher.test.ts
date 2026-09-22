import { describe, expect, it } from "vitest";
import { createCaptureKey, openCapture, sealCapture } from "../src/background/capture-cipher";
import type { PendingCapture } from "../src/background/outbox";

describe("encrypted capture storage", () => {
  const item = { id: "capture-1", backendUrl: "https://private.example", createdAt: 1, bytes: 12,
    payload: { messages: [{ content: "private conversation" }] } } as PendingCapture;
  it("round-trips with non-exportable AES-GCM keys and fresh nonces", async () => {
    const key = await createCaptureKey();
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
    const a = await sealCapture(item, key), b = await sealCapture(item, key);
    expect(a.iv).not.toEqual(b.iv);
    expect(a).not.toHaveProperty("payload");
    expect(a).not.toHaveProperty("backendUrl");
    expect(new TextDecoder().decode(a.ciphertext)).not.toContain("private conversation");
    expect(await openCapture(a, key)).toEqual(item);
  });
  it("fails closed on a wrong key, modified ciphertext or substituted identity", async () => {
    const key = await createCaptureKey(), sealed = await sealCapture(item, key);
    await expect(openCapture(sealed, await createCaptureKey())).rejects.toThrow();
    await expect(openCapture({ ...sealed, id: "another-record" }, key)).rejects.toThrow();
    new Uint8Array(sealed.ciphertext)[0] ^= 1;
    await expect(openCapture(sealed, key)).rejects.toThrow();
  });
});
