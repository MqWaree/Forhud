import { z } from "zod";
import { scrapePage } from "./scraper-client.js";
import { supportedSourceCurrencies } from "./currency-rates.js";

const allowedOrigins = new Set([
  "https://prod-api.lzt.market",
  "https://api.lzt.market",
]);

const itemSchema = z
  .object({
    item_id: z.union([z.number().int().nonnegative(), z.string().min(1)]),
    item_state: z.string().optional(),
    published_date: z.number().int().nonnegative().optional(),
    title: z.string().optional(),
    title_en: z.string().optional(),
    price: z.number().nonnegative(),
    price_currency: z.string().optional(),
    item_origin: z.string().optional(),
    public_url: z.string().url().optional(),
    steam_game_count: z.number().int().nonnegative().optional(),
    steam_full_games: z.unknown().optional(),
    steam_cs2_inv_value: z.number().nonnegative().optional(),
    steam_rust_inv_value: z.number().nonnegative().optional(),
    steam_inv_value: z.number().nonnegative().optional(),
  })
  .passthrough();

const pageSchema = z
  .object({
    items: z.array(itemSchema),
    stickyItems: z.array(itemSchema).default([]),
    hasNextPage: z.boolean(),
    page: z.number().int().positive(),
    serverTime: z.number().optional(),
  })
  .passthrough();

const itemResponseSchema = z.object({ item: itemSchema }).passthrough();

export type LztApiItem = z.infer<typeof itemSchema>;
export type LztApiPage = z.infer<typeof pageSchema>;
export type LztItemLookup = {
  status: "FOUND" | "SOLD" | "REMOVED";
  item?: LztApiItem;
  rateLimit: LztRateLimit;
  latencyMs: number;
};
export type LztRateLimit = {
  limit?: number;
  remaining?: number;
  resetAt?: Date;
};

const supportedLztCurrencies = new Set<string>(supportedSourceCurrencies);

export function normalizeLztCurrency(value?: string) {
  const currency = (value || "EUR").trim().toUpperCase();
  const normalized = currency === "RUR" ? "RUB" : currency;
  if (!supportedLztCurrencies.has(normalized))
    throw new LztApiError(
      "INVALID_RESPONSE",
      `LZT API returned an unsupported price currency: ${normalized || "empty"}`,
    );
  return normalized;
}

export class LztApiError extends Error {
  constructor(
    public code:
      | "AUTH_ERROR"
      | "FORBIDDEN"
      | "ACCESS_CHALLENGE"
      | "RATE_LIMITED"
      | "SERVER_ERROR"
      | "TIMEOUT"
      | "INVALID_RESPONSE"
      | "NETWORK_ERROR",
    message: string,
    public status?: number,
    public retryAt?: Date,
  ) {
    super(message);
  }
}

export function normalizeLztItemState(value?: string) {
  const state = (value || "ACTIVE").trim().toUpperCase();
  if (/SOLD|PAID|PURCHASED/.test(state)) return "SOLD";
  if (/DELETED|REMOVED/.test(state)) return "REMOVED";
  if (/ACTIVE|OPEN/.test(state)) return "ACTIVE";
  return state || "ACTIVE";
}

export type LztSearchOptions = {
  minimumRustHours?: number;
  maximumPriceUsd?: number;
  orderBy?: "pdate_to_down" | "price_to_up";
};

export function lztSearchUrl(
  baseUrl: string,
  page = 1,
  options: LztSearchOptions = {},
) {
  const url = new URL("/steam", baseUrl);
  url.searchParams.set("page", String(page));
  url.searchParams.append("game[]", "252490");
  url.searchParams.set("order_by", options.orderBy || "pdate_to_down");
  url.searchParams.set("currency", options.maximumPriceUsd ? "usd" : "eur");
  if (options.minimumRustHours)
    url.searchParams.set(
      "hours_played[252490]",
      String(Math.floor(options.minimumRustHours)),
    );
  if (options.maximumPriceUsd)
    url.searchParams.set("pmax", String(options.maximumPriceUsd));
  for (const origin of ["brute", "phishing", "stealer"])
    url.searchParams.append("not_origin[]", origin);
  return url;
}

