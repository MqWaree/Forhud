import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchPage = vi.fn();
const robotsDecision = vi.fn();
const classifyFetchError = (message: string) =>
  /timeout|timed out/i.test(message)
    ? "TIMEOUT"
    : /worker busy/i.test(message)
      ? "SCRAPER_BUSY"
      : /cross-domain|redirect blocked/i.test(message)
        ? "REDIRECT_BLOCKED"
        : "INVALID_RESPONSE";
vi.mock("./crawler.js", () => ({
  fetchPage,
  robotsDecision,
  classifyFetchError,
}));

function page(url: string, overrides: Record<string, unknown> = {}) {
  return {
    requestedUrl: url,
    finalUrl: url,
    redirectUrl: null,
    httpStatus: 200,
    title: "Fixture",
    metaDescription: "",
    canonicalUrl: null,
    faviconUrl: null,
    contentType: "text/html",
    fetchMode: "HTTP",
    discordLinks: [],
    discordDetections: [],
    emails: [],
    socialLinks: [],
    internalLinks: [],
    durationMs: 1,
    looksDynamic: false,
    isSoft404: false,
    ...overrides,
  };
}

beforeEach(() => {
  fetchPage.mockReset();
  robotsDecision.mockReset();
  robotsDecision.mockResolvedValue({
    allowed: true,
    reason: "ALLOWED",
    httpStatus: 200,
    fromCache: false,
  });
  fetchPage.mockImplementation((url: string) => Promise.resolve(page(url)));
});

