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
  });

  it("returns a useful error when the allowance is exhausted", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 429 })),
    );

    await expect(searchBrave("test", 20)).rejects.toMatchObject({
      statusCode: 429,
    } satisfies Partial<SearchProviderError>);
  });
});
