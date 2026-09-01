import { canonicalSiteKey } from "@lead/shared";
import { createHash } from "node:crypto";
import { isExcludedBusinessSearchResult } from "./business-filter.js";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const PAGE_SIZE = 20;
export const MAX_BRAVE_SEARCH_REQUESTS = Math.max(
  1,
  Math.min(1_000, Number(process.env.BRAVE_MAX_REQUESTS || 300)),
);
export const BRAVE_SEARCH_CONCURRENCY = Math.max(
  1,
  Math.min(5, Number(process.env.BRAVE_SEARCH_CONCURRENCY || 3)),
);
export const MAX_SEARCH_TARGET_RESULTS = Math.max(
  1_000,
  Math.min(50_000, Number(process.env.MAX_SEARCH_TARGET_RESULTS || 5_000)),
);
// Brave documents offsets 0-9. Use the complete available window instead of
// stopping at three pages, while still respecting the global request budget.
const MAX_PAGES_PER_VARIANT = 10;
const BRAVE_SEARCH_CACHE_TTL_MS = Math.max(
  0,
  Math.min(
    24 * 60 * 60 * 1_000,
    Number(process.env.BRAVE_SEARCH_CACHE_TTL_MS || 15 * 60 * 1_000),
  ),
);
const BRAVE_SEARCH_CACHE_MAX_PAGES = Math.max(
  100,
  Math.min(20_000, Number(process.env.BRAVE_SEARCH_CACHE_MAX_PAGES || 2_000)),
);
const DISCOVERY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "best",
  "business",
  "businesses",
  "buy",
  "companies",
  "company",
  "find",
  "for",
  "in",
  "me",
  "near",
  "of",
  "the",
  "top",
  "website",
  "websites",
]);
const DISCOVERY_INTENTS = ["provider", "vendor", "supplier"];
const DISCOVERY_REGIONS = [
  "United States",
  "United Kingdom",
  "Canada",
  "Australia",
  "Germany",
  "France",
  "Spain",
  "Italy",
  "Netherlands",
  "Belgium",
  "Denmark",
  "Sweden",
  "Norway",
  "Finland",
  "Poland",
  "Austria",
  "Switzerland",
  "Ireland",
  "Portugal",
  "Czech Republic",
  "Romania",
  "Greece",
  "Turkey",
  "Ukraine",
  "Brazil",
  "Mexico",
  "Argentina",
  "India",
  "Singapore",
  "Japan",
  "South Korea",
  "Indonesia",
  "Malaysia",
  "Philippines",
  "Vietnam",
  "Thailand",
  "United Arab Emirates",
  "Saudi Arabia",
  "South Africa",
  "New Zealand",
  "Europe",
  "North America",
  "South America",
  "Asia",
  "global",
];
const DISCOVERY_TLDS = [
  ".com",
  ".net",
  ".org",
  ".io",
  ".co",
  ".gg",
  ".shop",
  ".store",
  ".market",
  ".us",
  ".uk",
  ".ca",
  ".au",
  ".de",
  ".fr",
  ".es",
  ".it",
  ".nl",
  ".be",
  ".dk",
  ".se",
  ".no",
  ".fi",
  ".pl",
  ".at",
  ".ch",
  ".ie",
  ".pt",
  ".cz",
  ".ro",
  ".br",
  ".mx",
  ".in",
  ".sg",
  ".za",
];

function uniqueQueries(values: string[], previouslySeen = new Set<string>()) {
  return values
    .map((value) => value.slice(0, 400))
    .filter((value) => {
      if (previouslySeen.has(value)) return false;
      previouslySeen.add(value);
      return true;
    });
}

