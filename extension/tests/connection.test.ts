import { beforeEach, describe, expect, it, vi } from "vitest";

function encodeConnectionPayload(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf-8")
    .toString("base64url");
}

describe("connection strings", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("parses a connection string and normalizes the backend URL", async () => {
    const { parseConnectionString } = await import("../src/shared/connection");
    const parsed = parseConnectionString(
      `smc_conn_1_${encodeConnectionPayload({
        v: 1,
        u: "https://notes.example.com/",
        g: "grant-123",
        s: "secret-456",
        l: "per_device"
      })}`
    );

    expect(parsed).toEqual({
      version: 1,
      baseUrl: "https://notes.example.com",
      grantId: "grant-123",
      secret: "secret-456",
      securityLevel: "per_device"
    });
  });

  it("rejects connection strings with the wrong prefix", async () => {
    const { parseConnectionString } = await import("../src/shared/connection");
    expect(() => parseConnectionString("savemycontext_pat_test")).toThrow("unexpected prefix");
  });

  it("redeems a parsed connection bundle against the backend", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        token: "savemycontext_pat_test",
        token_id: "token-123",
        token_name: "Work Laptop",
        scopes: ["ingest", "read"],
        security_level: "per_device_code",
        second_factor_mode: "one_time_code"
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { redeemConnectionBundle } = await import("../src/background/backend");
    const response = await redeemConnectionBundle(
      {
        version: 1,
        baseUrl: "https://notes.example.com",
        grantId: "grant-123",
        secret: "secret-456",
        securityLevel: "per_device_code"
      },
      {
        installationId: "install-789",
        clientName: "Chrome macOS",
        verificationCode: "1234-5678"
      }
    );

    expect(response.token).toBe("savemycontext_pat_test");
    expect(fetchMock).toHaveBeenCalledWith("https://notes.example.com/api/v1/auth/connections/redeem", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        grant_id: "grant-123",
        secret: "secret-456",
        installation_id: "install-789",
        client_name: "Chrome macOS",
        verification_code: "1234-5678"
      })
    });
  });
});
