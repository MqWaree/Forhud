import { createHash, randomUUID } from "node:crypto";
import { prisma } from "./db.js";
import { emitToUsers } from "./events.js";
import {
  convertMinorUnits,
  getCurrencyRates,
  type DisplayCurrency,
} from "./currency-rates.js";
import {
  LztApiClient,
  LztApiError,
  LztPublicClient,
  normalizeLztCurrency,
  normalizeLztItemState,
  type LztApiItem,
} from "./lzt-client.js";
import { userIdsWithRankPermission } from "./ranks.js";

const STATE_ID = "global";
const SOLD_PANEL_RETENTION_MS = 60_000;
const LEGACY_DETECTION_METRIC_THRESHOLD_MS = 3_600_000;
const workerId = `${process.pid}:${randomUUID()}`;
const configuredPollIntervalMs = Math.max(
  3_100,
  Number(process.env.LZT_POLL_INTERVAL_MS || 3_100),
);
const leaseMs = Math.max(15_000, Number(process.env.LZT_LEASE_MS || 30_000));
const maxCatchupPages = Math.max(
  2,
  Math.min(100, Number(process.env.LZT_MAX_CATCHUP_PAGES || 25)),
);
const timezone = process.env.LZT_TIMEZONE || "Europe/Copenhagen";
const maxPriceUsdMinor = Math.round(
  Number(process.env.LZT_MAX_PRICE_USD || 20) * 100,
);
function positiveEnvironmentNumber(
  value: string | undefined,
  fallback: number,
) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
const notifyBelowUsdMinor = Math.round(
  positiveEnvironmentNumber(process.env.LZT_NOTIFY_BELOW_USD, 5) * 100,
);
const notifyHighHoursBelowUsdMinor = Math.round(
  positiveEnvironmentNumber(process.env.LZT_NOTIFY_HIGH_HOURS_BELOW_USD, 6) *
    100,
);
const notifyHighHoursMinimum = Math.round(
  positiveEnvironmentNumber(process.env.LZT_NOTIFY_HIGH_HOURS_MINIMUM, 2_000),
);
const reconciliationIntervalMs = Math.max(
  300_000,
  Number(process.env.LZT_RECONCILIATION_INTERVAL_MS || 900_000),
);
let timer: NodeJS.Timeout | undefined;
let watchdog: NodeJS.Timeout | undefined;
let runningPoll = false;
const enrichmentQueue = 0;
type LztClient = LztApiClient | LztPublicClient;
let client: LztClient = process.env.LZT_API_TOKEN?.trim()
  ? new LztApiClient()
  : new LztPublicClient();

function pollIntervalMs() {
  return client instanceof LztPublicClient
    ? Math.max(60_000, configuredPollIntervalMs)
    : configuredPollIntervalMs;
}

function catchupPageLimit() {
  return client instanceof LztPublicClient
    ? Math.min(3, maxCatchupPages)
    : maxCatchupPages;
}

