import { describe, expect, it } from "vitest";
import { AdaptiveConcurrencyController } from "./adaptive-concurrency.js";

describe("adaptive scanner concurrency", () => {
  it("does not let one unrelated site's rate limit collapse global throughput", () => {
    let now = 0;
    const controller = new AdaptiveConcurrencyController(8, true, () => now);

    expect(controller.snapshot().currentConcurrency).toBe(8);
    now += 1_000;
    expect(
      controller.record({
        status: "Blocked",
        durationMs: 1_000,
        httpStatus: 429,
        failureReason: "HTTP_429",
      }),
    ).toBe(false);
    expect(controller.snapshot()).toMatchObject({
      currentConcurrency: 8,
      rateLimited: 1,
      pressureEvents: 1,
    });
  });

  it("backs off immediately when the local scraper reports capacity pressure", () => {
    const controller = new AdaptiveConcurrencyController(32);
    expect(
      controller.record({
        status: "Failed",
        durationMs: 500,
        httpStatus: 503,
        failureReason: "SCRAPER_BUSY",
      }),
    ).toBe(true);
    expect(controller.snapshot()).toMatchObject({
      currentConcurrency: 6,
      pressureEvents: 1,
      lastAdjustmentReason:
        "Local scraper pressure; concurrency reduced immediately",
    });
  });

  it("backs off for sustained pressure and recovers after healthy work", () => {
    let now = 0;
    const controller = new AdaptiveConcurrencyController(8, true, () => now);
    for (let index = 0; index < 8; index += 1) {
      now += 1_000;
      controller.record({
        status: "Timeout",
        durationMs: 1_000,
        failureReason: "TIMEOUT",
      });
    }
    expect(controller.snapshot()).toMatchObject({
      currentConcurrency: 6,
      pressureEvents: 8,
    });

    for (let index = 0; index < 6; index += 1) {
      now += 500;
      controller.record({ status: "Completed", durationMs: 500 });
    }
    expect(controller.snapshot()).toMatchObject({
      currentConcurrency: 7,
      successful: 6,
      totalCompleted: 14,
    });
  });

  it("reduces one worker for timeouts and server errors without going below its floor", () => {
    const controller = new AdaptiveConcurrencyController(3);
    controller.record({
      status: "Timeout",
      durationMs: 10_000,
      failureReason: "TIMEOUT",
    });
    controller.record({
      status: "Failed",
      durationMs: 2_000,
      httpStatus: 503,
      failureReason: "HTTP_5XX",
    });
    for (let index = 0; index < 6; index += 1)
      controller.record({
        status: "Timeout",
        durationMs: 10_000,
        failureReason: "TIMEOUT",
      });
    expect(controller.snapshot()).toMatchObject({
      currentConcurrency: 2,
      minimumConcurrency: 2,
      timeoutEvents: 7,
      serverErrors: 1,
      pressureEvents: 8,
    });
  });

  it("records metrics without changing worker count when adaptation is disabled", () => {
    const controller = new AdaptiveConcurrencyController(6, false);
    controller.record({
      status: "Blocked",
      durationMs: 1_200,
      httpStatus: 429,
    });
    expect(controller.snapshot()).toMatchObject({
      enabled: false,
      configuredConcurrency: 6,
      currentConcurrency: 6,
      totalCompleted: 1,
      rateLimited: 1,
      pressureEvents: 0,
    });
  });

  it("backs off quickly from the high-throughput ceiling under broad pressure", () => {
    const controller = new AdaptiveConcurrencyController(32);
    expect(controller.snapshot()).toMatchObject({
      configuredConcurrency: 32,
      currentConcurrency: 8,
    });
    for (let index = 0; index < 8; index += 1)
      controller.record({
        status: "Timeout",
        durationMs: 6_000,
        failureReason: "TIMEOUT",
      });
    expect(controller.snapshot()).toMatchObject({
      configuredConcurrency: 32,
      currentConcurrency: 6,
      pressureEvents: 8,
    });
  });
});
