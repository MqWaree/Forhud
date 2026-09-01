import { describe, expect, it } from "vitest";
import { discoveryProgressPercent } from "./search-progress.js";

describe("persistent search progress", () => {
  it("uses completed discovery work instead of only the result target", () => {
    expect(
      discoveryProgressPercent({
        requested: 500,
        discovered: 50,
        queryPagesChecked: 150,
        totalVariants: 100,
        maxRequests: 300,
      }),
    ).toBe(47);
  });

  it("keeps active discovery below the queueing and completed phases", () => {
    expect(
      discoveryProgressPercent({
        requested: 10,
        discovered: 10,
        queryPagesChecked: 1,
        totalVariants: 100,
        maxRequests: 300,
      }),
    ).toBe(90);
  });
});
