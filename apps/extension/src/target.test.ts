import { describe, expect, it } from "vitest";
import { hasReachedTarget, parseExtensionTarget } from "./target.js";

describe("extension result targets", () => {
  it("accepts presets, custom whole numbers, and Until Stopped", () => {
    expect(parseExtensionTarget("500", "")).toEqual({
      mode: "LIMIT",
      targetResults: 500,
    });
    expect(parseExtensionTarget("CUSTOM", "375")).toEqual({
      mode: "LIMIT",
      targetResults: 375,
    });
    expect(parseExtensionTarget("UNTIL_STOPPED", "")).toEqual({
      mode: "UNTIL_STOPPED",
      targetResults: 0,
    });
  });

  it.each(["0", "-1", "1.5", "words", "5001"])(
    "rejects invalid custom target %s",
    (value) => {
      expect(() => parseExtensionTarget("CUSTOM", value)).toThrow(
        /positive whole number/i,
      );
    },
  );

  it("stops only when the unique result target is reached", () => {
    expect(hasReachedTarget("LIMIT", 500, 499)).toBe(false);
    expect(hasReachedTarget("LIMIT", 500, 500)).toBe(true);
    expect(hasReachedTarget("UNTIL_STOPPED", 0, 50_000)).toBe(false);
  });
});
