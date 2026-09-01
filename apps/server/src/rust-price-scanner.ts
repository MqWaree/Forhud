import { createHash } from "node:crypto";
import { prisma } from "./db.js";
import {
  classifyFetchError,
  fetchPage,
  robotsAllows,
  type FetchAttempt,
  type RedirectHop,
} from "./crawler.js";
import { emit } from "./events.js";
import type { RustPriceDetection } from "./scraper-client.js";
import {
  convertMinorUnits,
  getCurrencyRates,
  type DisplayCurrency,
} from "./currency-rates.js";
import type { MarketProduct } from "./market-products.js";
import { canonicalSiteKey } from "@lead/shared";

export type RustPriceScannerSettings = {
  crawlerConcurrency: number;
  timeoutSeconds: number;
  retries: number;
  dynamicFallback: boolean;
  robotsRespect: boolean;
  maxPages?: number;
};

const activeRuns = new Map<string, Promise<void>>();

export async function bootstrapRustPriceScanner() {
  await prisma.rustPriceSource.updateMany({
    where: { scanStatus: "Scanning" },
    data: {
      scanStatus: "Pending",
      error: "Recovered after application restart",
    },
  });
  await prisma.rustPriceScanDiagnostic.updateMany({
    where: { status: "Scanning" },
    data: {
      status: "Failed",
      outcomeCode: "APPLICATION_RESTARTED",
      errorCode: "APPLICATION_RESTARTED",
      error:
        "Scan interrupted by application restart; source returned to the pending queue",
      completedAt: new Date(),
    },
  });
  await prisma.rustPriceScannerState.updateMany({
    where: { status: { in: ["RUNNING", "STOPPING", "ERROR"] } },
    data: {
      status: "STOPPED",
      stopRequested: false,
      currentSourceId: null,
      stoppedAt: new Date(),
    },
  });
}

type RustPricePageDiagnostic = {
  requestedUrl: string;
  finalUrl?: string;
  outcome: string;
  httpStatus?: number;
  contentType?: string;
  fetchMode?: string;
  staticFetchResult?: string;
  dynamicFetchResult?: string;
  dynamicError?: string;
  durationMs: number;
  looksDynamic?: boolean;
  soft404?: boolean;
  listingsExtracted: number;
  extractionMethods?: Record<string, number>;
  listingSamples?: Array<{
    name: string;
    priceText: string;
    link: string;
    method: string;
  }>;
  internalLinksFound: number;
  priorityLinksQueued: number;
  attempts: FetchAttempt[];
  redirects: RedirectHop[];
  errorCode?: string;
  error?: string;
};

type RustPriceDiagnosticReport = {
  version: 1;
  source: { originalUrl: string; normalizedUrl: string; domain: string };
  settings: {
    timeoutSeconds: number;
    retries: number;
    dynamicFallback: boolean;
    robotsRespect: boolean;
    maxPages: number;
  };
  pages: RustPricePageDiagnostic[];
  summary?: {
    status: string;
    outcomeCode: string;
    pagesChecked: number;
    listingsFound: number;
    durationMs: number;
    errorCode?: string;
    error?: string;
  };
};

function safeDiagnosticUrl(value: string) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (
        /(?:token|key|auth|session|password|passwd|signature|secret|code)/i.test(
          key,
        )
      )
        url.searchParams.set(key, "[REDACTED]");
    }
    return url.toString();
  } catch {
    return "[INVALID_URL]";
  }
}

