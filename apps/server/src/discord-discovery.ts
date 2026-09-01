import {
  classifyFetchError,
  fetchPage,
  isHttp5xxReason,
  robotsDecision,
  type FetchAttempt,
  type RecoveredPage,
  type RedirectHop,
} from "./crawler.js";
import type {
  DiscordDetection,
  ScrapedPage,
  SocialLink,
} from "./scraper-client.js";

const COMMON_PATHS = [
  "/discord",
  "/community",
  "/contact",
  "/contact-us",
  "/social",
  "/socials",
  "/links",
  "/link",
  "/about",
  "/about-us",
  "/support",
  "/help",
  "/team",
  "/partners",
  "/faq",
  "/reviews",
  "/forum",
] as const;
const EXTERNAL_SOCIAL_TYPES = new Set([
  "linktree",
  "beacons",
  "carrd",
  "link-aggregator",
  "discord-landing",
  "telegram",
  "vk",
  "youtube",
  "twitter",
  "instagram",
  "facebook",
]);
const EXTERNAL_SOCIAL_PRIORITY: Record<string, number> = {
  "discord-landing": 100,
  linktree: 90,
  beacons: 90,
  carrd: 90,
  "link-aggregator": 90,
  telegram: 70,
  vk: 65,
  youtube: 50,
  twitter: 45,
  instagram: 40,
  facebook: 35,
};
const RECOVERY_LINK_RE =
  /(?:^|[-_/])(discord|dsc|dc|invite|join|community|contacts?(?:-us)?|socials?|support|help|links?|about(?:-us)?|team|partners?|faq|forums?|chat|reviews?|testimonials?)(?:[-_/.]|$)/i;
const EXPLICIT_DISCORD_ROUTE_RE =
  /(?:^|\/)(?:discord|dsc|dc|invite|join)(?:[-_/]|$)/i;
const LOW_VALUE_CONTENT_PATH_RE =
  /(?:^|\/)(?:blogs?|articles?|news|products?|product-category|categories|store|shop|forums?\/topic)(?:\/|$)/i;
const LOW_VALUE_SCRIPT_RE =
  /(?:jquery|bootstrap|font-?awesome|polyfill|analytics|gtag|google-translate|gtranslate|email-decode|rocket-loader|cookie)/i;
const RECOVERABLE_CHALLENGE_STATUSES = new Set([418, 430, 440, 441, 444, 460]);

type CandidateKind =
  | "original"
  | "root-fallback"
  | "common-page"
  | "internal-link"
  | "host-fallback"
  | "http-fallback"
  | "script-asset"
  | "sitemap"
  | "dynamic-retry"
  | "social-aggregator";
type Candidate = {
  url: string;
  kind: CandidateKind;
  externalHop?: boolean;
};

export type DiscordDiscoveryPage = {
  url: string;
  finalUrl?: string;
  kind: CandidateKind;
  status: "Completed" | "Blocked" | "Failed" | "Timeout";
  httpStatus?: number;
  fetchMode?: string;
  soft404?: boolean;
  robotsReason?: string;
  error?: string;
  errorDetail?: string;
  durationMs?: number;
  attempts?: FetchAttempt[];
  redirectChain?: RedirectHop[];
  staticFetchResult?: string;
  dynamicFetchResult?: string;
  dynamicError?: string;
  title?: string;
  looksDynamic?: boolean;
  diagnosticPriorityLinks?: string[];
  diagnosticSocialLinks?: { type: string; url: string }[];
  diagnosticScriptLinks?: string[];
};

export type DiscordDiscoveryHit = {
  url: string;
  inviteCode: string;
  discoveryPage: string;
  discoveryMethod: string;
  fetchMode: string;
  validationStatus: "UNVALIDATED" | "VALID" | "EXPIRED" | "UNKNOWN";
  discoverySection: string;
  interaction: string;
};