export type NormalizedLztItem = {
  itemId: string;
  title: string;
  itemState: string;
  publicUrl: string;
  originalPriceMinor: number;
  originalCurrency: string;
  priceEurMinor: number;
  priceUsdMinor?: number;
  conversionSource: string;
  conversionTimestamp: Date;
  gamesCount?: number;
  rustHours?: number;
  inventoryCs2EurMinor?: number;
  inventoryRustEurMinor?: number;
  inventoryTotalEurMinor?: number;
  publishedAt: Date;
  position: number;
  hash: string;
};

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function extractLztGames(item: LztApiItem) {
  const full = objectValue(item.steam_full_games);
  const list = objectValue(full?.list) ?? full;
  const games = list
    ? (Object.values(list).map(objectValue).filter(Boolean) as Record<
        string,
        unknown
      >[])
    : [];
  const uniqueIds = new Set(
    games
      .map((game) => String(game.appid ?? game.app_id ?? ""))
      .filter(Boolean),
  );
  const numberFrom = (...values: unknown[]) => {
    for (const value of values) {
      if (value === undefined || value === null || value === "") continue;
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  };
  const itemRecord = objectValue(item) ?? {};
  const gamesCount = numberFrom(
    item.steam_game_count,
    itemRecord.games_count,
    full?.total,
    uniqueIds.size || undefined,
  );
  const rust = games.find(
    (game) => Number(game.appid ?? game.app_id) === 252490,
  );
  const directHours = numberFrom(
    rust?.playtime_forever,
    rust?.hours,
    rust?.hours_played,
    itemRecord.steam_rust_playtime_forever,
    itemRecord.steam_rust_hours,
  );
  const minutes = numberFrom(
    rust?.playtime_minutes,
    itemRecord.steam_rust_playtime_minutes,
  );
  const rustHours =
    directHours !== undefined
      ? Math.round(directHours * 100) / 100
      : minutes !== undefined
        ? Math.round((minutes / 60) * 100) / 100
        : undefined;
  return {
    gamesCount:
      gamesCount !== undefined && gamesCount >= 0
        ? Math.round(gamesCount)
        : undefined,
    rustHours,
  };
}

export function convertLztEurMinor(
  value: number | null | undefined,
  displayCurrency: DisplayCurrency,
  rates: Record<string, number>,
) {
  if (value == null) return undefined;
  return convertMinorUnits(value, "EUR", displayCurrency, rates) ?? value;
}
export function convertLztRubInventoryMinor(
  value: number | null | undefined,
  displayCurrency: DisplayCurrency,
  rates: Record<string, number>,
) {
  if (value == null) return undefined;
  return convertMinorUnits(value, "RUB", displayCurrency, rates) ?? value;
}
export function extractLztInventory(item: LztApiItem) {
  const minor = (value: number | undefined) =>
    value === undefined || !Number.isFinite(value) || value < 0
      ? undefined
      : Math.round(value * 100);
  const inventoryCs2EurMinor = minor(item.steam_cs2_inv_value);
  const inventoryRustEurMinor = minor(item.steam_rust_inv_value);
  const reportedTotal = minor(item.steam_inv_value);
  const knownParts = [inventoryCs2EurMinor, inventoryRustEurMinor].filter(
    (value): value is number => value !== undefined,
  );
  return {
    inventoryCs2EurMinor,
    inventoryRustEurMinor,
    inventoryTotalEurMinor:
      reportedTotal ??
      (knownParts.length
        ? knownParts.reduce((sum, value) => sum + value, 0)
        : undefined),
  };
}

export async function normalizeLztItem(
  item: LztApiItem,
  position: number,
  now = new Date(),
): Promise<NormalizedLztItem> {
  const rates = await getCurrencyRates();
  const originalCurrency = normalizeLztCurrency(item.price_currency);
  const originalPriceMinor = Math.round(item.price * 100);
  const eurMinor = convertMinorUnits(
    originalPriceMinor,
    originalCurrency,
    "EUR",
    rates.rates,
  );
  const usdMinor = convertMinorUnits(
    originalPriceMinor,
    originalCurrency,
    "USD",
    rates.rates,
  );
  if (eurMinor === undefined || usdMinor === undefined)
    throw new LztApiError(
      "INVALID_RESPONSE",
      `Unable to convert LZT ${originalCurrency} prices`,
    );
  const games = extractLztGames(item);
  const inventory = extractLztInventory(item);
  const publishedAt = new Date(
    (item.published_date || Math.floor(now.getTime() / 1000)) * 1000,
  );
  const safeTitle = (
    item.title_en ||
    item.title ||
    `LZT Rust account ${item.item_id}`
  )
    .replace(/<[^>]*>/g, "")
    .trim();
  const itemId = String(item.item_id);
  return {
    itemId,
    title: safeTitle,
    itemState: normalizeLztItemState(item.item_state),
    publicUrl:
      item.public_url || `https://lzt.market/${encodeURIComponent(itemId)}/`,
    originalPriceMinor,
    originalCurrency,
    priceEurMinor: eurMinor,
    priceUsdMinor: usdMinor,
    conversionSource: rates.source,
    conversionTimestamp: new Date(rates.updatedAt),
    ...games,
    ...inventory,
    publishedAt,
    position,
    hash: createHash("sha256").update(JSON.stringify(item)).digest("hex"),
  };
}

export function localDate(date: Date, zone = timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const read = (type: string) =>
    parts.find((part) => part.type === type)?.value;
  return `${read("year")}-${read("month")}-${read("day")}`;
}

export function calculateLztAverage(
  rows: Array<{
    lztItemId: string;
    priceUsdMinor: number | null;
    priceEurMinor: number;
    itemState: string;
  }>,
  threshold = maxPriceUsdMinor,
) {
  const unique = new Map(rows.map((row) => [row.lztItemId, row]));
  const eligible = [...unique.values()].filter(
    (row) =>
      row.itemState === "ACTIVE" &&
      row.priceUsdMinor !== null &&
      row.priceUsdMinor <= threshold,
  );
  return {
    eligibleCount: eligible.length,
    averagePriceEurMinor: eligible.length
      ? Math.round(
          eligible.reduce((sum, row) => sum + row.priceEurMinor, 0) /
            eligible.length,
        )
      : null,
    lowestPriceEurMinor: eligible.length
      ? Math.min(...eligible.map((row) => row.priceEurMinor))
      : null,
  };
}

export function dedupeLztItems<T extends { itemId: string; publishedAt: Date }>(
  items: T[],
) {
  return [...new Map(items.map((item) => [item.itemId, item])).values()].sort(
    (a, b) => a.publishedAt.getTime() - b.publishedAt.getTime(),
  );
}

export function resolveLztSoldAt(
  previousSoldAt: Date | null,
  nextState: string,
  now = new Date(),
) {
  if (nextState === "ACTIVE") return null;
  if (nextState === "SOLD") return previousSoldAt ?? now;
  return previousSoldAt;
}

export function lztListingVisibilityWhere(
  now = new Date(),
  soldRetentionMs = SOLD_PANEL_RETENTION_MS,
) {
  return {
    OR: [
      { itemState: "ACTIVE" },
      {
        itemState: "SOLD",
        soldAt: { gte: new Date(now.getTime() - soldRetentionMs) },
      },
    ],
  };
}

export type LztAlertQualification = {
  code: "NEW_LISTING" | "CHEAP_PRICE" | "HIGH_HOURS";
  label: string;
};

export function qualifyLztListingAlert(
  priceUsdMinor: number | null | undefined,
  rustHours: number | null | undefined,
  cheapPriceUsdMinor = notifyBelowUsdMinor,
  highHoursPriceUsdMinor = notifyHighHoursBelowUsdMinor,
  highHoursMinimum = notifyHighHoursMinimum,
): LztAlertQualification {
  const validPrice =
    priceUsdMinor != null &&
    Number.isInteger(priceUsdMinor) &&
    priceUsdMinor > 0;
  if (validPrice && priceUsdMinor <= cheapPriceUsdMinor)
    return {
      code: "CHEAP_PRICE",
      label: "UNDER $" + (cheapPriceUsdMinor / 100).toFixed(2),
    };
  if (
    validPrice &&
    rustHours != null &&
    Number.isFinite(rustHours) &&
    rustHours > highHoursMinimum &&
    priceUsdMinor <= highHoursPriceUsdMinor
  )
    return {
      code: "HIGH_HOURS",
      label:
        String(highHoursMinimum) +
        "+ HRS / UNDER $" +
        (highHoursPriceUsdMinor / 100).toFixed(0),
    };
  return { code: "NEW_LISTING", label: "NEW RUST ACCOUNT" };
}

export function shouldNotifyLztListing(
  priceUsdMinor: number | null | undefined,
  rustHours?: number | null,
) {
  return Boolean(qualifyLztListingAlert(priceUsdMinor, rustHours));
}

function lztAlertWhere() {
  return { baseline: false };
}
export function pageContainsKnownLztListing(
  items: LztApiItem[],
  knownIds: ReadonlySet<string>,
) {
  return items.some((item) => knownIds.has(String(item.item_id)));
}

export function shouldRunFullLztReconciliation(
  initialized: boolean,
  lastCompleteCatchupAt: Date | null,
  now = Date.now(),
) {
  return (
    !initialized ||
    !lastCompleteCatchupAt ||
    now - lastCompleteCatchupAt.getTime() >= reconciliationIntervalMs
  );
}

export function lztDetectionLatencyMs(
  pollStartedAt: Date,
  detectedAt = new Date(),
) {
  return Math.max(0, detectedAt.getTime() - pollStartedAt.getTime());
}

export function averageLztApiRequestLatency(
  totalLatencyMs: number,
  requestCount: number,
) {
  return requestCount > 0 ? Math.round(totalLatencyMs / requestCount) : 0;
}

export function isFreshLztListing(
  publishedAt: Date,
  notifyAfter: Date | null | undefined,
) {
  return !notifyAfter || publishedAt.getTime() > notifyAfter.getTime();
}

export function hasLegacyLztLatencyMetrics(maxDetectionMs: bigint | number) {
  return Number(maxDetectionMs) > LEGACY_DETECTION_METRIC_THRESHOLD_MS;
}

async function emitLzt(type: string, data: unknown) {
  emitToUsers(type, data, await userIdsWithRankPermission("LZT_ACCESS"));
}

async function ensureState() {
  return prisma.lztTrackerState.upsert({
    where: { id: STATE_ID },
    update: {},
    create: { id: STATE_ID },
  });
}

async function acquireLease() {
  await ensureState();
  const now = new Date();
  const result = await prisma.lztTrackerState.updateMany({
    where: {
      id: STATE_ID,
      OR: [
        { leaseOwner: workerId },
        { leaseUntil: null },
        { leaseUntil: { lt: now } },
      ],
    },
    data: {
      leaseOwner: workerId,
      leaseUntil: new Date(now.getTime() + leaseMs),
    },
  });
  return result.count === 1;
}

function schedule(delay = pollIntervalMs()) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void poll(), Math.max(0, delay));
  timer.unref?.();
}

