import { afterEach, describe, expect, it, vi } from "vitest";
import {
  braveSearchConfigured,
  SearchProviderError,
  searchBrave,
} from "./brave-search.js";

const originalKey = process.env.BRAVE_SEARCH_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = originalKey;
});

describe("Brave search provider", () => {
  it("reports whether the server-side key is configured", () => {
    delete process.env.BRAVE_SEARCH_API_KEY;
    expect(braveSearchConfigured()).toBe(false);
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    expect(braveSearchConfigured()).toBe(true);
  });

  it("collects HTTP results without exposing the API key in the URL", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "private-test-key";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          web: {
            results: [
              { title: "Example", url: "https://example.com/#about" },
              { title: "Unsafe", url: "javascript:alert(1)" },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const found = await searchBrave("security companies", 1);

    expect(found.results).toEqual([
      { title: "Example", url: "https://example.com/", position: 1 },
    ]);
    expect(found.requests).toBe(1);
    expect(found.excluded).toBe(0);
    const [url, options] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.searchParams.get("q")).toBe("security companies");
    expect(url.toString()).not.toContain("private-test-key");
    expect(
      (options.headers as Record<string, string>)["X-Subscription-Token"],
    ).toBe("private-test-key");
  });

  it("filters platform results and continues to the next page", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            web: {
              results: [
                { title: "Reddit", url: "https://www.reddit.com/r/business" },
                { title: "Steam", url: "https://store.steampowered.com/app/1" },
              ],
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            web: {
              results: [
                { title: "Agency", url: "https://example-agency.fr" },
                { title: "Consulting", url: "https://example-consulting.com" },
              ],
            },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const found = await searchBrave("security companies", 2);

    expect(found.results.map((item) => item.url)).toEqual([
      "https://example-agency.fr/",
      "https://example-consulting.com/",
    ]);
    expect(found.excluded).toBe(2);
    expect(found.requests).toBe(2);
  });

  it("filters informational results while retaining first-party vendors", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            web: {
              results: [
                {
                  title:
                    "What are some useful Rust cheats and console commands?",
                  url: "https://ionos.com/digitalguide/rust-cheats",
                },
                {
                  title: "Rust Language Cheat Sheet",
                  url: "https://cheats.rs/",
                },
                {
                  title: "Rust Cheats - Undetected Rust Hacks | HERA.GG",
                  url: "https://hera.gg/",
                },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    );

    const found = await searchBrave("Rust cheats", 1);

    expect(found.results.map((item) => item.url)).toEqual(["https://hera.gg/"]);
    expect(found.excluded).toBe(2);
  });

  it("counts one website per domain toward the requested total", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            web: {
              results: [
                { title: "Agency home", url: "https://agency.example/" },
                {
                  title: "Agency contact",
                  url: "https://www.agency.example/contact",
                },
                { title: "Second business", url: "https://business.example/" },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    );

    const found = await searchBrave("security companies", 2);

    expect(found.results.map((item) => new URL(item.url).hostname)).toEqual([
      "agency.example",
      "business.example",
    ]);
    expect(found.requests).toBe(1);
  });

  it("treats common shop prefixes and URL paths as one website", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            web: {
              results: [
                {
                  title: "Seller product",
                  url: "https://shop.seller.com/rust/one",
                },
                { title: "Seller home", url: "https://seller.com/" },
                {
                  title: "Other seller",
                  url: "https://other-seller.com/store",
                },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    );

    const found = await searchBrave("Rust NFA accounts", 2);
    expect(found.results.map((item) => item.url)).toEqual([
      "https://shop.seller.com/rust/one",
      "https://other-seller.com/store",
    ]);
  });

  it("tries distinct query wordings before using deeper pages", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            query: { more_results_available: true },
            web: { results: [{ title: "One", url: "https://one.example/" }] },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            query: { more_results_available: false },
            web: { results: [{ title: "Two", url: "https://two.example/" }] },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const found = await searchBrave("Rust NFA accounts", 2);
    expect(found.results).toHaveLength(2);
    expect(found.requests).toBe(2);
    expect(
      new URL(fetchMock.mock.calls[1]![0] as URL).searchParams.get("offset"),
    ).toBe("0");
    expect(
      new URL(fetchMock.mock.calls[1]![0] as URL).searchParams.get("q"),
    ).not.toBe(
      new URL(fetchMock.mock.calls[0]![0] as URL).searchParams.get("q"),
    );
  });

  it("deepens productive primary wording before spending requests on regional expansion", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    const baseQuery = "specialist widget providers";
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(input.toString());
      const searchQuery = url.searchParams.get("q");
      const offset = Number(url.searchParams.get("offset"));
      const result =
        searchQuery === baseQuery && offset === 1
          ? { title: "Second provider", url: "https://second.example/" }
          : { title: "Repeated provider", url: "https://repeated.example/" };
      return new Response(
        JSON.stringify({
          query: { more_results_available: true },
          web: { results: [result] },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const found = await searchBrave(baseQuery, 2);

    expect(found.results.map((result) => result.url)).toEqual([
      "https://repeated.example/",
      "https://second.example/",
    ]);
    expect(found.requests).toBeLessThan(40);
    expect(
      fetchMock.mock.calls.some(([input]) => {
        const searchQuery = new URL(input.toString()).searchParams.get("q")!;
        return searchQuery.includes("Denmark") || searchQuery.includes("site:");
      }),
    ).toBe(false);
  });

  it("reuses a recent successful page without consuming another Brave request", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          web: {
            results: [
              { title: "Cached provider", url: "https://cached.example/" },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await searchBrave("cache efficiency provider", 1);
    const second = await searchBrave("cache efficiency provider", 1);

    expect(first.requests).toBe(1);
    expect(second.requests).toBe(0);
    expect(second.results).toEqual(first.results);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a custom target above the former 100-result limit", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    let requestNumber = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const start = requestNumber++ * 20;
        return new Response(
          JSON.stringify({
            web: {
              results: Array.from({ length: 20 }, (_, index) => ({
                title: `Business ${start + index}`,
                url: `https://business-${start + index}.example/`,
              })),
            },
          }),
          { status: 200 },
        );
      }),
    );
    const found = await searchBrave("security vendors", 125);
    expect(found.results).toHaveLength(125);
    expect(found.requests).toBe(7);
    expect(found.stopReason).toBe("TARGET_REACHED");
  });

  it("collects a full 500 unique-site target without the former 60-request bottleneck", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    let requestNumber = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const start = requestNumber++ * 20;
        return new Response(
          JSON.stringify({
            web: {
              results: Array.from({ length: 20 }, (_, index) => ({
                title: `Unique business ${start + index}`,
                url: `https://unique-business-${start + index}.example/`,
              })),
            },
          }),
          { status: 200 },
        );
      }),
    );

    const found = await searchBrave("European security vendors", 500);
    expect(found.results).toHaveLength(500);
    expect(found.requests).toBe(25);
    expect(found.stopReason).toBe("TARGET_REACHED");
  });

  it("continues through regional expansion and reports live progress until the target is reached", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    const progress = vi.fn();
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const searchQuery = new URL(input.toString()).searchParams.get("q") || "";
      return new Response(
        JSON.stringify({
          query: { more_results_available: false },
          web: {
            results: [
              searchQuery.includes("Denmark")
                ? {
                    title: "Regional provider",
                    url: "https://regional.example/",
                  }
                : {
                    title: "Repeated provider",
                    url: "https://repeated.example/",
                  },
            ],
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const found = await searchBrave("specialist security providers", 2, {
      onProgress: progress,
    });

    expect(found.results).toHaveLength(2);
    expect(found.stopReason).toBe("TARGET_REACHED");
    expect(
      fetchMock.mock.calls.some(([input]) =>
        (input as URL).searchParams.get("q")?.includes("Denmark"),
      ),
    ).toBe(true);
    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({
      requested: 2,
      discovered: 2,
      requests: expect.any(Number),
      queryPagesChecked: expect.any(Number),
    });
  });

  it("returns a useful error when the allowance is exhausted", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 429 })),
    );

    await expect(searchBrave("test", 20)).rejects.toMatchObject({
      statusCode: 429,
      expose: true,
      fatal: true,
    } satisfies Partial<SearchProviderError>);
  });

  it("preserves successful pages when a neighboring request fails", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    let successPage = 0;
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(input.toString());
      if (url.searchParams.get("q") === "security")
        return new Response("", { status: 503 });
      const start = successPage++ * 20;
      return new Response(
        JSON.stringify({
          web: {
            results: Array.from({ length: 20 }, (_, index) => ({
              title: `Business ${start + index}`,
              url: `https://resilient-${start + index}.example/`,
            })),
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const found = await searchBrave("security companies", 40);

    expect(found.results).toHaveLength(40);
    expect(found.failedRequests).toBe(1);
    expect(found.requests).toBe(4);
    expect(found.stopReason).toBe("TARGET_REACHED");
  });

  it("retries and exposes a safe error when Brave remains unavailable", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchBrave("security companies", 20)).rejects.toMatchObject({
      message: "Brave Search returned an error (503). Please try again.",
      statusCode: 502,
      expose: true,
      fatal: false,
    } satisfies Partial<SearchProviderError>);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
