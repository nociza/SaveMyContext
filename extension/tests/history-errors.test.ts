import { expect, it } from "vitest";
import { HistoryTransportError, throwHistoryHttpError } from "../src/injected/history-errors";

it("honors numeric and HTTP-date retry windows without immediate provider-wide retries", () => {
  const later = Date.now() + 3_600_000;
  expect(Date.parse(new HistoryTransportError(429, "3600").retryAfter)).toBeGreaterThanOrEqual(later);
  expect(Date.parse(new HistoryTransportError(503, new Date(later).toUTCString()).retryAfter)).toBeGreaterThan(later - 1000);
  expect(Date.parse(new HistoryTransportError(401).retryAfter)).toBeGreaterThanOrEqual(Date.now() + 899_000);
  expect(() => throwHistoryHttpError(new Response(null, { status: 429 }))).toThrow(HistoryTransportError);
  try { throwHistoryHttpError(new Response(null, { status: 404 })); } catch (error) { expect(error).not.toBeInstanceOf(HistoryTransportError); }
});
