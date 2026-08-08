import { isExcludedBusinessSearchResult } from "./business-filter.js";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const PAGE_SIZE = 20;
export const MAX_BRAVE_SEARCH_REQUESTS = Math.max(
  1,
  Math.min(500, Number(process.env.BRAVE_MAX_REQUESTS || 60)),
);
export const MAX_SEARCH_TARGET_RESULTS = Math.max(
  1_000,
  Math.min(50_000, Number(process.env.MAX_SEARCH_TARGET_RESULTS || 5_000)),
);
const MAX_PAGES_PER_VARIANT = 3;
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

function buildQueryVariants(query: string) {
  const core = query
    .split(/\s+/)
    .filter((word) => !DISCOVERY_STOP_WORDS.has(word.toLowerCase()))
    .join(" ")
    .trim();
  const subject = core || query;
  return [
    query,
    subject,
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
  ].filter((value, index, values) => values.indexOf(value) === index);
}

type BraveWebResult = {
  title?: string;
  url?: string;
};

type BraveResponse = {
  web?: { results?: BraveWebResult[] };
};

export type DiscoveredSearchResult = {
  title: string;
  url: string;
  position: number;
};

export class SearchProviderError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = "SearchProviderError";
    this.statusCode = statusCode;
  }
}

export function braveSearchConfigured() {
  return Boolean(process.env.BRAVE_SEARCH_API_KEY?.trim());
}

export async function searchBrave(
  query: string,
  maxResults: number,
): Promise<{
  results: DiscoveredSearchResult[];
  requests: number;
  excluded: number;
}> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey)
    throw new SearchProviderError(
      "Brave Search is not configured. Add BRAVE_SEARCH_API_KEY to the server environment.",
      503,
    );

  const target = Math.min(
    MAX_SEARCH_TARGET_RESULTS,
    Math.max(1, Math.trunc(maxResults)),
  );
  const results: DiscoveredSearchResult[] = [];
  const seenUrls = new Set<string>();
  const seenDomains = new Set<string>();
  let requests = 0;
  let excluded = 0;

  const queryVariants = buildQueryVariants(query);

  for (const searchQuery of queryVariants) {
    for (
      let offset = 0;
      results.length < target &&
      offset < MAX_PAGES_PER_VARIANT &&
      requests < MAX_BRAVE_SEARCH_REQUESTS;
      offset++
    ) {
      const url = new URL(BRAVE_SEARCH_ENDPOINT);
      url.searchParams.set("q", searchQuery);
      // Keep page size stable because Brave's offset is a page number.
      url.searchParams.set("count", String(PAGE_SIZE));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("safesearch", "moderate");
      url.searchParams.set("spellcheck", "1");

      let response: Response;
      try {
        requests++;
        response = await fetch(url, {
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": apiKey,
          },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        throw new SearchProviderError(
          error instanceof Error && error.name === "TimeoutError"
            ? "Brave Search timed out. Please try again."
            : "Brave Search could not be reached. Please try again.",
        );
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403)
          throw new SearchProviderError(
            "The Brave Search API key was rejected. Check the key or subscription.",
            502,
          );
        if (response.status === 429)
          throw new SearchProviderError(
            "Brave Search rate limit or monthly allowance reached. Try again later or check the Brave dashboard.",
            429,
          );
        throw new SearchProviderError(
          `Brave Search returned an error (${response.status}). Please try again.`,
        );
      }

      const payload = (await response.json()) as BraveResponse;
      const page = payload.web?.results ?? [];
      for (const item of page) {
        if (!item.url) continue;
        try {
          const parsed = new URL(item.url);
          if (!["http:", "https:"].includes(parsed.protocol)) continue;
          parsed.hash = "";
          const normalized = parsed.toString();
          const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
          if (seenUrls.has(normalized) || seenDomains.has(hostname)) continue;
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
          seenDomains.add(hostname);
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
      if (page.length === 0) break;
    }
    if (results.length >= target || requests >= MAX_BRAVE_SEARCH_REQUESTS)
      break;
  }

  return { results, requests, excluded };
}
