import { afterEach, describe, expect, it, vi } from "vitest";

function result(discordLinks: string[], fetchMode: "HTTP" | "Dynamic") {
  return {
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    redirectUrl: null,
    httpStatus: 200,
    title: "Fixture",
    metaDescription: "",
    canonicalUrl: null,
    faviconUrl: null,
    contentType: "text/html",
    fetchMode,
    discordLinks,
    discordDetections: discordLinks.map((url) => ({
      url,
      method: fetchMode === "Dynamic" ? "rendered-dom" : "anchor",
      section: "MAIN",
      interaction: "NONE",
    })),
    emails: [],
    socialLinks: [],
    internalLinks: [],
    priorityLinks: [],
    scriptLinks: [],
    rustPriceListings: [],
    durationMs: 10,
    looksDynamic: true,
    isSoft404: false,
    staticFetchResult: "SUCCESS",
    dynamicFetchResult: fetchMode === "Dynamic" ? "SUCCESS" : "NOT_ATTEMPTED",
    dynamicError: "",
    retryAfterSeconds: null,
  };
}

function response(payload: unknown) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ result: payload }),
  });
}

function errorResponse(
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
) {
  return Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve({ error, ...extra }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Scrapling dynamic fast path", () => {
  it("rejects absent, placeholder, and short scraper tokens in production", async () => {
    const { configuredScraperToken } = await import("./scraper-client.js");
    expect(() => configuredScraperToken({ NODE_ENV: "production" })).toThrow(
      /SCRAPER_TOKEN/,
    );
    expect(() =>
      configuredScraperToken({
        NODE_ENV: "production",
        SCRAPER_TOKEN: "aether-dev-local-worker",
      }),
    ).toThrow(/SCRAPER_TOKEN/);
    expect(
      configuredScraperToken({
        NODE_ENV: "production",
        SCRAPER_TOKEN: "production-scraper-secret-123456789",
      }),
    ).toBe("production-scraper-secret-123456789");
  });

  it("does not launch Chromium when static extraction already found Discord", async () => {
    const fetchMock = vi.fn(() =>
      response(result(["https://discord.gg/static-fast-path"], "HTTP")),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { scrapePage } = await import("./scraper-client.js");

    const page = await scrapePage("https://example.com/", {
      timeoutMs: 1_000,
      dynamicFallback: true,
      forceDynamic: true,
    });

    expect(page.discordLinks).toEqual(["https://discord.gg/static-fast-path"]);
    expect(page.fetchMode).toBe("HTTP");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still launches Chromium for a forced deep scan when static extraction misses", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => response(result([], "HTTP")))
      .mockImplementationOnce(() =>
        response(result(["https://discord.gg/dynamic-fallback"], "Dynamic")),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { scrapePage } = await import("./scraper-client.js");

    const page = await scrapePage("https://example.com/", {
      timeoutMs: 1_000,
      dynamicFallback: true,
      forceDynamic: true,
    });

    expect(page.discordLinks).toEqual(["https://discord.gg/dynamic-fallback"]);
    expect(page.fetchMode).toBe("Dynamic");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the browser for a recoverable nonstandard challenge response", async () => {
    const challenged = {
      ...result([], "HTTP"),
      httpStatus: 441,
      looksDynamic: false,
    };
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => response(challenged))
      .mockImplementationOnce(() =>
        response(result(["https://discord.gg/challenge-recovered"], "Dynamic")),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { scrapePage } = await import("./scraper-client.js");

    const page = await scrapePage("https://example.com/", {
      timeoutMs: 1_000,
      dynamicFallback: true,
    });

    expect(page.discordLinks).toEqual([
      "https://discord.gg/challenge-recovered",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("passes Rust price mode to both static and rendered worker requests", async () => {
    const staticResult = { ...result([], "HTTP"), looksDynamic: true };
    const dynamicResult = {
      ...result([], "Dynamic"),
      rustPriceListings: [
        {
          name: "Premium",
          priceMinor: 160,
          currency: "USD",
          priceText: "$1.60",
          link: "https://example.com/rust-nfa",
          method: "VARIANT_CONTROL",
        },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => response(staticResult))
      .mockImplementationOnce(() => response(dynamicResult));
    vi.stubGlobal("fetch", fetchMock);
    const { scrapePage } = await import("./scraper-client.js");

    const page = await scrapePage("https://example.com/rust-nfa", {
      timeoutMs: 1_000,
      dynamicFallback: true,
      discoveryMode: "rust-price",
    });

    expect(page.rustPriceListings).toHaveLength(1);
    const bodies = fetchMock.mock.calls.map((call) =>
      JSON.parse(String((call[1] as RequestInit).body)),
    );
    expect(bodies).toEqual([
      expect.objectContaining({
        discoveryMode: "rust-price",
        forceDynamic: false,
      }),
      expect.objectContaining({
        discoveryMode: "rust-price",
        forceDynamic: true,
      }),
    ]);
  });

  it("turns worker overload and gateway timeouts into retryable diagnostics", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        errorResponse(503, "Scrapling worker busy; global capacity is full", {
          retryAfterSeconds: 7,
        }),
      )
      .mockImplementationOnce(() =>
        errorResponse(504, "Timeout while rendering page"),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { scrapePage } = await import("./scraper-client.js");

    await expect(
      scrapePage("https://example.com/", {
        timeoutMs: 1_000,
        dynamicFallback: false,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/worker busy.*503/i),
      status: 503,
      retryAfterSeconds: 7,
    });
    await expect(
      scrapePage("https://example.com/", {
        timeoutMs: 1_000,
        dynamicFallback: false,
      }),
    ).rejects.toThrow(/worker timeout.*504/i);
  });

  it("preserves a structured remote network cause from the worker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        errorResponse(502, "Could not resolve target", {
          code: "DNS_FAILURE",
        }),
      ),
    );
    const { scrapePage } = await import("./scraper-client.js");

    await expect(
      scrapePage("https://example.com/", {
        timeoutMs: 1_000,
        dynamicFallback: false,
      }),
    ).rejects.toThrow(/DNS_FAILURE/);
  });
});
