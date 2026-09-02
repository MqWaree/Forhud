import { describe, expect, it } from "vitest";
import { correctLegacyFailureReason } from "./failure-label-reconciliation.js";

describe("legacy failure label reconciliation", () => {
  it("turns legacy HTTP_5XX into the specific stored status", () => {
    expect(
      correctLegacyFailureReason({
        reason: "HTTP_5XX",
        originalHttpStatus: 503,
      }),
    ).toBe("HTTP_503");
  });

  it("recovers a 403 access block that was stored as TIMEOUT", () => {
    expect(
      correctLegacyFailureReason({ reason: "TIMEOUT", originalHttpStatus: 403 }),
    ).toBe("HTTP_403");
  });

  it("recovers a 429 rate limit that was stored as TIMEOUT", () => {
    expect(
      correctLegacyFailureReason({ reason: "TIMEOUT", originalHttpStatus: 429 }),
    ).toBe("HTTP_429");
  });

  it("recovers a specific 5xx original that was stored as TIMEOUT", () => {
    expect(
      correctLegacyFailureReason({ reason: "TIMEOUT", originalHttpStatus: 503 }),
    ).toBe("HTTP_503");
  });

  it("distinguishes a local worker timeout from a remote timeout", () => {
    expect(
      correctLegacyFailureReason({
        reason: "TIMEOUT",
        originalHttpStatus: null,
        pagesJson: JSON.stringify([
          { depth: 0, error: "Scrapling worker timeout", attempts: [] },
        ]),
      }),
    ).toBe("SCRAPER_TIMEOUT");
  });

  it("reads worker-timeout evidence from discovery page records", () => {
    expect(
      correctLegacyFailureReason({
        reason: "TIMEOUT",
        originalHttpStatus: null,
        pagesJson: JSON.stringify([
          {
            kind: "original",
            error: "TIMEOUT",
            errorDetail: "Scrapling worker timeout",
            attempts: [],
          },
        ]),
      }),
    ).toBe("SCRAPER_TIMEOUT");
  });

  it("keeps a remote worker 504 timeout classified as TIMEOUT", () => {
    expect(
      correctLegacyFailureReason({
        reason: "TIMEOUT",
        originalHttpStatus: null,
        pagesJson: JSON.stringify([
          {
            depth: 0,
            error:
              "Scrapling worker timeout (HTTP 504): TIMEOUT: Fetch exceeded deadline",
            attempts: [],
          },
        ]),
      }),
    ).toBe(null);
  });

  it("keeps a healthy homepage timeout label unchanged", () => {
    expect(
      correctLegacyFailureReason({
        reason: "TIMEOUT",
        originalHttpStatus: 200,
        pagesJson: JSON.stringify([{ depth: 0, httpStatus: 200 }]),
      }),
    ).toBe(null);
  });

  it("derives a specific 5xx from page evidence when the original status is missing", () => {
    expect(
      correctLegacyFailureReason({
        reason: "HTTP_5XX",
        originalHttpStatus: null,
        pagesJson: JSON.stringify([{ depth: 0, httpStatus: 500 }]),
      }),
    ).toBe("HTTP_500");
  });

  it("falls back to the fallback status for legacy HTTP_5XX rows", () => {
    expect(
      correctLegacyFailureReason({
        reason: "HTTP_5XX",
        originalHttpStatus: null,
        fallbackHttpStatus: 502,
        pagesJson: "[]",
      }),
    ).toBe("HTTP_502");
  });

  it("corrects non-legacy reasons when the original entry page was blocked", () => {
    expect(
      correctLegacyFailureReason({
        reason: "DISCORD_NOT_FOUND",
        originalHttpStatus: 403,
      }),
    ).toBe("HTTP_403");
  });

  it("leaves contact rows and already-correct rows untouched", () => {
    expect(
      correctLegacyFailureReason({ reason: "", originalHttpStatus: 403 }),
    ).toBe(null);
    expect(
      correctLegacyFailureReason({ reason: "HTTP_403", originalHttpStatus: 403 }),
    ).toBe(null);
    expect(
      correctLegacyFailureReason({ reason: "HTTP_429", originalHttpStatus: 429 }),
    ).toBe(null);
    expect(
      correctLegacyFailureReason({
        reason: "CONTACT_NOT_FOUND",
        originalHttpStatus: null,
      }),
    ).toBe(null);
    expect(
      correctLegacyFailureReason({
        reason: "HTTP_404",
        originalHttpStatus: 404,
      }),
    ).toBe(null);
  });
});
