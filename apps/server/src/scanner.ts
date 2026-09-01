import type { Prisma } from "./generated/client/client.js";
import { normalizeTelegramUrl } from "@lead/shared";
import { prisma } from "./db.js";
import {
  classifyFetchError,
  fetchPage,
  robotsAllows,
  type FetchAttempt,
  type RecoveredPage,
  type RedirectHop,
} from "./crawler.js";
import {
  discoverDiscord,
  type DiscordDiscoveryReport,
} from "./discord-discovery.js";
import { emit } from "./events.js";
import {
  scraperHealth,
  type DiscordDetection,
  type ScrapedPage,
  type SocialLink,
} from "./scraper-client.js";
import { syncScannerResultToLead } from "./lead-sync.js";
import { AdaptiveConcurrencyController } from "./adaptive-concurrency.js";
import { isExcludedBusinessSearchResult } from "./business-filter.js";
import { summarizeDiscordDestinations } from "./discord-invite-reconciliation.js";

export type ScannerSettings = {
  crawlerConcurrency: number;
  adaptiveConcurrency: boolean;
  timeoutSeconds: number;
  retries: number;
  dynamicFallback: boolean;
  robotsRespect: boolean;
  deepScan: boolean;
  maxPages: number;
  maxDepth: number;
};
type QueueEntry = { url: string; depth: number };
type PageVisit = {
  url: string;
  path: string;
  depth: number;
  status: "Completed" | "Failed" | "Blocked" | "Timeout";
  httpStatus?: number;
  fetchMode?: string;
  durationMs?: number;
  error?: string;
  errorCode?: string;
  attempts?: FetchAttempt[];
  redirectChain?: RedirectHop[];
  staticFetchResult?: string;
  dynamicFetchResult?: string;
  dynamicError?: string;
};
type CrawlCheckpoint = {
  queue: QueueEntry[];
  visited: string[];
  pages: PageVisit[];
  discord: Record<string, string>;
  emails: string[];
  socials: SocialLink[];
  root?: Pick<
    ScrapedPage,
    | "title"
    | "finalUrl"
    | "httpStatus"
    | "metaDescription"
    | "canonicalUrl"
    | "faviconUrl"
    | "contentType"
    | "fetchMode"
  >;
};
type ScanOutcome = {
  status: string;
  durationMs: number;
  httpStatus?: number;
  failureReason?: string;
};

const activeRuns = new Map<string, Promise<void>>();
const activeResultIds = new Map<string, Set<string>>();
const stopStateCache = new Map<
  string,
  { expiresAt: number; stopRequested: boolean }
>();
const performanceControllers = new Map<string, AdaptiveConcurrencyController>();
let cachedEngineHealth:
  | { expiresAt: number; value: Awaited<ReturnType<typeof scraperHealth>> }
  | undefined;
const snapshotSettingsCache = new Map<
  string,
  { expiresAt: number; value: ScannerSettings }
>();

const defaultScannerSettings: ScannerSettings = {
  crawlerConcurrency: 32,
  adaptiveConcurrency: true,
  timeoutSeconds: 10,
  retries: 1,
  dynamicFallback: true,
  robotsRespect: true,
  deepScan: false,
  maxPages: 6,
  maxDepth: 2,
};

const CONTACT_FAILURE_LIMIT = 4;
const CONTACT_FAILURE_REASONS = new Set([
  "CONTACT_NOT_FOUND",
  "DISCORD_NOT_FOUND",
  "NO_DISCORD_FOUND",
]);

async function recordScannerFailure(input: {
  workspaceId: string;
  scannerResultId: string;
  status: string;
  failureReason: string;
  error: string;
  httpStatus?: number;
}) {
  const result = await prisma.scannerResult.findFirstOrThrow({
    where: { id: input.scannerResultId, workspaceId: input.workspaceId },
    select: {
      id: true,
      url: true,
      normalizedUrl: true,
      contactFailureCount: true,
      domain: { select: { hostname: true } },
    },
  });
  const isContactFailure = CONTACT_FAILURE_REASONS.has(input.failureReason);
  const contactFailureCount = isContactFailure
    ? result.contactFailureCount + 1
    : result.contactFailureCount;
  const quarantined =
    isContactFailure && contactFailureCount > CONTACT_FAILURE_LIMIT;
  await prisma.$transaction([
    prisma.scannerFailureHistory.create({
      data: {
        workspaceId: input.workspaceId,
        scannerResultId: result.id,
        url: result.url,
        normalizedUrl: result.normalizedUrl,
        domain: result.domain.hostname,
        status: input.status,
        failureReason: input.failureReason,
        error: input.error,
        httpStatus: input.httpStatus,
        contactFailureCount,
      },
    }),
    prisma.scannerResult.update({
      where: { id: result.id },
      data: quarantined
        ? {
            contactFailureCount,
            quarantinedAt: new Date(),
            scanStatus: "Excluded",
            discoveryFailureReason: "CONTACT_FAILURE_LIMIT",
            error:
              "Removed from the active scanner after " +
              contactFailureCount +
              " unsuccessful contact extraction attempts",
            crawlCheckpoint: "",
          }
        : { contactFailureCount },
    }),
  ]);
  return {
    contactFailureCount,
    quarantined,
    status: quarantined ? "Excluded" : input.status,
  };
}