function buildQueryTiers(query: string) {
  const core = query
    .split(/\s+/)
    .filter((word) => !DISCOVERY_STOP_WORDS.has(word.toLowerCase()))
    .join(" ")
    .trim();
  const subject = core || query;
  const commerceVariants =
    /\b(?:account|accounts|nfa|market|price|sale|shop|store)\b/i.test(query)
      ? [
          `"${subject}"`,
          `${subject} marketplace`,
          `${subject} buy`,
          `${subject} cheap`,
          `${subject} listings`,
          `${subject} sellers`,
          `${subject} digital goods`,
          `${subject} inurl:market`,
          `${subject} inurl:accounts`,
          `${subject} inurl:category`,
        ]
      : [];
  const rustAccountVariants =
    /\brust\b/i.test(query) && /\b(?:account|accounts|nfa)\b/i.test(query)
      ? [
          "Rust NFA accounts",
          "Rust non full access accounts",
          "Rust Steam accounts for sale",
          "Rust account marketplace",
          "buy Rust accounts",
          "купить аккаунт Rust",
          "Rust аккаунты купить",
          "Rust Konto kaufen",
          "acheter compte Rust",
          "comprar cuenta Rust",
        ]
      : [];
  const seen = new Set<string>();
  const primary = uniqueQueries(
    [
      query,
      subject,
      ...rustAccountVariants,
      `${subject} official website`,
      `${subject} provider`,
      `${subject} vendor`,
      `${subject} supplier`,
      `${subject} reseller`,
      `${subject} services`,
      `${subject} solutions`,
      `${subject} shop`,
      `${subject} store`,
      `${subject} pricing`,
      `${subject} products`,
      `${subject} purchase`,
      `${subject} contact`,
      `${subject} alternatives`,
      `${subject} inurl:shop`,
      `${subject} inurl:store`,
      `${subject} inurl:pricing`,
      `${subject} inurl:products`,
      `${subject} inurl:contact`,
      ...commerceVariants,
    ],
    seen,
  );
  const geographic = uniqueQueries(
    [
      ...DISCOVERY_REGIONS.map((region) => `${subject} ${region}`),
      ...DISCOVERY_TLDS.map((tld) => `${subject} site:${tld}`),
    ],
    seen,
  );
  const longTail = uniqueQueries(
    [
      ...DISCOVERY_REGIONS.flatMap((region) =>
        DISCOVERY_INTENTS.map((intent) => `${subject} ${intent} ${region}`),
      ),
    ],
    seen,
  );
  let remaining = MAX_BRAVE_SEARCH_REQUESTS;
  return [primary, geographic, longTail].map((tier) => {
    const limited = tier.slice(0, remaining);
    remaining -= limited.length;
    return limited;
  });
}

type BraveWebResult = {
  title?: string;
  url?: string;
};

type BraveResponse = {
  web?: { results?: BraveWebResult[] };
  query?: { more_results_available?: boolean };
};

export type DiscoveredSearchResult = {
  title: string;
  url: string;
  position: number;
};

export type BraveSearchProgress = {
  requested: number;
  discovered: number;
  excluded: number;
  requests: number;
  failedRequests: number;
  queryPagesChecked: number;
  totalVariants: number;
  activeVariants: number;
};

export class SearchProviderError extends Error {
  statusCode: number;
  expose = true;
  fatal: boolean;

  constructor(message: string, statusCode = 502, fatal = false) {
    super(message);
    this.name = "SearchProviderError";
    this.statusCode = statusCode;
    this.fatal = fatal;
  }
}

const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

type BravePage = {
  searchQuery: string;
  payload: BraveResponse;
};

const bravePageCache = new Map<
  string,
  { expiresAt: number; value: BravePage }
>();
const bravePageRequests = new Map<string, Promise<BravePage>>();
const fetchIdentities = new WeakMap<typeof globalThis.fetch, number>();
let nextFetchIdentity = 1;

function fetchIdentity() {
  const fetchFunction = globalThis.fetch;
  let identity = fetchIdentities.get(fetchFunction);
  if (!identity) {
    identity = nextFetchIdentity++;
    fetchIdentities.set(fetchFunction, identity);
  }
  return identity;
}

function pageCacheKey(apiKey: string, searchQuery: string, offset: number) {
  const credentialScope = createHash("sha256")
    .update(apiKey)
    .digest("base64url")
    .slice(0, 16);
  return `${fetchIdentity()}:${credentialScope}:${offset}:${searchQuery}`;
}