function rateLimit(headers: Headers): LztRateLimit {
  const numberHeader = (name: string) => {
    const raw = headers.get(name);
    if (raw === null || raw.trim() === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const reset = numberHeader("x-ratelimit-reset");
  return {
    limit: numberHeader("x-ratelimit-limit"),
    remaining: numberHeader("x-ratelimit-remaining"),
    resetAt: reset
      ? new Date(reset > 1_000_000_000_000 ? reset : reset * 1000)
      : undefined,
  };
}

export function retryAfterDate(value: string | null, now = Date.now()) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return new Date(now + seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now
    ? new Date(timestamp)
    : undefined;
}

export class LztApiClient {
  readonly baseUrl: string;
  constructor(
    private token = process.env.LZT_API_TOKEN?.trim() || "",
    baseUrl = process.env.LZT_API_BASE_URL || "https://prod-api.lzt.market",
    private request: typeof fetch = fetch,
    private timeoutMs = 15_000,
  ) {
    const parsed = new URL(baseUrl);
    if (!allowedOrigins.has(parsed.origin) || parsed.pathname !== "/")
      throw new Error(
        "LZT_API_BASE_URL must use an approved official API origin",
      );
    this.baseUrl = parsed.origin;
  }

  configured() {
    return Boolean(this.token);
  }

  async search(
    page = 1,
    options: LztSearchOptions = {},
  ): Promise<{ page: LztApiPage; rateLimit: LztRateLimit; latencyMs: number }> {
    if (!this.token)
      throw new LztApiError("AUTH_ERROR", "LZT API token is not configured");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = performance.now();
    try {
      const response = await this.request(
        lztSearchUrl(this.baseUrl, page, options),
        {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.token}`,
            "User-Agent": "FGP-LZT-Tracker/1.0",
          },
          signal: controller.signal,
        },
      );
      const limits = rateLimit(response.headers);
      if (!response.ok) {
        if (response.status === 401)
          throw new LztApiError(
            "AUTH_ERROR",
            "LZT API token is invalid or expired",
            401,
          );
        if (response.status === 403)
          throw new LztApiError(
            "FORBIDDEN",
            "LZT Market scope or API access is unavailable",
            403,
          );
        if (response.status === 429) {
          const retryAt =
            limits.resetAt ||
            retryAfterDate(response.headers.get("retry-after")) ||
            new Date(Date.now() + 60_000);
          throw new LztApiError(
            "RATE_LIMITED",
            "LZT API rate limit reached",
            429,
            retryAt,
          );
        }
        if (response.status >= 500)
          throw new LztApiError(
            "SERVER_ERROR",
            `LZT API returned HTTP ${response.status}`,
            response.status,
          );
        throw new LztApiError(
          "INVALID_RESPONSE",
          `LZT API returned HTTP ${response.status}`,
          response.status,
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new LztApiError(
          "INVALID_RESPONSE",
          "LZT API returned invalid JSON",
        );
      }
      const parsed = pageSchema.safeParse(payload);
      if (!parsed.success)
        throw new LztApiError(
          "INVALID_RESPONSE",
          "LZT API response did not match the current Steam category contract",
        );
      return {
        page: parsed.data,
        rateLimit: limits,
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      if (error instanceof LztApiError) throw error;
      if (error instanceof Error && error.name === "AbortError")
        throw new LztApiError("TIMEOUT", "LZT category request timed out");
      throw new LztApiError("NETWORK_ERROR", "LZT API could not be reached");
    } finally {
      clearTimeout(timeout);
    }
  }
  async getItem(itemId: string): Promise<LztItemLookup> {
    if (!this.token)
      throw new LztApiError("AUTH_ERROR", "LZT API token is not configured");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = performance.now();
    try {
      const url = new URL(`/${encodeURIComponent(itemId)}`, this.baseUrl);
      url.searchParams.set("currency", "eur");
      const response = await this.request(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
          "User-Agent": "FGP-LZT-Tracker/1.0",
        },
        signal: controller.signal,
      });
      const limits = rateLimit(response.headers);
      const latencyMs = Math.round(performance.now() - started);
      const body = await response.text();
      if (!response.ok) {
        if (response.status === 404 || response.status === 410)
          return { status: "REMOVED", rateLimit: limits, latencyMs };
        if (
          /sold|purchased|already.{0,20}(?:bought|paid)|\u043f\u0440\u043e\u0434\u0430\u043d/i.test(
            body,
          )
        )
          return { status: "SOLD", rateLimit: limits, latencyMs };
        if (response.status === 401)
          throw new LztApiError(
            "AUTH_ERROR",
            "LZT API token is invalid or expired",
            401,
          );
        if (response.status === 403)
          throw new LztApiError(
            "FORBIDDEN",
            "LZT Market scope or API access is unavailable",
            403,
          );
        if (response.status === 429) {
          const retryAt =
            limits.resetAt ||
            retryAfterDate(response.headers.get("retry-after")) ||
            new Date(Date.now() + 60_000);
          throw new LztApiError(
            "RATE_LIMITED",
            "LZT API rate limit reached",
            429,
            retryAt,
          );
        }
        if (response.status >= 500)
          throw new LztApiError(
            "SERVER_ERROR",
            `LZT API returned HTTP ${response.status}`,
            response.status,
          );
        throw new LztApiError(
          "INVALID_RESPONSE",
          `LZT API returned HTTP ${response.status}`,
          response.status,
        );
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new LztApiError(
          "INVALID_RESPONSE",
          "LZT API returned invalid JSON",
        );
      }
      const direct = itemSchema.safeParse(payload);
      const wrapped = itemResponseSchema.safeParse(payload);
      if (!direct.success && !wrapped.success)
        throw new LztApiError(
          "INVALID_RESPONSE",
          "LZT item response did not match the current contract",
        );
      const item = direct.success
        ? direct.data
        : wrapped.success
          ? wrapped.data.item
          : undefined;
      if (!item)
        throw new LztApiError("INVALID_RESPONSE", "LZT item is missing");
      const state = normalizeLztItemState(item.item_state);
      return {
        status:
          state === "SOLD" ? "SOLD" : state === "REMOVED" ? "REMOVED" : "FOUND",
        item,
        rateLimit: limits,
        latencyMs,
      };
    } catch (error) {
      if (error instanceof LztApiError) throw error;
      if (error instanceof Error && error.name === "AbortError")
        throw new LztApiError("TIMEOUT", "LZT item request timed out");
      throw new LztApiError(
        "NETWORK_ERROR",
        "LZT item API could not be reached",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class LztPublicClient {
  readonly baseUrl = "https://lzt.market";
  constructor(private scrape: typeof scrapePage = scrapePage) {}
  configured() {
    return true;
  }
  sourceMode() {
    return "PUBLIC_PAGE" as const;
  }

  async search(
    page = 1,
  ): Promise<{ page: LztApiPage; rateLimit: LztRateLimit; latencyMs: number }> {
    const url = new URL("/steam", this.baseUrl);
    url.searchParams.set("page", String(page));
    url.searchParams.append("game[]", "252490");
    url.searchParams.set("order_by", "pdate_to_down");
    const started = performance.now();
    try {
      const result = await this.scrape(url.href, {
        timeoutMs: 15_000,
        dynamicFallback: true,
        discoveryMode: "rust-price",
        product: { name: "Rust accounts", type: "GAME_ACCOUNTS" },
      });
      const challengeText = `${result.title} ${result.metaDescription} ${result.dynamicError}`;
      if (
        /security check|captcha|verify.{0,20}human|robot|проверка безопасности|человек/i.test(
          challengeText,
        )
      )
        throw new LztApiError(
          "ACCESS_CHALLENGE",
          "LZT requires human verification; the public tracker will retry later without bypassing it",
          403,
        );
      if (result.httpStatus === 403 || result.httpStatus === 429)
        throw new LztApiError(
          result.httpStatus === 429 ? "RATE_LIMITED" : "FORBIDDEN",
          `LZT public page returned HTTP ${result.httpStatus}`,
          result.httpStatus,
        );
      if (result.httpStatus >= 500)
        throw new LztApiError(
          "SERVER_ERROR",
          `LZT public page returned HTTP ${result.httpStatus}`,
          result.httpStatus,
        );
      if (result.httpStatus >= 400)
        throw new LztApiError(
          "INVALID_RESPONSE",
          `LZT public page returned HTTP ${result.httpStatus}`,
          result.httpStatus,
        );
      const items: LztApiItem[] = result.rustPriceListings.map(
        (listing, index) => {
          const match = new URL(listing.link).pathname.match(
            /^\/(\d+)(?:\/|$)/,
          );
          return {
            item_id:
              match?.[1] ||
              `public-${Buffer.from(listing.link).toString("base64url").slice(0, 24)}`,
            item_state: "ACTIVE",
            published_date: Math.floor(Date.now() / 1000) - index,
            title_en: listing.name,
            price: listing.priceMinor / 100,
            price_currency: listing.currency,
            item_origin: "public_page",
            public_url: listing.link,
          };
        },
      );
      if (!items.length)
        throw new LztApiError(
          "INVALID_RESPONSE",
          result.dynamicFetchResult === "FAILED"
            ? `No public listings found; rendered fallback failed: ${result.dynamicError || "unknown error"}`
            : "No public Rust listings were visible on the LZT page",
        );
      return {
        page: { items, stickyItems: [], hasNextPage: items.length >= 20, page },
        rateLimit: {},
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      if (error instanceof LztApiError) throw error;
      if (error instanceof Error && /timeout/i.test(error.message))
        throw new LztApiError("TIMEOUT", "LZT public page request timed out");
      throw new LztApiError(
        "NETWORK_ERROR",
        error instanceof Error
          ? error.message
          : "LZT public page could not be reached",
      );
    }
  }
}
