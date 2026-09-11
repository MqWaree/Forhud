import { describe, expect, it } from "vitest";
import {
  IDLE_CLAIM_DELAY_MS,
  MAX_IDLE_CLAIM_DELAY_MS,
  nextIdleDelayMs,
} from "./scanner.js";

describe("scanner idle claim backoff", () => {
  it("starts at the historical 750 ms delay when a worker first finds no work", () => {
    expect(nextIdleDelayMs(0)).toBe(IDLE_CLAIM_DELAY_MS);
    expect(IDLE_CLAIM_DELAY_MS).toBe(750);
  });

  it("doubles on consecutive empty claims and caps at the ceiling", () => {
    const delays: number[] = [];
    let delay = 0;
    for (let i = 0; i < 6; i++) {
      delay = nextIdleDelayMs(delay);
      delays.push(delay);
    }
    expect(delays).toEqual([750, 1500, 3000, 5000, 5000, 5000]);
    expect(Math.max(...delays)).toBe(MAX_IDLE_CLAIM_DELAY_MS);
  });

  it("keeps new imports responsive: a drained scanner notices queued work within the ceiling", () => {
    // A worker that has been idle for a long time must still poll again within
    // MAX_IDLE_CLAIM_DELAY_MS, never longer, so new work is picked up promptly.
    let delay = 0;
    for (let i = 0; i < 100; i++) delay = nextIdleDelayMs(delay);
    expect(delay).toBeLessThanOrEqual(MAX_IDLE_CLAIM_DELAY_MS);
    expect(delay).toBeGreaterThan(0);
  });
});