async function saveAverage(forceSnapshot = false) {
  const aggregate = await prisma.lztRustListing.aggregate({
    where: {
      itemState: "ACTIVE",
      priceUsdMinor: { not: null, lte: maxPriceUsdMinor },
    },
    _count: { _all: true },
    _avg: { priceEurMinor: true },
    _min: { priceEurMinor: true },
  });
  const average = {
    eligibleCount: aggregate._count._all,
    averagePriceEurMinor:
      aggregate._avg.priceEurMinor === null
        ? null
        : Math.round(aggregate._avg.priceEurMinor),
    lowestPriceEurMinor: aggregate._min.priceEurMinor,
  };
  const now = new Date();
  const latest = await prisma.lztMarketAverageSnapshot.findFirst({
    orderBy: { calculatedAt: "desc" },
  });
  if (
    forceSnapshot ||
    !latest ||
    now.getTime() - latest.calculatedAt.getTime() >= 300_000 ||
    localDate(latest.calculatedAt) !== localDate(now)
  )
    await prisma.lztMarketAverageSnapshot.create({
      data: {
        date: localDate(now),
        timezone,
        maxPriceUsdMinor,
        ...average,
        calculatedAt: now,
      },
    });
  await emitLzt("LZT_MARKET_AVERAGE_UPDATED", {
    ...average,
    maxPriceUsdMinor,
    calculatedAt: now.toISOString(),
  });
  return average;
}

