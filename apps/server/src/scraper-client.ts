import { z } from "zod";

const socialSchema = z.object({
  type: z.string().max(50),
  url: z.string().url(),
  sourcePage: z.string().url(),
});
const discordDetectionSchema = z.object({
  url: z.string().url(),
  method: z.enum([
    "anchor",
    "icon-anchor",
    "visible-text",
    "embedded-data",
    "html-source",
    "data-attribute",
    "onclick-attribute",
    "source-attribute",
    "icon-metadata",
    "redirect-location",
    "rendered-dom",
  ]),
  section: z
    .enum([
      "HEADER",
      "NAVIGATION",
      "MAIN",
      "FAQ",
      "SUPPORT",
      "FOOTER",
      "FLOATING",
      "MODAL",
      "UNKNOWN",
    ])
    .default("UNKNOWN"),
  interaction: z
    .enum(["NONE", "HOVER", "EXPAND_MENU", "CLICK", "SCROLL", "POPUP"])
    .default("NONE"),
});
const pageResultSchema = z.object({
  requestedUrl: z.string().url(),
  finalUrl: z.string().url(),
  redirectUrl: z.string().url().nullable(),
  httpStatus: z.number().int(),
  title: z.string(),
  metaDescription: z.string(),
  canonicalUrl: z.string().url().nullable(),
  faviconUrl: z.string().url().nullable(),
  contentType: z.string(),
  fetchMode: z.enum(["HTTP", "Dynamic"]),
  discordLinks: z.array(z.string().url()),
  discordDetections: z.array(discordDetectionSchema),
  emails: z.array(z.string()),
  socialLinks: z.array(socialSchema),
  internalLinks: z.array(z.string().url()),
  priorityLinks: z.array(z.string().url()).default([]),
  scriptLinks: z.array(z.string().url()).default([]),
  durationMs: z.number().int().nonnegative(),
  looksDynamic: z.boolean(),
  isSoft404: z.boolean(),
  staticFetchResult: z.enum(["SUCCESS", "FAILED"]).default("SUCCESS"),
  dynamicFetchResult: z
    .enum(["NOT_ATTEMPTED", "SUCCESS", "FAILED"])
    .default("NOT_ATTEMPTED"),
  dynamicError: z.string().default(""),
  retryAfterSeconds: z.number().int().nonnegative().nullable().default(null),
});
const robotsResultSchema = z.object({
  requestedUrl: z.string().url(),
  finalUrl: z.string().url(),
  redirectUrl: z.string().url().nullable(),
  httpStatus: z.number().int(),
  contentType: z.string(),
  text: z.string(),
  durationMs: z.number().int().nonnegative(),
});
export type ScrapedPage = z.infer<typeof pageResultSchema>;
export type SocialLink = z.infer<typeof socialSchema>;
export type DiscordDetection = z.infer<typeof discordDetectionSchema>;
export type RobotsResource = z.infer<typeof robotsResultSchema>;

const baseUrl = process.env.SCRAPER_URL || "http://127.0.0.1:3011";
const token = process.env.SCRAPER_TOKEN || "aether-dev-local-worker";
const dynamicConcurrency = Math.max(
  1,
  Math.min(4, Number(process.env.SCRAPER_DYNAMIC_CONCURRENCY || 3)),
);
let activeDynamicRequests = 0;
const dynamicWaiters: Array<() => void> = [];

async function withDynamicSlot<T>(task: () => Promise<T>) {
  if (activeDynamicRequests >= dynamicConcurrency) {
    await new Promise<void>((resolve) => dynamicWaiters.push(resolve));
  } else {
    activeDynamicRequests += 1;
  }
  try {
    return await task();
  } finally {
    const next = dynamicWaiters.shift();
    if (next) next();
    else activeDynamicRequests -= 1;
  }
}

