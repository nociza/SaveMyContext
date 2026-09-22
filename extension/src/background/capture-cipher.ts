import type { PendingCapture } from "./outbox";

export interface SealedCapture {
  id: string;
  version: 1;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}

export function createCaptureKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function sealCapture(item: PendingCapture, key: CryptoKey): Promise<SealedCapture> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(item.id) },
    key, new TextEncoder().encode(JSON.stringify(item))
  );
  return { id: item.id, version: 1, iv, ciphertext };
}

export async function openCapture(item: SealedCapture, key: CryptoKey): Promise<PendingCapture> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: item.iv, additionalData: new TextEncoder().encode(item.id) }, key, item.ciphertext
  );
  const result = JSON.parse(new TextDecoder().decode(plaintext)) as PendingCapture;
  if (result.id !== item.id) throw new Error("Capture identity mismatch");
  return result;
}
