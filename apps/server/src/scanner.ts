import type { Prisma } from "./generated/client/client.js";
import { prisma } from "./db.js";
import {
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
const performanceControllers = new Map<string, AdaptiveConcurrencyController>();

const defaultScannerSettings: ScannerSettings = {
  crawlerConcurrency: 8,
  adaptiveConcurrency: true,
  timeoutSeconds: 10,
  retries: 1,
  dynamicFallback: true,
  robotsRespect: true,
  deepScan: false,
  maxPages: 6,
  maxDepth: 2,
};

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

function jsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
) {
  const report = await discoverDiscord(originalUrl, {
    timeoutMs: settings.timeoutSeconds * 1000,
    redirects: 5,
    dynamicFallback: settings.dynamicFallback,
    robotsRespect: settings.robotsRespect,
    maxPages: settings.deepScan
      ? settings.maxPages
      : Math.min(6, settings.maxPages),
    maxDurationMs: settings.deepScan ? 2 * 60_000 : 45_000,
    maxDynamicPages: settings.deepScan ? 3 : 2,
    continueAfterFound: false,
    deepScan: settings.deepScan,
    retries: settings.retries,
  });
  for (const hit of report.detections)
    await saveDiscordHit(scannerResultId, originalUrl, hit);
  return report;
}

export async function bootstrapScanner() {
  const workspaces = await prisma.workspace.findMany({ select: { id: true } });
  for (const workspace of workspaces)
    await prisma.scannerState.upsert({
      where: { workspaceId: workspace.id },
      create: { workspaceId: workspace.id },
      update: {},
    });
  await prisma.scannerResult.updateMany({
    where: { scanStatus: "Scanning" },
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
  // A prior attempt may have found and persisted Discord evidence before a
  // later page timed out or was blocked. Preserve the warning, but do not
  // present that useful result as a failed discovery.
  await prisma.scannerResult.updateMany({
    where: {
      scanStatus: { in: ["Failed", "Timeout", "Blocked"] },
      discordLinks: { some: {} },
    },
    data: { scanStatus: "CompletedWithWarnings" },
  });
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
  const existingResults = await prisma.scannerResult.findMany({
    select: { id: true, workspaceId: true },
  });
  for (const result of existingResults)
    await syncScannerResultToLead({
      workspaceId: result.workspaceId,
      scannerResultId: result.id,
      sourceLabel: "Existing Searcher workspace",
    });
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
  status: string,
  error?: string | null,
  discord: string[] = [],
) {
  const sources = await prisma.scannerSource.findMany({
    where: { scannerResultId },
    select: { searchSessionId: true },
  });
  const sessions = sources.map((source) => source.searchSessionId);
  if (!sessions.length) return;
  const normalizedUrl = (
    await prisma.scannerResult.findUniqueOrThrow({
      where: { id: scannerResultId },
      select: { normalizedUrl: true },
    })
  ).normalizedUrl;
  const rows = await prisma.searchResult.findMany({
    where: { searchSessionId: { in: sessions }, normalizedUrl },
  });
  await prisma.searchResult.updateMany({
    where: { id: { in: rows.map((row) => row.id) } },
    data: { scanStatus: status, error: error ?? null, scannedAt: new Date() },
  });
  for (const row of rows)
    for (const url of discord)
      await prisma.discordLink.upsert({
        where: { searchResultId_url: { searchResultId: row.id, url } },
        create: {
          searchResultId: row.id,
          url,
          inviteCode: url.split("/").pop()!,
          sourcePage: row.url,
        },
        update: { sourcePage: row.url },
      });
}

async function stopped(workspaceId: string) {
  return (
    await prisma.scannerState.findUniqueOrThrow({
      where: { workspaceId },
      select: { stopRequested: true },
    })
  ).stopRequested;
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
    retries: settings.retries,
  });
}

