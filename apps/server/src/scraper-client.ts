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
const rustPriceListingSchema = z.object({
  name: z.string().min(1).max(300),
  priceMinor: z.number().int().positive(),
  currency: z.string().min(3).max(4),
  priceText: z.string().min(1).max(100),
  link: z.string().url(),
  method: z.enum([
    "JSON_LD",
    "PRODUCT_CARD",
    "PRODUCT_META",
    "VARIANT_CONTROL",
    "VISIBLE_TEXT",
  ]),
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
  rustPriceListings: z.array(rustPriceListingSchema).default([]),
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
export type RustPriceDetection = z.infer<typeof rustPriceListingSchema>;
export type RobotsResource = z.infer<typeof robotsResultSchema>;

export class ScraperRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ScraperRequestError";
  }
}

const baseUrl = process.env.SCRAPER_URL || "http://127.0.0.1:3011";
const DEVELOPMENT_SCRAPER_TOKEN = "aether-dev-local-worker";
export function configuredScraperToken(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const configured = String(environment.SCRAPER_TOKEN || "").trim();
  if (environment.NODE_ENV === "production") {
    if (
      configured.length < 24 ||
      configured === DEVELOPMENT_SCRAPER_TOKEN ||
      configured.includes("REPLACE_WITH")
    )
      throw new Error(
        "SCRAPER_TOKEN must be a unique secret of at least 24 characters in production",
      );
    return configured;
  }
  return configured || DEVELOPMENT_SCRAPER_TOKEN;
}
const token = configuredScraperToken();
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
    if (!response.ok) {
      const detail =
        typeof payload?.error === "string"
          ? payload.error
          : `Scraper service failed (${response.status})`;
      const retryAfterSeconds = Number.isFinite(
        Number(payload?.retryAfterSeconds),
      )
        ? Math.max(0, Math.min(300, Number(payload.retryAfterSeconds)))
        : undefined;
      const code = typeof payload?.code === "string" ? `${payload.code}: ` : "";
      if (response.status === 504)
        throw new ScraperRequestError(
          `Scrapling worker timeout (HTTP 504): ${code}${detail}`,
          response.status,
          retryAfterSeconds,
        );
      if (
        response.status === 429 ||
        (response.status === 503 &&
          /busy|capacity|overload|queue/i.test(detail))
      )
        throw new ScraperRequestError(
          `Scrapling worker busy (HTTP ${response.status}): ${code}${detail}`,
          response.status,
          retryAfterSeconds,
        );
      if (response.status >= 500)
        throw new ScraperRequestError(
          `Scrapling worker error (HTTP ${response.status}): ${code}${detail}`,
          response.status,
          retryAfterSeconds,
        );
      throw new ScraperRequestError(
        `${code}${detail}`,
        response.status,
        retryAfterSeconds,
      );
    }
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
  discoveryMode: "discord" | "rust-price" = "discord",
  product?: { name: string; type: string },
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
        discoveryMode,
        productName: product?.name,
        productType: product?.type,
        mode: "page",
      }),
    },
    timeoutMs + (forceDynamic ? 12_000 : 5_000),
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
    discoveryMode?: "discord" | "rust-price";
    product?: { name: string; type: string };
  },
): Promise<ScrapedPage> {
  const staticPage = await requestPage(
    url,
    options.timeoutMs,
    false,
    options.discoveryMode,
    options.product,
  );
  const needsDetection =
    options.discoveryMode === "rust-price"
      ? staticPage.rustPriceListings.length === 0 || staticPage.looksDynamic
      : staticPage.discordLinks.length === 0;
  const shouldRender =
    options.dynamicFallback &&
    needsDetection &&
    staticPage.httpStatus !== 429 &&
    (options.forceDynamic ||
      (staticPage.looksDynamic &&
        staticPage.httpStatus >= 200 &&
        staticPage.httpStatus < 300) ||
      (options.discoveryMode !== "rust-price" &&
        !staticPage.discordLinks.length &&
        staticPage.httpStatus >= 200 &&
        staticPage.httpStatus < 300 &&
        contactPath.test(new URL(staticPage.finalUrl).pathname)) ||
      staticPage.httpStatus === 403 ||
      recoverableChallengeStatuses.has(staticPage.httpStatus) ||
      staticPage.httpStatus >= 500);
  if (!shouldRender) return staticPage;
  try {
    const rendered = await withDynamicSlot(() =>
      requestPage(
        staticPage.finalUrl,
        options.timeoutMs,
        true,
        options.discoveryMode,
        options.product,
      ),
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
    timeoutMs + 5_000,
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
