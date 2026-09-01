import { describe, expect, it } from "vitest";
import {
  calculateLztAverage,
  convertLztEurMinor,
  convertLztRubInventoryMinor,
  dedupeLztItems,
  extractLztGames,
  averageLztApiRequestLatency,
  extractLztInventory,
  hasLegacyLztLatencyMetrics,
  isFreshLztListing,
  lztDetectionLatencyMs,
  lztListingVisibilityWhere,
  lztTestAlertLabel,
  localDate,
  normalizeLztItem,
  pageContainsKnownLztListing,
  qualifyLztListingAlert,
  resolveLztSoldAt,
  serializeLztTrackerState,
  shouldNotifyLztListing,
  shouldRunFullLztReconciliation,
} from "./lzt-tracker.js";
describe("LZT tracker contracts", () => {
  it("extracts unique games and Rust lifetime hours", () => {
    const result = extractLztGames({
      item_id: 101,
      price: 5,
      steam_full_games: {
        list: {
          a: { appid: 252490, playtime_forever: 74700 },
          duplicate: { appid: 252490, playtime_forever: 74700 },
          b: { appid: 242760, playtime_forever: 100 },
        },
      },
    });
    expect(result).toEqual({ gamesCount: 2, rustHours: 74700 });
  });
  it("uses API game totals", () =>
    expect(
      extractLztGames({ item_id: 1, price: 1, steam_game_count: 8 }).gamesCount,
    ).toBe(8));
  it("calculates inclusive twenty-dollar average without duplicates", () => {
    const result = calculateLztAverage([
      {
        lztItemId: "A",
        priceUsdMinor: 500,
        priceEurMinor: 460,
        itemState: "ACTIVE",
      },
      {
        lztItemId: "B",
        priceUsdMinor: 1000,
        priceEurMinor: 920,
        itemState: "ACTIVE",
      },
      {
        lztItemId: "C",
        priceUsdMinor: 2000,
        priceEurMinor: 1840,
        itemState: "ACTIVE",
      },
      {
        lztItemId: "D",
        priceUsdMinor: 2001,
        priceEurMinor: 1841,
        itemState: "ACTIVE",
      },
      {
        lztItemId: "A",
        priceUsdMinor: 500,
        priceEurMinor: 460,
        itemState: "ACTIVE",
      },
      {
        lztItemId: "S",
        priceUsdMinor: 100,
        priceEurMinor: 92,
        itemState: "SOLD",
      },
    ]);
    expect(result).toEqual({
      eligibleCount: 3,
      averagePriceEurMinor: 1073,
      lowestPriceEurMinor: 460,
    });
  });
  it("does not display a zero average", () =>
    expect(calculateLztAverage([])).toEqual({
      eligibleCount: 0,
      averagePriceEurMinor: null,
      lowestPriceEurMinor: null,
    }));
  it("keeps sold listings visible for one minute", () => {
    const now = new Date("2026-08-15T12:00:00.000Z");
    expect(lztListingVisibilityWhere(now)).toEqual({
      OR: [
        { itemState: "ACTIVE" },
        {
          itemState: "SOLD",
          soldAt: { gte: new Date("2026-08-15T11:59:00.000Z") },
        },
      ],
    });
  });
  it("starts the sold timer once and does not reset it on later polls", () => {
    const firstSoldAt = new Date("2026-08-15T12:00:00.000Z");
    expect(resolveLztSoldAt(null, "SOLD", firstSoldAt)).toBe(firstSoldAt);
    expect(
      resolveLztSoldAt(
        firstSoldAt,
        "SOLD",
        new Date("2026-08-15T12:00:30.000Z"),
      ),
    ).toBe(firstSoldAt);
    expect(resolveLztSoldAt(firstSoldAt, "ACTIVE")).toBeNull();
  });
  it("uses Copenhagen calendar across UTC midnight and DST", () => {
    expect(
      localDate(new Date("2026-03-28T23:30:00Z"), "Europe/Copenhagen"),
    ).toBe("2026-03-29");
    expect(
      localDate(new Date("2026-10-24T22:30:00Z"), "Europe/Copenhagen"),
    ).toBe("2026-10-25");
  });
  it("is stable for five thousand calculation cycles", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      lztItemId: String(i),
      priceUsdMinor: i * 10,
      priceEurMinor: i * 9,
      itemState: "ACTIVE",
    }));
    for (let i = 0; i < 5000; i++)
      expect(calculateLztAverage(rows).eligibleCount).toBe(200);
  });
  it("deduplicates sticky items and emits new items in chronological order", () => {
    const result = dedupeLztItems([
      { itemId: "105", publishedAt: new Date(5000) },
      { itemId: "103", publishedAt: new Date(3000) },
      { itemId: "105", publishedAt: new Date(5000) },
      { itemId: "104", publishedAt: new Date(4000) },
    ]);
    expect(result.map((item) => item.itemId)).toEqual(["103", "104", "105"]);
  });
  it("formats custom Haze test criteria without changing production rules", () => {
    expect(
      lztTestAlertLabel({
        maximumPriceUsd: 15,
        minimumGames: 25,
        minimumRustHours: 2_000,
      }),
    ).toBe("TEST • ≤$15.00 • ≥2,000H • ≥25 GAMES");
  });
  it("notifies once for every new Rust listing and retains priority labels", () => {
    expect(qualifyLztListingAlert(500, 0)).toEqual({
      code: "CHEAP_PRICE",
      label: "UNDER $5.00",
    });
    expect(qualifyLztListingAlert(600, 2_001)).toEqual({
      code: "HIGH_HOURS",
      label: "2000+ HRS / UNDER $6",
    });
    expect(qualifyLztListingAlert(501, 2_000)).toEqual({
      code: "NEW_LISTING",
      label: "NEW RUST ACCOUNT",
    });
    expect(qualifyLztListingAlert(null, 10_000)).toEqual({
      code: "NEW_LISTING",
      label: "NEW RUST ACCOUNT",
    });
    expect(shouldNotifyLztListing(9_999, 0)).toBe(true);
    expect(shouldNotifyLztListing(null, null)).toBe(true);
  });
  it("does not stop catch-up pagination because a repeated sticky item is known", () => {
    const known = new Set(["sticky"]);
    expect(
      pageContainsKnownLztListing([{ item_id: "new", price: 1 }], known),
    ).toBe(false);
    expect(
      pageContainsKnownLztListing([{ item_id: "sticky", price: 1 }], known),
    ).toBe(true);
  });
  it("measures detection from poll start instead of marketplace publication age", () => {
    const pollStartedAt = new Date("2026-08-16T12:00:00.000Z");
    const detectedAt = new Date("2026-08-16T12:00:00.275Z");
    expect(lztDetectionLatencyMs(pollStartedAt, detectedAt)).toBe(275);
  });
  it("reports API latency per request instead of summing catch-up pages", () => {
    expect(averageLztApiRequestLatency(900, 3)).toBe(300);
    expect(averageLztApiRequestLatency(900, 0)).toBe(0);
  });
  it("only notifies listings newer than the saved watermark", () => {
    const watermark = new Date("2026-08-16T12:00:00.000Z");
    expect(
      isFreshLztListing(new Date("2026-08-16T12:00:01.000Z"), watermark),
    ).toBe(true);
    expect(
      isFreshLztListing(new Date("2026-08-16T12:00:00.000Z"), watermark),
    ).toBe(false);
    expect(isFreshLztListing(new Date("2026-08-01T00:00:00.000Z"), null)).toBe(
      true,
    );
  });
  it("identifies only impossible legacy detection counters for repair", () => {
    expect(hasLegacyLztLatencyMetrics(2_762_457_784n)).toBe(true);
    expect(hasLegacyLztLatencyMetrics(42_000n)).toBe(false);
  });
  it("runs a bounded full reconciliation on startup and after the interval", () => {
    const now = Date.parse("2026-08-14T12:00:00Z");
    expect(shouldRunFullLztReconciliation(false, null, now)).toBe(true);
    expect(
      shouldRunFullLztReconciliation(true, new Date(now - 60_000), now),
    ).toBe(false);
    expect(
      shouldRunFullLztReconciliation(true, new Date(now - 3_600_000), now),
    ).toBe(true);
  });
  it("converts a non-EUR API price instead of treating it as EUR", async () => {
    const result = await normalizeLztItem(
      {
        item_id: 106,
        title: "Rust account",
        price: 1000,
        price_currency: "RUB",
        published_date: 1_786_200_000,
      },
      0,
    );
    expect(result.originalPriceMinor).toBe(100_000);
    expect(result.originalCurrency).toBe("RUB");
    expect(result.priceEurMinor).toBeGreaterThan(0);
    expect(result.priceEurMinor).toBeLessThan(result.originalPriceMinor);
  });
  it("serializes oversized detection counters without crashing JSON responses", () => {
    const state = serializeLztTrackerState({
      id: "global",
      totalDetectionMs: 1_049_500_169_730n,
      maxDetectionMs: 1_049_500_169_730n,
    });
    expect(state.totalDetectionMs).toBe(1_049_500_169_730);
    expect(state.maxDetectionMs).toBe(1_049_500_169_730);
    expect(() => JSON.stringify(state)).not.toThrow();
  });
});
describe("LZT inventory extraction", () => {
  it("stores official RUB inventory values as minor units", () => {
    expect(
      extractLztInventory({
        item_id: 201,
        price: 5,
        steam_cs2_inv_value: 12.34,
        steam_rust_inv_value: 4.56,
        steam_inv_value: 18,
      }),
    ).toEqual({
      inventoryCs2EurMinor: 1234,
      inventoryRustEurMinor: 456,
      inventoryTotalEurMinor: 1800,
    });
  });

  it("uses the known inventory distribution when LZT omits its total", () => {
    expect(
      extractLztInventory({
        item_id: 202,
        price: 5,
        steam_cs2_inv_value: 1.25,
        steam_rust_inv_value: 2.75,
      }).inventoryTotalEurMinor,
    ).toBe(400);
  });

  it("converts a RUB inventory total to the selected USD currency", () => {
    const rates = { EUR: 0.8, USD: 1, DKK: 6, RUB: 80 };
    expect(convertLztRubInventoryMinor(160_000, "USD", rates)).toBe(2000);
  });

  it("converts every inventory value from EUR to the selected currency", () => {
    const rates = { EUR: 0.8, USD: 1, DKK: 6, RUB: 90 };
    expect(convertLztEurMinor(800, "USD", rates)).toBe(1000);
    expect(convertLztEurMinor(800, "DKK", rates)).toBe(6000);
    expect(convertLztEurMinor(800, "RUB", rates)).toBe(90_000);
    expect(convertLztEurMinor(800, "EUR", rates)).toBe(800);
    expect(convertLztEurMinor(undefined, "USD", rates)).toBeUndefined();
  });
});