function parseSetting(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

async function loadScannerSettings(workspaceId: string) {
  const [globalRows, workspaceRows] = await Promise.all([
    prisma.setting.findMany(),
    prisma.workspaceSetting.findMany({ where: { workspaceId } }),
  ]);
  const globalSettings = Object.fromEntries(
    globalRows.map((row) => [row.id, parseSetting(row.value)]),
  );
  const workspaceSettings = Object.fromEntries(
    workspaceRows.map((row) => [row.key, parseSetting(row.value)]),
  );
  const saved = { ...globalSettings, ...workspaceSettings };
  return {
    crawlerConcurrency: Number(
      saved.crawlerConcurrency ?? defaultScannerSettings.crawlerConcurrency,
    ),
    adaptiveConcurrency: Boolean(
      saved.adaptiveConcurrency ?? defaultScannerSettings.adaptiveConcurrency,
    ),
    timeoutSeconds: Number(
      saved.timeoutSeconds ?? defaultScannerSettings.timeoutSeconds,
    ),
    retries: Number(saved.retries ?? defaultScannerSettings.retries),
    dynamicFallback: Boolean(
      saved.dynamicFallback ?? defaultScannerSettings.dynamicFallback,
    ),
    robotsRespect: Boolean(
      saved.robotsRespect ?? defaultScannerSettings.robotsRespect,
    ),
    deepScan: Boolean(saved.deepScan ?? defaultScannerSettings.deepScan),
    maxPages: Number(saved.maxPages ?? defaultScannerSettings.maxPages),
    maxDepth: Number(saved.maxDepth ?? defaultScannerSettings.maxDepth),
  } satisfies ScannerSettings;
}

async function loadSnapshotSettings(workspaceId: string) {
  const cached = snapshotSettingsCache.get(workspaceId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await loadScannerSettings(workspaceId);
  snapshotSettingsCache.set(workspaceId, {
    expiresAt: Date.now() + 5_000,
    value,
  });
  return value;
}

async function cachedScraperHealthCheck() {
  if (cachedEngineHealth && cachedEngineHealth.expiresAt > Date.now())
    return cachedEngineHealth.value;
  const value = await scraperHealth();
  cachedEngineHealth = { expiresAt: Date.now() + 10_000, value };
  return value;
}

function jsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function firstTelegram(socials: Iterable<SocialLink>) {
  for (const social of socials) {
    if (social.type !== "telegram") continue;
    const normalized = normalizeTelegramUrl(social.url);
    if (normalized) return normalized;
  }
  return "";
}
function hasContact(
  discordCount: number,
  socials: Iterable<SocialLink>,
  emailCount: number,
) {
  return discordCount > 0 || Boolean(firstTelegram(socials)) || emailCount > 0;
}
function parseCheckpoint(value: string): CrawlCheckpoint | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as CrawlCheckpoint;
    return parsed &&
      Array.isArray(parsed.queue) &&
      Array.isArray(parsed.visited)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}
function statusForError(message: string) {
  return /timeout|timed out|abort/i.test(message)
    ? "Timeout"
    : /blocked|private|internal|robots|cross-domain/i.test(message)
      ? "Blocked"
      : "Failed";
}

const INFRASTRUCTURE_FAILURE_REASONS = new Set([
  "TIMEOUT",
  "HTTP_403",
  "HTTP_429",
  "HTTP_5XX",
  "DNS_FAILURE",
  "CONNECTION_FAILURE",
  "TLS_FAILURE",
  "REDIRECT_LIMIT",
  "REDIRECT_BLOCKED",
  "INVALID_RESPONSE",
  "SCRAPER_OFFLINE",
  "SCRAPER_BUSY",
  "SCRAPER_ERROR",
  "ROBOTS_RESTRICTED",
]);

const AUTOMATIC_RETRY_FAILURE_REASONS = new Set([
  "TIMEOUT",
  "HTTP_408",
  "HTTP_425",
  "HTTP_429",
  "HTTP_5XX",
  "DNS_FAILURE",
  "CONNECTION_FAILURE",
  "INVALID_RESPONSE",
  "SCRAPER_OFFLINE",
  "SCRAPER_BUSY",
  "SCRAPER_ERROR",
  "UNEXPECTED_SCAN_FAILURE",
]);
const AUTOMATIC_RETRY_LIMIT = 3;
const AUTOMATIC_RETRY_WINDOW_MS = 2 * 60 * 60_000;

export function isInfrastructureFailureReason(reason?: string | null) {
  const value = String(reason || "").toUpperCase();
  return (
    INFRASTRUCTURE_FAILURE_REASONS.has(value) ||
    /^HTTP_(?:403|408|425|429|5\d\d)$/.test(value)
  );
}

export function isRetryableFailureReason(reason?: string | null) {
  const value = String(reason || "").toUpperCase();
  return (
    AUTOMATIC_RETRY_FAILURE_REASONS.has(value) ||
    /^HTTP_(?:408|425|429|5\d\d)$/.test(value)
  );
}

export function automaticRetryDelayMs(
  reason: string | null | undefined,
  failureCount: number,
) {
  const value = String(reason || "").toUpperCase();
  const attempt = Math.max(1, Math.trunc(failureCount));
  const baseMs =
    value === "HTTP_429" ? 15_000 : value === "TIMEOUT" ? 5_000 : 3_000;
  return Math.min(30_000, baseMs * 2 ** Math.max(0, attempt - 1));
}

export function statusForFailureReason(reason: string) {
  const value = reason.toUpperCase();
  if (value.includes("TIMEOUT")) return "Timeout";
  if (
    ["HTTP_403", "HTTP_429", "ROBOTS_RESTRICTED", "REDIRECT_BLOCKED"].includes(
      value,
    )
  )
    return "Blocked";
  return "Failed";
}

function contactFailureReason(reason?: string) {
  return !reason || CONTACT_FAILURE_REASONS.has(reason)
    ? "CONTACT_NOT_FOUND"
    : reason;
}

function failureMessage(reason: string) {
  const messages: Record<string, string> = {
    CONTACT_NOT_FOUND: "No Discord, Telegram, or email contact found",
    TIMEOUT: "Website or scraper did not respond before the retry deadline",
    HTTP_403: "Website denied public access (HTTP 403)",
    HTTP_429: "Website rate limited the scanner (HTTP 429)",
    HTTP_5XX: "Website returned a temporary server error",
    DNS_FAILURE: "The website hostname could not be resolved",
    CONNECTION_FAILURE: "The website connection failed",
    TLS_FAILURE: "The website TLS certificate or handshake failed",
    SCRAPER_OFFLINE: "The Scrapling worker was unavailable",
    SCRAPER_BUSY: "The Scrapling worker was temporarily at capacity",
    SCRAPER_ERROR: "The Scrapling worker returned an internal error",
    INVALID_RESPONSE: "The website or scraper returned an invalid response",
    ROBOTS_RESTRICTED: "Public crawling is restricted by robots.txt",
    REDIRECT_BLOCKED: "A redirect left the approved public website boundary",
    REDIRECT_LIMIT: "The website exceeded the safe redirect limit",
  };
  return (
    messages[reason] ||
    `Contact extraction failed: ${reason.replaceAll("_", " ")}`
  );
}

function chooseFailureReason(primary: string, recovery?: string) {
  if (isInfrastructureFailureReason(recovery)) return recovery!;
  if (isInfrastructureFailureReason(primary)) return primary;
  return recovery || primary;
}
function terminalStatus(page: ScrapedPage) {
  if (page.httpStatus === 403 || page.httpStatus === 429) return "Blocked";
  if (page.httpStatus >= 400) return "Failed";
  return "Completed";
}
function sameDomain(value: string, hostname: string) {
  try {
    return (
      new URL(value).hostname.toLowerCase().replace(/^www\./, "") ===
      hostname.toLowerCase().replace(/^www\./, "")
    );
  } catch {
    return false;
  }
}
function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRetryDelay(workspaceId: string, delayMs: number) {
  const deadline = Date.now() + delayMs;
  while (Date.now() < deadline) {
    if (await stopped(workspaceId)) return true;
    await wait(Math.min(750, Math.max(1, deadline - Date.now())));
  }
  return stopped(workspaceId);
}

function performanceHttpStatus(...statuses: Array<number | null | undefined>) {
  const available = statuses.filter(
    (status): status is number => status != null,
  );
  return (
    available.find((status) => status === 429) ??
    available.find((status) => status >= 500) ??
    available.at(-1)
  );
}

function directDiscoveryMethod(page: ScrapedPage, detection: DiscordDetection) {
  if (page.fetchMode === "Dynamic" || detection.method === "rendered-dom")
    return detection.method === "icon-anchor"
      ? "RENDERED_ICON_ANCHOR"
      : "RENDERED_DOM";
  const methods: Record<DiscordDetection["method"], string> = {
    anchor: "ANCHOR_HREF",
    "icon-anchor": "ICON_ANCHOR",
    "visible-text": "VISIBLE_TEXT",
    "embedded-data": "EMBEDDED_JSON",
    "html-source": "RAW_HTML",
    "data-attribute": "HTML_ATTRIBUTE",
    "onclick-attribute": "ONCLICK_ATTRIBUTE",
    "source-attribute": "SOURCE_ATTRIBUTE",
    "icon-metadata": "ICON_METADATA",
    "redirect-location": "REDIRECT_LOCATION",
    "rendered-dom": "RENDERED_DOM",
  };
  return methods[detection.method];
}

async function saveDiscordHit(
  scannerResultId: string,
  originalUrl: string,
  hit: {
    url: string;
    inviteCode?: string;
    discoveryPage: string;
    discoveryMethod: string;
    fetchMode: string;
    validationStatus?: string;
    discoverySection?: string;
    interaction?: string;
  },
) {
  await prisma.scannerDiscordLink.upsert({
    where: {
      scannerResultId_url: { scannerResultId, url: hit.url },
    },
    create: {
      scannerResultId,
      url: hit.url,
      inviteCode: hit.inviteCode || hit.url.split("/").pop() || "",
      sourcePage: hit.discoveryPage,
      discoveryMethod: hit.discoveryMethod,
      fetchMode: hit.fetchMode,
      validationStatus: hit.validationStatus || "UNVALIDATED",
      discoverySection: hit.discoverySection || "UNKNOWN",
      interaction: hit.interaction || "NONE",
      originalUrl,
    },
    update: {
      sourcePage: hit.discoveryPage,
      discoveryMethod: hit.discoveryMethod,
      fetchMode: hit.fetchMode,
      validationStatus: hit.validationStatus || "UNVALIDATED",
      discoverySection: hit.discoverySection || "UNKNOWN",
      interaction: hit.interaction || "NONE",
      originalUrl,
    },
  });
}

async function runDiscordRecovery(
  originalUrl: string,
  scannerResultId: string,
  settings: ScannerSettings,
  initialPage?: RecoveredPage,
) {
  const report = await discoverDiscord(originalUrl, {
    timeoutMs: settings.timeoutSeconds * 1000,
    redirects: 5,
    dynamicFallback: settings.dynamicFallback,
    robotsRespect: settings.robotsRespect,
    maxPages: settings.deepScan
      ? settings.maxPages
      : Math.min(4, settings.maxPages),
    // Secondary candidates have their own shorter caps in discoverDiscord.
    // Keep the documented 45-second normal domain budget so one slow entry
    // page does not consume the entire recovery window before fallbacks run.
    maxDurationMs: settings.deepScan ? 2 * 60_000 : 45_000,
    maxDynamicPages: settings.deepScan ? 3 : 1,
    continueAfterFound: false,
    deepScan: settings.deepScan,
    retries: settings.deepScan
      ? settings.retries
      : Math.min(1, settings.retries),
    initialPage,
  });
  await Promise.all(
    [...new Map(report.detections.map((hit) => [hit.url, hit])).values()].map(
      (hit) => saveDiscordHit(scannerResultId, originalUrl, hit),
    ),
  );
  return report;
}

export async function bootstrapScanner() {
  const speedPolicyMarker = await prisma.setting.findUnique({
    where: { id: "scanner.performance-policy-v2" },
  });
  if (!speedPolicyMarker) {
    const [globalConcurrency, workspaceConcurrency] = await Promise.all([
      prisma.setting.findUnique({ where: { id: "crawlerConcurrency" } }),
      prisma.workspaceSetting.findMany({
        where: { key: "crawlerConcurrency" },
        select: { workspaceId: true, key: true, value: true },
      }),
    ]);
    const legacyValues = new Set([12, 18, 20]);
    await prisma.$transaction([
      ...(globalConcurrency &&
      legacyValues.has(Number(parseSetting(globalConcurrency.value)))
        ? [
            prisma.setting.update({
              where: { id: globalConcurrency.id },
              data: { value: JSON.stringify(32) },
            }),
          ]
        : []),
      ...workspaceConcurrency
        .filter((row) => legacyValues.has(Number(parseSetting(row.value))))
        .map((row) =>
          prisma.workspaceSetting.update({
            where: {
              workspaceId_key: {
                workspaceId: row.workspaceId,
                key: row.key,
              },
            },
            data: { value: JSON.stringify(32) },
          }),
        ),
      prisma.setting.create({
        data: {
          id: "scanner.performance-policy-v2",
          value: JSON.stringify(true),
        },
      }),
    ]);
  }
  const workspaces = await prisma.workspace.findMany({ select: { id: true } });
  for (const workspace of workspaces)
    await prisma.scannerState.upsert({
      where: { workspaceId: workspace.id },
      create: { workspaceId: workspace.id },
      update: {},
    });
  await prisma.scannerResult.updateMany({
    where: { scanStatus: { in: ["Scanning", "Retrying"] } },
    data: {
      scanStatus: "Pending",
      error: "Recovered after application restart",
    },
  });
  await prisma.scannerState.updateMany({
    where: { status: "ERROR" },
    data: {
      status: "STOPPED",
      stopRequested: false,
      currentResultId: null,
      stoppedAt: new Date(),
    },
  });
  // A scanner result is successful only when it contains a supported contact
  // destination. Repair older rows that treated reachability alone as success.
  const completedContactCandidates = await prisma.scannerResult.findMany({
    where: {
      scanStatus: {
        in: ["Completed", "CompletedWithFallback", "CompletedWithWarnings"],
      },
      discordLinks: { none: {} },
    },
    select: {
      id: true,
      emailsJson: true,
      socialLinksJson: true,
    },
  });
  const invalidCompletedIds = completedContactCandidates
    .filter(
      (result) =>
        !firstTelegram(jsonArray<SocialLink>(result.socialLinksJson)) &&
        jsonArray<string>(result.emailsJson).length === 0,
    )
    .map((result) => result.id);
  if (invalidCompletedIds.length)
    await prisma.scannerResult.updateMany({
      where: { id: { in: invalidCompletedIds } },
      data: {
        scanStatus: "Failed",
        error: "No Discord, Telegram, or email contact found",
        discoveryFailureReason: "CONTACT_NOT_FOUND",
      },
    });
  // A prior attempt may have persisted a contact before a later page timed
  // out or was blocked. Preserve that useful result as a warning completion.
  await prisma.scannerResult.updateMany({
    where: {
      scanStatus: { in: ["Failed", "Timeout", "Blocked"] },
      discordLinks: { some: {} },
    },
    data: { scanStatus: "CompletedWithWarnings" },
  });
  const warningContactCandidates = await prisma.scannerResult.findMany({
    where: {
      scanStatus: { in: ["Failed", "Timeout", "Blocked"] },
      discordLinks: { none: {} },
    },
    select: {
      id: true,
      emailsJson: true,
      socialLinksJson: true,
    },
  });
  const warningContactIds = warningContactCandidates
    .filter(
      (result) =>
        Boolean(firstTelegram(jsonArray<SocialLink>(result.socialLinksJson))) ||
        jsonArray<string>(result.emailsJson).length > 0,
    )
    .map((result) => result.id);
  if (warningContactIds.length)
    await prisma.scannerResult.updateMany({
      where: { id: { in: warningContactIds } },
      data: { scanStatus: "CompletedWithWarnings" },
    });
  const failureHistoryMarker = await prisma.setting.findUnique({
    where: { id: "scanner.failure-history-backfill-v1" },
  });
  if (!failureHistoryMarker) {
    const historicalFailures = await prisma.scannerResult.findMany({
      where: { scanStatus: { in: ["Failed", "Timeout", "Blocked"] } },
      select: {
        id: true,
        workspaceId: true,
        url: true,
        normalizedUrl: true,
        scanStatus: true,
        discoveryFailureReason: true,
        error: true,
        httpStatus: true,
        contactFailureCount: true,
        scannedAt: true,
        updatedAt: true,
        domain: { select: { hostname: true } },
      },
    });
    for (const result of historicalFailures) {
      const isContactFailure = CONTACT_FAILURE_REASONS.has(
        result.discoveryFailureReason,
      );
      const contactFailureCount =
        isContactFailure && result.contactFailureCount === 0
          ? 1
          : result.contactFailureCount;
      await prisma.$transaction([
        prisma.scannerFailureHistory.create({
          data: {
            workspaceId: result.workspaceId,
            scannerResultId: result.id,
            url: result.url,
            normalizedUrl: result.normalizedUrl,
            domain: result.domain.hostname,
            status: result.scanStatus,
            failureReason: result.discoveryFailureReason,
            error: result.error || "",
            httpStatus: result.httpStatus,
            contactFailureCount,
            occurredAt: result.scannedAt || result.updatedAt,
          },
        }),
        ...(contactFailureCount !== result.contactFailureCount
          ? [
              prisma.scannerResult.update({
                where: { id: result.id },
                data: { contactFailureCount },
              }),
            ]
          : []),
      ]);
    }
    await prisma.setting.create({
      data: {
        id: "scanner.failure-history-backfill-v1",
        value: JSON.stringify(true),
      },
    });
  }
  const automaticCandidates = await prisma.scannerResult.findMany({
    where: { scanStatus: { not: "Excluded" }, sources: { some: {} } },
    select: {
      id: true,
      url: true,
      title: true,
      sources: {
        select: { searchSession: { select: { source: true } } },
      },
    },
  });
  const excludedIds = automaticCandidates
    .filter(
      (item) =>
        item.sources.length > 0 &&
        item.sources.every((source) =>
          ["brave", "google"].includes(
            source.searchSession.source.toLowerCase(),
          ),
        ) &&
        isExcludedBusinessSearchResult({ url: item.url, title: item.title }),
    )
    .map((item) => item.id);
  if (excludedIds.length)
    await prisma.scannerResult.updateMany({
      where: { id: { in: excludedIds } },
      data: {
        scanStatus: "Excluded",
        error: "Excluded as a non-business search result",
        crawlCheckpoint: "",
      },
    });
  const interrupted = await prisma.scannerState.findMany({
    where: { status: { in: ["RUNNING", "STOPPING"] } },
  });
  for (const state of interrupted)
    await prisma.scannerState.update({
      where: { id: state.id },
      data: {
        status: "STOPPED",
        stopRequested: false,
        currentResultId: null,
        stoppedAt: new Date(),
      },
    });
  const marker = await prisma.setting.findUnique({
    where: { id: "scannerWorkspaceBackfilled" },
  });
  if (!marker) {
    const legacyWorkspace = await prisma.workspace.findUnique({
      where: { id: "legacy-workspace" },
    });
    if (legacyWorkspace) {
      const legacy = await prisma.searchResult.findMany({
        include: { searchSession: true },
      });
      for (const item of legacy) {
        const workspace = await prisma.scannerResult.upsert({
          where: {
            workspaceId_domainId: {
              workspaceId: legacyWorkspace.id,
              domainId: item.domainId,
            },
          },
          create: {
            workspaceId: legacyWorkspace.id,
            url: item.url,
            normalizedUrl: item.normalizedUrl,
            title: item.title,
            domainId: item.domainId,
            scanStatus:
              item.scanStatus === "Queued" ? "Pending" : item.scanStatus,
            httpStatus: item.httpStatus,
            scanDuration: item.scanDuration,
            error: item.error,
            scannedAt: item.scannedAt,
          },
          update: { lastSeen: new Date() },
        });
        await prisma.scannerSource.upsert({
          where: {
            scannerResultId_searchSessionId: {
              scannerResultId: workspace.id,
              searchSessionId: item.searchSessionId,
            },
          },
          create: {
            scannerResultId: workspace.id,
            searchSessionId: item.searchSessionId,
            query: item.searchSession.query,
            clientId: item.searchSession.clientId,
            position: item.position,
          },
          update: { position: item.position },
        });
      }
    }
    await prisma.setting.create({
      data: { id: "scannerWorkspaceBackfilled", value: "true" },
    });
  }
  const contactBackfillMarker = await prisma.setting.findUnique({
    where: { id: "scannerContactLeadBackfilledV2" },
  });
  if (!contactBackfillMarker) {
    const existingResultsWithContacts = await prisma.scannerResult.findMany({
      where: { scanStatus: { not: "Excluded" } },
      select: {
        id: true,
        workspaceId: true,
        socialLinksJson: true,
        discordLinks: { take: 1, select: { id: true } },
      },
    });
    const existingResults = existingResultsWithContacts.filter(
      (result) =>
        result.discordLinks.length > 0 ||
        Boolean(firstTelegram(jsonArray<SocialLink>(result.socialLinksJson))),
    );
    for (let index = 0; index < existingResults.length; index += 25)
      await Promise.all(
        existingResults.slice(index, index + 25).map((result) =>
          syncScannerResultToLead({
            workspaceId: result.workspaceId,
            scannerResultId: result.id,
            sourceLabel: "Existing Searcher workspace",
          }),
        ),
      );
    await prisma.setting.create({
      data: { id: "scannerContactLeadBackfilledV2", value: "true" },
    });
  }
  for (const state of interrupted) {
    if (state.status !== "RUNNING" || state.stopRequested) continue;
    await startScanner(
      state.workspaceId,
      await loadScannerSettings(state.workspaceId),
    );
  }
}

async function mirrorLegacyResult(
  scannerResultId: string,
  normalizedUrl: string,
  status: string,
  error?: string | null,
  discord: string[] = [],
) {
  const where: Prisma.SearchResultWhereInput = {
    normalizedUrl,
    searchSession: { scannerSources: { some: { scannerResultId } } },
  };
  const [rows] = await Promise.all([
    prisma.searchResult.findMany({
      where,
      select: { id: true, url: true },
    }),
    prisma.searchResult.updateMany({
      where,
      data: { scanStatus: status, error: error ?? null, scannedAt: new Date() },
    }),
  ]);
  await Promise.all(
    rows.flatMap((row) =>
      discord.map((url) =>
        prisma.discordLink.upsert({
          where: { searchResultId_url: { searchResultId: row.id, url } },
          create: {
            searchResultId: row.id,
            url,
            inviteCode: url.split("/").pop()!,
            sourcePage: row.url,
          },
          update: { sourcePage: row.url },
        }),
      ),
    ),
  );
}

async function stopped(workspaceId: string) {
  const cached = stopStateCache.get(workspaceId);
  if (cached && cached.expiresAt > Date.now()) return cached.stopRequested;
  const stopRequested = (
    await prisma.scannerState.findUniqueOrThrow({
      where: { workspaceId },
      select: { stopRequested: true },
    })
  ).stopRequested;
  stopStateCache.set(workspaceId, {
    expiresAt: Date.now() + 250,
    stopRequested,
  });
  return stopRequested;
}

async function persistProgress(
  id: string,
  checkpoint: CrawlCheckpoint,
  started: number,
  paused = false,
) {
  const root = checkpoint.root;
  await prisma.scannerResult.update({
    where: { id },
    data: {
      title: root?.title || undefined,
      scanEngine: "Scrapling",
      fetchMode: root?.fetchMode || "",
      httpStatus: root?.httpStatus,
      finalUrl: root?.finalUrl || "",
      metaDescription: root?.metaDescription || "",
      canonicalUrl: root?.canonicalUrl || "",
      faviconUrl: root?.faviconUrl || "",
      contentType: root?.contentType || "",
      pagesVisited: checkpoint.pages.filter(
        (page) => page.status === "Completed",
      ).length,
      emailsJson: JSON.stringify([...new Set(checkpoint.emails)].sort()),
      socialLinksJson: JSON.stringify(checkpoint.socials),
      pagesJson: JSON.stringify(checkpoint.pages),
      crawlCheckpoint: JSON.stringify(checkpoint),
      scanDuration: Date.now() - started,
      scanStatus: paused ? "Pending" : "Scanning",
      error: paused
        ? "Paused safely; resume will continue remaining pages"
        : null,
    },
  });
}

async function fetchWithRetries(
  url: string,
  settings: ScannerSettings,
  allowedHostname: string,
  dynamicFallback = settings.dynamicFallback,
) {
  return fetchPage(url, {
    timeoutMs: settings.timeoutSeconds * 1000,
    redirects: 5,
    dynamicFallback,
    allowedHostname,
    retries: settings.deepScan
      ? settings.retries
      : Math.min(1, settings.retries),
  });
}

async function scanOne(
  workspaceId: string,
  id: string,
  settings: ScannerSettings,
): Promise<ScanOutcome | undefined> {
  const result = await prisma.scannerResult.findFirst({
    where: { id, workspaceId },
    select: {
      id: true,
      normalizedUrl: true,
      url: true,
      title: true,
      crawlCheckpoint: true,
      domain: { select: { hostname: true } },
    },
  });
  if (!result) return;
  const started = Date.now();
  const existing = parseCheckpoint(result.crawlCheckpoint);
  const checkpoint: CrawlCheckpoint = existing || {
    queue: [{ url: result.normalizedUrl, depth: 0 }],
    visited: [],
    pages: [],
    discord: {},
    emails: [],
    socials: [],
  };
  const visited = new Set(checkpoint.visited);
  const discord = new Map(Object.entries(checkpoint.discord));
  const emails = new Set(checkpoint.emails);
  const socials = new Map(
    checkpoint.socials.map((social) => [social.url, social]),
  );
  let initialRecoveryPage: RecoveredPage | undefined;
  emit(
    "scanner-progress",
    { id, status: "Scanning", domain: result.domain.hostname },
    workspaceId,
  );

  try {
    while (
      checkpoint.queue.length &&
      checkpoint.pages.length < settings.maxPages
    ) {
      if (checkpoint.pages.length && (await stopped(workspaceId))) {
        await persistProgress(id, checkpoint, started, true);
        emit(
          "scanner-progress",
          { id, status: "Paused", domain: result.domain.hostname },
          workspaceId,
        );
        return;
      }
      const candidate = checkpoint.queue.shift()!;
      if (visited.has(candidate.url) || candidate.depth > settings.maxDepth)
        continue;
      if (candidate.depth > 0 && !settings.deepScan) continue;
      if (!sameDomain(candidate.url, result.domain.hostname)) continue;
      visited.add(candidate.url);
      checkpoint.visited = [...visited];
      if (
        settings.robotsRespect &&
        !(await robotsAllows(
          candidate.url,
          settings.deepScan
            ? settings.timeoutSeconds * 1000
            : Math.min(settings.timeoutSeconds * 1000, 3_000),
        ))
      ) {
        const visit: PageVisit = {
          url: candidate.url,
          path: new URL(candidate.url).pathname || "/",
          depth: candidate.depth,
          status: "Blocked",
          error: "Blocked by robots.txt",
        };
        checkpoint.pages.push(visit);
        if (candidate.depth === 0) throw new Error("Blocked by robots.txt");
        await persistProgress(id, checkpoint, started);
        continue;
      }

      let page: RecoveredPage;
      try {
        page = await fetchWithRetries(
          candidate.url,
          settings,
          result.domain.hostname,
          false,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Scan failed";
        const diagnostics = error as Error & {
          attempts?: FetchAttempt[];
          redirectChain?: RedirectHop[];
        };
        checkpoint.pages.push({
          url: candidate.url,
          path: new URL(candidate.url).pathname || "/",
          depth: candidate.depth,
          status: statusForError(message) as PageVisit["status"],
          error: message,
          attempts: diagnostics.attempts,
          redirectChain: diagnostics.redirectChain,
        });
        if (candidate.depth === 0) throw error;
        await persistProgress(id, checkpoint, started);
        if (await stopped(workspaceId)) {
          await persistProgress(id, checkpoint, started, true);
          return;
        }
        continue;
      }

      const pageStatus = terminalStatus(page);
      checkpoint.pages.push({
        url: page.finalUrl,
        path: new URL(page.finalUrl).pathname || "/",
        depth: candidate.depth,
        status: pageStatus,
        httpStatus: page.httpStatus,
        fetchMode: page.fetchMode,
        durationMs: page.durationMs,
        attempts: page.attempts,
        redirectChain: page.redirectChain,
        staticFetchResult: page.staticFetchResult,
        dynamicFetchResult: page.dynamicFetchResult,
        dynamicError: page.dynamicError,
        ...(pageStatus !== "Completed"
          ? { error: `HTTP ${page.httpStatus}` }
          : {}),
      });
      if (candidate.depth === 0) {
        initialRecoveryPage = page;
        checkpoint.root = {
          title: page.title,
          finalUrl: page.finalUrl,
          httpStatus: page.httpStatus,
          metaDescription: page.metaDescription,
          canonicalUrl: page.canonicalUrl,
          faviconUrl: page.faviconUrl,
          contentType: page.contentType,
          fetchMode: page.fetchMode,
        };
        if (pageStatus !== "Completed")
          throw new Error(`HTTP ${page.httpStatus}`);
      }
      const discordBefore = discord.size;
      const telegramBefore = firstTelegram(socials.values());
      const emailsBefore = emails.size;
      for (const url of page.discordLinks) discord.set(url, page.finalUrl);
      for (const email of page.emails) emails.add(email);
      for (const social of page.socialLinks) socials.set(social.url, social);
      checkpoint.discord = Object.fromEntries(discord);
      checkpoint.emails = [...emails];
      checkpoint.socials = [...socials.values()];
      await Promise.all(
        [
          ...new Map(
            page.discordDetections.map((detection) => [
              detection.url,
              detection,
            ]),
          ).values(),
        ].map((detection) =>
          saveDiscordHit(id, result.normalizedUrl, {
            url: detection.url,
            discoveryPage: page.finalUrl,
            discoveryMethod: directDiscoveryMethod(page, detection),
            discoverySection: detection.section,
            interaction: detection.interaction,
            fetchMode: page.fetchMode,
          }),
        ),
      );
      if (settings.deepScan && candidate.depth < settings.maxDepth)
        for (const url of page.internalLinks)
          if (
            sameDomain(url, result.domain.hostname) &&
            !visited.has(url) &&
            !checkpoint.queue.some((queued) => queued.url === url)
          )
            checkpoint.queue.push({ url, depth: candidate.depth + 1 });
      const contactChanged =
        discord.size > discordBefore ||
        firstTelegram(socials.values()) !== telegramBefore ||
        emails.size > emailsBefore;
      if (contactChanged) {
        // Persist before syncing so the Leads panel receives the contact while
        // the remaining pages continue scanning in the background.
        await persistProgress(id, checkpoint, started);
        await syncScannerResultToLead({ workspaceId, scannerResultId: id });
      } else if (settings.deepScan) {
        await persistProgress(id, checkpoint, started);
      }
      emit(
        "scanner-progress",
        {
          id,
          status: "Scanning",
          domain: result.domain.hostname,
          currentPage: new URL(page.finalUrl).pathname || "/",
          pagesVisited: checkpoint.pages.length,
          maxPages: settings.maxPages,
          discord: discord.size,
          emails: emails.size,
        },
        workspaceId,
      );
      if (await stopped(workspaceId)) {
        await persistProgress(id, checkpoint, started, true);
        emit(
          "scanner-progress",
          { id, status: "Paused", domain: result.domain.hostname },
          workspaceId,
        );
        return;
      }
      if (checkpoint.queue.length) await wait(40);
    }

    let discoveryReport: DiscordDiscoveryReport | undefined;
    if (!discord.size) {
      discoveryReport = await runDiscordRecovery(
        result.normalizedUrl,
        id,
        settings,
        initialRecoveryPage,
      );
      for (const hit of discoveryReport.detections)
        discord.set(hit.url, hit.discoveryPage);
      for (const email of discoveryReport.emails) emails.add(email);
      for (const social of discoveryReport.socialLinks)
        socials.set(social.url, social);
      const knownPages = new Set(checkpoint.pages.map((page) => page.url));
      for (const page of discoveryReport.pages)
        if (!knownPages.has(page.finalUrl || page.url)) {
          checkpoint.pages.push({
            url: page.finalUrl || page.url,
            path: new URL(page.finalUrl || page.url).pathname || "/",
            depth: page.kind === "original" ? 0 : 1,
            status: page.status,
            httpStatus: page.httpStatus,
            fetchMode: page.fetchMode,
            durationMs: page.durationMs,
            error: page.error,
            errorCode: page.error,
            attempts: page.attempts,
            redirectChain: page.redirectChain,
            staticFetchResult: page.staticFetchResult,
            dynamicFetchResult: page.dynamicFetchResult,
            dynamicError: page.dynamicError,
          });
          knownPages.add(page.finalUrl || page.url);
        }
    }
    if (!hasContact(discord.size, socials.values(), emails.size)) {
      const failureReason = contactFailureReason(
        discoveryReport?.failureReason,
      );
      const status = statusForFailureReason(failureReason);
      const message = failureMessage(failureReason);
      await prisma.scannerResult.update({
        where: { id },
        data: {
          title: checkpoint.root?.title || result.title,
          scanStatus: status,
          scanEngine: "Scrapling",
          fetchMode: checkpoint.root?.fetchMode || "HTTP",
          httpStatus: checkpoint.root?.httpStatus,
          originalHttpStatus:
            discoveryReport?.originalHttpStatus ?? checkpoint.root?.httpStatus,
          scanDuration: Date.now() - started,
          finalUrl:
            discoveryReport?.finalUrl ||
            checkpoint.root?.finalUrl ||
            result.url,
          fallbackUsed: discoveryReport?.fallbackUsed || false,
          fallbackUrl: discoveryReport?.fallbackUrl || "",
          fallbackHttpStatus: discoveryReport?.fallbackHttpStatus,
          discoveryFailureReason: failureReason,
          robotsStatus: discoveryReport?.robotsStatus || "",
          metaDescription: checkpoint.root?.metaDescription || "",
          canonicalUrl: checkpoint.root?.canonicalUrl || "",
          faviconUrl: checkpoint.root?.faviconUrl || "",
          contentType: checkpoint.root?.contentType || "",
          pagesVisited: checkpoint.pages.filter(
            (page) => page.status === "Completed",
          ).length,
          emailsJson: JSON.stringify([...emails].sort()),
          socialLinksJson: JSON.stringify([...socials.values()]),
          pagesJson: JSON.stringify(checkpoint.pages),
          crawlCheckpoint: "",
          error: message,
          scannedAt: new Date(),
        },
      });
      const failure = await recordScannerFailure({
        workspaceId,
        scannerResultId: id,
        status,
        failureReason,
        error: message,
        httpStatus: performanceHttpStatus(
          checkpoint.root?.httpStatus,
          discoveryReport?.originalHttpStatus,
          discoveryReport?.fallbackHttpStatus,
        ),
      });
      await Promise.all([
        mirrorLegacyResult(id, result.normalizedUrl, status, message, []),
        syncScannerResultToLead({ workspaceId, scannerResultId: id }),
      ]);
      emit(
        "scanner-progress",
        {
          id,
          status: failure.status,
          domain: result.domain.hostname,
          pagesVisited: checkpoint.pages.length,
          discord: 0,
          telegram: false,
          error: message,
        },
        workspaceId,
      );
      return {
        status: failure.status,
        durationMs: Date.now() - started,
        httpStatus: performanceHttpStatus(
          checkpoint.root?.httpStatus,
          discoveryReport?.originalHttpStatus,
          discoveryReport?.fallbackHttpStatus,
        ),
        failureReason,
      };
    }
    const completedStatus = discoveryReport?.fallbackUsed
      ? "CompletedWithFallback"
      : "Completed";
    await prisma.scannerResult.update({
      where: { id },
      data: {
        title: checkpoint.root?.title || result.title,
        scanStatus: completedStatus,
        scanEngine: "Scrapling",
        fetchMode: checkpoint.root?.fetchMode || "HTTP",
        httpStatus: checkpoint.root?.httpStatus,
        originalHttpStatus:
          discoveryReport?.originalHttpStatus ?? checkpoint.root?.httpStatus,
        scanDuration: Date.now() - started,
        finalUrl: checkpoint.root?.finalUrl || result.url,
        fallbackUsed: discoveryReport?.fallbackUsed || false,
        fallbackUrl: discoveryReport?.fallbackUrl || "",
        fallbackHttpStatus: discoveryReport?.fallbackHttpStatus,
        discoveryFailureReason: discoveryReport?.failureReason || "",
        robotsStatus: discoveryReport?.robotsStatus || "",
        metaDescription: checkpoint.root?.metaDescription || "",
        canonicalUrl: checkpoint.root?.canonicalUrl || "",
        faviconUrl: checkpoint.root?.faviconUrl || "",
        contentType: checkpoint.root?.contentType || "",
        pagesVisited: checkpoint.pages.filter(
          (page) => page.status === "Completed",
        ).length,
        emailsJson: JSON.stringify([...emails].sort()),
        socialLinksJson: JSON.stringify([...socials.values()]),
        pagesJson: JSON.stringify(checkpoint.pages),
        crawlCheckpoint: "",
        error: null,
        contactFailureCount: 0,
        quarantinedAt: null,
        scannedAt: new Date(),
      },
    });
    await Promise.all([
      mirrorLegacyResult(id, result.normalizedUrl, completedStatus, null, [
        ...discord.keys(),
      ]),
      syncScannerResultToLead({ workspaceId, scannerResultId: id }),
    ]);
    emit(
      "scanner-progress",
      {
        id,
        status: completedStatus,
        domain: result.domain.hostname,
        pagesVisited: checkpoint.pages.length,
        discord: discord.size,
        telegram: Boolean(firstTelegram(socials.values())),
        emails: emails.size,
      },
      workspaceId,
    );
    return {
      status: completedStatus,
      durationMs: Date.now() - started,
      httpStatus: performanceHttpStatus(
        checkpoint.root?.httpStatus,
        discoveryReport?.originalHttpStatus,
        discoveryReport?.fallbackHttpStatus,
      ),
      failureReason: discoveryReport?.failureReason,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scan failed";
    let recovery: DiscordDiscoveryReport | undefined;
    try {
      recovery = await runDiscordRecovery(
        result.normalizedUrl,
        id,
        settings,
        initialRecoveryPage,
      );
      for (const hit of recovery.detections)
        discord.set(hit.url, hit.discoveryPage);
      for (const email of recovery.emails) emails.add(email);
      for (const social of recovery.socialLinks)
        socials.set(social.url, social);
    } catch {
      // Preserve the original scanner error when recovery itself is unavailable.
    }
    if (recovery && recovery.discordFound && discord.size > 0) {
      const recoveryPages: PageVisit[] = recovery.pages.map((page) => ({
        url: page.finalUrl || page.url,
        path: new URL(page.finalUrl || page.url).pathname || "/",
        depth: page.kind === "original" ? 0 : 1,
        status: page.status,
        httpStatus: page.httpStatus,
        fetchMode: page.fetchMode,
        durationMs: page.durationMs,
        error: page.error,
        errorCode: page.error,
        attempts: page.attempts,
        redirectChain: page.redirectChain,
        staticFetchResult: page.staticFetchResult,
        dynamicFetchResult: page.dynamicFetchResult,
        dynamicError: page.dynamicError,
      }));
      await prisma.scannerResult.update({
        where: { id },
        data: {
          scanStatus: "CompletedWithFallback",
          scanEngine: "Scrapling",
          scanDuration: Date.now() - started,
          originalHttpStatus:
            recovery.originalHttpStatus ?? checkpoint.root?.httpStatus,
          finalUrl: recovery.finalUrl || result.url,
          fallbackUsed: true,
          fallbackUrl: recovery.fallbackUrl || "",
          fallbackHttpStatus: recovery.fallbackHttpStatus,
          discoveryFailureReason: recovery.failureReason || "",
          robotsStatus: recovery.robotsStatus,
          pagesVisited: recovery.pages.filter(
            (page) => page.status === "Completed",
          ).length,
          emailsJson: JSON.stringify([...emails].sort()),
          socialLinksJson: JSON.stringify([...socials.values()]),
          pagesJson: JSON.stringify(recoveryPages),
          crawlCheckpoint: "",
          error: null,
          contactFailureCount: 0,
          quarantinedAt: null,
          scannedAt: new Date(),
        },
      });
      await Promise.all([
        mirrorLegacyResult(
          id,
          result.normalizedUrl,
          "CompletedWithFallback",
          null,
          [...discord.keys()],
        ),
        syncScannerResultToLead({ workspaceId, scannerResultId: id }),
      ]);
      emit(
        "scanner-progress",
        {
          id,
          status: "CompletedWithFallback",
          domain: result.domain.hostname,
          pagesVisited: recovery.pagesChecked,
          discord: discord.size,
        },
        workspaceId,
      );
      return {
        status: "CompletedWithFallback",
        durationMs: Date.now() - started,
        httpStatus: performanceHttpStatus(
          checkpoint.root?.httpStatus,
          recovery.originalHttpStatus,
          recovery.fallbackHttpStatus,
        ),
        failureReason: recovery.failureReason,
      };
    }
    const persistedDiscord = await prisma.scannerDiscordLink.findMany({
      where: { scannerResultId: id },
      select: { url: true },
    });
    const savedDiscordUrls = [
      ...new Set([
        ...discord.keys(),
        ...persistedDiscord.map((link) => link.url),
      ]),
    ];
    const persistedResult = await prisma.scannerResult.findUnique({
      where: { id },
      select: { socialLinksJson: true, emailsJson: true },
    });
    const persistedSocials = jsonArray<SocialLink>(
      persistedResult?.socialLinksJson || "[]",
    );
    const savedSocials = socials.size
      ? [...socials.values()]
      : persistedSocials;
    const savedTelegram =
      firstTelegram(socials.values()) || firstTelegram(persistedSocials);
    const savedEmails = emails.size
      ? [...emails]
      : jsonArray<string>(persistedResult?.emailsJson || "[]");
    if (savedDiscordUrls.length || savedTelegram || savedEmails.length) {
      const warningReason =
        recovery?.failureReason ||
        (message.startsWith("HTTP ")
          ? message.replace(" ", "_")
          : statusForError(message).toUpperCase());
      await prisma.scannerResult.update({
        where: { id },
        data: {
          scanStatus: "CompletedWithWarnings",
          scanEngine: "Scrapling",
          scanDuration: Date.now() - started,
          originalHttpStatus:
            recovery?.originalHttpStatus ?? checkpoint.root?.httpStatus,
          finalUrl:
            recovery?.finalUrl || checkpoint.root?.finalUrl || result.url,
          fallbackUsed: recovery?.fallbackUsed || false,
          fallbackUrl: recovery?.fallbackUrl || "",
          fallbackHttpStatus: recovery?.fallbackHttpStatus,
          discoveryFailureReason: warningReason,
          robotsStatus: recovery?.robotsStatus || "",
          pagesVisited: checkpoint.pages.filter(
            (page) => page.status === "Completed",
          ).length,
          emailsJson: JSON.stringify(savedEmails.sort()),
          socialLinksJson: JSON.stringify(savedSocials),
          pagesJson: JSON.stringify(checkpoint.pages),
          crawlCheckpoint: "",
          error: message,
          contactFailureCount: 0,
          quarantinedAt: null,
          scannedAt: new Date(),
        },
      });
      await Promise.all([
        mirrorLegacyResult(
          id,
          result.normalizedUrl,
          "CompletedWithWarnings",
          message,
          savedDiscordUrls,
        ),
        syncScannerResultToLead({ workspaceId, scannerResultId: id }),
      ]);
      emit(
        "scanner-progress",
        {
          id,
          status: "CompletedWithWarnings",
          domain: result.domain.hostname,
          warning: message,
          discord: savedDiscordUrls.length,
          telegram: Boolean(savedTelegram),
        },
        workspaceId,
      );
      return {
        status: "CompletedWithWarnings",
        durationMs: Date.now() - started,
        httpStatus: performanceHttpStatus(
          checkpoint.root?.httpStatus,
          recovery?.originalHttpStatus,
          recovery?.fallbackHttpStatus,
        ),
        failureReason: warningReason,
      };
    }
    const primaryFailureReason = message.startsWith("HTTP ")
      ? message.replace(" ", "_")
      : classifyFetchError(message);
    const failureReason = chooseFailureReason(
      primaryFailureReason,
      recovery?.failureReason,
    );
    const status = statusForFailureReason(failureReason);
    const finalMessage = failureMessage(failureReason);
    await prisma.scannerResult.update({
      where: { id },
      data: {
        scanStatus: status,
        error: finalMessage,
        scanDuration: Date.now() - started,
        emailsJson: JSON.stringify([...emails].sort()),
        socialLinksJson: JSON.stringify([...socials.values()]),
        pagesJson: JSON.stringify(checkpoint.pages),
        originalHttpStatus:
          recovery?.originalHttpStatus ?? checkpoint.root?.httpStatus,
        fallbackUsed: recovery?.fallbackUsed || false,
        fallbackUrl: recovery?.fallbackUrl || "",
        fallbackHttpStatus: recovery?.fallbackHttpStatus,
        discoveryFailureReason: failureReason,
        robotsStatus: recovery?.robotsStatus || "",
        crawlCheckpoint: "",
        scannedAt: new Date(),
      },
    });
    const failure = await recordScannerFailure({
      workspaceId,
      scannerResultId: id,
      status,
      failureReason,
      error: finalMessage,
      httpStatus: performanceHttpStatus(
        checkpoint.root?.httpStatus,
        recovery?.originalHttpStatus,
        recovery?.fallbackHttpStatus,
      ),
    });
    await Promise.all([
      mirrorLegacyResult(id, result.normalizedUrl, status, finalMessage, [
        ...discord.keys(),
      ]),
      syncScannerResultToLead({ workspaceId, scannerResultId: id }),
    ]);
    emit(
      "scanner-progress",
      {
        id,
        status: failure.status,
        domain: result.domain.hostname,
        error: finalMessage,
      },
      workspaceId,
    );
    return {
      status: failure.status,
      durationMs: Date.now() - started,
      httpStatus: performanceHttpStatus(
        checkpoint.root?.httpStatus,
        recovery?.originalHttpStatus,
        recovery?.fallbackHttpStatus,
      ),
      failureReason,
    };
  }
}

async function claimNext(workspaceId: string) {
  const candidate = await prisma.scannerResult.findFirst({
    where: { workspaceId, scanStatus: { in: ["Pending", "Queued"] } },
    orderBy: { firstSeen: "asc" },
    select: { id: true },
  });
  if (!candidate) return null;
  const claimed = await prisma.scannerResult.updateMany({
    where: {
      id: candidate.id,
      workspaceId,
      scanStatus: { in: ["Pending", "Queued"] },
    },
    data: { scanStatus: "Scanning", error: null },
  });
  return claimed.count ? candidate : null;
}

async function scheduleAutomaticRetry(
  workspaceId: string,
  scannerResultId: string,
  outcome: ScanOutcome,
) {
  if (!isRetryableFailureReason(outcome.failureReason)) return false;
  const recentFailureRows = await prisma.scannerFailureHistory.findMany({
    where: {
      workspaceId,
      scannerResultId,
      occurredAt: {
        gte: new Date(Date.now() - AUTOMATIC_RETRY_WINDOW_MS),
      },
    },
    select: { failureReason: true },
  });
  const recentFailures = recentFailureRows.filter((failure) =>
    isRetryableFailureReason(failure.failureReason),
  ).length;
  if (recentFailures >= AUTOMATIC_RETRY_LIMIT) return false;
  const delayMs = automaticRetryDelayMs(outcome.failureReason, recentFailures);
  const staged = await prisma.scannerResult.updateMany({
    where: {
      id: scannerResultId,
      workspaceId,
      scanStatus: { in: ["Failed", "Timeout", "Blocked"] },
    },
    data: {
      scanStatus: "Retrying",
      error: `Transient failure; automatic retry ${recentFailures}/${AUTOMATIC_RETRY_LIMIT - 1} in ${Math.ceil(delayMs / 1_000)} seconds`,
    },
  });
  if (!staged.count) return false;
  emit(
    "scanner-progress",
    {
      id: scannerResultId,
      status: "Retrying",
      retryInMs: delayMs,
      retryAttempt: recentFailures,
      retryLimit: AUTOMATIC_RETRY_LIMIT - 1,
    },
    workspaceId,
  );
  const paused = await waitForRetryDelay(workspaceId, delayMs);
  await prisma.scannerResult.updateMany({
    where: { id: scannerResultId, workspaceId, scanStatus: "Retrying" },
    data: {
      scanStatus: "Pending",
      error: paused ? "Automatic retry paused with the scanner" : null,
    },
  });
  return true;
}

async function worker(
  workspaceId: string,
  settings: ScannerSettings,
  controller: AdaptiveConcurrencyController,
  workerIndex: number,
) {
  while (true) {
    if (await stopped(workspaceId)) break;
    if (!controller.allowsWorker(workerIndex)) {
      await wait(250);
      continue;
    }
    const next = await claimNext(workspaceId);
    if (!next) {
      await wait(750);
      continue;
    }
    if (await stopped(workspaceId)) {
      await prisma.scannerResult.update({
        where: { id: next.id },
        data: { scanStatus: "Pending" },
      });
      break;
    }
    const active = activeResultIds.get(workspaceId) || new Set<string>();
    active.add(next.id);
    activeResultIds.set(workspaceId, active);
    let observation: ScanOutcome | undefined;
    try {
      observation = await scanOne(workspaceId, next.id, settings);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unexpected scanner failure";
      await prisma.scannerResult.updateMany({
        where: { id: next.id, workspaceId },
        data: {
          scanStatus: "Failed",
          error: message,
          discoveryFailureReason: "UNEXPECTED_SCAN_FAILURE",
          scannedAt: new Date(),
        },
      });
      const failure = await recordScannerFailure({
        workspaceId,
        scannerResultId: next.id,
        status: "Failed",
        failureReason: "UNEXPECTED_SCAN_FAILURE",
        error: message,
      });
      observation = {
        status: failure.status,
        durationMs: 0,
        failureReason: "UNEXPECTED_SCAN_FAILURE",
      };
      emit(
        "scanner-progress",
        { id: next.id, status: failure.status, error: message },
        workspaceId,
      );
    } finally {
      active.delete(next.id);
    }
    if (observation) {
      const adjusted = controller.record({
        status: observation.status,
        durationMs: observation.durationMs,
        httpStatus: observation.httpStatus,
        failureReason: observation.failureReason,
      });
      if (adjusted)
        emit("scanner-performance", controller.snapshot(), workspaceId);
      if (await scheduleAutomaticRetry(workspaceId, next.id, observation)) {
        if (await stopped(workspaceId)) break;
        continue;
      }
    }
    emit("scanner-progress", { id: next.id, status: "Listening" }, workspaceId);
  }
}

async function run(
  workspaceId: string,
  settings: ScannerSettings,
  controller: AdaptiveConcurrencyController,
) {
  try {
    await Promise.all(
      Array.from(
        { length: Math.max(1, Math.min(32, settings.crawlerConcurrency)) },
        (_, workerIndex) =>
          worker(workspaceId, settings, controller, workerIndex),
      ),
    );
    const state = await prisma.scannerState.findUniqueOrThrow({
      where: { workspaceId },
    });
    const status = state.stopRequested ? "STOPPED" : "ERROR";
    await prisma.scannerState.update({
      where: { workspaceId },
      data: {
        status,
        stopRequested: false,
        currentResultId: null,
        stoppedAt: new Date(),
      },
    });
    emit("scanner-state", { status }, workspaceId);
  } catch (error) {
    await prisma.scannerState.update({
      where: { workspaceId },
      data: {
        status: "ERROR",
        stopRequested: false,
        currentResultId: null,
        stoppedAt: new Date(),
      },
    });
    emit(
      "scanner-state",
      {
        status: "ERROR",
        error: error instanceof Error ? error.message : "Scanner failed",
      },
      workspaceId,
    );
  }
  controller.stop();
  activeResultIds.delete(workspaceId);
  stopStateCache.set(workspaceId, {
    expiresAt: Number.POSITIVE_INFINITY,
    stopRequested: true,
  });
}

export async function startScanner(
  workspaceId: string,
  settings: ScannerSettings,
) {
  if (activeRuns.has(workspaceId))
    return prisma.scannerState.findUniqueOrThrow({ where: { workspaceId } });
  const state = await prisma.scannerState.update({
    where: { workspaceId },
    data: {
      status: "RUNNING",
      stopRequested: false,
      startedAt: new Date(),
      stoppedAt: null,
    },
  });
  stopStateCache.delete(workspaceId);
  const controller = new AdaptiveConcurrencyController(
    Math.max(1, Math.min(32, settings.crawlerConcurrency)),
    settings.adaptiveConcurrency,
  );
  performanceControllers.set(workspaceId, controller);
  emit(
    "scanner-state",
    { status: "RUNNING", performance: controller.snapshot() },
    workspaceId,
  );
  const activeRun = run(workspaceId, settings, controller).finally(() =>
    activeRuns.delete(workspaceId),
  );
  activeRuns.set(workspaceId, activeRun);
  return state;
}

export async function stopScanner(workspaceId: string) {
  const state = await prisma.scannerState.findUniqueOrThrow({
    where: { workspaceId },
  });
  if (state.status !== "RUNNING") return state;
  await prisma.scannerState.update({
    where: { workspaceId },
    data: { status: "STOPPING", stopRequested: true },
  });
  stopStateCache.set(workspaceId, {
    expiresAt: Number.POSITIVE_INFINITY,
    stopRequested: true,
  });
  emit("scanner-state", { status: "STOPPING" }, workspaceId);
  const activeRun = activeRuns.get(workspaceId);
  if (activeRun) await activeRun;
  return prisma.scannerState.findUniqueOrThrow({ where: { workspaceId } });
}

export async function resetScanner(workspaceId: string) {
  const state = await prisma.scannerState.findUniqueOrThrow({
    where: { workspaceId },
  });
  if (["RUNNING", "STOPPING"].includes(state.status))
    throw Object.assign(new Error("Stop the scanner before resetting it"), {
      statusCode: 409,
    });
  await prisma.$transaction([
    prisma.lead.updateMany({
      where: { workspaceId, scannerResultId: { not: null } },
      data: { scannerResultId: null },
    }),
    prisma.scannerSource.deleteMany({
      where: { scannerResult: { workspaceId } },
    }),
    prisma.scannerDiscordLink.deleteMany({
      where: { scannerResult: { workspaceId } },
    }),
    prisma.scannerResult.deleteMany({ where: { workspaceId } }),
    prisma.scannerState.update({
      where: { workspaceId },
      data: {
        status: "IDLE",
        stopRequested: false,
        currentResultId: null,
        startedAt: null,
        stoppedAt: null,
      },
    }),
  ]);
  performanceControllers.delete(workspaceId);
  activeResultIds.delete(workspaceId);
  stopStateCache.delete(workspaceId);
  emit("scanner-reset", {}, workspaceId);
}

export async function scannerSnapshot(
  workspaceId: string,
  page = 1,
  pageSize = 50,
  search = "",
  status = "All",
) {
  const performanceController = performanceControllers.get(workspaceId);
  const statsWhere: Prisma.ScannerResultWhereInput = {
    workspaceId,
    scanStatus: { not: "Excluded" },
  };
  const where: Prisma.ScannerResultWhereInput = {
    workspaceId,
    ...(status !== "All"
      ? { scanStatus: status }
      : { scanStatus: { not: "Excluded" } }),
    ...(search
      ? {
          OR: [
            { title: { contains: search } },
            { url: { contains: search } },
            { domain: { hostname: { contains: search } } },
          ],
        }
      : {}),
  };
  const [databaseSnapshot, engine, settings] = await Promise.all([
    (async () => {
      const [
        state,
        total,
        rawItems,
        groups,
        discordLinks,
        leads,
        recentPerformance,
      ] = await Promise.all([
        prisma.scannerState.findUniqueOrThrow({ where: { workspaceId } }),
        prisma.scannerResult.count({ where }),
        prisma.scannerResult.findMany({
          where,
          skip: (page - 1) * pageSize,
          take: pageSize,
          orderBy: { lastSeen: "desc" },
          omit: {
            emailsJson: true,
            socialLinksJson: true,
            pagesJson: true,
            crawlCheckpoint: true,
          },
          include: {
            domain: { include: { location: true } },
            discordLinks: { orderBy: { createdAt: "desc" } },
            sources: { orderBy: { discoveredAt: "desc" } },
            _count: { select: { sources: true } },
          },
        }),
        prisma.scannerResult.groupBy({
          by: ["scanStatus"],
          where: statsWhere,
          _count: true,
        }),
        prisma.scannerDiscordLink.findMany({
          where: {
            scannerResult: { workspaceId, scanStatus: { not: "Excluded" } },
          },
          select: {
            id: true,
            url: true,
            discordGuildId: true,
            lastValidatedAt: true,
          },
        }),
        prisma.lead.count({
          where: {
            scannerResultId: { not: null },
            scannerResult: { scanStatus: { not: "Excluded" } },
            workspaceId,
            OR: [
              { discordInvite: { not: "" } },
              { telegram: { not: "" } },
              { email: { not: "" } },
              { scannerResult: { discordLinks: { some: {} } } },
            ],
          },
        }),
        performanceController
          ? Promise.resolve([])
          : prisma.scannerResult.findMany({
              where: {
                workspaceId,
                scanDuration: { not: null },
                scanStatus: { not: "Excluded" },
              },
              orderBy: { scannedAt: "desc" },
              take: 100,
              select: {
                scanStatus: true,
                scanDuration: true,
                httpStatus: true,
                originalHttpStatus: true,
                fallbackHttpStatus: true,
                discoveryFailureReason: true,
              },
            }),
      ]);
      return {
        state,
        total,
        rawItems,
        groups,
        discordLinks,
        leads,
        recentPerformance,
      };
    })(),
    cachedScraperHealthCheck(),
    loadSnapshotSettings(workspaceId),
  ]);
  const {
    state,
    total,
    rawItems,
    groups,
    discordLinks,
    leads,
    recentPerformance,
  } = databaseSnapshot;
  const discordSummary = summarizeDiscordDestinations(discordLinks);
  const items = rawItems.map((item) => ({
    ...item,
    sourceCount: item._count.sources,
    _count: undefined,
    emails: [],
    socialLinks: [],
    pages: [],
  }));
  const counts = Object.fromEntries(
    groups.map((group) => [group.scanStatus, group._count]),
  );
  const all = Object.values(counts).reduce((a, b) => a + b, 0);
  const completed =
    (counts.Completed || 0) +
    (counts.CompletedWithFallback || 0) +
    (counts.CompletedWithWarnings || 0) +
    (counts.Failed || 0) +
    (counts.Timeout || 0) +
    (counts.Blocked || 0);
  const durations = recentPerformance
    .map((result) => result.scanDuration || 0)
    .filter((duration) => duration > 0)
    .sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    durations.length
      ? durations[
          Math.min(
            durations.length - 1,
            Math.max(0, Math.ceil(durations.length * fraction) - 1),
          )
        ] || 0
      : 0;
  const recentSuccessful = recentPerformance.filter((result) =>
    ["Completed", "CompletedWithFallback", "CompletedWithWarnings"].includes(
      result.scanStatus,
    ),
  ).length;
  const runtime =
    performanceController?.snapshot() ||
    new AdaptiveConcurrencyController(
      settings.crawlerConcurrency,
      settings.adaptiveConcurrency,
    ).snapshot();
  const recent = performanceController?.recentSnapshot() || {
    sampleSize: recentPerformance.length,
    medianDurationMs: percentile(0.5),
    p95DurationMs: percentile(0.95),
    successRate: recentPerformance.length
      ? Number(((recentSuccessful / recentPerformance.length) * 100).toFixed(1))
      : 0,
  };
  return {
    state: {
      ...state,
      currentResultId:
        activeResultIds.get(workspaceId)?.values().next().value || null,
    },
    engine,
    items,
    pagination: {
      page,
      pageSize,
      total,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    },
    stats: {
      websites: all,
      scanned: completed,
      pending:
        (counts.Pending || 0) + (counts.Queued || 0) + (counts.Retrying || 0),
      retrying: counts.Retrying || 0,
      scanning: counts.Scanning || 0,
      failed: counts.Failed || 0,
      timeouts: counts.Timeout || 0,
      blocked: counts.Blocked || 0,
      discord: discordSummary.invites,
      discordServers: discordSummary.uniqueServers,
      discordAlternateInvites: discordSummary.alternateInvites,
      discordUnresolved: discordSummary.unresolved,
      discordLastReconciledAt: discordSummary.lastReconciledAt,
      leads,
    },
    performance: {
      ...runtime,
      recent,
    },
  };
}

export async function scannerResultDetail(workspaceId: string, id: string) {
  const item = await prisma.scannerResult.findFirst({
    where: { id, workspaceId, scanStatus: { not: "Excluded" } },
    include: {
      domain: { include: { location: true } },
      discordLinks: { orderBy: { createdAt: "desc" } },
      sources: { orderBy: { discoveredAt: "desc" } },
      _count: { select: { sources: true } },
    },
  });
  if (!item) return null;
  return {
    ...item,
    sourceCount: item._count.sources,
    _count: undefined,
    emails: jsonArray<string>(item.emailsJson),
    socialLinks: jsonArray<SocialLink>(item.socialLinksJson),
    pages: jsonArray<PageVisit>(item.pagesJson),
    emailsJson: undefined,
    socialLinksJson: undefined,
    pagesJson: undefined,
    crawlCheckpoint: undefined,
  };
}