function safeDiagnosticMessage(value: string) {
  return value
    .replace(/(?:bearer\s+)[a-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /([?&](?:token|key|auth|session|password|signature|secret|code)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    )
    .slice(0, 1_000);
}

function safeAttempts(attempts: FetchAttempt[] = []) {
  return attempts.map((attempt) => ({
    ...attempt,
    url: safeDiagnosticUrl(attempt.url),
    ...(attempt.error ? { error: safeDiagnosticMessage(attempt.error) } : {}),
  }));
}

function safeRedirects(redirects: RedirectHop[] = []) {
  return redirects.map((redirect) => ({
    ...redirect,
    url: safeDiagnosticUrl(redirect.url),
    location: safeDiagnosticUrl(redirect.location),
  }));
}

export function rustListingFingerprint(
  hit: Pick<RustPriceDetection, "link" | "name">,
) {
  let link = hit.link.toLowerCase().replace(/\/$/, "");
  try {
    const normalized = new URL(hit.link);
    normalized.username = "";
    normalized.password = "";
    normalized.hash = "";
    for (const key of [...normalized.searchParams.keys()])
      if (/^(?:utm_.+|fbclid|gclid|msclkid|ref|referrer|source)$/i.test(key))
        normalized.searchParams.delete(key);
    normalized.searchParams.sort();
    normalized.pathname = normalized.pathname.replace(/\/$/, "") || "/";
    link = normalized.toString().toLowerCase().replace(/\/$/, "");
  } catch {
    /* The scraper already rejects non-public URLs; keep deterministic fallback. */
  }
  return createHash("sha256")
    .update(
      [link, hit.name.toLowerCase().replace(/\s+/g, " ").trim()].join("|"),
    )
    .digest("hex");
}

export function summarizeRustMarket(
  listings: Array<{
    priceAmount: number;
    currency: string;
    link: string;
    sourceId: string;
  }>,
) {
  const marketByCurrency = new Map<string, number[]>();
  for (const listing of listings) {
    const currency = listing.currency.trim().toUpperCase() || "OTHER";
    const prices = marketByCurrency.get(currency) ?? [];
    prices.push(listing.priceAmount);
    marketByCurrency.set(currency, prices);
  }
  const currencies = [...marketByCurrency.entries()]
    .map(([currency, unsortedPrices]) => {
      const prices = [...unsortedPrices].sort((a, b) => a - b);
      const middle = Math.floor(prices.length / 2);
      const medianMinor =
        prices.length % 2
          ? prices[middle]!
          : Math.round((prices[middle - 1]! + prices[middle]!) / 2);
      return {
        currency,
        listings: prices.length,
        lowestMinor: prices[0]!,
        medianMinor,
        averageMinor: Math.round(
          prices.reduce((sum, price) => sum + price, 0) / prices.length,
        ),
        highestMinor: prices[prices.length - 1]!,
      };
    })
    .sort(
      (a, b) => b.listings - a.listings || a.currency.localeCompare(b.currency),
    );
  return {
    totalListings: listings.length,
    publicLinks: new Set(listings.map((listing) => listing.link)).size,
    sourcesRepresented: new Set(listings.map((listing) => listing.sourceId))
      .size,
    currencies,
  };
}

export function summarizeConvertedMarket(
  prices: number[],
  currency: DisplayCurrency,
) {
  const sorted = [...prices].sort((a, b) => a - b);
  if (!sorted.length)
    return {
      currency,
      listings: 0,
      lowestMinor: 0,
      medianMinor: 0,
      averageMinor: 0,
      highestMinor: 0,
    };
  const middle = Math.floor(sorted.length / 2);
  const medianMinor =
    sorted.length % 2
      ? sorted[middle]!
      : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
  return {
    currency,
    listings: sorted.length,
    lowestMinor: sorted[0]!,
    medianMinor,
    averageMinor: Math.round(
      sorted.reduce((sum, price) => sum + price, 0) / sorted.length,
    ),
    highestMinor: sorted[sorted.length - 1]!,
  };
}

type NfaProviderSource = {
  id: string;
  domain: string;
  title: string;
  url: string;
  finalUrl: string;
  scanStatus: string;
  scannedAt: Date | null;
  updatedAt: Date;
};

export function summarizeNfaProviders(
  sources: NfaProviderSource[],
  listings: Array<{ sourceId: string; convertedPriceAmount?: number }>,
  currency: DisplayCurrency,
) {
  const sourceListings = new Map<
    string,
    Array<{ convertedPriceAmount?: number }>
  >();
  for (const listing of listings) {
    const rows = sourceListings.get(listing.sourceId) ?? [];
    rows.push(listing);
    sourceListings.set(listing.sourceId, rows);
  }

  const grouped = new Map<string, NfaProviderSource[]>();
  for (const source of sources) {
    let providerKey = source.domain.toLowerCase().replace(/^www\d*\./, "");
    try {
      providerKey = canonicalSiteKey(source.finalUrl || source.url);
    } catch {}
    const rows = grouped.get(providerKey) ?? [];
    rows.push(source);
    grouped.set(providerKey, rows);
  }

  return [...grouped.entries()]
    .map(([domain, providerSources]) => {
      const latest = [...providerSources].sort(
        (a, b) =>
          (b.scannedAt?.getTime() ?? b.updatedAt.getTime()) -
          (a.scannedAt?.getTime() ?? a.updatedAt.getTime()),
      )[0]!;
      const providerListings = providerSources.flatMap(
        (source) => sourceListings.get(source.id) ?? [],
      );
      const prices = providerListings.flatMap((listing) =>
        listing.convertedPriceAmount === undefined
          ? []
          : [listing.convertedPriceAmount],
      );
      const priceStats = summarizeConvertedMarket(prices, currency);
      let url = latest.finalUrl || latest.url;
      try {
        const parsed = new URL(url);
        url = `${parsed.protocol}//${parsed.host}/`;
      } catch {}
      return {
        domain,
        title: latest.title,
        url,
        scanStatus: latest.scanStatus,
        stock: providerListings.length,
        sourceCount: providerSources.length,
        currency,
        convertedListings: priceStats.listings,
        lowestPriceMinor: priceStats.listings
          ? priceStats.lowestMinor
          : undefined,
        averagePriceMinor: priceStats.listings
          ? priceStats.averageMinor
          : undefined,
        highestPriceMinor: priceStats.listings
          ? priceStats.highestMinor
          : undefined,
        lastScannedAt: (latest.scannedAt ?? latest.updatedAt).toISOString(),
      };
    })
    .sort((a, b) => b.stock - a.stock || a.domain.localeCompare(b.domain));
}

export function listingCategory(name: string) {
  const compact = name.replace(/\s+/g, " ").trim();
  const hours = compact.match(
    /\b(\d+(?:\s*[-–—]\s*\d+|\s*[kK]?\+))\s*(?:hours?|hrs?)\b/i,
  );
  if (hours) return `${hours[1]!.replace(/\s+/g, "")} Hours`;
  const inactive = compact.match(/\binactive\s+(\d+)\s+days?\b/i);
  if (inactive) return `Inactive ${inactive[1]} Days`;
  const level = compact.match(/\blevel\s*(\d+(?:\s*[-–—]\s*\d+|\s*\+))\b/i);
  if (level) return `Level ${level[1]!.replace(/\s+/g, "")}`;
  if (/\bpremium\b/i.test(compact)) return "Premium";
  if (/\binventory\b/i.test(compact)) return "Inventory";
  if (/\b(?:full access|fa)\b/i.test(compact)) return "Full access";
  if (/\baged\b/i.test(compact)) return "Aged";
  if (/\bbasic\b/i.test(compact)) return "Basic";
  if (/\brandom\b/i.test(compact)) return "Random";
  return "Other";
}

export function summarizeCategoryMarkets(
  listings: Array<{ name: string; convertedPriceAmount: number }>,
  currency: DisplayCurrency,
  minimumListings = 3,
) {
  const categories = new Map<string, number[]>();
  for (const listing of listings) {
    const label = listingCategory(listing.name);
    const prices = categories.get(label) ?? [];
    prices.push(listing.convertedPriceAmount);
    categories.set(label, prices);
  }
  return [...categories.entries()]
    .filter(([, prices]) => prices.length >= minimumListings)
    .map(([category, prices]) => ({
      category,
      ...summarizeConvertedMarket(prices, currency),
    }))
    .sort(
      (a, b) => b.listings - a.listings || a.category.localeCompare(b.category),
    );
}

function statusForError(message: string) {
  if (/timeout|timed out|abort/i.test(message)) return "Timeout";
  if (
    /blocked|private|internal|robots|cross-domain|HTTP (?:403|429)/i.test(
      message,
    )
  )
    return "Blocked";
  return "Failed";
}

function pricePriority(url: string, productName = "") {
  try {
    const path = new URL(url).pathname;
    const productTerms = productName
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(
        (term) =>
          term.length >= 3 &&
          !/^(?:the|and|for|items?|games?|accounts?)$/.test(term),
      );
    return (
      /(?:^|[-_/])(?:rust|accounts?|shop|store|market|catalog|products?|inventory|items?|offers?|pricing)(?:[-_/.]|$)/i.test(
        path,
      ) || productTerms.some((term) => path.toLowerCase().includes(term))
    );
  } catch {
    return false;
  }
}

async function saveDetection(
  workspaceId: string,
  sourceId: string,
  productKey: string,
  hit: RustPriceDetection,
) {
  const key = rustListingFingerprint(hit);
  const existing = await prisma.rustAccountListing.findUnique({
    where: {
      workspaceId_productKey_fingerprint: {
        workspaceId,
        productKey,
        fingerprint: key,
      },
    },
    include: { snapshots: { orderBy: { observedAt: "desc" }, take: 1 } },
  });
  const listing = await prisma.rustAccountListing.upsert({
    where: {
      workspaceId_productKey_fingerprint: {
        workspaceId,
        productKey,
        fingerprint: key,
      },
    },
    create: {
      workspaceId,
      productKey,
      sourceId,
      fingerprint: key,
      name: hit.name,
      priceAmount: hit.priceMinor,
      currency: hit.currency,
      priceText: hit.priceText,
      accountType: "",
      seller: "",
      availability: "",
      link: hit.link,
      sourcePage: "",
      method: hit.method,
      snapshots: {
        create: { priceMinor: hit.priceMinor, currency: hit.currency },
      },
    },
    update: {
      sourceId,
      name: hit.name,
      priceAmount: hit.priceMinor,
      currency: hit.currency,
      priceText: hit.priceText,
      accountType: "",
      seller: "",
      availability: "",
      link: hit.link,
      sourcePage: "",
      method: hit.method,
      active: true,
    },
  });
  const previous = existing?.snapshots[0];
  if (
    existing &&
    (!previous ||
      previous.priceMinor !== hit.priceMinor ||
      previous.currency !== hit.currency)
  ) {
    await prisma.rustPriceSnapshot.create({
      data: {
        listingId: listing.id,
        priceMinor: hit.priceMinor,
        currency: hit.currency,
      },
    });
  }
  return Boolean(existing);
}

async function stopped(workspaceId: string) {
  return Boolean(
    (
      await prisma.rustPriceScannerState.findUnique({
        where: { workspaceId },
        select: { stopRequested: true },
      })
    )?.stopRequested,
  );
}

async function scanSource(
  workspaceId: string,
  sourceId: string,
  settings: RustPriceScannerSettings,
) {
  const source = await prisma.rustPriceSource.findFirst({
    where: { id: sourceId, workspaceId },
  });
  if (!source) return;
  const started = Date.now();
  await prisma.rustPriceSource.update({
    where: { id: source.id },
    data: { scanStatus: "Scanning", error: null },
  });
  await prisma.rustPriceScannerState.update({
    where: { workspaceId },
    data: { currentSourceId: source.id },
  });
  emit(
    "rust-price-progress",
    { id: source.id, domain: source.domain, status: "Scanning" },
    workspaceId,
  );

  const maxPages = Math.max(1, Math.min(8, settings.maxPages ?? 4));
  const queue = [source.normalizedUrl];
  const visited = new Set<string>();
  const seenHits = new Set<string>();
  let rootTitle = source.title;
  let rootStatus: number | undefined;
  let rootFinalUrl = source.normalizedUrl;
  let rootFetchMode = "";
  let currentUrl = source.normalizedUrl;
  let currentPageStarted = started;
  const startedAt = new Date(started);
  const report: RustPriceDiagnosticReport = {
    version: 1,
    source: {
      originalUrl: safeDiagnosticUrl(source.url),
      normalizedUrl: safeDiagnosticUrl(source.normalizedUrl),
      domain: source.domain,
    },
    settings: {
      timeoutSeconds: settings.timeoutSeconds,
      retries: settings.retries,
      dynamicFallback: settings.dynamicFallback,
      robotsRespect: settings.robotsRespect,
      maxPages,
    },
    pages: [],
  };
  const diagnostic = await prisma.rustPriceScanDiagnostic.create({
    data: {
      workspaceId,
      sourceId: source.id,
      status: "Scanning",
      outcomeCode: "RUNNING",
      durationMs: 0,
      reportJson: JSON.stringify(report),
      startedAt,
    },
  });

  try {
    while (
      queue.length &&
      visited.size < maxPages &&
      !(await stopped(workspaceId))
    ) {
      const url = queue.shift()!;
      currentUrl = url;
      currentPageStarted = Date.now();
      if (visited.has(url)) continue;
      visited.add(url);
      if (
        settings.robotsRespect &&
        !(await robotsAllows(url, settings.timeoutSeconds * 1_000))
      ) {
        report.pages.push({
          requestedUrl: safeDiagnosticUrl(url),
          outcome: "ROBOTS_DISALLOWED",
          durationMs: 0,
          listingsExtracted: 0,
          internalLinksFound: 0,
          priorityLinksQueued: 0,
          attempts: [],
          redirects: [],
        });
        if (visited.size === 1) {
          const root = new URL(url).origin + "/";
          if (root !== url && !visited.has(root)) queue.unshift(root);
        }
        continue;
      }
      const page = await fetchPage(url, {
        timeoutMs: settings.timeoutSeconds * 1_000,
        redirects: 5,
        dynamicFallback: settings.dynamicFallback,
        retries: settings.retries,
        allowedHostname: source.domain,
        discoveryMode: "rust-price",
        product: { name: source.productName, type: source.productType },
      });
      if (visited.size === 1) {
        rootTitle = page.title;
        rootStatus = page.httpStatus;
        rootFinalUrl = page.finalUrl;
        rootFetchMode = page.fetchMode;
      }
      if (page.httpStatus >= 400) {
        report.pages.push({
          requestedUrl: safeDiagnosticUrl(url),
          finalUrl: safeDiagnosticUrl(page.finalUrl),
          outcome: `HTTP_${page.httpStatus}`,
          httpStatus: page.httpStatus,
          contentType: page.contentType,
          fetchMode: page.fetchMode,
          staticFetchResult: page.staticFetchResult,
          dynamicFetchResult: page.dynamicFetchResult,
          dynamicError: safeDiagnosticMessage(page.dynamicError),
          durationMs: page.durationMs,
          looksDynamic: page.looksDynamic,
          soft404: page.isSoft404,
          listingsExtracted: page.rustPriceListings.length,
          internalLinksFound: page.internalLinks.length,
          priorityLinksQueued: 0,
          attempts: safeAttempts(page.attempts),
          redirects: safeRedirects(page.redirectChain),
        });
        if (visited.size === 1) {
          const root = new URL(url).origin + "/";
          if (root !== url && !visited.has(root)) queue.unshift(root);
        }
        continue;
      }
      for (const hit of page.rustPriceListings) {
        const key = rustListingFingerprint(hit);
        if (seenHits.has(key)) continue;
        seenHits.add(key);
        await saveDetection(workspaceId, source.id, source.productKey, hit);
      }
      let queuedFromPage = 0;
      if (queue.length < maxPages) {
        for (const candidate of page.internalLinks) {
          if (
            pricePriority(candidate, source.productName) &&
            !visited.has(candidate) &&
            !queue.includes(candidate)
          ) {
            queue.push(candidate);
            queuedFromPage++;
          }
          if (queue.length >= maxPages) break;
        }
      }
      const extractionMethods = page.rustPriceListings.reduce<
        Record<string, number>
      >((methods, listing) => {
        methods[listing.method] = (methods[listing.method] || 0) + 1;
        return methods;
      }, {});
      const pageOutcome = page.rustPriceListings.length
        ? "LISTINGS_FOUND"
        : page.isSoft404
          ? "SOFT_404"
          : !/html|xhtml/i.test(page.contentType)
            ? "NON_HTML"
            : page.dynamicFetchResult === "FAILED"
              ? "DYNAMIC_RENDER_FAILED"
              : "NO_LISTINGS_ON_PAGE";
      report.pages.push({
        requestedUrl: safeDiagnosticUrl(url),
        finalUrl: safeDiagnosticUrl(page.finalUrl),
        outcome: pageOutcome,
        httpStatus: page.httpStatus,
        contentType: page.contentType,
        fetchMode: page.fetchMode,
        staticFetchResult: page.staticFetchResult,
        dynamicFetchResult: page.dynamicFetchResult,
        dynamicError: safeDiagnosticMessage(page.dynamicError),
        durationMs: page.durationMs,
        looksDynamic: page.looksDynamic,
        soft404: page.isSoft404,
        listingsExtracted: page.rustPriceListings.length,
        extractionMethods,
        listingSamples: page.rustPriceListings.slice(0, 20).map((listing) => ({
          name: listing.name,
          priceText: listing.priceText,
          link: safeDiagnosticUrl(listing.link),
          method: listing.method,
        })),
        internalLinksFound: page.internalLinks.length,
        priorityLinksQueued: queuedFromPage,
        attempts: safeAttempts(page.attempts),
        redirects: safeRedirects(page.redirectChain),
      });
    }
    const paused = await stopped(workspaceId);
    const outcomeCode = paused
      ? "STOPPED_BY_USER"
      : seenHits.size
        ? "LISTINGS_FOUND"
        : report.pages.some((page) => page.outcome === "ROBOTS_DISALLOWED") &&
            report.pages.every((page) => page.outcome === "ROBOTS_DISALLOWED")
          ? "ROBOTS_RESTRICTED"
          : report.pages.some(
                (page) => page.outcome === "DYNAMIC_RENDER_FAILED",
              )
            ? "DYNAMIC_RENDER_FAILED"
            : report.pages.length &&
                report.pages.every((page) => page.outcome === "NON_HTML")
              ? "NON_HTML"
              : report.pages.length &&
                  report.pages.every((page) => page.outcome === "SOFT_404")
                ? "SOFT_404"
                : "NO_LISTINGS_FOUND";
    const status = paused
      ? "Pending"
      : outcomeCode === "ROBOTS_RESTRICTED"
        ? "Blocked"
        : ["DYNAMIC_RENDER_FAILED", "NON_HTML", "SOFT_404"].includes(
              outcomeCode,
            )
          ? "Failed"
          : "Completed";
    const reachedUsableMarketPage = report.pages.some((page) =>
      ["LISTINGS_FOUND", "NO_LISTINGS_ON_PAGE"].includes(page.outcome),
    );
    if (!paused && reachedUsableMarketPage) {
      await prisma.rustAccountListing.updateMany({
        where: {
          workspaceId,
          productKey: source.productKey,
          sourceId: source.id,
          active: true,
          ...(seenHits.size ? { fingerprint: { notIn: [...seenHits] } } : {}),
        },
        data: { active: false },
      });
    }
    const durationMs = Date.now() - started;
    report.summary = {
      status,
      outcomeCode,
      pagesChecked: visited.size,
      listingsFound: seenHits.size,
      durationMs,
    };
    await prisma.rustPriceSource.update({
      where: { id: source.id },
      data: {
        title: rootTitle,
        scanStatus: status,
        fetchMode: rootFetchMode,
        httpStatus: rootStatus,
        finalUrl: rootFinalUrl,
        pagesChecked: visited.size,
        durationMs,
        error:
          status === "Completed" || status === "Pending" ? null : outcomeCode,
        scannedAt: paused ? null : new Date(),
      },
    });
    await prisma.rustPriceScanDiagnostic.update({
      where: { id: diagnostic.id },
      data: {
        status,
        outcomeCode,
        pagesChecked: visited.size,
        listingsFound: seenHits.size,
        durationMs,
        reportJson: JSON.stringify(report),
        completedAt: new Date(),
      },
    });
    emit(
      "rust-price-progress",
      {
        id: source.id,
        domain: source.domain,
        status,
        listings: seenHits.size,
        pagesChecked: visited.size,
      },
      workspaceId,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scan failed";
    const status = statusForError(message);
    const failure = error as Error & {
      attempts?: FetchAttempt[];
      redirectChain?: RedirectHop[];
    };
    const errorCode = classifyFetchError(message);
    const durationMs = Date.now() - started;
    report.pages.push({
      requestedUrl: safeDiagnosticUrl(currentUrl),
      outcome: "FETCH_FAILED",
      durationMs: Date.now() - currentPageStarted,
      listingsExtracted: 0,
      internalLinksFound: 0,
      priorityLinksQueued: 0,
      attempts: safeAttempts(failure.attempts),
      redirects: safeRedirects(failure.redirectChain),
      errorCode,
      error: safeDiagnosticMessage(message),
    });
    report.summary = {
      status,
      outcomeCode: errorCode,
      pagesChecked: visited.size,
      listingsFound: seenHits.size,
      durationMs,
      errorCode,
      error: safeDiagnosticMessage(message),
    };
    await prisma.rustPriceSource.update({
      where: { id: source.id },
      data: {
        scanStatus: status,
        pagesChecked: visited.size,
        durationMs,
        error: safeDiagnosticMessage(message).slice(0, 500),
        scannedAt: new Date(),
      },
    });
    await prisma.rustPriceScanDiagnostic.update({
      where: { id: diagnostic.id },
      data: {
        status,
        outcomeCode: errorCode,
        pagesChecked: visited.size,
        listingsFound: seenHits.size,
        durationMs,
        errorCode,
        error: safeDiagnosticMessage(message),
        reportJson: JSON.stringify(report),
        completedAt: new Date(),
      },
    });
    emit(
      "rust-price-progress",
      { id: source.id, domain: source.domain, status, error: message },
      workspaceId,
    );
  }
}

async function runQueue(
  workspaceId: string,
  settings: RustPriceScannerSettings,
) {
  const concurrency = Math.max(1, Math.min(12, settings.crawlerConcurrency));
  try {
    while (!(await stopped(workspaceId))) {
      const batch = await prisma.rustPriceSource.findMany({
        where: { workspaceId, scanStatus: "Pending" },
        orderBy: { createdAt: "asc" },
        take: concurrency,
        select: { id: true },
      });
      if (!batch.length) break;
      await Promise.all(
        batch.map((source) => scanSource(workspaceId, source.id, settings)),
      );
    }
    const wasStopped = await stopped(workspaceId);
    await prisma.rustPriceScannerState.update({
      where: { workspaceId },
      data: {
        status: wasStopped ? "STOPPED" : "COMPLETED",
        currentSourceId: null,
        stoppedAt: new Date(),
      },
    });
    emit(
      "rust-price-state",
      { status: wasStopped ? "STOPPED" : "COMPLETED" },
      workspaceId,
    );
  } catch (error) {
    await prisma.rustPriceScannerState.update({
      where: { workspaceId },
      data: { status: "ERROR", currentSourceId: null, stoppedAt: new Date() },
    });
    emit(
      "rust-price-state",
      {
        status: "ERROR",
        error: error instanceof Error ? error.message : "Queue failed",
      },
      workspaceId,
    );
  } finally {
    activeRuns.delete(workspaceId);
  }
}

export async function startRustPriceScanner(
  workspaceId: string,
  settings: RustPriceScannerSettings,
) {
  const state = await prisma.rustPriceScannerState.upsert({
    where: { workspaceId },
    create: { workspaceId, status: "RUNNING", startedAt: new Date() },
    update: {
      status: "RUNNING",
      stopRequested: false,
      startedAt: new Date(),
      stoppedAt: null,
    },
  });
  if (!activeRuns.has(workspaceId)) {
    const run = runQueue(workspaceId, settings);
    activeRuns.set(workspaceId, run);
    void run;
  }
  emit("rust-price-state", { status: "RUNNING" }, workspaceId);
  return state;
}

export async function stopRustPriceScanner(workspaceId: string) {
  const state = await prisma.rustPriceScannerState.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      status: "STOPPED",
      stopRequested: true,
      stoppedAt: new Date(),
    },
    update: { status: "STOPPING", stopRequested: true },
  });
  emit("rust-price-state", { status: state.status }, workspaceId);
  return state;
}

