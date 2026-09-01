import { describe, expect, it } from "vitest";
import { convertMinorUnits, parseCurrencyRates } from "./currency-rates.js";

describe("currency conversion", () => {
  const payload = {
    result: "success",
    base_code: "USD",
    time_last_update_unix: 1_700_000_000,
    rates: {
      USD: 1, EUR: 0.8, DKK: 6.4, RUB: 80, GBP: 0.75, CAD: 1.3,
      AUD: 1.5, UAH: 40, PLN: 4, SEK: 10, NOK: 10.5, JPY: 150, CNY: 7.2,
    },
  };

  it("accepts only complete supported rate snapshots", () => {
    const result = parseCurrencyRates(payload, new Date("2026-08-13T12:00:00Z"));
    expect(result.rates).toMatchObject({ DKK: 6.4, EUR: 0.8, USD: 1, RUB: 80, GBP: 0.75, USDT: 1 });
    expect(result.fetchedAt).toBe("2026-08-13T12:00:00.000Z");
  });

  it("converts through the USD base without losing minor-unit precision", () => {
    expect(convertMinorUnits(800, "EUR", "DKK", { DKK: 6.4, EUR: 0.8, USD: 1, RUB: 80 })).toBe(6400);
    expect(convertMinorUnits(100, "USD", "RUB", { DKK: 6.4, EUR: 0.8, USD: 1, RUB: 80 })).toBe(8000);
  });

  it("does not guess rates for unknown source currencies", () => {
    expect(convertMinorUnits(100, "BTC", "USD", { DKK: 6.4, EUR: 0.8, USD: 1, RUB: 80 })).toBeUndefined();
  });
});