describe("layered Discord discovery", () => {
  it("reuses the scanner entry page and follows its declared contact link first", async () => {
    const initialPage = page("https://example.com/", {
      priorityLinks: ["https://example.com/community"],
      internalLinks: ["https://example.com/community"],
    });
    fetchPage.mockImplementation((url: string) =>
      Promise.resolve(
        new URL(url).pathname === "/community"
          ? page(url, {
              discordLinks: ["https://discord.gg/seeded"],
              discordDetections: [
                { url: "https://discord.gg/seeded", method: "anchor" },
              ],
            })
          : page(url, { httpStatus: 404 }),
      ),
    );
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/", {
      timeoutMs: 1_000,
      maxPages: 6,
      initialPage: initialPage as never,
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage.mock.calls[0]?.[0]).toBe("https://example.com/community");
    expect(result.discordFound).toBe(true);
  });

  it("retains dynamic recovery when the reused entry page is a JS shell", async () => {
    const initialPage = page("https://example.com/", { looksDynamic: true });
    fetchPage.mockImplementation(
      (url: string, options: { forceDynamic?: boolean }) =>
        Promise.resolve(
          page(url, {
            fetchMode: options.forceDynamic ? "Dynamic" : "HTTP",
            dynamicFetchResult: options.forceDynamic
              ? "SUCCESS"
              : "NOT_ATTEMPTED",
            discordLinks: options.forceDynamic
              ? ["https://discord.gg/rendered-seed"]
              : [],
            discordDetections: options.forceDynamic
              ? [
                  {
                    url: "https://discord.gg/rendered-seed",
                    method: "rendered-dom",
                  },
                ]
              : [],
          }),
        ),
    );
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/", {
      timeoutMs: 1_000,
      maxPages: 2,
      dynamicFallback: true,
      initialPage: initialPage as never,
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage.mock.calls[0]?.[1].forceDynamic).toBe(true);
    expect(result.discordFound).toBe(true);
  });

  it("records the exact extraction method on the requested page", async () => {
    fetchPage.mockImplementation((url: string) =>
      Promise.resolve(
        page(url, {
          discordLinks: ["https://discord.gg/exact"],
          discordDetections: [
            { url: "https://discord.gg/exact", method: "anchor" },
          ],
        }),
      ),
    );
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/store", {
      timeoutMs: 1_000,
    });
    expect(result.discordFound).toBe(true);
    expect(result.detections[0]).toMatchObject({
      discoveryMethod: "ANCHOR_HREF",
      validationStatus: "UNVALIDATED",
    });
    expect(result.fallbackUsed).toBe(false);
  });

  it("recovers an outdated 404 URL through the domain root", async () => {
    fetchPage.mockImplementation((url: string) => {
      const path = new URL(url).pathname;
      return Promise.resolve(
        path === "/old-product"
          ? page(url, { httpStatus: 404, title: "Not found" })
          : path === "/sitemap.xml"
            ? page(url, { httpStatus: 404, title: "Not found" })
            : page(url, {
                discordLinks: ["https://discord.gg/root"],
                discordDetections: [
                  { url: "https://discord.gg/root", method: "anchor" },
                ],
              }),
      );
    });
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/old-product", {
      timeoutMs: 1_000,
    });
    expect(result.originalHttpStatus).toBe(404);
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackUrl).toBe("https://example.com/");
    expect(result.detections[0]!.discoveryMethod).toBe("ANCHOR_HREF");
  });

  it("continues with an allowed root when the exact URL is disallowed", async () => {
    robotsDecision.mockImplementation((url: string) =>
      Promise.resolve({
        allowed: new URL(url).pathname === "/",
        reason: new URL(url).pathname === "/" ? "ALLOWED" : "DISALLOWED",
        httpStatus: 200,
        fromCache: false,
      }),
    );
    fetchPage.mockImplementation((url: string) =>
      Promise.resolve(
        page(url, {
          discordLinks: ["https://discord.gg/allowed"],
          discordDetections: [
            { url: "https://discord.gg/allowed", method: "visible-text" },
          ],
        }),
      ),
    );
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/private/store", {
      timeoutMs: 1_000,
      maxPages: 20,
    });
    expect(result.discordFound).toBe(true);
    expect(result.robotsStatus).toBe("RESTRICTED_WITH_FALLBACK");
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("follows only one supported external aggregator hop", async () => {
    fetchPage.mockImplementation((url: string) => {
      const host = new URL(url).hostname;
      if (host === "linktr.ee")
        return Promise.resolve(
          page(url, {
            discordLinks: ["https://discord.gg/aggregated"],
            discordDetections: [
              { url: "https://discord.gg/aggregated", method: "anchor" },
            ],
          }),
        );
      return Promise.resolve(
        page(url, {
          socialLinks:
            new URL(url).pathname === "/"
              ? [
                  {
                    type: "linktree",
                    url: "https://linktr.ee/example-store",
                    sourcePage: url,
                  },
                ]
              : [],
        }),
      );
    });
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/", {
      timeoutMs: 1_000,
      maxPages: 20,
    });
    expect(result.discordFound).toBe(true);
    expect(result.detections[0]!.discoveryMethod).toBe("SOCIAL_AGGREGATOR");
    expect(
      result.pages.filter(
        (candidate) => candidate.kind === "social-aggregator",
      ),
    ).toHaveLength(1);
  });

  it("returns Telegram and email contacts found on recovery pages", async () => {
    fetchPage.mockImplementation((url: string) => {
      const path = new URL(url).pathname;
      return Promise.resolve(
        path === "/contact"
          ? page(url, {
              emails: ["support@example.com"],
              socialLinks: [
                {
                  type: "telegram",
                  url: "https://t.me/example_support",
                  sourcePage: url,
                },
              ],
            })
          : page(url),
      );
    });
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/", {
      timeoutMs: 1_000,
      maxPages: 4,
    });

    expect(result.discordFound).toBe(false);
    expect(result.contactFound).toBe(true);
    expect(result.emails).toEqual(["support@example.com"]);
    expect(result.socialLinks).toContainEqual(
      expect.objectContaining({ url: "https://t.me/example_support" }),
    );
    expect(result.failureReason).toBeUndefined();
  });

  it("labels a soft 404 independently and completes normally at the scan cap", async () => {
    fetchPage.mockImplementation((url: string) =>
      Promise.resolve(page(url, { isSoft404: true })),
    );
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/gone", {
      timeoutMs: 1_000,
      maxPages: 2,
    });
    expect(result.pages[0]!.error).toBe("SOFT_404");
    expect(result.failureReason).toBe("DISCORD_NOT_FOUND");
  });

  it("preserves a blocked explicit Discord route reached from the homepage", async () => {
    fetchPage.mockImplementation((url: string) =>
      Promise.resolve(
        url === "https://example.com/"
          ? page(url, {
              finalUrl: "https://example.com/discord",
              httpStatus: 403,
              fetchMode: "Dynamic",
            })
          : page(url, { httpStatus: 404 }),
      ),
    );
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/", {
      timeoutMs: 1_000,
      maxPages: 2,
    });
    expect(result.discordFound).toBe(false);
    expect(result.failureReason).toBe("HTTP_403");
  });

  it("does not let failed common-path guesses consume the useful-page budget", async () => {
    fetchPage.mockImplementation((url: string) => {
      const path = new URL(url).pathname;
      if (path === "/community")
        return Promise.resolve(
          page(url, {
            discordLinks: ["https://discord.gg/recovered-after-404"],
            discordDetections: [
              {
                url: "https://discord.gg/recovered-after-404",
                method: "anchor",
              },
            ],
          }),
        );
      return Promise.resolve(
        path === "/discord"
          ? page(url, { httpStatus: 404, title: "Not found" })
          : page(url),
      );
    });
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/", {
      timeoutMs: 1_000,
      maxPages: 2,
      deepScan: true,
    });
    expect(result.discordFound).toBe(true);
    expect(result.pages.some((candidate) => candidate.httpStatus === 404)).toBe(
      true,
    );
  });

  it("inspects bounded first-party script assets for embedded invite strings", async () => {
    fetchPage.mockImplementation((url: string) =>
      Promise.resolve(
        new URL(url).pathname === "/assets/app.js"
          ? page(url, {
              contentType: "application/javascript",
              discordLinks: ["https://discord.gg/in-bundle"],
              discordDetections: [
                {
                  url: "https://discord.gg/in-bundle",
                  method: "html-source",
                },
              ],
            })
          : page(url, { scriptLinks: ["https://example.com/assets/app.js"] }),
      ),
    );
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/", {
      timeoutMs: 1_000,
      maxPages: 2,
      deepScan: true,
    });
    expect(result.discordFound).toBe(true);
    expect(result.detections[0]?.discoveryMethod).toBe("SCRIPT_ASSET");
  });

  it("keeps valid Discord evidence from a branded 503 response", async () => {
    fetchPage.mockImplementation((url: string) =>
      Promise.resolve(
        page(url, {
          httpStatus: 503,
          discordLinks: ["https://discord.gg/error-document"],
          discordDetections: [
            {
              url: "https://discord.gg/error-document",
              method: "anchor",
            },
          ],
        }),
      ),
    );
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/", {
      timeoutMs: 1_000,
    });
    expect(result.discordFound).toBe(true);
    expect(result.pages[0]?.error).toBe("HTTP_5XX");
  });

  it("retries high-value recovery pages instead of treating them as one-shot guesses", async () => {
    const initialPage = page("https://example.com/", {
      priorityLinks: ["https://example.com/discord"],
      internalLinks: ["https://example.com/discord"],
    });
    fetchPage.mockResolvedValue(
      page("https://example.com/discord", {
        discordLinks: ["https://discord.gg/retried-route"],
        discordDetections: [
          { url: "https://discord.gg/retried-route", method: "anchor" },
        ],
      }),
    );
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/", {
      timeoutMs: 8_000,
      maxPages: 3,
      retries: 2,
      initialPage: initialPage as never,
    });

    expect(result.discordFound).toBe(true);
    expect(fetchPage.mock.calls[0]?.[1].retries).toBe(2);
    expect(fetchPage.mock.calls[0]?.[1].timeoutMs).toBe(8_000);
  });

  it("renders a declared Discord route after a transient static 503", async () => {
    const initialPage = page("https://example.com/", {
      priorityLinks: ["https://example.com/discord"],
      internalLinks: ["https://example.com/discord"],
    });
    fetchPage.mockImplementation(
      (url: string, options: { forceDynamic?: boolean }) =>
        Promise.resolve(
          options.forceDynamic
            ? page(url, {
                fetchMode: "Dynamic",
                dynamicFetchResult: "SUCCESS",
                discordLinks: ["https://discord.gg/rendered-after-503"],
                discordDetections: [
                  {
                    url: "https://discord.gg/rendered-after-503",
                    method: "rendered-dom",
                  },
                ],
              })
            : page(url, { httpStatus: 503 }),
        ),
    );
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/", {
      timeoutMs: 12_000,
      maxPages: 3,
      maxDynamicPages: 1,
      dynamicFallback: true,
      initialPage: initialPage as never,
    });

    expect(result.discordFound).toBe(true);
    expect(
      fetchPage.mock.calls.some(
        (call) =>
          call[0] === "https://example.com/discord" && call[1].forceDynamic,
      ),
    ).toBe(true);
  });

  it("continues to recovery routes after the homepage worker times out", async () => {
    fetchPage.mockImplementation((url: string) => {
      const path = new URL(url).pathname;
      if (path === "/")
        return Promise.reject(new Error("Scrapling worker timeout"));
      if (path === "/discord")
        return Promise.resolve(
          page(url, {
            discordLinks: ["https://discord.gg/timeout-recovery"],
            discordDetections: [
              { url: "https://discord.gg/timeout-recovery", method: "anchor" },
            ],
          }),
        );
      return Promise.resolve(page(url, { httpStatus: 404 }));
    });
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/", {
      timeoutMs: 1_000,
      maxPages: 6,
    });

    expect(result.discordFound).toBe(true);
    expect(result.pages[0]).toMatchObject({
      status: "Timeout",
      error: "TIMEOUT",
    });
  });

  it("does not amplify a saturated worker into fallback request bursts", async () => {
    fetchPage.mockRejectedValue(
      new Error("Scrapling worker busy (HTTP 503): capacity is full"),
    );
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/", {
      timeoutMs: 1_000,
      maxPages: 20,
      deepScan: true,
    });

    expect(result.discordFound).toBe(false);
    expect(result.failureReason).toBe("SCRAPER_BUSY");
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("keeps a persistent original 503 classified as HTTP 5XX", async () => {
    fetchPage.mockImplementation((url: string) =>
      Promise.resolve(page(url, { httpStatus: 503 })),
    );
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/", {
      timeoutMs: 1_000,
      maxPages: 2,
      dynamicFallback: false,
    });

    expect(result.discordFound).toBe(false);
    expect(result.failureReason).toBe("HTTP_5XX");
  });

  it("keeps browser rendering in a separate bounded tier", async () => {
    fetchPage.mockImplementation(
      (url: string, options: { forceDynamic?: boolean }) =>
        Promise.resolve(
          page(url, {
            fetchMode: options.forceDynamic ? "Dynamic" : "HTTP",
            dynamicFetchResult: options.forceDynamic
              ? "SUCCESS"
              : "NOT_ATTEMPTED",
            internalLinks: [
              "https://example.com/about",
              "https://example.com/contact",
              "https://example.com/community",
            ],
          }),
        ),
    );
    const { discoverDiscord } = await import("./discord-discovery.js");
    await discoverDiscord("https://example.com/", {
      timeoutMs: 1_000,
      maxPages: 3,
      maxDynamicPages: 1,
      dynamicFallback: true,
      deepScan: true,
    });
    expect(
      fetchPage.mock.calls.filter((call) => call[1].dynamicFallback),
    ).toHaveLength(1);
  });

  it("keeps guessed common routes on the fast static tier", async () => {
    const initialPage = page("https://example.com/");
    const { discoverDiscord } = await import("./discord-discovery.js");
    await discoverDiscord("https://example.com/", {
      timeoutMs: 10_000,
      maxPages: 4,
      maxDynamicPages: 1,
      dynamicFallback: true,
      initialPage: initialPage as never,
    });

    expect(fetchPage).toHaveBeenCalled();
    expect(
      fetchPage.mock.calls.every(
        (call) =>
          call[1].dynamicFallback === false &&
          call[1].forceDynamic === false &&
          call[1].retries === 0 &&
          call[1].timeoutMs <= 5_000,
      ),
    ).toBe(true);
  });

  it("does not turn a healthy website into a timeout when a guessed path is slow", async () => {
    fetchPage.mockImplementation((url: string) => {
      const path = new URL(url).pathname;
      if (path === "/") return Promise.resolve(page(url));
      if (path === "/discord")
        return Promise.reject(new Error("Scrapling worker timeout"));
      return Promise.resolve(page(url, { httpStatus: 404 }));
    });
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/", {
      timeoutMs: 1_000,
      maxPages: 2,
      dynamicFallback: false,
    });

    expect(result.discordFound).toBe(false);
    expect(
      result.pages.some((candidate) => candidate.status === "Timeout"),
    ).toBe(true);
    expect(result.failureReason).toBe("DISCORD_NOT_FOUND");
  });

  it("does not turn a healthy website into blocked because a guessed path returns 403", async () => {
    fetchPage.mockImplementation((url: string) =>
      Promise.resolve(
        page(url, {
          httpStatus: new URL(url).pathname === "/discord" ? 403 : 200,
        }),
      ),
    );
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/", {
      timeoutMs: 1_000,
      maxPages: 2,
      dynamicFallback: false,
    });

    expect(result.discordFound).toBe(false);
    expect(
      result.pages.some((candidate) => candidate.status === "Blocked"),
    ).toBe(true);
    expect(result.failureReason).toBe("DISCORD_NOT_FOUND");
  });

  it("tries real internal links before guessed common paths", async () => {
    fetchPage.mockImplementation((url: string) => {
      const path = new URL(url).pathname;
      if (path === "/products/community-edition")
        return Promise.resolve(
          page(url, {
            discordLinks: ["https://discord.gg/real-link"],
            discordDetections: [
              { url: "https://discord.gg/real-link", method: "anchor" },
            ],
          }),
        );
      if (path === "/")
        return Promise.resolve(
          page(url, {
            internalLinks: ["https://example.com/products/community-edition"],
          }),
        );
      return Promise.resolve(page(url));
    });
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/", {
      timeoutMs: 1_000,
      maxPages: 2,
      deepScan: true,
    });
    expect(result.discordFound).toBe(true);
    expect(result.pages.map((candidate) => candidate.url)).toEqual([
      "https://example.com/",
      "https://example.com/products/community-edition",
    ]);
  });

  it("reserves one browser attempt for an explicit Discord landing route", async () => {
    fetchPage.mockImplementation(
      (url: string, options: { dynamicFallback: boolean }) => {
        const path = new URL(url).pathname;
        if (path === "/")
          return Promise.resolve(
            page(url, {
              priorityLinks: [
                "https://example.com/about",
                "https://example.com/dc",
              ],
            }),
          );
        if (path === "/about")
          return Promise.resolve(page(url, { dynamicFetchResult: "SUCCESS" }));
        if (path === "/dc" && options.dynamicFallback)
          return Promise.resolve(
            page(url, {
              dynamicFetchResult: "SUCCESS",
              discordLinks: ["https://discord.gg/rendered-redirect"],
              discordDetections: [
                {
                  url: "https://discord.gg/rendered-redirect",
                  method: "rendered-dom",
                },
              ],
            }),
          );
        return Promise.resolve(page(url));
      },
    );
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/", {
      timeoutMs: 1_000,
      maxPages: 2,
      maxDynamicPages: 1,
      dynamicFallback: true,
      deepScan: true,
    });
    expect(result.discordFound).toBe(true);
    expect(result.detections[0]?.discoveryMethod).toBe("RENDERED_DOM");
  });

  it("stages one rendered entry-page pass behind static discovery during Deep Scan", async () => {
    fetchPage.mockImplementation(
      (url: string, options: { forceDynamic?: boolean }) =>
        Promise.resolve(
          page(url, {
            fetchMode: options.forceDynamic ? "Dynamic" : "HTTP",
            dynamicFetchResult: options.forceDynamic
              ? "SUCCESS"
              : "NOT_ATTEMPTED",
            discordLinks: options.forceDynamic
              ? ["https://discord.gg/staged-render"]
              : [],
            discordDetections: options.forceDynamic
              ? [
                  {
                    url: "https://discord.gg/staged-render",
                    method: "rendered-dom",
                  },
                ]
              : [],
          }),
        ),
    );
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/", {
      timeoutMs: 1_000,
      maxPages: 1,
      dynamicFallback: true,
      deepScan: true,
    });
    expect(fetchPage.mock.calls[0]?.[1].forceDynamic).toBe(false);
    expect(
      fetchPage.mock.calls.some((call) => call[1].forceDynamic === true),
    ).toBe(true);
    expect(result.discordFound).toBe(true);
  });

  it("lets a real static priority page win before the staged browser pass", async () => {
    fetchPage.mockImplementation((url: string) => {
      const path = new URL(url).pathname;
      if (path === "/")
        return Promise.resolve(
          page(url, { priorityLinks: ["https://example.com/contact"] }),
        );
      if (path === "/contact")
        return Promise.resolve(
          page(url, {
            discordLinks: ["https://discord.gg/static-priority"],
            discordDetections: [
              {
                url: "https://discord.gg/static-priority",
                method: "anchor",
              },
            ],
          }),
        );
      return Promise.resolve(page(url, { httpStatus: 404 }));
    });
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/", {
      timeoutMs: 1_000,
      maxPages: 2,
      dynamicFallback: true,
      deepScan: true,
    });

    expect(result.discordFound).toBe(true);
    expect(result.detections[0]?.url).toBe(
      "https://discord.gg/static-priority",
    );
    expect(
      fetchPage.mock.calls.some((call) => call[1].forceDynamic === true),
    ).toBe(false);
  });

  it("preserves the guaranteed rendered entry retry after an earlier browser failure", async () => {
    fetchPage.mockImplementation(
      (url: string, options: { forceDynamic?: boolean }) =>
        Promise.resolve(
          page(url, {
            dynamicFetchResult: options.forceDynamic ? "SUCCESS" : "FAILED",
            fetchMode: options.forceDynamic ? "Dynamic" : "HTTP",
            discordLinks: options.forceDynamic
              ? ["https://discord.gg/retry-after-timeout"]
              : [],
            discordDetections: options.forceDynamic
              ? [
                  {
                    url: "https://discord.gg/retry-after-timeout",
                    method: "rendered-dom",
                  },
                ]
              : [],
          }),
        ),
    );
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/", {
      timeoutMs: 1_000,
      maxPages: 1,
      maxDynamicPages: 1,
      dynamicFallback: true,
      deepScan: true,
    });

    expect(result.discordFound).toBe(true);
    expect(
      fetchPage.mock.calls.some((call) => call[1].forceDynamic === true),
    ).toBe(true);
  });

  it("follows an explicit invite redirect revealed by an internal landing page", async () => {
    fetchPage.mockImplementation((url: string) => {
      const path = new URL(url).pathname;
      if (path === "/")
        return Promise.resolve(
          page(url, { priorityLinks: ["https://example.com/dc"] }),
        );
      if (path === "/dc")
        return Promise.resolve(
          page(url, {
            priorityLinks: ["https://example.com/discord-redirect"],
          }),
        );
      if (path === "/discord-redirect")
        return Promise.resolve(
          page(url, {
            discordLinks: ["https://discord.gg/nested-route"],
            discordDetections: [
              { url: "https://discord.gg/nested-route", method: "anchor" },
            ],
          }),
        );
      return Promise.resolve(page(url, { httpStatus: 404 }));
    });
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/", {
      timeoutMs: 1_000,
      maxPages: 4,
      deepScan: true,
    });
    expect(result.discordFound).toBe(true);
    expect(result.pages.map((candidate) => candidate.url)).toContain(
      "https://example.com/discord-redirect",
    );
  });

  it("uses a public sitemap without charging it against the content-page budget", async () => {
    fetchPage.mockImplementation((url: string) => {
      const path = new URL(url).pathname;
      if (path === "/sitemap.xml")
        return Promise.resolve(
          page(url, {
            contentType: "application/xml",
            internalLinks: ["https://example.com/hidden/community"],
            priorityLinks: ["https://example.com/hidden/community"],
          }),
        );
      if (path === "/hidden/community")
        return Promise.resolve(
          page(url, {
            discordLinks: ["https://discord.gg/from-sitemap"],
            discordDetections: [
              { url: "https://discord.gg/from-sitemap", method: "anchor" },
            ],
          }),
        );
      return Promise.resolve(page(url));
    });
    const { discoverDiscord } = await import("./discord-discovery.js");
    const result = await discoverDiscord("https://example.com/", {
      timeoutMs: 1_000,
      maxPages: 2,
      deepScan: true,
    });
    expect(result.discordFound).toBe(true);
    expect(result.pages.map((candidate) => candidate.kind)).toEqual([
      "original",
      "sitemap",
      "internal-link",
    ]);
  });
});