async function internalRequest<T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        typeof payload?.error === "string"
          ? payload.error
          : `Scraper service failed (${response.status})`,
      );
    return payload as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new Error("Scrapling worker timeout");
    if (error instanceof TypeError)
      throw new Error("Scrapling worker unavailable");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestPage(
  url: string,
  timeoutMs: number,
  forceDynamic = false,
): Promise<ScrapedPage> {
  const payload = await internalRequest<{ result: unknown }>(
    "/internal/scrape",
    {
      method: "POST",
      body: JSON.stringify({
        url,
        timeoutMs,
        dynamicFallback: false,
        forceDynamic,
        mode: "page",
      }),
    },
    timeoutMs + 3_000,
  );
  const parsed = pageResultSchema.safeParse(payload.result);
  if (!parsed.success) throw new Error("Malformed Scrapling worker response");
  return parsed.data;
}

const contactPath =
  /(?:^|[-_/])(contacts?(?:-us)?|about(?:-us)?|community|discord|dsc|dc|invite|join|socials?|support|help|links?|team|faq|forums?|chat|reviews?|testimonials?)(?:[-_/.]|$)/i;
const recoverableChallengeStatuses = new Set([418, 430, 440, 441, 444, 460]);

export async function scrapePage(
  url: string,
  options: {
    timeoutMs: number;
    dynamicFallback: boolean;
    forceDynamic?: boolean;
  },
): Promise<ScrapedPage> {
  const staticPage = await requestPage(url, options.timeoutMs);
  const shouldRender =
    options.dynamicFallback &&
    staticPage.discordLinks.length === 0 &&
    staticPage.httpStatus !== 429 &&
    (options.forceDynamic ||
      (staticPage.looksDynamic &&
        staticPage.httpStatus >= 200 &&
        staticPage.httpStatus < 300) ||
      (!staticPage.discordLinks.length &&
        staticPage.httpStatus >= 200 &&
        staticPage.httpStatus < 300 &&
        contactPath.test(new URL(staticPage.finalUrl).pathname)) ||
      staticPage.httpStatus === 403 ||
      recoverableChallengeStatuses.has(staticPage.httpStatus) ||
      staticPage.httpStatus >= 500);
  if (!shouldRender) return staticPage;
  try {
    const rendered = await withDynamicSlot(() =>
      requestPage(staticPage.finalUrl, options.timeoutMs, true),
    );
    return {
      ...rendered,
      requestedUrl: staticPage.requestedUrl,
      durationMs: staticPage.durationMs + rendered.durationMs,
      staticFetchResult: "SUCCESS",
      dynamicFetchResult: "SUCCESS",
    };
  } catch (error) {
    return {
      ...staticPage,
      dynamicFetchResult: "FAILED",
      dynamicError:
        error instanceof Error
          ? error.message.slice(0, 500)
          : "Dynamic render failed",
    };
  }
}

export async function fetchRobotsResource(
  url: string,
  timeoutMs: number,
): Promise<RobotsResource> {
  const payload = await internalRequest<{ result: unknown }>(
    "/internal/scrape",
    {
      method: "POST",
      body: JSON.stringify({
        url,
        timeoutMs,
        dynamicFallback: false,
        mode: "robots",
      }),
    },
    timeoutMs + 3_000,
  );
  const parsed = robotsResultSchema.safeParse(payload.result);
  if (!parsed.success) throw new Error("Malformed Scrapling robots response");
  return parsed.data;
}

let healthCache:
  | {
      until: number;
      value: {
        healthy: boolean;
        engine: string;
        version?: string;
        error?: string;
      };
    }
  | undefined;
export async function scraperHealth(force = false) {
  if (!force && healthCache && healthCache.until > Date.now())
    return healthCache.value;
  let value: {
    healthy: boolean;
    engine: string;
    version?: string;
    error?: string;
  };
  try {
    const health = await internalRequest<{
      ok: boolean;
      engine: string;
      scraplingVersion: string;
    }>("/internal/health", { method: "GET" }, 1_500);
    value = {
      healthy: health.ok,
      engine: health.engine || "Scrapling",
      version: health.scraplingVersion,
    };
  } catch (error) {
    value = {
      healthy: false,
      engine: "Scrapling",
      error: error instanceof Error ? error.message : "Worker unavailable",
    };
  }
  healthCache = { until: Date.now() + 3_000, value };
  return value;
}
