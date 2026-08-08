import { beforeEach, describe, expect, it, vi } from "vitest";

const scrapePage = vi.fn();
const fetchRobotsResource = vi.fn();
vi.mock("./scraper-client.js", () => ({
  scrapePage,
  fetchRobotsResource,
}));

const page = (url: string, redirectUrl: string | null = null) => ({
  requestedUrl: url,
  finalUrl: url,
  redirectUrl,
  httpStatus: redirectUrl ? 302 : 200,
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
});

beforeEach(() => {
  scrapePage.mockReset();
  fetchRobotsResource.mockReset();
});

describe("Node-controlled Scrapling URL boundaries", () => {
  it("classifies structured network failures without a generic scan error", async () => {
    const { classifyFetchError } = await import("./crawler.js");
    expect(classifyFetchError("getaddrinfo EAI_AGAIN example.com")).toBe(
      "DNS_FAILURE",
    );
    expect(classifyFetchError("certificate verify failed")).toBe("TLS_FAILURE");
    expect(classifyFetchError("Scrapling worker timeout")).toBe("TIMEOUT");
  });

  it("rejects a public-to-private redirect before a second worker request", async () => {
    scrapePage.mockResolvedValueOnce(page("https://11.0.0.1/", "http://127.0.0.1/private"));
    const { fetchPage } = await import("./crawler.js");
    await expect(
      fetchPage("https://11.0.0.1/", {
        timeoutMs: 2_000,
        redirects: 5,
        dynamicFallback: false,
      }),
    ).rejects.toThrow(/private|internal/i);
    expect(scrapePage).toHaveBeenCalledTimes(1);
  });

  it("blocks a deep-scan redirect to another public domain", async () => {
    scrapePage.mockResolvedValueOnce(page("https://11.0.0.1/contact", "https://12.0.0.1/contact"));
    const { fetchPage } = await import("./crawler.js");
    await expect(
      fetchPage("https://11.0.0.1/contact", {
        timeoutMs: 2_000,
        redirects: 5,
        dynamicFallback: false,
        allowedHostname: "11.0.0.1",
      }),
    ).rejects.toThrow(/cross-domain/i);
    expect(scrapePage).toHaveBeenCalledTimes(1);
  });

  it("records a Discord Location redirect without fetching the external host", async () => {
    scrapePage.mockResolvedValueOnce({
      ...page("https://11.0.0.1/discord", "https://discord.gg/redirect-code"),
      discordLinks: ["https://discord.gg/redirect-code"],
      discordDetections: [
        { url: "https://discord.gg/redirect-code", method: "redirect-location" },
      ],
    });
    const { fetchPage } = await import("./crawler.js");
    await expect(
      fetchPage("https://11.0.0.1/discord", {
        timeoutMs: 2_000,
        redirects: 5,
        dynamicFallback: false,
        allowedHostname: "11.0.0.1",
      }),
    ).resolves.toMatchObject({
      discordLinks: ["https://discord.gg/redirect-code"],
    });
    expect(scrapePage).toHaveBeenCalledTimes(1);
  });

  it("turns a supported public social redirect into one controlled landing hop", async () => {
    scrapePage.mockResolvedValueOnce(
      page("https://11.0.0.1/discord", "https://dsc.gg/example-community"),
    );
    const { fetchPage } = await import("./crawler.js");
    const result = await fetchPage("https://11.0.0.1/discord", {
      timeoutMs: 2_000,
      redirects: 5,
      dynamicFallback: false,
      allowedHostname: "11.0.0.1",
    });
    expect(result.socialLinks).toContainEqual({
      type: "discord-landing",
      url: "https://dsc.gg/example-community",
      sourcePage: "https://11.0.0.1/discord",
    });
    expect(scrapePage).toHaveBeenCalledTimes(1);
  });

  it("centrally retries a transient 5xx response and records each attempt", async () => {
    scrapePage
      .mockResolvedValueOnce({ ...page("https://11.0.0.1/"), httpStatus: 503 })
      .mockResolvedValueOnce(page("https://11.0.0.1/"));
    const { fetchPage } = await import("./crawler.js");
    const result = await fetchPage("https://11.0.0.1/", {
      timeoutMs: 2_000,
      redirects: 5,
      dynamicFallback: false,
      retries: 2,
    });
    expect(result.httpStatus).toBe(200);
    expect(result.attempts.map((attempt) => attempt.status)).toEqual([503, 200]);
  });

  it("records a safe redirect chain and validates every destination", async () => {
    scrapePage
      .mockResolvedValueOnce(page("https://11.0.0.1/old", "https://11.0.0.1/new"))
      .mockResolvedValueOnce(page("https://11.0.0.1/new"));
    const { fetchPage } = await import("./crawler.js");
    const result = await fetchPage("https://11.0.0.1/old", {
      timeoutMs: 2_000,
      redirects: 5,
      dynamicFallback: false,
      allowedHostname: "11.0.0.1",
    });
    expect(result.redirectChain).toEqual([
      {
        url: "https://11.0.0.1/old",
        status: 302,
        location: "https://11.0.0.1/new",
      },
    ]);
  });

  it("honors the most-specific robots rule", async () => {
    fetchRobotsResource.mockResolvedValue({
      requestedUrl: "https://11.0.0.1/robots.txt",
      finalUrl: "https://11.0.0.1/robots.txt",
      redirectUrl: null,
      httpStatus: 200,
      contentType: "text/plain",
      text: "User-agent: *\nDisallow: /private\nAllow: /private/public",
      durationMs: 1,
    });
    const { robotsAllows } = await import("./crawler.js");
    await expect(robotsAllows("https://11.0.0.1/private/secret", 2_000)).resolves.toBe(false);
    await expect(robotsAllows("https://11.0.0.1/private/public/info", 2_000)).resolves.toBe(true);
  });

  it("fails open when robots.txt is unavailable and exposes that decision", async () => {
    fetchRobotsResource.mockRejectedValueOnce(new Error("worker timeout"));
    const { robotsDecision } = await import("./crawler.js");
    await expect(robotsDecision("https://13.0.0.1/store", 2_000)).resolves.toMatchObject({
      allowed: true,
      reason: "ROBOTS_UNAVAILABLE_FAIL_OPEN",
    });
  });

  it("does not crawl when robots.txt itself requires authorization", async () => {
    fetchRobotsResource.mockResolvedValueOnce({
      requestedUrl: "https://14.0.0.1/robots.txt",
      finalUrl: "https://14.0.0.1/robots.txt",
      redirectUrl: null,
      httpStatus: 403,
      contentType: "text/plain",
      text: "",
      durationMs: 1,
    });
    const { robotsDecision } = await import("./crawler.js");
    await expect(robotsDecision("https://14.0.0.1/store", 2_000)).resolves.toMatchObject({
      allowed: false,
      reason: "ROBOTS_AUTH_REQUIRED",
    });
  });
});
