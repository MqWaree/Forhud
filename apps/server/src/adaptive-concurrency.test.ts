import { describe, expect, it } from "vitest";
import { AdaptiveConcurrencyController } from "./adaptive-concurrency.js";

describe("adaptive scanner concurrency", () => {
  it("backs off aggressively for rate limiting and recovers after healthy work", () => {
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
    ).toBe(true);
    expect(controller.snapshot()).toMatchObject({
      currentConcurrency: 4,
      rateLimited: 1,
      pressureEvents: 1,
    });

    for (let index = 0; index < 8; index += 1) {
      now += 500;
      controller.record({ status: "Completed", durationMs: 500 });
    }
    expect(controller.snapshot()).toMatchObject({
      currentConcurrency: 5,
      successful: 8,
      totalCompleted: 9,
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
    expect(controller.snapshot()).toMatchObject({
      currentConcurrency: 2,
      minimumConcurrency: 2,
      timeoutEvents: 1,
      serverErrors: 1,
      pressureEvents: 2,
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
});