export async function rustPriceSnapshot(
  workspaceId: string,
  page: number,
  pageSize: number,
  search: string,
  options: {
    preset?: string;
    minPrice?: number;
    maxPrice?: number;
    sort?: string;
    displayCurrency?: DisplayCurrency;
    product?: MarketProduct;
  } = {},
) {
  const product = options.product ?? {
    key: "rust-nfa-accounts",
    name: "Rust NFA accounts",
    type: "RUST_NFA",
  };
  const displayCurrency = options.displayCurrency ?? "USD";
  const exchangeRates = await getCurrencyRates();
  const presetTerms: Record<string, string> = {
    Hours: "Hours",
    Inactive: "Inactive",
    Premium: "Premium",
    Inventory: "Inventory",
  };
  const nameConditions: Array<Record<string, unknown>> = [];
  if (search.trim()) nameConditions.push({ name: { contains: search.trim() } });
  if (presetTerms[options.preset || ""])
    nameConditions.push({
      name: { contains: presetTerms[options.preset || ""] },
    });
  if (options.preset === "Other NFA") {
    for (const term of Object.values(presetTerms))
      nameConditions.push({ NOT: { name: { contains: term } } });
  }
  const where = {
    workspaceId,
    productKey: product.key,
    active: true,
    ...(nameConditions.length ? { AND: nameConditions } : {}),
  };
  const orderBy =
    options.sort === "price-asc"
      ? { priceAmount: "asc" as const }
      : options.sort === "price-desc"
        ? { priceAmount: "desc" as const }
        : options.sort === "name-asc"
          ? { name: "asc" as const }
          : { lastSeenAt: "desc" as const };
  const [
    state,
    sources,
    matchingListings,
    sourceCount,
    completed,
    failed,
    totalListings,
    marketListings,
    providerSources,
  ] = await Promise.all([
    prisma.rustPriceScannerState.findUnique({ where: { workspaceId } }),
    prisma.rustPriceSource.findMany({
      where: { workspaceId, productKey: product.key },
      orderBy: { updatedAt: "desc" },
      take: 100,
    }),
    prisma.rustAccountListing.findMany({
      where,
      select: {
        id: true,
        name: true,
        priceAmount: true,
        currency: true,
        priceText: true,
        link: true,
      },
      orderBy,
    }),
    prisma.rustPriceSource.count({
      where: { workspaceId, productKey: product.key },
    }),
    prisma.rustPriceSource.count({
      where: { workspaceId, productKey: product.key, scanStatus: "Completed" },
    }),
    prisma.rustPriceSource.count({
      where: {
        workspaceId,
        productKey: product.key,
        scanStatus: { in: ["Failed", "Blocked", "Timeout"] },
      },
    }),
    prisma.rustAccountListing.count({
      where: { workspaceId, productKey: product.key, active: true },
    }),
    prisma.rustAccountListing.findMany({
      where: { workspaceId, productKey: product.key, active: true },
      select: {
        name: true,
        priceAmount: true,
        currency: true,
        link: true,
        sourceId: true,
      },
    }),
    prisma.rustPriceSource.findMany({
      where: { workspaceId, productKey: product.key },
      select: {
        id: true,
        domain: true,
        title: true,
        url: true,
        finalUrl: true,
        scanStatus: true,
        scannedAt: true,
        updatedAt: true,
      },
    }),
  ]);
  const convertedListings = matchingListings
    .map((listing) => ({
      ...listing,
      convertedPriceAmount: convertMinorUnits(
        listing.priceAmount,
        listing.currency,
        displayCurrency,
        exchangeRates.rates,
      ),
    }))
    .filter((listing) => {
      if (listing.convertedPriceAmount === undefined)
        return options.minPrice === undefined && options.maxPrice === undefined;
      if (
        options.minPrice !== undefined &&
        listing.convertedPriceAmount < options.minPrice
      )
        return false;
      if (
        options.maxPrice !== undefined &&
        listing.convertedPriceAmount > options.maxPrice
      )
        return false;
      return true;
    });
  if (options.sort === "price-asc")
    convertedListings.sort(
      (a, b) =>
        (a.convertedPriceAmount ?? Number.POSITIVE_INFINITY) -
        (b.convertedPriceAmount ?? Number.POSITIVE_INFINITY),
    );
  if (options.sort === "price-desc")
    convertedListings.sort(
      (a, b) =>
        (b.convertedPriceAmount ?? Number.NEGATIVE_INFINITY) -
        (a.convertedPriceAmount ?? Number.NEGATIVE_INFINITY),
    );
  const listingTotal = convertedListings.length;
  const listings = convertedListings.slice(
    (page - 1) * pageSize,
    page * pageSize,
  );
  const convertedMarketPrices = marketListings.flatMap((listing) => {
    const converted = convertMinorUnits(
      listing.priceAmount,
      listing.currency,
      displayCurrency,
      exchangeRates.rates,
    );
    return converted === undefined ? [] : [converted];
  });
  const categoryListings = marketListings.flatMap((listing) => {
    const convertedPriceAmount = convertMinorUnits(
      listing.priceAmount,
      listing.currency,
      displayCurrency,
      exchangeRates.rates,
    );
    return convertedPriceAmount === undefined
      ? []
      : [{ name: listing.name, convertedPriceAmount }];
  });
  const providerListings = marketListings.map((listing) => ({
    sourceId: listing.sourceId,
    convertedPriceAmount: convertMinorUnits(
      listing.priceAmount,
      listing.currency,
      displayCurrency,
      exchangeRates.rates,
    ),
  }));
  const storedProducts = await prisma.rustPriceSource.findMany({
    where: { workspaceId },
    distinct: ["productKey"],
    select: { productKey: true, productName: true, productType: true },
    orderBy: { createdAt: "asc" },
  });
  return {
    product,
    products: [
      { key: "rust-nfa-accounts", name: "Rust NFA accounts", type: "RUST_NFA" },
      ...storedProducts
        .filter((stored) => stored.productKey !== "rust-nfa-accounts")
        .map((stored) => ({
          key: stored.productKey,
          name: stored.productName,
          type: stored.productType,
        })),
    ],
    state: state ?? { status: "IDLE" },
    sources,
    listings,
    providers: summarizeNfaProviders(
      providerSources,
      providerListings,
      displayCurrency,
    ),
    pagination: {
      page,
      pageSize,
      total: listingTotal,
      pages: Math.max(1, Math.ceil(listingTotal / pageSize)),
    },
    stats: {
      sources: sourceCount,
      completed,
      pending: Math.max(0, sourceCount - completed - failed),
      failed,
      listings: totalListings,
    },
    conversion: {
      targetCurrency: displayCurrency,
      updatedAt: exchangeRates.updatedAt,
      fetchedAt: exchangeRates.fetchedAt,
      stale: exchangeRates.stale,
      source: exchangeRates.source,
    },
    marketStats: {
      ...summarizeRustMarket(marketListings),
      converted: summarizeConvertedMarket(
        convertedMarketPrices,
        displayCurrency,
      ),
      categories: summarizeCategoryMarkets(categoryListings, displayCurrency),
    },
  };
}