export type DiscordDiscoveryReport = {
  originalUrl: string;
  originalHttpStatus?: number;
  finalUrl?: string;
  fallbackUsed: boolean;
  fallbackUrl?: string;
  fallbackHttpStatus?: number;
  pagesChecked: number;
  pages: DiscordDiscoveryPage[];
  discordFound: boolean;
  contactFound: boolean;
  detections: DiscordDiscoveryHit[];
  emails: string[];
  socialLinks: SocialLink[];
  discoveryMethod?: string;
  failureReason?: string;
  robotsStatus:
    | "NOT_CHECKED"
    | "ALLOWED"
    | "RESTRICTED_WITH_FALLBACK"
    | "RESTRICTED_NO_ALLOWED_PAGES"
    | "UNAVAILABLE_FAIL_OPEN";
  durationMs: number;
};

export type DiscordDiscoveryOptions = {
  timeoutMs: number;
  redirects?: number;
  dynamicFallback?: boolean;
  robotsRespect?: boolean;
  maxPages?: number;
  maxDurationMs?: number;
  maxDynamicPages?: number;
  continueAfterFound?: boolean;
  deepScan?: boolean;
  retries?: number;
  /** Reuse the entry page fetched by the scanner instead of downloading it twice. */
  initialPage?: RecoveredPage;
};

function normalized(value: string) {
  const url = new URL(value);
  url.hash = "";
  if (!url.pathname) url.pathname = "/";
  return url.toString();
}

function rootUrl(value: string) {
  return new URL("/", value).toString();
}

function sameHost(value: string, hostname: string) {
  try {
    return (
      new URL(value).hostname.toLowerCase().replace(/^www\./, "") ===
      hostname.toLowerCase().replace(/^www\./, "")
    );
  } catch {
    return false;
  }
}

function pageFailure(page: ScrapedPage) {
  if (page.isSoft404) return "SOFT_404";
  if (
    page.contentType &&
    !/(?:html|xhtml|xml|text\/plain)/i.test(page.contentType)
  )
    return "NON_HTML";
  if (page.httpStatus === 404) return "HTTP_404";
  if (page.httpStatus === 403) return "HTTP_403";
  if (page.httpStatus === 429) return "HTTP_429";
  if (page.httpStatus >= 500) return `HTTP_${page.httpStatus}`;
  if (page.httpStatus >= 400) return `HTTP_${page.httpStatus}`;
  return "DISCORD_NOT_FOUND";
}