async function scanOne(
  workspaceId: string,
  id: string,
  settings: ScannerSettings,
): Promise<ScanOutcome | undefined> {
  const result = await prisma.scannerResult.findFirst({
    where: { id, workspaceId },
    include: { domain: true },
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
        !(await robotsAllows(candidate.url, settings.timeoutSeconds * 1000))
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
      for (const url of page.discordLinks) discord.set(url, page.finalUrl);
      for (const email of page.emails) emails.add(email);
      for (const social of page.socialLinks) socials.set(social.url, social);
      checkpoint.discord = Object.fromEntries(discord);
      checkpoint.emails = [...emails];
      checkpoint.socials = [...socials.values()];
      for (const detection of page.discordDetections)
        await saveDiscordHit(id, result.normalizedUrl, {
          url: detection.url,
          discoveryPage: page.finalUrl,
          discoveryMethod: directDiscoveryMethod(page, detection),
          discoverySection: detection.section,
          interaction: detection.interaction,
          fetchMode: page.fetchMode,
        });
      if (settings.deepScan && candidate.depth < settings.maxDepth)
        for (const url of page.internalLinks)
          if (
            sameDomain(url, result.domain.hostname) &&
            !visited.has(url) &&
            !checkpoint.queue.some((queued) => queued.url === url)
          )
            checkpoint.queue.push({ url, depth: candidate.depth + 1 });
      await persistProgress(id, checkpoint, started);
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
      if (checkpoint.queue.length) await wait(200);
    }

    let discoveryReport: DiscordDiscoveryReport | undefined;
    if (!discord.size) {
      discoveryReport = await runDiscordRecovery(
        result.normalizedUrl,
        id,
        settings,
      );
      for (const hit of discoveryReport.detections)
        discord.set(hit.url, hit.discoveryPage);
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
        scannedAt: new Date(),
      },
    });
    await mirrorLegacyResult(id, completedStatus, null, [...discord.keys()]);
    await syncScannerResultToLead({ workspaceId, scannerResultId: id });
    emit(
      "scanner-progress",
      {
        id,
        status: completedStatus,
        domain: result.domain.hostname,
        pagesVisited: checkpoint.pages.length,
        discord: discord.size,
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
      recovery = await runDiscordRecovery(result.normalizedUrl, id, settings);
      for (const hit of recovery.detections)
        discord.set(hit.url, hit.discoveryPage);
    } catch {
      // Preserve the original scanner error when recovery itself is unavailable.
    }
    const fallbackReachable = Boolean(
      recovery?.fallbackHttpStatus &&
      recovery.fallbackHttpStatus >= 200 &&
      recovery.fallbackHttpStatus < 400,
    );
    if (recovery && (recovery.discordFound || fallbackReachable)) {
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
          pagesJson: JSON.stringify(recoveryPages),
          crawlCheckpoint: "",
          error: null,
          scannedAt: new Date(),
        },
      });
      await mirrorLegacyResult(id, "CompletedWithFallback", null, [
        ...discord.keys(),
      ]);
      await syncScannerResultToLead({ workspaceId, scannerResultId: id });
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
    if (savedDiscordUrls.length) {
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
          pagesJson: JSON.stringify(checkpoint.pages),
          crawlCheckpoint: "",
          error: message,
          scannedAt: new Date(),
        },
      });
      await mirrorLegacyResult(
        id,
        "CompletedWithWarnings",
        message,
        savedDiscordUrls,
      );
      await syncScannerResultToLead({ workspaceId, scannerResultId: id });
      emit(
        "scanner-progress",
        {
          id,
          status: "CompletedWithWarnings",
          domain: result.domain.hostname,
          warning: message,
          discord: savedDiscordUrls.length,
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
    const status = /^HTTP 403$|^HTTP 429$/.test(message)
      ? "Blocked"
      : statusForError(message);
    await prisma.scannerResult.update({
      where: { id },
      data: {
        scanStatus: status,
        error: message,
        scanDuration: Date.now() - started,
        pagesJson: JSON.stringify(checkpoint.pages),
        originalHttpStatus:
          recovery?.originalHttpStatus ?? checkpoint.root?.httpStatus,
        fallbackUsed: recovery?.fallbackUsed || false,
        fallbackUrl: recovery?.fallbackUrl || "",
        fallbackHttpStatus: recovery?.fallbackHttpStatus,
        discoveryFailureReason:
          recovery?.failureReason ||
          (message.startsWith("HTTP ")
            ? message.replace(" ", "_")
            : statusForError(message).toUpperCase()),
        robotsStatus: recovery?.robotsStatus || "",
        crawlCheckpoint: "",
        scannedAt: new Date(),
      },
    });
    await mirrorLegacyResult(id, status, message, [...discord.keys()]);
    await syncScannerResultToLead({ workspaceId, scannerResultId: id });
    emit(
      "scanner-progress",
      { id, status, domain: result.domain.hostname, error: message },
      workspaceId,
    );
    return {
      status,
      durationMs: Date.now() - started,
      httpStatus: performanceHttpStatus(
        checkpoint.root?.httpStatus,
        recovery?.originalHttpStatus,
        recovery?.fallbackHttpStatus,
      ),
      failureReason:
        recovery?.failureReason ||
        (message.startsWith("HTTP ")
          ? message.replace(" ", "_")
          : statusForError(message).toUpperCase()),
    };
  }
}