export async function rustPriceDiagnosticExport(workspaceId: string) {
  const rows = await prisma.rustPriceScanDiagnostic.findMany({
    where: { workspaceId },
    include: {
      source: {
        select: {
          url: true,
          normalizedUrl: true,
          domain: true,
          title: true,
        },
      },
    },
    orderBy: { startedAt: "desc" },
  });
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    privacy:
      "URLs have credentials removed and sensitive query values redacted. No HTML, cookies, authentication headers, API keys, or passwords are stored.",
    totalScans: rows.length,
    totals: rows.reduce(
      (totals, row) => {
        totals[
          row.status.toLowerCase() === "completed"
            ? "completed"
            : "notCompleted"
        ]++;
        totals.listingsFound += row.listingsFound;
        return totals;
      },
      { completed: 0, notCompleted: 0, listingsFound: 0 },
    ),
    scans: rows.map((row) => {
      let report: unknown = {};
      try {
        report = JSON.parse(row.reportJson);
      } catch {
        report = { parseError: "Stored diagnostic report is invalid JSON" };
      }
      return {
        id: row.id,
        sourceId: row.sourceId,
        source: {
          ...row.source,
          url: safeDiagnosticUrl(row.source.url),
          normalizedUrl: safeDiagnosticUrl(row.source.normalizedUrl),
        },
        status: row.status,
        outcomeCode: row.outcomeCode,
        pagesChecked: row.pagesChecked,
        listingsFound: row.listingsFound,
        durationMs: row.durationMs,
        errorCode: row.errorCode,
        error: row.error,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        report,
      };
    }),
  };
}

export async function deleteRustPriceResults(
  workspaceId: string,
  productKey: string,
) {
  const result = await prisma.rustAccountListing.deleteMany({
    where: { workspaceId, productKey },
  });
  emit(
    "rust-price-reset",
    { productKey, resultsDeleted: result.count },
    workspaceId,
  );
  return result.count;
}

export async function resetRustPriceScanner(
  workspaceId: string,
  productKey: string,
) {
  await stopRustPriceScanner(workspaceId);
  await prisma.$transaction([
    prisma.rustPriceSource.deleteMany({ where: { workspaceId, productKey } }),
    prisma.rustPriceScannerState.upsert({
      where: { workspaceId },
      create: { workspaceId, status: "IDLE" },
      update: {
        status: "IDLE",
        stopRequested: false,
        currentSourceId: null,
        startedAt: null,
        stoppedAt: null,
      },
    }),
  ]);
  emit("rust-price-reset", { reset: true, productKey }, workspaceId);
}