async function processPageItems(
  items: NormalizedLztItem[],
  baseline: boolean,
  notify: boolean,
  options?: { pollStartedAt?: Date; notifyAfter?: Date | null },
) {
  let inserted = 0,
    duplicates = 0,
    notifications = 0,
    totalDetection = 0,
    maxDetection = 0;
  let enrichmentSuccesses = 0,
    enrichmentFailures = 0;
  const uniqueItems = dedupeLztItems(items);
  const existingListings = new Map(
    (
      await prisma.lztRustListing.findMany({
        where: { lztItemId: { in: uniqueItems.map((item) => item.itemId) } },
        select: { lztItemId: true, itemState: true, soldAt: true },
      })
    ).map((item) => [item.lztItemId, item]),
  );
  for (const item of uniqueItems) {
    const existing = existingListings.get(item.itemId);
    if (existing) {
      duplicates++;
      await prisma.lztRustListing.update({
        where: { lztItemId: item.itemId },
        data: {
          title: item.title,
          publicUrl: item.publicUrl,
          itemState: item.itemState,
          originalPriceMinor: item.originalPriceMinor,
          originalCurrency: item.originalCurrency,
          priceEurMinor: item.priceEurMinor,
          priceUsdMinor: item.priceUsdMinor,
          conversionSource: item.conversionSource,
          conversionTimestamp: item.conversionTimestamp,
          gamesCount: item.gamesCount,
          rustHours: item.rustHours,
          inventoryCs2EurMinor: item.inventoryCs2EurMinor,
          inventoryRustEurMinor: item.inventoryRustEurMinor,
          inventoryTotalEurMinor: item.inventoryTotalEurMinor,
          reconciliationMisses: 0,
          soldAt: resolveLztSoldAt(existing.soldAt, item.itemState),
          enriched:
            item.gamesCount !== undefined || item.rustHours !== undefined,
          enrichmentFailure:
            item.gamesCount === undefined && item.rustHours === undefined
              ? "API_ENRICHMENT_UNAVAILABLE"
              : null,
          rawResponseHash: item.hash,
          lastSeenAt: new Date(),
        },
      });
      continue;
    }
    const detectedAt = new Date();
    const qualification =
      notify && isFreshLztListing(item.publishedAt, options?.notifyAfter)
        ? qualifyLztListingAlert(item.priceUsdMinor, item.rustHours)
        : undefined;
    await prisma.$transaction(async (transaction) => {
      const listing = await transaction.lztRustListing.create({
        data: {
          lztItemId: item.itemId,
          title: item.title,
          publicUrl: item.publicUrl,
          itemState: item.itemState,
          originalPriceMinor: item.originalPriceMinor,
          originalCurrency: item.originalCurrency,
          priceEurMinor: item.priceEurMinor,
          priceUsdMinor: item.priceUsdMinor,
          conversionSource: item.conversionSource,
          conversionTimestamp: item.conversionTimestamp,
          gamesCount: item.gamesCount,
          rustHours: item.rustHours,
          inventoryCs2EurMinor: item.inventoryCs2EurMinor,
          inventoryRustEurMinor: item.inventoryRustEurMinor,
          inventoryTotalEurMinor: item.inventoryTotalEurMinor,
          soldAt: item.itemState === "SOLD" ? detectedAt : null,
          enriched:
            item.gamesCount !== undefined || item.rustHours !== undefined,
          enrichmentFailure:
            item.gamesCount === undefined && item.rustHours === undefined
              ? "API_ENRICHMENT_UNAVAILABLE"
              : null,
          publishedAt: item.publishedAt,
          firstSeenAt: detectedAt,
          lastSeenAt: detectedAt,
          originalApiPosition: item.position,
          baseline,
          rawResponseHash: item.hash,
        },
      });
      if (qualification)
        await transaction.lztHazeAlert.create({
          data: {
            listingId: listing.id,
            alertCode: qualification.code,
            alertLabel: qualification.label,
          },
        });
    });
    inserted++;
    if (qualification) {
      const detectionMs = lztDetectionLatencyMs(
        options?.pollStartedAt ?? detectedAt,
        detectedAt,
      );
      notifications++;
      totalDetection += detectionMs;
      maxDetection = Math.max(maxDetection, detectionMs);
      await emitLzt("LZT_LISTING_CREATED", {
        listing: {
          itemId: item.itemId,
          title: item.title,
          priceEurMinor: item.priceEurMinor,
          priceUsdMinor: item.priceUsdMinor,
          gamesCount: item.gamesCount ?? null,
          rustHours: item.rustHours ?? null,
          link: item.publicUrl,
          publishedAt: item.publishedAt.toISOString(),
          detectedAt: detectedAt.toISOString(),
        },
        alert: qualification,
      });
    }
    if (item.gamesCount !== undefined || item.rustHours !== undefined)
      enrichmentSuccesses++;
    else enrichmentFailures++;
  }
  if (enrichmentSuccesses || enrichmentFailures) {
    await prisma.lztTrackerState.update({
      where: { id: STATE_ID },
      data: {
        enrichmentSuccesses: enrichmentSuccesses
          ? { increment: enrichmentSuccesses }
          : undefined,
        enrichmentFailures: enrichmentFailures
          ? { increment: enrichmentFailures }
          : undefined,
      },
    });
  }
  return {
    inserted,
    duplicates,
    notifications,
    totalDetection,
    maxDetection,
  };
}