function methodFor(
  candidate: Candidate,
  page: ScrapedPage,
  detection: DiscordDetection,
) {
  if (candidate.kind === "social-aggregator") return "SOCIAL_AGGREGATOR";
  if (candidate.kind === "script-asset") return "SCRIPT_ASSET";
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

function alternateHostRoot(value: string) {
  const url = new URL(rootUrl(value));
  url.hostname = url.hostname.startsWith("www.")
    ? url.hostname.slice(4)
    : `www.${url.hostname}`;
  return url.toString();
}

function candidateRetries(candidate: Candidate, configured = 1) {
  const retries = Math.max(0, Math.min(2, configured));
  if (
    !retries ||
    candidate.kind === "script-asset" ||
    candidate.kind === "common-page"
  )
    return 0;
  if (candidate.kind === "dynamic-retry") return Math.min(1, retries);
  if (candidate.kind !== "internal-link") return retries;
  return RECOVERY_LINK_RE.test(new URL(candidate.url).pathname) ? retries : 0;
}

export async function discoverDiscord(
  input: string,
  options: DiscordDiscoveryOptions,
): Promise<DiscordDiscoveryReport> {
  const started = Date.now();
  const originalUrl = normalized(input);
  const originalHostname = new URL(originalUrl).hostname;
  const maxPages = Math.max(1, Math.min(50, options.maxPages ?? 6));
  const maxDurationMs = Math.max(
    options.timeoutMs + 3_000,
    Math.min(
      10 * 60_000,
      options.maxDurationMs ?? (options.deepScan ? 4 * 60_000 : 2 * 60_000),
    ),
  );
  const deadline = started + maxDurationMs;
  const fallbackPageLimit = options.deepScan
    ? Math.max(0, maxPages - 1)
    : Math.min(3, Math.max(0, maxPages - 1));
  const queue: Candidate[] = [{ url: originalUrl, kind: "original" }];
  const visited = new Set<string>();
  const pages: DiscordDiscoveryPage[] = [];
  const detections = new Map<string, DiscordDiscoveryHit>();
  const emails = new Set<string>();
  const socialLinks = new Map<string, SocialLink>();
  let externalProfilesQueued = 0;
  let recoveryQueued = false;
  let hostFallbackQueued = false;
  let httpFallbackQueued = false;
  let originalHttpStatus: number | undefined;
  let finalUrl: string | undefined;
  let fallbackUrl: string | undefined;
  let fallbackHttpStatus: number | undefined;
  let failureReason: string | undefined;
  let robotsRestricted = false;
  let robotsAllowedFallback = false;
  let robotsUnavailable = false;
  let successfulContentPages = 0;
  let dynamicPagesAttempted = 0;
  let dynamicDiscordPagesAttempted = 0;
  let originalFailureReason: string | undefined;
  let explicitDiscordAccessFailure: string | undefined;
  const maxDynamicPages = Math.max(
    0,
    Math.min(5, options.maxDynamicPages ?? (options.deepScan ? 3 : 2)),
  );
  // Failed guesses (404s, robots blocks, etc.) are diagnostic attempts, not
  // useful discovery pages. Keep an independent hard ceiling so they cannot
  // exhaust the configured content-page budget or create an unbounded crawl.
  const attemptLimit = Math.min(200, Math.max(maxPages, maxPages * 4));
  const commonGuessLimit = options.deepScan ? 10 : 3;

  function enqueue(
    url: string,
    kind: CandidateKind,
    externalHop = false,
    priority = false,
  ) {
    try {
      const value = normalized(url);
      const key = kind === "dynamic-retry" ? `${value}#dynamic` : value;
      if (visited.has(key)) return;
      const queuedIndex = queue.findIndex(
        (candidate) =>
          (candidate.kind === "dynamic-retry"
            ? `${candidate.url}#dynamic`
            : candidate.url) === key,
      );
      if (queuedIndex >= 0) {
        // A destination first seen as a generic sitemap/page link may later be
        // identified as an explicit Discord route. Promote the existing entry
        // instead of leaving it buried behind lower-value candidates.
        if (priority) {
          const queued = queue[queuedIndex]!;
          if (kind === "internal-link" && queued.kind === "common-page")
            queued.kind = "internal-link";
          queue.splice(queuedIndex, 1);
          queue.unshift(queued);
        }
        return;
      }
      priority
        ? queue.unshift({ url: value, kind, externalHop })
        : queue.push({ url: value, kind, externalHop });
    } catch {
      // Invalid candidates are ignored; the original target remains preserved.
    }
  }

  function enqueueRecovery(
    includeCommonPages = true,
    prioritizeSitemap = false,
  ) {
    if (recoveryQueued) return;
    recoveryQueued = true;
    const root = rootUrl(originalUrl);
    enqueue(root, "root-fallback");
    const includeSitemap = options.deepScan || prioritizeSitemap;
    const sitemapUrl = new URL("/sitemap.xml", root).toString();
    if (includeSitemap)
      enqueue(sitemapUrl, "sitemap", false, prioritizeSitemap);
    if (
      includeSitemap &&
      !prioritizeSitemap &&
      !options.initialPage?.looksDynamic
    ) {
      const sitemapIndex = queue.findIndex(
        (candidate) => candidate.url === normalized(sitemapUrl),
      );
      const dynamicIndex = queue.findIndex(
        (candidate) => candidate.kind === "dynamic-retry",
      );
      if (sitemapIndex > dynamicIndex && dynamicIndex >= 0) {
        const [sitemap] = queue.splice(sitemapIndex, 1);
        queue.splice(dynamicIndex, 0, sitemap!);
      }
    }
    if (includeCommonPages)
      for (const path of COMMON_PATHS.slice(0, commonGuessLimit))
        enqueue(new URL(path, root).toString(), "common-page");
  }

  function enqueueStagedDynamicRetry(url: string) {
    const value = normalized(url);
    const key = `${value}#dynamic`;
    if (
      visited.has(key) ||
      queue.some(
        (candidate) =>
          candidate.kind === "dynamic-retry" && candidate.url === value,
      )
    )
      return;

    // Keep declared contact/social/script candidates ahead of Chromium, but do
    // not bury the guaranteed rendered pass behind catalogue, blog, guessed,
    // or exhaustive deep-crawl pages.
    const insertionIndex = queue.findIndex((candidate) => {
      if (
        ["common-page", "root-fallback", "host-fallback"].includes(
          candidate.kind,
        )
      )
        return true;
      if (candidate.kind !== "internal-link") return false;
      const path = new URL(candidate.url).pathname;
      return !RECOVERY_LINK_RE.test(path);
    });
    const candidate = { url: value, kind: "dynamic-retry" as const };
    if (insertionIndex < 0) queue.push(candidate);
    else queue.splice(insertionIndex, 0, candidate);
  }

  while (queue.length && pages.length < attemptLimit && Date.now() < deadline) {
    if (
      !options.deepScan &&
      pages.filter(
        (page) =>
          page.status === "Completed" &&
          page.kind !== "original" &&
          page.kind !== "social-aggregator" &&
          page.kind !== "sitemap",
      ).length >= fallbackPageLimit
    )
      break;
    let candidate: Candidate;
    if (successfulContentPages >= maxPages) {
      const retryIndex = queue.findIndex(
        (queued) => queued.kind === "dynamic-retry",
      );
      if (retryIndex < 0) break;
      candidate = queue.splice(retryIndex, 1)[0]!;
    } else candidate = queue.shift()!;
    const visitKey =
      candidate.kind === "dynamic-retry"
        ? `${candidate.url}#dynamic`
        : candidate.url;
    if (visited.has(visitKey)) continue;
    if (!candidate.externalHop && !sameHost(candidate.url, originalHostname))
      continue;
    visited.add(visitKey);

    if (options.robotsRespect !== false) {
      const decision = await robotsDecision(candidate.url, options.timeoutMs);
      if (decision.reason === "ROBOTS_UNAVAILABLE_FAIL_OPEN")
        robotsUnavailable = true;
      if (!decision.allowed) {
        robotsRestricted = true;
        pages.push({
          url: candidate.url,
          kind: candidate.kind,
          status: "Blocked",
          robotsReason: decision.reason,
          error: "ROBOTS_RESTRICTED",
        });
        failureReason = "ROBOTS_RESTRICTED";
        if (candidate.kind === "original") enqueueRecovery(true, true);
        continue;
      }
      if (robotsRestricted && candidate.kind !== "original")
        robotsAllowedFallback = true;
    }

    const isExplicitDiscordCandidate =
      candidate.kind !== "script-asset" &&
      EXPLICIT_DISCORD_ROUTE_RE.test(new URL(candidate.url).pathname);
    let page: RecoveredPage;
    try {
      // Normal candidates stay on the fast HTTP tier. Chromium is launched
      // only by a separately queued dynamic retry backed by page evidence.
      const allowDynamic =
        options.dynamicFallback !== false &&
        candidate.kind === "dynamic-retry" &&
        dynamicPagesAttempted < maxDynamicPages;
      const reusedInitialPage =
        candidate.kind === "original" && Boolean(options.initialPage);
      const highValueFallback =
        [
          "root-fallback",
          "host-fallback",
          "http-fallback",
          "sitemap",
          "social-aggregator",
        ].includes(candidate.kind) ||
        (candidate.kind === "internal-link" &&
          RECOVERY_LINK_RE.test(new URL(candidate.url).pathname));
      const candidateTimeoutMs = options.deepScan
        ? options.timeoutMs
        : candidate.kind === "dynamic-retry"
          ? options.timeoutMs
          : candidate.kind === "original"
            ? options.timeoutMs
            : Math.min(options.timeoutMs, highValueFallback ? 8_000 : 5_000);
      page = reusedInitialPage
        ? options.initialPage!
        : await fetchPage(candidate.url, {
            timeoutMs: candidateTimeoutMs,
            redirects: options.redirects ?? 5,
            dynamicFallback: allowDynamic,
            // Deep Scan deliberately renders the entry surface once even when its
            // static HTML does not look like a JS shell. Some sites attach social
            // actions to image banners only after hydration/scroll.
            forceDynamic: candidate.kind === "dynamic-retry",
            allowedHostname: new URL(candidate.url).hostname,
            retries: candidateRetries(candidate, options.retries ?? 1),
          });
      // `dynamicFallback` only grants permission to render. Most healthy static
      // pages never launch Chromium, so charging them against the browser
      // budget starved later `/discord` and contact routes. Count only an
      // actual render attempt (successful or failed).
      if (
        allowDynamic &&
        page.dynamicFetchResult &&
        page.dynamicFetchResult !== "NOT_ATTEMPTED"
      ) {
        dynamicPagesAttempted += 1;
        if (isExplicitDiscordCandidate) dynamicDiscordPagesAttempted += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Scan failed";
      const reason = classifyFetchError(message);
      const diagnostics = error as Error & {
        attempts?: FetchAttempt[];
        redirectChain?: RedirectHop[];
      };
      failureReason = reason;
      if (candidate.kind === "original") originalFailureReason = reason;
      if (
        candidate.kind === "internal-link" &&
        isExplicitDiscordCandidate &&
        (reason === "TIMEOUT" ||
          ["HTTP_403", "HTTP_429"].includes(reason) ||
          isHttp5xxReason(reason))
      )
        explicitDiscordAccessFailure = reason;
      pages.push({
        url: candidate.url,
        kind: candidate.kind,
        status:
          reason === "TIMEOUT" || reason === "SCRAPER_TIMEOUT"
            ? "Timeout"
            : reason === "REDIRECT_BLOCKED"
              ? "Blocked"
              : "Failed",
        error: reason,
        errorDetail: message,
        attempts: diagnostics.attempts,
        redirectChain: diagnostics.redirectChain,
      });
      if (candidate.kind === "original") {
        const workerUnavailable = [
          "SCRAPER_OFFLINE",
          "SCRAPER_BUSY",
          "SCRAPER_TIMEOUT",
        ].includes(reason);
        if (
          !workerUnavailable &&
          !["DNS_FAILURE", "CONNECTION_FAILURE", "SCRAPER_OFFLINE"].includes(
            reason,
          )
        )
          enqueueRecovery(reason !== "TLS_FAILURE", true);
        if (!workerUnavailable && !hostFallbackQueued) {
          hostFallbackQueued = true;
          enqueue(alternateHostRoot(originalUrl), "host-fallback");
        }
        if (
          new URL(originalUrl).protocol === "https:" &&
          reason === "TLS_FAILURE" &&
          !httpFallbackQueued
        ) {
          httpFallbackQueued = true;
          const http = new URL(rootUrl(originalUrl));
          http.protocol = "http:";
          enqueue(http.toString(), "http-fallback");
        }
      }
      continue;
    }

    finalUrl = page.finalUrl;
    if (candidate.kind === "original") originalHttpStatus = page.httpStatus;
    if (
      candidate.kind !== "original" &&
      candidate.kind !== "sitemap" &&
      candidate.kind !== "dynamic-retry" &&
      fallbackHttpStatus === undefined
    ) {
      fallbackUrl = page.finalUrl;
      fallbackHttpStatus = page.httpStatus;
    }
    const failed =
      page.httpStatus >= 400 ||
      page.isSoft404 ||
      Boolean(
        page.contentType &&
        !/(?:html|xhtml|xml|text\/plain)/i.test(page.contentType),
      );
    pages.push({
      url: candidate.url,
      finalUrl: page.finalUrl,
      kind: candidate.kind,
      status:
        page.httpStatus === 403 || page.httpStatus === 429
          ? "Blocked"
          : failed
            ? "Failed"
            : "Completed",
      httpStatus: page.httpStatus,
      fetchMode: page.fetchMode,
      soft404: page.isSoft404,
      durationMs: page.durationMs,
      attempts: page.attempts,
      redirectChain: page.redirectChain,
      staticFetchResult: page.staticFetchResult,
      dynamicFetchResult: page.dynamicFetchResult,
      dynamicError: page.dynamicError,
      title: page.title,
      looksDynamic: page.looksDynamic,
      diagnosticPriorityLinks: (page.priorityLinks ?? []).slice(0, 20),
      diagnosticSocialLinks: (page.socialLinks ?? [])
        .slice(0, 20)
        .map(({ type, url }) => ({ type, url })),
      diagnosticScriptLinks: (page.scriptLinks ?? []).slice(0, 12),
      ...(failed ? { error: pageFailure(page) } : {}),
    });

    // A useful destination may be present in a branded error document, a
    // challenge response, a redirect body, or a linked JavaScript bundle.
    // Extraction evidence remains valid even when the fetch status/content
    // classification is not a normal HTML success.
    for (const detection of page.discordDetections) {
      if (!detections.has(detection.url))
        detections.set(detection.url, {
          url: detection.url,
          inviteCode: detection.url.split("/").pop() || "",
          discoveryPage: page.finalUrl,
          discoveryMethod: methodFor(candidate, page, detection),
          discoverySection: detection.section,
          interaction: detection.interaction,
          fetchMode: page.fetchMode,
          validationStatus: "UNVALIDATED",
        });
    }
    for (const email of page.emails) emails.add(email);
    for (const social of page.socialLinks) socialLinks.set(social.url, social);
    if (detections.size && !options.continueAfterFound) break;

    if (failed) {
      failureReason = pageFailure(page);
      if (candidate.kind === "original") originalFailureReason = failureReason;
      if (
        (candidate.kind === "internal-link" &&
          EXPLICIT_DISCORD_ROUTE_RE.test(new URL(candidate.url).pathname)) ||
        ((candidate.kind === "original" ||
          candidate.kind === "dynamic-retry") &&
          page.finalUrl !== candidate.url &&
          EXPLICIT_DISCORD_ROUTE_RE.test(new URL(page.finalUrl).pathname))
      )
        explicitDiscordAccessFailure = failureReason;
      // A normal browser render can recover public pages whose static edge
      // response is transient or JS-gated. It never solves or bypasses a
      // login/CAPTCHA, and persistent rate limits are deliberately not retried
      // through Chromium.
      if (
        candidate.kind !== "dynamic-retry" &&
        options.dynamicFallback !== false &&
        page.fetchMode !== "Dynamic" &&
        page.httpStatus !== 429 &&
        dynamicPagesAttempted < maxDynamicPages &&
        (candidate.kind === "original" ||
          candidate.kind === "root-fallback" ||
          isExplicitDiscordCandidate) &&
        (page.httpStatus === 403 ||
          page.httpStatus >= 500 ||
          RECOVERABLE_CHALLENGE_STATUSES.has(page.httpStatus))
      )
        enqueueStagedDynamicRetry(candidate.url);
      if (candidate.kind === "original") {
        if (
          ["HTTP_404", "HTTP_403", "SOFT_404"].includes(failureReason) ||
          RECOVERABLE_CHALLENGE_STATUSES.has(page.httpStatus) ||
          isHttp5xxReason(failureReason)
        )
          enqueueRecovery(failureReason !== "HTTP_429", true);
      }
      continue;
    }

    if (candidate.kind !== "sitemap" && candidate.kind !== "dynamic-retry")
      successfulContentPages += 1;

    // A reused static entry page still needs the normal rendered fallback when
    // the document looks dynamic. Queue it without downloading the static page
    // a second time.
    if (
      (candidate.kind === "original" || candidate.kind === "root-fallback") &&
      options.dynamicFallback !== false &&
      page.fetchMode !== "Dynamic" &&
      (options.deepScan || page.looksDynamic)
    )
      enqueueStagedDynamicRetry(candidate.url);

    // A real, site-declared Discord route gets one rendered attempt after its
    // static HTML is checked. Guessed common paths do not launch a browser.
    if (
      candidate.kind === "internal-link" &&
      isExplicitDiscordCandidate &&
      options.dynamicFallback !== false &&
      page.fetchMode !== "Dynamic" &&
      dynamicDiscordPagesAttempted < 1
    )
      enqueueStagedDynamicRetry(candidate.url);

    const internalLinks = page.internalLinks.filter((internal) =>
      sameHost(internal, originalHostname),
    );
    // Priority links are seeded from the entry document/root only. Letting every
    // deep-crawl page prepend its own priority links can starve root-level
    // contact/review/social pages behind large forum or catalogue trees.
    const shouldExpandPriorityLinks =
      candidate.kind === "original" ||
      candidate.kind === "root-fallback" ||
      candidate.kind === "dynamic-retry" ||
      candidate.kind === "sitemap";
    if (shouldExpandPriorityLinks)
      for (const asset of [...(page.scriptLinks ?? [])].slice(0, 8).reverse())
        if (
          sameHost(asset, originalHostname) &&
          !LOW_VALUE_SCRIPT_RE.test(new URL(asset).pathname)
        )
          // Put bundles ahead of guessed common paths, but enqueue them before
          // the explicit-link blocks below so those stronger candidates win.
          enqueue(asset, "script-asset", false, true);
    if (shouldExpandPriorityLinks)
      for (const internal of [...(page.priorityLinks ?? [])].reverse())
        if (sameHost(internal, originalHostname))
          enqueue(internal, "internal-link", false, true);
    if (shouldExpandPriorityLinks)
      for (const internal of [...internalLinks].reverse())
        if (RECOVERY_LINK_RE.test(new URL(internal).pathname))
          enqueue(internal, "internal-link", false, true);
    if (candidate.kind === "sitemap")
      for (const internal of internalLinks) {
        const path = new URL(internal).pathname;
        enqueue(
          internal,
          path.toLowerCase().endsWith(".xml") ? "sitemap" : "internal-link",
        );
      }
    if (options.deepScan)
      for (const internal of internalLinks)
        if (
          !RECOVERY_LINK_RE.test(new URL(internal).pathname) ||
          LOW_VALUE_CONTENT_PATH_RE.test(new URL(internal).pathname)
        )
          enqueue(internal, "internal-link");
    // Landing pages can reveal the final same-site redirect only after they
    // are fetched. Promote explicit invite routes after all broader link tiers
    // so later unshift operations cannot bury them again.
    for (const internal of [...(page.priorityLinks ?? [])].reverse())
      if (
        sameHost(internal, originalHostname) &&
        EXPLICIT_DISCORD_ROUTE_RE.test(new URL(internal).pathname)
      )
        enqueue(internal, "internal-link", false, true);
    if (externalProfilesQueued < 3 && candidate.kind !== "social-aggregator")
      for (const social of [...page.socialLinks]
        .filter((item) => EXTERNAL_SOCIAL_TYPES.has(item.type))
        .sort(
          (a, b) =>
            (EXTERNAL_SOCIAL_PRIORITY[b.type] ?? 0) -
            (EXTERNAL_SOCIAL_PRIORITY[a.type] ?? 0),
        )) {
        if (externalProfilesQueued >= 3) break;
        externalProfilesQueued += 1;
        enqueue(
          social.url,
          "social-aggregator",
          true,
          (EXTERNAL_SOCIAL_PRIORITY[social.type] ?? 0) >= 90,
        );
      }
    // Guessed routes are the last recovery tier. Real links and script assets
    // declared by the site must be tried first so catch-all 200 pages cannot
    // consume the useful-page budget before genuine site destinations.
    if (candidate.kind === "original" || candidate.kind === "root-fallback")
      enqueueRecovery();
    failureReason = "DISCORD_NOT_FOUND";
  }

  // Exhausting the configured page budget is an expected completion state,
  // not a fetch or scanner failure. The checked pages and attempts already
  // preserve how far discovery progressed, while the final outcome remains
  // the accurate user-facing result: no public Discord destination found.
  const deadlineReached = Date.now() >= deadline;
  const originalFailure =
    originalHttpStatus === 403
      ? "HTTP_403"
      : originalHttpStatus === 429
        ? "HTTP_429"
        : originalHttpStatus != null && originalHttpStatus >= 500
          ? `HTTP_${originalHttpStatus}`
          : undefined;
  // The healthy-homepage rule below must only mask guessed-path failures.
  // When the original entry page itself failed for an access or transport
  // reason, that failure remains the honest domain-level outcome even if some
  // recovery page later loaded successfully.
  const originalAccessFailure =
    originalFailure ||
    (originalFailureReason &&
    !["HTTP_404", "SOFT_404", "CONTACT_NOT_FOUND"].includes(
      originalFailureReason,
    )
      ? originalFailureReason
      : undefined);
  if (!detections.size && successfulContentPages > 0 && !originalAccessFailure) {
    // A failed guessed path must never overwrite a healthy website result.
    // Keep its page-level diagnostic, but report the domain as a completed
    // contact search unless the total discovery deadline really expired.
    failureReason = deadlineReached ? "TIMEOUT" : "DISCORD_NOT_FOUND";
  } else if (
    !detections.size &&
    recoveryQueued &&
    failureReason === "SOFT_404" &&
    !originalAccessFailure
  )
    failureReason = "DISCORD_NOT_FOUND";
  else if (!detections.size && originalAccessFailure)
    failureReason = originalFailure || originalFailureReason;
  else if (!detections.size && deadlineReached) failureReason = "TIMEOUT";
  else if (
    !detections.size &&
    (successfulContentPages >= maxPages || pages.length >= attemptLimit) &&
    queue.length
  )
    failureReason = "DISCORD_NOT_FOUND";
  if (
    !detections.size &&
    explicitDiscordAccessFailure &&
    (["HTTP_403", "HTTP_429", "ROBOTS_RESTRICTED"].includes(
      explicitDiscordAccessFailure,
    ) ||
      isHttp5xxReason(explicitDiscordAccessFailure))
  )
    failureReason = explicitDiscordAccessFailure;
  const robotsStatus = robotsRestricted
    ? robotsAllowedFallback
      ? "RESTRICTED_WITH_FALLBACK"
      : "RESTRICTED_NO_ALLOWED_PAGES"
    : robotsUnavailable
      ? "UNAVAILABLE_FAIL_OPEN"
      : options.robotsRespect === false
        ? "NOT_CHECKED"
        : "ALLOWED";
  const alternateContactFound =
    emails.size > 0 ||
    [...socialLinks.values()].some((social) => social.type === "telegram");
  const contactFound = detections.size > 0 || alternateContactFound;

  return {
    originalUrl,
    originalHttpStatus,
    finalUrl,
    fallbackUsed: pages.some((page) => page.kind !== "original"),
    fallbackUrl,
    fallbackHttpStatus,
    pagesChecked: pages.length,
    pages,
    discordFound: detections.size > 0,
    contactFound,
    detections: [...detections.values()],
    emails: [...emails].sort(),
    socialLinks: [...socialLinks.values()],
    discoveryMethod: detections.values().next().value?.discoveryMethod,
    failureReason: contactFound
      ? undefined
      : failureReason || "DISCORD_NOT_FOUND",
    robotsStatus,
    durationMs: Date.now() - started,
  };
}
