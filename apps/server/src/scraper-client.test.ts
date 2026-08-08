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
});