async function reconcileMissingLztListings(activeIds: string[]) {
  if (!(client instanceof LztApiClient)) return 0;
  const apiClient = client;
  const limit = Math.max(
    1,
    Math.min(60, Number(process.env.LZT_RECONCILIATION_ITEM_LIMIT || 30)),
  );
  const candidates = await prisma.lztRustListing.findMany({
    where: {
      itemState: "ACTIVE",
      ...(activeIds.length ? { lztItemId: { notIn: activeIds } } : {}),
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  let changed = 0;
  for (let offset = 0; offset < candidates.length; offset += 4) {
    const batch = candidates.slice(offset, offset + 4);
    await Promise.all(
      batch.map(async (listing) => {
        try {
          const lookup = await apiClient.getItem(listing.lztItemId);
          if (lookup.item) {
            const normalized = await normalizeLztItem(
              lookup.item,
              listing.originalApiPosition,
            );
            await processPageItems([normalized], true, false);
          }
          if (lookup.status !== "FOUND") {
            await prisma.lztRustListing.update({
              where: { id: listing.id },
              data: {
                itemState: lookup.status,
                soldAt: lookup.status === "SOLD" ? new Date() : null,
                reconciliationMisses: { increment: 1 },
              },
            });
            changed++;
          }
        } catch (error) {
          await prisma.lztRustListing.update({
            where: { id: listing.id },
            data: { reconciliationMisses: { increment: 1 } },
          });
          if (
            error instanceof LztApiError &&
            (error.code === "AUTH_ERROR" || error.code === "RATE_LIMITED")
          )
            throw error;
        }
      }),
    );
  }
  return changed;
}

async function poll() {
  if (runningPoll) return;
  runningPoll = true;
  const pollStartedAt = new Date();
  let nextDelay = pollIntervalMs();
  try {
    if (!(await acquireLease())) {
      schedule(leaseMs);
      return;
    }
    const state = await ensureState();
    if (!state.enabled || state.stopRequested) {
      await stopLztTracker();
      return;
    }
    const knownRecent = new Set(
      JSON.parse(state.recentItemIdsJson) as string[],
    );
    const collected = new Map<string, NormalizedLztItem>();
    const fullReconciliation = shouldRunFullLztReconciliation(
      state.initialized,
      state.lastCompleteCatchupAt,
    );
    const pageLimit = catchupPageLimit();
    let pageNumber = 1,
      reachedKnownPage = false,
      reachedEnd = false,
      latestLimits: Awaited<ReturnType<LztApiClient["search"]>>["rateLimit"] =
        {},
      latency = 0;
    let apiRequests = 0;
    const outcome = {
      inserted: 0,
      duplicates: 0,
      notifications: 0,
      totalDetection: 0,
      maxDetection: 0,
    };
    do {
      const result = await client.search(pageNumber);
      apiRequests++;
      latestLimits = result.rateLimit;
      latency += result.latencyMs;
      const raw = [...result.page.items, ...result.page.stickyItems].filter(
        (source) =>
          !["brute", "phishing", "stealer"].includes(source.item_origin || ""),
      );
      const ids = [...new Set(raw.map((source) => String(source.item_id)))];
      const stored = ids.length
        ? await prisma.lztRustListing.findMany({
            where: { lztItemId: { in: ids } },
            select: { lztItemId: true },
          })
        : [];
      const knownIds = new Set([
        ...knownRecent,
        ...stored.map((item) => item.lztItemId),
      ]);
      reachedKnownPage ||= pageContainsKnownLztListing(
        result.page.items,
        knownIds,
      );
      const pending = raw
        .map((source, index) => ({ source, index, id: String(source.item_id) }))
        .filter(({ id }) => !collected.has(id));
      const normalized = await Promise.allSettled(
        pending.map(({ source, index }) => normalizeLztItem(source, index)),
      );
      normalized.forEach((entry, index) => {
        if (entry.status === "fulfilled")
          collected.set(pending[index]!.id, entry.value);
      });
      const pageItems = normalized.flatMap((entry) =>
        entry.status === "fulfilled" ? [entry.value] : [],
      );
      const pageOutcome = await processPageItems(
        pageItems,
        !state.initialized && state.importBaseline,
        state.initialized ? true : state.notifyExisting,
        { pollStartedAt, notifyAfter: state.watermarkPublishedAt },
      );
      outcome.inserted += pageOutcome.inserted;
      outcome.duplicates += pageOutcome.duplicates;
      outcome.notifications += pageOutcome.notifications;
      outcome.totalDetection += pageOutcome.totalDetection;
      outcome.maxDetection = Math.max(
        outcome.maxDetection,
        pageOutcome.maxDetection,
      );
      if (!result.page.hasNextPage) {
        reachedEnd = true;
        break;
      }
      if ((!fullReconciliation && reachedKnownPage) || pageNumber >= pageLimit)
        break;
      pageNumber++;
    } while (pageNumber <= pageLimit);

    const values = [...collected.values()];
    const baseline = !state.initialized && state.importBaseline;
    const averageApiLatency = averageLztApiRequestLatency(latency, apiRequests);
    const resetLegacyMetrics = hasLegacyLztLatencyMetrics(state.maxDetectionMs);
    let inactivated = 0;
    if (fullReconciliation && reachedEnd) {
      inactivated = await reconcileMissingLztListings(
        values.map((item) => item.itemId),
      );
    }
    const recent = values
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
      .slice(0, 250)
      .map((item) => item.itemId);
    const newest = values.reduce<Date | undefined>(
      (max, item) => (!max || item.publishedAt > max ? item.publishedAt : max),
      state.watermarkPublishedAt || undefined,
    );
    await prisma.lztTrackerState.update({
      where: { id: STATE_ID },
      data: {
        state: "RUNNING",
        initialized: true,
        lastSuccessfulPollAt: new Date(),
        lastCompleteCatchupAt: fullReconciliation
          ? new Date()
          : state.lastCompleteCatchupAt,
        lastNewListingAt: outcome.notifications
          ? new Date()
          : state.lastNewListingAt,
        nextPollAt: new Date(Date.now() + pollIntervalMs()),
        watermarkPublishedAt: newest,
        recentItemIdsJson: JSON.stringify(recent),
        apiLatencyMs: averageApiLatency,
        rateLimitLimit: latestLimits.limit,
        rateLimitRemaining: latestLimits.remaining,
        rateLimitResetAt: latestLimits.resetAt,
        leaseUntil: new Date(Date.now() + leaseMs),
        pollCount: { increment: 1 },
        successfulPolls: resetLegacyMetrics ? 1 : { increment: 1 },
        newListings: resetLegacyMetrics
          ? outcome.notifications
          : { increment: outcome.notifications },
        duplicatesSkipped: { increment: outcome.duplicates },
        totalApiLatencyMs: resetLegacyMetrics
          ? averageApiLatency
          : { increment: averageApiLatency },
        totalDetectionMs: resetLegacyMetrics
          ? BigInt(outcome.totalDetection)
          : { increment: BigInt(outcome.totalDetection) },
        maxDetectionMs: resetLegacyMetrics
          ? BigInt(outcome.maxDetection)
          : state.maxDetectionMs > BigInt(outcome.maxDetection)
            ? state.maxDetectionMs
            : BigInt(outcome.maxDetection),
        lastError: null,
        lastErrorCode: null,
      },
    });
    if (outcome.inserted)
      await emitLzt("LZT_LISTINGS_UPDATED", {
        inserted: outcome.inserted,
        baseline,
        detectedAt: new Date().toISOString(),
      });
    if (outcome.inserted || inactivated) await saveAverage();
    await emitLzt("LZT_TRACKER_STATUS", await lztTrackerSnapshot());
    if (latestLimits.remaining === 0 && latestLimits.resetAt)
      nextDelay = Math.max(
        pollIntervalMs(),
        latestLimits.resetAt.getTime() - Date.now() + 250,
      );
  } catch (error) {
    const failure =
      error instanceof LztApiError
        ? error
        : new LztApiError("NETWORK_ERROR", "Unexpected tracker failure");
    const fatal = failure.code === "AUTH_ERROR";
    nextDelay = failure.retryAt
      ? Math.max(pollIntervalMs(), failure.retryAt.getTime() - Date.now() + 250)
      : failure.code === "ACCESS_CHALLENGE" || failure.code === "FORBIDDEN"
        ? 300_000
        : failure.code === "SERVER_ERROR"
          ? Math.max(30_000, pollIntervalMs())
          : Math.max(15_000, pollIntervalMs());
    await ensureState();
    await prisma.lztTrackerState.update({
      where: { id: STATE_ID },
      data: {
        state: fatal
          ? "AUTH_ERROR"
          : failure.code === "RATE_LIMITED"
            ? "RATE_LIMITED"
            : "DEGRADED",
        enabled: fatal ? false : undefined,
        lastErrorCode: failure.code,
        lastError: failure.message,
        nextPollAt: fatal ? null : new Date(Date.now() + nextDelay),
        pollCount: { increment: 1 },
        failedPolls: { increment: 1 },
        rateLimitedCount:
          failure.code === "RATE_LIMITED" ? { increment: 1 } : undefined,
      },
    });
    await emitLzt("LZT_TRACKER_ERROR", {
      code: failure.code,
      message: failure.message,
      retryAt: fatal ? null : new Date(Date.now() + nextDelay).toISOString(),
    });
    if (fatal) return;
  } finally {
    runningPoll = false;
    const state = await ensureState().catch(() => undefined);
    if (state?.enabled && !state.stopRequested) schedule(nextDelay);
  }
}

export async function bootstrapLztTracker() {
  const state = await ensureState();
  if (process.env.LZT_TRACKER_ENABLED === "true" && client.configured()) {
    await prisma.lztTrackerState.update({
      where: { id: STATE_ID },
      data: {
        enabled: true,
        stopRequested: false,
        workerRestarts: { increment: 1 },
      },
    });
    schedule(0);
  }
  if (!watchdog) {
    watchdog = setInterval(() => {
      void (async () => {
        const current = await ensureState();
        if (
          current.enabled &&
          current.lastSuccessfulPollAt &&
          Date.now() - current.lastSuccessfulPollAt.getTime() >
            Math.max(30_000, pollIntervalMs() * 2) &&
          current.state === "RUNNING"
        )
          await prisma.lztTrackerState.update({
            where: { id: STATE_ID },
            data: {
              state: "DEGRADED",
              lastErrorCode: "WATCHDOG_STALE",
              lastError: "No successful poll for 30 seconds",
            },
          });
        if (current.enabled && !timer && !runningPoll) schedule(0);
        if (current.enabled) await saveAverage().catch(() => undefined);
      })().catch(() => undefined);
    }, 10_000);
    watchdog.unref?.();
  }
  return state;
}

export async function startLztTracker(options?: {
  importBaseline?: boolean;
  notifyExisting?: boolean;
}) {
  await ensureState();
  await prisma.lztTrackerState.update({
    where: { id: STATE_ID },
    data: {
      enabled: true,
      stopRequested: false,
      state: "STARTING",
      startedAt: new Date(),
      stoppedAt: null,
      importBaseline: options?.importBaseline,
      notifyExisting: options?.notifyExisting,
    },
  });
  schedule(0);
  return lztTrackerSnapshot();
}

export async function stopLztTracker() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  await ensureState();
  await prisma.lztTrackerState.update({
    where: { id: STATE_ID },
    data: {
      enabled: false,
      stopRequested: true,
      state: "STOPPED",
      stoppedAt: new Date(),
      nextPollAt: null,
      leaseOwner: null,
      leaseUntil: null,
    },
  });
  await emitLzt("LZT_TRACKER_STATUS", await lztTrackerSnapshot());
}

export async function restartLztTracker() {
  await stopLztTracker();
  return startLztTracker();
}

export async function testLztConnection() {
  const result = await client.search(1);
  return {
    status: "Connected",
    latencyMs: result.latencyMs,
    rateLimit: result.rateLimit,
    items: result.page.items.length,
  };
}

export type LztTestAlertCriteria = {
  maximumPriceUsd: number;
  minimumGames: number;
  minimumRustHours: number;
};

export function lztTestAlertLabel(criteria: LztTestAlertCriteria) {
  return [
    "TEST",
    "≤$" + criteria.maximumPriceUsd.toFixed(2),
    `≥${criteria.minimumRustHours.toLocaleString("en-US")}H`,
    `≥${criteria.minimumGames.toLocaleString("en-US")} GAMES`,
  ].join(" • ");
}

export async function queueLztHighHoursTestAlert(
  criteria: LztTestAlertCriteria,
) {
  if (!(client instanceof LztApiClient))
    throw new LztApiError(
      "AUTH_ERROR",
      "The live Haze alert test requires the configured official LZT API",
      503,
    );
  const maximumPriceUsdMinor = Math.round(criteria.maximumPriceUsd * 100);
  const label = lztTestAlertLabel(criteria);
  const candidates: NormalizedLztItem[] = [];
  for (let pageNumber = 1; pageNumber <= 3; pageNumber++) {
    const result = await client.search(pageNumber, {
      minimumRustHours: criteria.minimumRustHours || undefined,
      maximumPriceUsd: criteria.maximumPriceUsd,
      orderBy: "price_to_up",
    });
    const normalized = await Promise.all(
      result.page.items.map((item, index) =>
        normalizeLztItem(item, (pageNumber - 1) * 20 + index + 1).catch(
          () => undefined,
        ),
      ),
    );
    candidates.push(
      ...normalized
        .filter((item): item is NormalizedLztItem => Boolean(item))
        .filter(
          (item) =>
            item.itemState === "ACTIVE" &&
            (item.rustHours === undefined ||
              item.rustHours >= criteria.minimumRustHours) &&
            (item.priceUsdMinor ?? Number.POSITIVE_INFINITY) <=
              maximumPriceUsdMinor &&
            (item.gamesCount === undefined ||
              item.gamesCount >= criteria.minimumGames),
        ),
    );
    if (!result.page.hasNextPage || candidates.length >= 10) break;
  }
  candidates.sort(
    (left, right) =>
      (left.priceUsdMinor ?? Number.POSITIVE_INFINITY) -
      (right.priceUsdMinor ?? Number.POSITIVE_INFINITY),
  );
  for (const candidate of candidates) {
    const lookup = await client.getItem(candidate.itemId);
    if (lookup.status !== "FOUND" || !lookup.item) continue;
    const verified = await normalizeLztItem(lookup.item, candidate.position);
    if (
      verified.itemState !== "ACTIVE" ||
      (verified.priceUsdMinor ?? Number.POSITIVE_INFINITY) >
        maximumPriceUsdMinor ||
      (verified.rustHours ?? 0) < criteria.minimumRustHours ||
      (verified.gamesCount ?? 0) < criteria.minimumGames
    )
      continue;
    await processPageItems([verified], false, false);
    const listing = await prisma.lztRustListing.findUniqueOrThrow({
      where: { lztItemId: verified.itemId },
    });
    const alert = await prisma.lztHazeAlert.upsert({
      where: { listingId: listing.id },
      create: {
        listingId: listing.id,
        alertCode: "TEST_CUSTOM",
        alertLabel: label,
      },
      update: {
        alertCode: "TEST_CUSTOM",
        alertLabel: label,
        status: "PENDING",
        attempts: 0,
        claimedAt: null,
        nextAttemptAt: null,
        sentAt: null,
        discordMessageId: null,
        lastError: null,
      },
    });
    await emitLzt("LZT_TEST_ALERT_QUEUED", {
      alertId: alert.id,
      itemId: verified.itemId,
      title: verified.title,
      priceUsdMinor: verified.priceUsdMinor,
      gamesCount: verified.gamesCount,
      rustHours: verified.rustHours,
      criteria,
    });
    return {
      status: "Queued",
      alertId: alert.id,
      itemId: verified.itemId,
      title: verified.title,
      priceUsdMinor: verified.priceUsdMinor,
      gamesCount: verified.gamesCount ?? 0,
      rustHours: verified.rustHours ?? 0,
      publicUrl: verified.publicUrl,
      criteria,
    };
  }
  throw new LztApiError(
    "INVALID_RESPONSE",
    "No active Rust account matches ≤$" +
      criteria.maximumPriceUsd.toFixed(2) +
      ", ≥" +
      criteria.minimumGames +
      " games, and ≥" +
      criteria.minimumRustHours +
      " hours",
    404,
  );
}

export async function retryLatestFailedHazeTestAlert() {
  const alert = await prisma.lztHazeAlert.findFirst({
    where: { status: "FAILED", alertCode: "TEST_CUSTOM" },
    orderBy: { updatedAt: "desc" },
    include: { listing: true },
  });
  if (!alert)
    throw new LztApiError(
      "INVALID_RESPONSE",
      "No failed Haze test alert is available to retry",
      404,
    );
  const retried = await prisma.lztHazeAlert.update({
    where: { id: alert.id },
    data: {
      status: "PENDING",
      attempts: 0,
      claimedAt: null,
      nextAttemptAt: null,
      sentAt: null,
      discordMessageId: null,
      lastError: null,
    },
  });
  await emitLzt("LZT_TEST_ALERT_RETRIED", {
    alertId: retried.id,
    itemId: alert.listing.lztItemId,
  });
  return {
    status: "Queued",
    alertId: retried.id,
    itemId: alert.listing.lztItemId,
  };
}

export async function recalculateLztAverage() {
  return saveAverage(true);
}

export function serializeLztTrackerState<
  T extends { totalDetectionMs: bigint; maxDetectionMs: bigint },
>(state: T) {
  return {
    ...state,
    totalDetectionMs: Number(state.totalDetectionMs),
    maxDetectionMs: Number(state.maxDetectionMs),
  };
}

export async function lztTrackerSnapshot(filters?: {
  page?: number;
  pageSize?: number;
  search?: string;
  minEur?: number;
  maxEur?: number;
  maxHours?: number;
  sort?: string;
  displayCurrency?: DisplayCurrency;
}) {
  const state = await ensureState();
  const displayCurrency = filters?.displayCurrency || "EUR";
  const page = Math.max(1, filters?.page || 1),
    pageSize = Math.max(1, Math.min(200, filters?.pageSize || 50));
  const where = {
    ...(filters?.search ? { title: { contains: filters.search } } : {}),
    ...lztListingVisibilityWhere(),
    ...(filters?.minEur !== undefined || filters?.maxEur !== undefined
      ? { priceEurMinor: { gte: filters?.minEur, lte: filters?.maxEur } }
      : {}),
    ...(filters?.maxHours !== undefined
      ? { rustHours: { lte: filters.maxHours } }
      : {}),
  };
  const orderBy =
    filters?.sort === "price-asc"
      ? { priceEurMinor: "asc" as const }
      : filters?.sort === "price-desc"
        ? { priceEurMinor: "desc" as const }
        : filters?.sort === "hours-asc"
          ? { rustHours: "asc" as const }
          : { publishedAt: "desc" as const };
  const [
    listings,
    total,
    notifications,
    notificationCount,
    latestAverage,
    rates,
    hazePending,
    hazeSent,
    hazeFailed,
    latestHazeAlert,
  ] = await Promise.all([
    prisma.lztRustListing.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.lztRustListing.count({ where }),
    prisma.lztRustListing.findMany({
      where: { ...lztAlertWhere(), ...lztListingVisibilityWhere() },
      orderBy: { firstSeenAt: "desc" },
      take: 200,
    }),
    prisma.lztRustListing.count({
      where: { ...lztAlertWhere(), ...lztListingVisibilityWhere() },
    }),
    prisma.lztMarketAverageSnapshot.findFirst({
      orderBy: { calculatedAt: "desc" },
    }),
    getCurrencyRates(),
    prisma.lztHazeAlert.count({
      where: { status: { in: ["PENDING", "SENDING"] } },
    }),
    prisma.lztHazeAlert.count({ where: { status: "SENT" } }),
    prisma.lztHazeAlert.count({ where: { status: "FAILED" } }),
    prisma.lztHazeAlert.findFirst({
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        alertCode: true,
        alertLabel: true,
        status: true,
        attempts: true,
        lastError: true,
        updatedAt: true,
      },
    }),
  ]);
  const withDisplayCurrency = <
    T extends {
      priceEurMinor: number;
      inventoryCs2EurMinor: number | null;
      inventoryRustEurMinor: number | null;
      inventoryTotalEurMinor: number | null;
    },
  >(
    listing: T,
  ) => ({
    ...listing,
    displayCurrency,
    priceDisplayMinor: convertLztEurMinor(
      listing.priceEurMinor,
      displayCurrency,
      rates.rates,
    ),
    inventoryCs2DisplayMinor: convertLztRubInventoryMinor(
      listing.inventoryCs2EurMinor,
      displayCurrency,
      rates.rates,
    ),
    inventoryRustDisplayMinor: convertLztRubInventoryMinor(
      listing.inventoryRustEurMinor,
      displayCurrency,
      rates.rates,
    ),
    inventoryTotalDisplayMinor: convertLztRubInventoryMinor(
      listing.inventoryTotalEurMinor,
      displayCurrency,
      rates.rates,
    ),
  });
  return {
    configured: client.configured(),
    displayCurrency,
    conversion: {
      updatedAt: rates.updatedAt,
      fetchedAt: rates.fetchedAt,
      stale: rates.stale,
      source: rates.source,
    },
    sourceMode:
      client instanceof LztPublicClient ? "PUBLIC_PAGE" : "OFFICIAL_API",
    state: {
      ...serializeLztTrackerState(state),
      recentItemIdsJson: undefined,
      leaseOwner: state.leaseOwner ? "active" : null,
    },
    listings: listings.map(withDisplayCurrency),
    notifications: notifications.map(withDisplayCurrency),
    notificationCount,
    pagination: {
      page,
      pageSize,
      total,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    },
    latestAverage: latestAverage
      ? {
          ...latestAverage,
          averagePriceDisplayMinor: convertLztEurMinor(
            latestAverage.averagePriceEurMinor,
            displayCurrency,
            rates.rates,
          ),
        }
      : undefined,
    queueLength: enrichmentQueue,
    pollIntervalMs: pollIntervalMs(),
    maxPriceUsdMinor,
    notifyBelowUsdMinor,
    notifyHighHoursBelowUsdMinor,
    notifyHighHoursMinimum,
    timezone,
    notifyBelowDisplayMinor:
      convertMinorUnits(
        notifyBelowUsdMinor,
        "USD",
        displayCurrency,
        rates.rates,
      ) ?? notifyBelowUsdMinor,
    notifyHighHoursBelowDisplayMinor:
      convertMinorUnits(
        notifyHighHoursBelowUsdMinor,
        "USD",
        displayCurrency,
        rates.rates,
      ) ?? notifyHighHoursBelowUsdMinor,
    haze: {
      enabled: process.env.HAZE_LZT_NOTIFICATIONS_ENABLED === "true",
      configured:
        process.env.HAZE_LZT_NOTIFICATIONS_ENABLED === "true" &&
        Boolean(process.env.DISCORD_USER_TOKEN?.trim()) &&
        /^\d{5,30}$/.test(
          process.env.HAZE_LZT_CHANNEL_ID?.trim() ||
            process.env.LZT_ALERT_CHANNEL_ID?.trim() ||
            "",
        ),
      pending: hazePending,
      sent: hazeSent,
      failed: hazeFailed,
      delivery: "HAZE_CLIENT",
      latest: latestHazeAlert || undefined,
    },
    metrics: {
      averageApiLatencyMs: state.successfulPolls
        ? Math.round(state.totalApiLatencyMs / state.successfulPolls)
        : null,
      averageDetectionLatencyMs: state.newListings
        ? Math.round(Number(state.totalDetectionMs) / state.newListings)
        : null,
      maximumDetectionLatencyMs: Number(state.maxDetectionMs),
    },
  };
}

export function replaceLztClientForTest(next: LztClient) {
  client = next;
}

export async function shutdownLztTracker() {
  if (timer) clearTimeout(timer);
  if (watchdog) clearInterval(watchdog);
  timer = undefined;
  watchdog = undefined;
  await prisma.lztTrackerState.updateMany({
    where: { leaseOwner: workerId },
    data: { leaseOwner: null, leaseUntil: null },
  });
}
