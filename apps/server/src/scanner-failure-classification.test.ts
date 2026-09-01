import { describe, expect, it } from "vitest";
import {
  automaticRetryDelayMs,
  isInfrastructureFailureReason,
  isRetryableFailureReason,
  statusForFailureReason,
} from "./scanner.js";

describe("scanner infrastructure failure classification", () => {
  it("keeps timeouts, access blocks, and worker failures separate from contact misses", () => {
    expect(isInfrastructureFailureReason("TIMEOUT")).toBe(true);
    expect(isInfrastructureFailureReason("SCRAPER_TIMEOUT")).toBe(true);
    expect(isInfrastructureFailureReason("HTTP_503")).toBe(true);
    expect(isInfrastructureFailureReason("SCRAPER_BUSY")).toBe(true);
    expect(isInfrastructureFailureReason("CONTACT_NOT_FOUND")).toBe(false);
    expect(isInfrastructureFailureReason("DISCORD_NOT_FOUND")).toBe(false);
  });

  it("maps infrastructure reasons to the correct scanner status", () => {
    expect(statusForFailureReason("TIMEOUT")).toBe("Timeout");
    expect(statusForFailureReason("SCRAPER_TIMEOUT")).toBe("Timeout");
    expect(statusForFailureReason("HTTP_403")).toBe("Blocked");
    expect(statusForFailureReason("HTTP_429")).toBe("Blocked");
    expect(statusForFailureReason("ROBOTS_RESTRICTED")).toBe("Blocked");
    expect(statusForFailureReason("HTTP_5XX")).toBe("Failed");
    expect(statusForFailureReason("HTTP_503")).toBe("Failed");
    expect(statusForFailureReason("SCRAPER_ERROR")).toBe("Failed");
  });

  it("automatically retries transient failures but not access controls", () => {
    expect(isRetryableFailureReason("TIMEOUT")).toBe(true);
    expect(isRetryableFailureReason("SCRAPER_TIMEOUT")).toBe(true);
    expect(isRetryableFailureReason("HTTP_503")).toBe(true);
    expect(isRetryableFailureReason("SCRAPER_BUSY")).toBe(true);
    expect(isRetryableFailureReason("HTTP_403")).toBe(false);
    expect(isRetryableFailureReason("ROBOTS_RESTRICTED")).toBe(false);
    expect(isRetryableFailureReason("CONTACT_NOT_FOUND")).toBe(false);
  });

  it("uses bounded exponential retry delays", () => {
    expect(automaticRetryDelayMs("SCRAPER_BUSY", 1)).toBe(3_000);
    expect(automaticRetryDelayMs("SCRAPER_TIMEOUT", 1)).toBe(3_000);
    expect(automaticRetryDelayMs("TIMEOUT", 2)).toBe(10_000);
    expect(automaticRetryDelayMs("HTTP_429", 3)).toBe(30_000);
  });
});
