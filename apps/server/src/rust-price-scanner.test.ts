import { describe, expect, it } from "vitest";
import {
  rustListingFingerprint,
  listingCategory,
  summarizeCategoryMarkets,
  summarizeConvertedMarket,
  summarizeNfaProviders,
  summarizeRustMarket,
} from "./rust-price-scanner.js";

describe("Rust NFA listing identity", () => {
  it("keeps variants sharing a link distinct", () => {
    const link = "https://market.example/rust-nfa";
    expect(rustListingFingerprint({ link, name: "Premium" })).not.toBe(
      rustListingFingerprint({ link, name: "0-250 Hours" }),
    );
  });

  it("deduplicates the same canonical link and normalized name", () => {
    expect(
      rustListingFingerprint({
        link: "https://market.example/rust-nfa/",
        name: "  PREMIUM  ",
      }),
    ).toBe(
      rustListingFingerprint({
        link: "https://market.example/rust-nfa",
        name: "premium",
      }),
    );
  });

  it("ignores common tracking parameters in listing identity", () => {
    expect(
      rustListingFingerprint({
        link: "https://market.example/item?utm_source=search&id=7#price",
        name: "Premium",
      }),
    ).toBe(
      rustListingFingerprint({
        link: "https://market.example/item?id=7",
        name: "premium",
      }),
    );
  });

  it("calculates one converted market in the selected currency", () => {
    expect(summarizeConvertedMarket([100, 200, 500, 900], "DKK")).toEqual({
      currency: "DKK",
      listings: 4,
      lowestMinor: 100,
      medianMinor: 350,
      averageMinor: 425,
      highestMinor: 900,
    });
  });
});

describe("Rust NFA providers", () => {
  it("groups equivalent provider domains and counts active listing stock", () => {
    const older = new Date("2026-08-01T10:00:00.000Z");
    const newer = new Date("2026-08-02T10:00:00.000Z");
    const result = summarizeNfaProviders(
      [
        {
          id: "one-a",
          domain: "www.store.example.com",
          title: "Old title",
          url: "https://www.store.example.com/rust",
          finalUrl: "",
          scanStatus: "Completed",
          scannedAt: older,
          updatedAt: older,
        },
        {
          id: "one-b",
          domain: "store.example.com",
          title: "Example Store",
          url: "https://store.example.com/accounts",
          finalUrl: "https://store.example.com/rust/accounts",
          scanStatus: "CompletedWithFallback",
          scannedAt: newer,
          updatedAt: newer,
        },
        {
          id: "empty",
          domain: "empty.example.net",
          title: "Empty provider",
          url: "https://empty.example.net/",
          finalUrl: "",
          scanStatus: "Blocked",
          scannedAt: null,
          updatedAt: older,
        },
      ],
      [
        { sourceId: "one-a", convertedPriceAmount: 100 },
        { sourceId: "one-b", convertedPriceAmount: 300 },
        { sourceId: "one-b" },
      ],
      "USD",
    );

    expect(result).toEqual([
      {
        domain: "example.com",
        title: "Example Store",
        url: "https://store.example.com/",
        scanStatus: "CompletedWithFallback",
        stock: 3,
        sourceCount: 2,
        currency: "USD",
        convertedListings: 2,
        lowestPriceMinor: 100,
        averagePriceMinor: 200,
        highestPriceMinor: 300,
        lastScannedAt: newer.toISOString(),
      },
      {
        domain: "empty.example.net",
        title: "Empty provider",
        url: "https://empty.example.net/",
        scanStatus: "Blocked",
        stock: 0,
        sourceCount: 1,
        currency: "USD",
        convertedListings: 0,
        lowestPriceMinor: undefined,
        averagePriceMinor: undefined,
        highestPriceMinor: undefined,
        lastScannedAt: older.toISOString(),
      },
    ]);
  });
});

describe("Rust NFA market statistics", () => {
  it("keeps currencies separate and calculates full-market price statistics", () => {
    const result = summarizeRustMarket([
      {
        priceAmount: 100,
        currency: "usd",
        link: "https://one.example/a",
        sourceId: "one",
      },
      {
        priceAmount: 200,
        currency: "USD",
        link: "https://one.example/b",
        sourceId: "one",
      },
      {
        priceAmount: 500,
        currency: "USD",
        link: "https://two.example/c",
        sourceId: "two",
      },
      {
        priceAmount: 900,
        currency: "EUR",
        link: "https://three.example/d",
        sourceId: "three",
      },
    ]);

    expect(result).toMatchObject({
      totalListings: 4,
      publicLinks: 4,
      sourcesRepresented: 3,
    });
    expect(result.currencies).toEqual([
      {
        currency: "USD",
        listings: 3,
        lowestMinor: 100,
        medianMinor: 200,
        averageMinor: 267,
        highestMinor: 500,
      },
      {
        currency: "EUR",
        listings: 1,
        lowestMinor: 900,
        medianMinor: 900,
        averageMinor: 900,
        highestMinor: 900,
      },
    ]);
  });

  it("shows category statistics only when at least three listings match", () => {
    const result = summarizeCategoryMarkets(
      [
        { name: "Premium account A", convertedPriceAmount: 100 },
        { name: "Premium account B", convertedPriceAmount: 200 },
        { name: "Premium account C", convertedPriceAmount: 600 },
        { name: "Inventory account A", convertedPriceAmount: 300 },
        { name: "Inventory account B", convertedPriceAmount: 400 },
      ],
      "USD",
    );
    expect(result).toEqual([
      {
        category: "Premium",
        currency: "USD",
        listings: 3,
        lowestMinor: 100,
        medianMinor: 200,
        averageMinor: 300,
        highestMinor: 600,
      },
    ]);
  });

  it("derives useful categories from account and item listing names", () => {
    expect(listingCategory("Rust NFA 500-1000 Hours")).toBe("500-1000 Hours");
    expect(listingCategory("Level 20-40 game account")).toBe("Level 20-40");
    expect(listingCategory("Premium inventory")).toBe("Premium");
  });
});
