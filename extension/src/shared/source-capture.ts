import type { SourceCaptureKind, SourceCapturePayload } from "./types";

function randomUuid(): string {
  if (typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join("")
  ].join("-");
}

export function createSourceCaptureKey(
  createUuid: () => string = randomUuid
): string {
  return `smc_capture_${createUuid()}`;
}

type MaterialSourceCapturePayload = Omit<SourceCapturePayload, "captureKey">;

type PendingSourceCapture = {
  fingerprint: string;
  captureKey: string;
};

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalJsonValue(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJsonValue(item)])
    );
  }
  return value;
}

export function sourceCapturePayloadFingerprint(
  payload: SourceCapturePayload
): string {
  const { captureKey: _captureKey, ...materialPayload } = payload;
  return JSON.stringify(canonicalJsonValue(materialPayload));
}

/**
 * Retain an idempotency key across ambiguous failures for one capture surface.
 * A successful request consumes the key; a materially different payload starts
 * a new user action with a new key.
 */
export class SourceCaptureRetryLifecycle {
  private readonly pendingByKind = new Map<SourceCaptureKind, PendingSourceCapture>();

  constructor(
    private readonly createKey: () => string = createSourceCaptureKey
  ) {}

  prepare(payload: MaterialSourceCapturePayload): SourceCapturePayload {
    const fingerprint = sourceCapturePayloadFingerprint(payload);
    const pending = this.pendingByKind.get(payload.captureKind);
    if (pending?.fingerprint === fingerprint) {
      return {
        ...payload,
        captureKey: pending.captureKey
      };
    }

    const captureKey = this.createKey();
    this.pendingByKind.set(payload.captureKind, {
      fingerprint,
      captureKey
    });
    return {
      ...payload,
      captureKey
    };
  }

  markSucceeded(payload: SourceCapturePayload): void {
    if (!payload.captureKey) {
      return;
    }
    const pending = this.pendingByKind.get(payload.captureKind);
    if (
      pending?.captureKey === payload.captureKey &&
      pending.fingerprint === sourceCapturePayloadFingerprint(payload)
    ) {
      this.pendingByKind.delete(payload.captureKind);
    }
  }
}