function rememberBravePage(key: string, value: BravePage) {
  if (BRAVE_SEARCH_CACHE_TTL_MS <= 0) return;
  bravePageCache.set(key, {
    expiresAt: Date.now() + BRAVE_SEARCH_CACHE_TTL_MS,
    value,
  });
  while (bravePageCache.size > BRAVE_SEARCH_CACHE_MAX_PAGES) {
    const oldestKey = bravePageCache.keys().next().value;
    if (oldestKey === undefined) break;
    bravePageCache.delete(oldestKey);
  }
}

async function fetchBravePageFromProvider({
  apiKey,
  searchQuery,
  offset,
  onRequest,
}: {
  apiKey: string;
  searchQuery: string;
  offset: number;
  onRequest: () => void;
}) {
  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", searchQuery);
  url.searchParams.set("count", String(PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("safesearch", "moderate");
  url.searchParams.set("spellcheck", "1");

  let lastError: SearchProviderError | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try {
      onRequest();
      response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      lastError = new SearchProviderError(
        error instanceof Error &&
          ["AbortError", "TimeoutError"].includes(error.name)
          ? "Brave Search timed out. Please try again."
          : "Brave Search could not be reached. Please try again.",
      );
      if (attempt === 0) {
        await wait(250);
        continue;
      }
      throw lastError;
    }

    if (response.status === 401 || response.status === 403)
      throw new SearchProviderError(
        "The Brave Search API key was rejected. Check the key or subscription.",
        502,
        true,
      );
    if (response.status === 429)
      throw new SearchProviderError(
        "Brave Search rate limit or monthly allowance reached. Try again later or check the Brave dashboard.",
        429,
        true,
      );
    if (!response.ok) {
      lastError = new SearchProviderError(
        `Brave Search returned an error (${response.status}). Please try again.`,
      );
      if (response.status >= 500 && attempt === 0) {
        await wait(250);
        continue;
      }
      throw lastError;
    }

    try {
      return {
        searchQuery,
        payload: (await response.json()) as BraveResponse,
      };
    } catch {
      lastError = new SearchProviderError(
        "Brave Search returned an invalid response. Please try again.",
      );
      if (attempt === 0) {
        await wait(250);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError || new SearchProviderError("Brave Search failed.");
}

async function fetchBravePage(args: {
  apiKey: string;
  searchQuery: string;
  offset: number;
  onRequest: () => void;
}) {
  const key = pageCacheKey(args.apiKey, args.searchQuery, args.offset);
  const cached = bravePageCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    // Refresh insertion order so frequently reused pages remain in the LRU.
    bravePageCache.delete(key);
    bravePageCache.set(key, cached);
    return cached.value;
  }
  if (cached) bravePageCache.delete(key);

  const inFlight = bravePageRequests.get(key);
  if (inFlight) return inFlight;

  const request = fetchBravePageFromProvider(args).then((page) => {
    rememberBravePage(key, page);
    return page;
  });
  bravePageRequests.set(key, request);
  try {
    return await request;
  } finally {
    if (bravePageRequests.get(key) === request) bravePageRequests.delete(key);
  }
}

export function braveSearchConfigured() {
  return Boolean(process.env.BRAVE_SEARCH_API_KEY?.trim());
}

export async function searchBrave(
  query: string,
  maxResults: number,
  options: {
    onProgress?: (progress: BraveSearchProgress) => void;
  } = {},
): Promise<{
  results: DiscoveredSearchResult[];
  requests: number;
  failedRequests: number;
  excluded: number;
  stopReason:
    | "TARGET_REACHED"
    | "RESULTS_EXHAUSTED"
    | "REQUEST_LIMIT_REACHED"
    | "PROVIDER_DEGRADED";
}> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey)
    throw new SearchProviderError(
      "Brave Search is not configured. Add BRAVE_SEARCH_API_KEY to the server environment.",
      503,
      true,
    );

  const target = Math.min(
    MAX_SEARCH_TARGET_RESULTS,
    Math.max(1, Math.trunc(maxResults)),
  );
  const results: DiscoveredSearchResult[] = [];
  const seenUrls = new Set<string>();
  const seenDomains = new Set<string>();
  let requests = 0;
  let failedRequests = 0;
  let excluded = 0;
  let consecutiveFailedBatches = 0;
  let providerDegraded = false;
  let lastProviderError: SearchProviderError | undefined;
  let queryPagesChecked = 0;

  const queryTiers = buildQueryTiers(query);
  const queryVariants = queryTiers.flat();
  type QueryState = {
    query: string;
    tier: number;
    nextOffset: number;
    exhausted: boolean;
    totalYield: number;
    lastYield: number;
    zeroYieldStreak: number;
  };
  const states: QueryState[] = queryTiers.flatMap((tier, tierIndex) =>
    tier.map((searchQuery) => ({
      query: searchQuery,
      tier: tierIndex,
      nextOffset: 0,
      exhausted: false,
      totalYield: 0,
      lastYield: 0,
      zeroYieldStreak: 0,
    })),
  );
  const activeQueries = new Set(queryVariants);
  const reportProgress = () => {
    try {
      options.onProgress?.({
        requested: target,
        discovered: results.length,
        excluded,
        requests,
        failedRequests,
        queryPagesChecked,
        totalVariants: queryVariants.length,
        activeVariants: activeQueries.size,
      });
    } catch {
      // UI progress reporting must never interrupt provider discovery.
    }
  };
  reportProgress();

  const canContinue = () =>
    results.length < target &&
    requests < MAX_BRAVE_SEARCH_REQUESTS &&
    activeQueries.size > 0;

  const runCandidates = async (candidates: QueryState[]) => {
    for (let cursor = 0; cursor < candidates.length && canContinue();) {
      const remainingTarget = Math.max(1, target - results.length);
      const batchSize = Math.min(
        BRAVE_SEARCH_CONCURRENCY,
        Math.ceil(remainingTarget / PAGE_SIZE),
        MAX_BRAVE_SEARCH_REQUESTS - requests,
        candidates.length - cursor,
      );
      if (batchSize <= 0) break;
      const batchStates = candidates.slice(cursor, cursor + batchSize);
      cursor += batchSize;
      const settledResponses = await Promise.allSettled(
        batchStates.map((state) =>
          fetchBravePage({
            apiKey,
            searchQuery: state.query,
            offset: state.nextOffset,
            onRequest: () => requests++,
          }),
        ),
      );
      queryPagesChecked += settledResponses.length;
      const responses: Array<{
        state: QueryState;
        payload: BraveResponse;
      }> = [];
      for (const [index, response] of settledResponses.entries()) {
        const state = batchStates[index]!;
        state.nextOffset++;
        if (response.status === "fulfilled") {
          responses.push({ state, payload: response.value.payload });
          continue;
        }
        failedRequests++;
        state.lastYield = 0;
        state.zeroYieldStreak++;
        if (state.nextOffset >= MAX_PAGES_PER_VARIANT) {
          state.exhausted = true;
          activeQueries.delete(state.query);
        }
        const providerError =
          response.reason instanceof SearchProviderError
            ? response.reason
            : new SearchProviderError("Brave Search could not be reached.");
        if (providerError.fatal) throw providerError;
        lastProviderError = providerError;
      }
      if (responses.length === 0) {
        consecutiveFailedBatches++;
        providerDegraded = true;
        if (results.length === 0 || consecutiveFailedBatches >= 2)
          throw (
            lastProviderError ||
            new SearchProviderError("Brave Search could not be reached.")
          );
        break;
      }
      consecutiveFailedBatches = 0;
      if (responses.length < settledResponses.length) providerDegraded = true;

      for (const { state, payload } of responses) {
        const page = payload.web?.results ?? [];
        const resultCountBeforePage = results.length;
        for (const item of page) {
          if (!item.url) continue;
          try {
            const parsed = new URL(item.url);
            if (!["http:", "https:"].includes(parsed.protocol)) continue;
            parsed.hash = "";
            const normalized = parsed.toString();
            const siteKey = canonicalSiteKey(normalized);
            if (seenUrls.has(normalized) || seenDomains.has(siteKey)) continue;
            seenUrls.add(normalized);
            if (
              isExcludedBusinessSearchResult({
                url: normalized,
                title: item.title,
              })
            ) {
              excluded++;
              continue;
            }
            seenDomains.add(siteKey);
            results.push({
              title: item.title?.trim() || parsed.hostname,
              url: normalized,
              position: results.length + 1,
            });
            if (results.length >= target) break;
          } catch {
            // Ignore malformed provider entries.
          }
        }
        const added = results.length - resultCountBeforePage;
        state.lastYield = added;
        state.totalYield += added;
        state.zeroYieldStreak = added === 0 ? state.zeroYieldStreak + 1 : 0;
        if (
          page.length === 0 ||
          payload.query?.more_results_available === false ||
          state.nextOffset >= MAX_PAGES_PER_VARIANT
        ) {
          state.exhausted = true;
          activeQueries.delete(state.query);
        }
        if (results.length >= target) break;
      }
      reportProgress();
    }
  };

  const activeInTier = (tier: number, unvisitedOnly = false) =>
    states.filter(
      (state) =>
        state.tier === tier &&
        !state.exhausted &&
        (!unvisitedOnly || state.nextOffset === 0),
    );
  const productiveStates = (maximumTier: number) =>
    states
      .filter(
        (state) =>
          state.tier <= maximumTier &&
          !state.exhausted &&
          state.totalYield > 0 &&
          state.zeroYieldStreak < 2,
      )
      .sort(
        (left, right) =>
          right.lastYield - left.lastYield ||
          right.totalYield - left.totalYield ||
          left.tier - right.tier,
      );

  // Start with compact, high-intent wording. Productive variants get one
  // additional page before broader geography is introduced. This cuts the
  // common-case request count without removing any exhaustive fallback.
  await runCandidates(activeInTier(0, true));
  if (canContinue()) await runCandidates(productiveStates(0));

  // Add broad regional and TLD coverage only when the primary wording did not
  // satisfy the requested total, then deepen variants that proved useful.
  if (canContinue()) await runCandidates(activeInTier(1, true));
  for (let round = 0; round < 2 && canContinue(); round++) {
    const productive = productiveStates(1);
    if (productive.length === 0) break;
    await runCandidates(productive);
  }

  // The region-by-intent cross product is expensive and therefore remains the
  // final discovery expansion. It is still available when the target requires
  // exhaustive coverage.
  if (canContinue()) await runCandidates(activeInTier(2, true));

  // Spend any remaining allowance on the best-yielding active variants. A
  // bounded window re-ranks after every group so duplicate-heavy queries do
  // not consume the rest of the request budget.
  while (canContinue()) {
    const ranked = states
      .filter((state) => !state.exhausted)
      .sort(
        (left, right) =>
          Number(left.nextOffset === 0) - Number(right.nextOffset === 0) ||
          left.zeroYieldStreak - right.zeroYieldStreak ||
          right.lastYield - left.lastYield ||
          right.totalYield - left.totalYield ||
          left.tier - right.tier,
      );
    if (ranked.length === 0) break;
    await runCandidates(
      ranked.slice(0, Math.max(BRAVE_SEARCH_CONCURRENCY, 12)),
    );
  }
  reportProgress();

  return {
    results,
    requests,
    failedRequests,
    excluded,
    stopReason:
      results.length >= target
        ? "TARGET_REACHED"
        : providerDegraded
          ? "PROVIDER_DEGRADED"
          : requests >= MAX_BRAVE_SEARCH_REQUESTS
            ? "REQUEST_LIMIT_REACHED"
            : "RESULTS_EXHAUSTED",
  };
}