async function claimNext(workspaceId: string) {
  const candidate = await prisma.scannerResult.findFirst({
    where: { workspaceId, scanStatus: { in: ["Pending", "Queued"] } },
    orderBy: { firstSeen: "asc" },
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
      await wait(500);
      continue;
    }
    if (await stopped(workspaceId)) {
      await prisma.scannerResult.update({
        where: { id: next.id },
        data: { scanStatus: "Pending" },
      });
      break;
    }
    await prisma.scannerState.update({
      where: { workspaceId },
      data: { currentResultId: next.id },
    });
    const observation = await scanOne(workspaceId, next.id, settings);
    if (observation) {
      const adjusted = controller.record({
        status: observation.status,
        durationMs: observation.durationMs,
        httpStatus: observation.httpStatus,
        failureReason: observation.failureReason,
      });
      if (adjusted)
        emit("scanner-performance", controller.snapshot(), workspaceId);
    }
    const cleared = await prisma.scannerState.updateMany({
      where: { workspaceId, currentResultId: next.id },
      data: { currentResultId: null },
    });
    if (cleared.count)
      emit(
        "scanner-progress",
        { id: next.id, status: "Listening" },
        workspaceId,
      );
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
        { length: Math.max(1, Math.min(20, settings.crawlerConcurrency)) },
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
  const controller = new AdaptiveConcurrencyController(
    Math.max(1, Math.min(20, settings.crawlerConcurrency)),
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
    prisma.$transaction(async (transaction) => {
      const [
        state,
        total,
        rawItems,
        groups,
        discord,
        leads,
        recentPerformance,
      ] = await Promise.all([
        transaction.scannerState.findUniqueOrThrow({ where: { workspaceId } }),
        transaction.scannerResult.count({ where }),
        transaction.scannerResult.findMany({
          where,
          skip: (page - 1) * pageSize,
          take: pageSize,
          orderBy: { lastSeen: "desc" },
          include: {
            domain: { include: { location: true } },
            discordLinks: true,
            sources: { orderBy: { discoveredAt: "desc" } },
          },
        }),
        transaction.scannerResult.groupBy({
          by: ["scanStatus"],
          where,
          _count: true,
        }),
        transaction.scannerDiscordLink.count({
          where: {
            scannerResult: { workspaceId, scanStatus: { not: "Excluded" } },
          },
        }),
        transaction.lead.count({
          where: {
            scannerResultId: { not: null },
            scannerResult: { scanStatus: { not: "Excluded" } },
            workspaceId,
          },
        }),
        performanceController
          ? Promise.resolve([])
          : transaction.scannerResult.findMany({
              where: {
                workspaceId,
                scanDuration: { not: null },
                scanStatus: { not: "Excluded" },
              },
              orderBy: { scannedAt: "desc" },
              take: 500,
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
        discord,
        leads,
        recentPerformance,
      };
    }),
    scraperHealth(),
    loadScannerSettings(workspaceId),
  ]);
  const { state, total, rawItems, groups, discord, leads, recentPerformance } =
    databaseSnapshot;
  const items = rawItems.map((item) => ({
    ...item,
    emails: jsonArray<string>(item.emailsJson),
    socialLinks: jsonArray<SocialLink>(item.socialLinksJson),
    pages: jsonArray<PageVisit>(item.pagesJson),
    emailsJson: undefined,
    socialLinksJson: undefined,
    pagesJson: undefined,
    crawlCheckpoint: undefined,
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
    state,
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
      pending: (counts.Pending || 0) + (counts.Queued || 0),
      scanning: counts.Scanning || 0,
      failed: counts.Failed || 0,
      timeouts: counts.Timeout || 0,
      blocked: counts.Blocked || 0,
      discord,
      leads,
    },
    performance: {
      ...runtime,
      recent,
    },
  };
}
