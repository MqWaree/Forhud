import { describe, expect, it } from "vitest";
import {
  LztApiClient,
  LztApiError,
  LztPublicClient,
  lztSearchUrl,
  normalizeLztCurrency,
  normalizeLztItemState,
  retryAfterDate,
} from "./lzt-client.js";
const item = {
  item_id: 101,
  title: "Rust account",
  price: 5.24,
  published_date: 1_786_200_000,
};
describe("LZT API client", () => {
  it("builds the documented safe newest-first Rust query", () => {
    const url = lztSearchUrl("https://prod-api.lzt.market", 3);
    expect(url.pathname).toBe("/steam");
    expect(url.searchParams.get("game[]")).toBe("252490");
    expect(url.searchParams.get("order_by")).toBe("pdate_to_down");
    expect(url.searchParams.get("currency")).toBe("eur");
    expect(url.searchParams.getAll("not_origin[]")).toEqual([
      "brute",
      "phishing",
      "stealer",
    ]);
  });
  it("builds the bounded high-hours live-alert test query", () => {
    const url = lztSearchUrl("https://prod-api.lzt.market", 1, {
      minimumRustHours: 2_000,
      maximumPriceUsd: 15,
      orderBy: "price_to_up",
    });
    expect(url.searchParams.get("game[]")).toBe("252490");
    expect(url.searchParams.get("hours_played[252490]")).toBe("2000");
    expect(url.searchParams.get("pmax")).toBe("15");
    expect(url.searchParams.get("currency")).toBe("usd");
    expect(url.searchParams.get("order_by")).toBe("price_to_up");
  });
  it("sends bearer auth, validates pages, and reads rate headers", async () => {
    const request = async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toContain("game%5B%5D=252490");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer test-token",
      );
      return new Response(
        JSON.stringify({
          items: [item],
          stickyItems: [],
          hasNextPage: false,
          page: 1,
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-limit": "20",
            "x-ratelimit-remaining": "19",
          },
        },
      );
    };
    const result = await new LztApiClient(
      "test-token",
      undefined,
      request as typeof fetch,
    ).search();
    expect(result.page.items[0]?.item_id).toBe(101);
    expect(result.rateLimit.remaining).toBe(19);
  });
  it("does not report missing rate headers as zero remaining", async () => {
    const request = async () =>
      new Response(
        JSON.stringify({
          items: [item],
          stickyItems: [],
          hasNextPage: false,
          page: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const result = await new LztApiClient(
      "test-token",
      undefined,
      request as typeof fetch,
    ).search();
    expect(result.rateLimit).toEqual({
      limit: undefined,
      remaining: undefined,
      resetAt: undefined,
    });
  });
  it("accepts supported response currencies even when LZT does not echo the requested EUR unit", async () => {
    const request = async () =>
      new Response(
        JSON.stringify({
          items: [{ ...item, price_currency: "RUB" }],
          stickyItems: [],
          hasNextPage: false,
          page: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const result = await new LztApiClient(
      "test-token",
      undefined,
      request as typeof fetch,
    ).search();
    expect(result.page.items[0]?.price_currency).toBe("RUB");
    expect(normalizeLztCurrency("rur")).toBe("RUB");
    expect(normalizeLztCurrency("gbp")).toBe("GBP");
  });
  it("preserves an unknown item currency so the tracker can skip only that malformed item", async () => {
    const request = async () =>
      new Response(
        JSON.stringify({
          items: [{ ...item, price_currency: "BTC" }],
          stickyItems: [],
          hasNextPage: false,
          page: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const result = await new LztApiClient(
      "test-token",
      undefined,
      request as typeof fetch,
    ).search();
    expect(result.page.items[0]?.price_currency).toBe("BTC");
    expect(() => normalizeLztCurrency("BTC")).toThrowError(LztApiError);
  });
  it.each([
    [401, "AUTH_ERROR"],
    [403, "FORBIDDEN"],
    [500, "SERVER_ERROR"],
  ] as const)("classifies HTTP %s", async (status, code) => {
    const request = async () => new Response("{}", { status });
    await expect(
      new LztApiClient("token", undefined, request as typeof fetch).search(),
    ).rejects.toMatchObject({ code });
  });
  it("pauses 429 responses until reset", async () => {
    const request = async () =>
      new Response("{}", {
        status: 429,
        headers: { "x-ratelimit-reset": "1786200060" },
      });
    try {
      await new LztApiClient(
        "token",
        undefined,
        request as typeof fetch,
      ).search();
    } catch (error) {
      expect(error).toBeInstanceOf(LztApiError);
      expect((error as LztApiError).code).toBe("RATE_LIMITED");
      expect((error as LztApiError).retryAt).toBeInstanceOf(Date);
    }
  });
  it("supports both Retry-After seconds and HTTP dates", () => {
    const now = Date.parse("2026-08-14T10:00:00Z");
    expect(retryAfterDate("15", now)?.toISOString()).toBe(
      "2026-08-14T10:00:15.000Z",
    );
    expect(
      retryAfterDate("Fri, 14 Aug 2026 10:01:00 GMT", now)?.toISOString(),
    ).toBe("2026-08-14T10:01:00.000Z");
    expect(retryAfterDate("invalid", now)).toBeUndefined();
  });
  it("rejects malformed successful responses", async () => {
    const request = async () =>
      new Response(JSON.stringify({ items: "wrong" }), { status: 200 });
    await expect(
      new LztApiClient("token", undefined, request as typeof fetch).search(),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
describe("LZT public client", () => {
  it("requires no marketplace token", () =>
    expect(new LztPublicClient().configured()).toBe(true));
  it("reports public-page source mode", () =>
    expect(new LztPublicClient().sourceMode()).toBe("PUBLIC_PAGE"));
  it("maps public listing cards without marketplace credentials", async () => {
    const scrape = async () => ({
      requestedUrl: "https://lzt.market/steam",
      finalUrl: "https://lzt.market/steam",
      redirectUrl: null,
      httpStatus: 200,
      title: "Steam accounts",
      metaDescription: "",
      canonicalUrl: null,
      faviconUrl: null,
      contentType: "text/html",
      fetchMode: "HTTP" as const,
      discordLinks: [],
      discordDetections: [],
      emails: [],
      socialLinks: [],
      internalLinks: [],
      priorityLinks: [],
      scriptLinks: [],
      durationMs: 20,
      looksDynamic: false,
      isSoft404: false,
      staticFetchResult: "SUCCESS" as const,
      dynamicFetchResult: "NOT_ATTEMPTED" as const,
      dynamicError: "",
      retryAfterSeconds: null,
      rustPriceListings: [
        {
          name: "Rust NFA 1,000 hours",
          priceMinor: 725,
          currency: "EUR",
          priceText: "€7.25",
          link: "https://lzt.market/123456/",
          method: "PRODUCT_CARD" as const,
        },
      ],
    });
    const result = await new LztPublicClient(scrape).search(1);
    expect(result.page.items[0]).toMatchObject({
      item_id: "123456",
      price: 7.25,
      public_url: "https://lzt.market/123456/",
    });
  });
  it("reports human verification instead of bypassing it", async () => {
    const scrape = async () =>
      ({
        title: "Security check - verify human",
        metaDescription: "",
        dynamicError: "",
        httpStatus: 200,
        rustPriceListings: [],
      }) as never;
    await expect(new LztPublicClient(scrape).search()).rejects.toMatchObject({
      code: "ACCESS_CHALLENGE",
    });
  });
});
describe("LZT item lifecycle lookup", () => {
  it("reads a confirmed sold state and official inventory values", async () => {
    const request = async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/101");
      expect(url.searchParams.get("currency")).toBe("eur");
      return new Response(
        JSON.stringify({
          item: {
            ...item,
            item_state: "sold",
            steam_cs2_inv_value: 12.34,
            steam_rust_inv_value: 4.56,
            steam_inv_value: 16.9,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const result = await new LztApiClient(
      "test-token",
      undefined,
      request as typeof fetch,
    ).getItem("101");
    expect(result.status).toBe("SOLD");
    expect(result.item).toMatchObject({
      steam_cs2_inv_value: 12.34,
      steam_rust_inv_value: 4.56,
      steam_inv_value: 16.9,
    });
  });

  it("keeps removed listings distinct from sold listings", async () => {
    const request = async () => new Response("{}", { status: 404 });
    await expect(
      new LztApiClient(
        "test-token",
        undefined,
        request as typeof fetch,
      ).getItem("missing"),
    ).resolves.toMatchObject({ status: "REMOVED" });
  });

  it("normalizes documented lifecycle variants", () => {
    expect(normalizeLztItemState("paid")).toBe("SOLD");
    expect(normalizeLztItemState("deleted")).toBe("REMOVED");
    expect(normalizeLztItemState("open")).toBe("ACTIVE");
  });
});
