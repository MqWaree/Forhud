import { describe, expect, it } from "vitest";
import {
  assertInitialSetupAuthorized,
  initialSetupProtection,
} from "./setup-security.js";

describe("initial administrator setup protection", () => {
  it("allows an uncomplicated local development bootstrap", () => {
    expect(initialSetupProtection({ NODE_ENV: "development" })).toMatchObject({
      required: false,
      configured: true,
    });
    expect(() =>
      assertInitialSetupAuthorized(undefined, { NODE_ENV: "development" }),
    ).not.toThrow();
  });

  it("fails closed in production until a strong setup token is configured", () => {
    expect(initialSetupProtection({ NODE_ENV: "production" })).toMatchObject({
      required: true,
      configured: false,
    });
    expect(() =>
      assertInitialSetupAuthorized(undefined, { NODE_ENV: "production" }),
    ).toThrow(/locked/i);
  });

  it("accepts only the exact production setup token", () => {
    const environment = {
      NODE_ENV: "production",
      INITIAL_SETUP_TOKEN: "a-strong-one-time-setup-secret",
    };
    expect(() => assertInitialSetupAuthorized("wrong", environment)).toThrow(
      /invalid/i,
    );
    expect(() =>
      assertInitialSetupAuthorized(
        "a-strong-one-time-setup-secret",
        environment,
      ),
    ).not.toThrow();
  });
});
