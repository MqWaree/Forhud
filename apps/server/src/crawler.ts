import { normalizeDiscordUrl } from "@lead/shared";
import { assertPublicUrl } from "./security.js";
import {
  fetchRobotsResource,
  scrapePage,
  type RobotsResource,
  type ScrapedPage,
} from "./scraper-client.js";

export type CrawlOptions = {
  timeoutMs: number;
  redirects: number;
  dynamicFallback: boolean;
  forceDynamic?: boolean;
  allowedHostname?: string;
  retries?: number;
};

export type FetchErrorCode =
  | "DNS_FAILURE"
  | "CONNECTION_FAILURE"
  | "TLS_FAILURE"
  | "TIMEOUT"
  | "REDIRECT_LIMIT"
  | "REDIRECT_BLOCKED"
  | "INVALID_RESPONSE"
  | "SCRAPER_OFFLINE";

export type FetchAttempt = {
  attempt: number;
  url: string;
  status?: number;
  fetchMode?: string;
  staticResult?: string;
  dynamicResult?: string;
  errorCode?: FetchErrorCode;
  error?: string;
  durationMs: number;
  retryAfterSeconds?: number;
};

export type RedirectHop = {
  url: string;
  status: number;
  location: string;
};

export type RecoveredPage = ScrapedPage & {
  attempts: FetchAttempt[];
  redirectChain: RedirectHop[];
};

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function classifyFetchError(message: string): FetchErrorCode {
  if (/redirect limit/i.test(message)) return "REDIRECT_LIMIT";
  if (/redirect|cross-domain|private|internal/i.test(message))
    return "REDIRECT_BLOCKED";
  if (/timeout|timed out|abort/i.test(message)) return "TIMEOUT";
  if (/dns|getaddrinfo|name.*resolve|enotfound|eai_again|querya/i.test(message))
    return "DNS_FAILURE";
  if (/tls|certificate|ssl/i.test(message)) return "TLS_FAILURE";
  if (/worker unavailable|scraper.*offline|connect.*3011/i.test(message))
    return "SCRAPER_OFFLINE";
  if (/connect|socket|network|reset|refused/i.test(message))
    return "CONNECTION_FAILURE";
  return "INVALID_RESPONSE";
}

function assertAllowedHostname(value: URL, allowedHostname?: string) {
  if (
    allowedHostname &&
    value.hostname.toLowerCase().replace(/^www\./, "") !==
      allowedHostname.toLowerCase().replace(/^www\./, "")
  )
    throw new Error("Deep scan cross-domain redirect blocked");
}

const CONTROLLED_SOCIAL_REDIRECT_HOSTS = new Set([
  "dsc.gg",
  "discord.io",
  "discord.me",
  "discord.link",
  "invite.gg",
  "linktr.ee",
  "beacons.ai",
  "carrd.co",
  "solo.to",
  "allmylinks.com",
  "bio.link",
  "taplink.cc",
  "guns.lol",
  "t.me",
  "telegram.me",
  "vk.com",
]);

function controlledSocialRedirect(value: string) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return [...CONTROLLED_SOCIAL_REDIRECT_HOSTS].some(
      (allowed) => host === allowed || host.endsWith(`.${allowed}`),
    );
  } catch {
    return false;
  }
}

export async function fetchPage(
  input: string,
  opts: CrawlOptions,
): Promise<RecoveredPage> {
  let current = input;
  const attempts: FetchAttempt[] = [];
  const redirectChain: RedirectHop[] = [];
  const retries = Math.max(0, Math.min(3, opts.retries ?? 1));
  for (let redirects = 0; ; redirects++) {
    let approved: URL | undefined;
    let approvalError: unknown;
    for (let retry = 0; retry <= retries; retry++) {
      const started = Date.now();
      try {
        approved = await assertPublicUrl(current);
        assertAllowedHostname(approved, opts.allowedHostname);
        break;
      } catch (error) {
        approvalError = error;
        const message = error instanceof Error ? error.message : "URL validation failed";
        const errorCode = classifyFetchError(message);
        attempts.push({
          attempt: attempts.length + 1,
          url: current,
          errorCode,
          error: message,
          durationMs: Date.now() - started,
        });
        if (errorCode !== "DNS_FAILURE" || retry >= retries) break;
        await wait(Math.min(2_000, 250 * 2 ** retry));
      }
    }
    if (!approved) {
      const error =
        approvalError instanceof Error
          ? approvalError
          : new Error("URL validation failed");
      Object.assign(error, { attempts, redirectChain });
      throw error;
    }
    let page: ScrapedPage | undefined;
    let lastError: unknown;
    for (let retry = 0; retry <= retries; retry++) {
      const started = Date.now();
      try {
        page = await scrapePage(approved.toString(), {
          timeoutMs: opts.timeoutMs,
          dynamicFallback: opts.dynamicFallback,
          forceDynamic: opts.forceDynamic,
        });
        attempts.push({
          attempt: attempts.length + 1,
          url: approved.toString(),
          status: page.httpStatus,
          fetchMode: page.fetchMode,
          staticResult: page.staticFetchResult,
          dynamicResult: page.dynamicFetchResult,
          durationMs: page.durationMs || Date.now() - started,
          ...(page.retryAfterSeconds !== null
            ? { retryAfterSeconds: page.retryAfterSeconds }
            : {}),
        });
        if (
          (page.httpStatus === 429 || page.httpStatus >= 500) &&
          retry < retries
        ) {
          const backoff = page.retryAfterSeconds
            ? page.retryAfterSeconds * 1_000
            : 400 * 2 ** retry;
          await wait(Math.min(10_000, backoff));
          continue;
        }
        break;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : "Fetch failed";
        attempts.push({
          attempt: attempts.length + 1,
          url: approved.toString(),
          errorCode: classifyFetchError(message),
          error: message,
          durationMs: Date.now() - started,
        });
        if (retry < retries) {
          await wait(Math.min(2_000, 250 * 2 ** retry));
          continue;
        }
      }
    }
    if (!page) {
      const error =
        lastError instanceof Error ? lastError : new Error("Fetch failed");
      Object.assign(error, { attempts, redirectChain });
      throw error;
    }
    if (!page.redirectUrl)
      return Object.assign(page, { attempts, redirectChain });
    // A public site may expose its community link through a same-site endpoint
    // that redirects to Discord. Record that Location value without requesting
    // the external Discord host or weakening same-domain redirect boundaries.
    if (normalizeDiscordUrl(page.redirectUrl))
      return Object.assign(page, { attempts, redirectChain });
    if (controlledSocialRedirect(page.redirectUrl)) {
      page.socialLinks = [
        ...page.socialLinks,
        {
          type: "discord-landing",
          url: page.redirectUrl,
          sourcePage: page.finalUrl,
        },
      ];
      return Object.assign(page, { attempts, redirectChain });
    }
    redirectChain.push({
      url: approved.toString(),
      status: page.httpStatus,
      location: page.redirectUrl,
    });
    if (redirects >= opts.redirects) {
      const error = new Error("Redirect limit exceeded");
      Object.assign(error, { attempts, redirectChain });
      throw error;
    }
    const next = await assertPublicUrl(
      new URL(page.redirectUrl, approved).toString(),
    );
    assertAllowedHostname(next, opts.allowedHostname);
    current = next.toString();
  }
}

async function fetchRobots(
  input: string,
  timeoutMs: number,
): Promise<RobotsResource> {
  let current = new URL("/robots.txt", input).toString();
  for (let redirects = 0; ; redirects++) {
    const approved = await assertPublicUrl(current);
    const resource = await fetchRobotsResource(approved.toString(), timeoutMs);
    if (!resource.redirectUrl) return resource;
    if (redirects >= 3) throw new Error("robots.txt redirect limit exceeded");
    current = (await assertPublicUrl(
      new URL(resource.redirectUrl, approved).toString(),
    )).toString();
  }
}

type RobotRule = { path: string; allow: boolean };
const robotsCache = new Map<
  string,
  {
    until: number;
    httpStatus: number;
    text: string;
    failureReason?: string;
  }
>();
function rulesForFgp(text: string) {
  const groups: { agents: string[]; rules: RobotRule[] }[] = [];
  let group: { agents: string[]; rules: RobotRule[] } | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!group || group.rules.length) {
        group = { agents: [], rules: [] };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && group && value) {
      group.rules.push({ path: value, allow: key === "allow" });
    }
  }
  const applicable = groups.filter((candidate) =>
    candidate.agents.some(
      (agent) => agent === "*" || "fgpleadresearch".includes(agent),
    ),
  );
  return applicable.flatMap((group) => group.rules);
}

function matchesRobotPath(pathname: string, rule: string) {
  const end = rule.endsWith("$");
  const escaped = rule
    .replace(/[$]/g, "")
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}${end ? "$" : ""}`).test(pathname);
}

export type RobotsDecision = {
  allowed: boolean;
  reason:
    | "ALLOWED"
    | "DISALLOWED"
    | "ROBOTS_AUTH_REQUIRED"
    | "ROBOTS_UNAVAILABLE_FAIL_OPEN";
  httpStatus?: number;
  fromCache: boolean;
};

export async function robotsDecision(
  url: string,
  timeoutMs: number,
): Promise<RobotsDecision> {
  const origin = new URL(url).origin;
  let cached = robotsCache.get(origin);
  const fromCache = Boolean(cached && cached.until >= Date.now());
  if (!cached || cached.until < Date.now()) {
    try {
      const resource = await fetchRobots(url, timeoutMs);
      cached = {
        until: Date.now() + 5 * 60_000,
        httpStatus: resource.httpStatus,
        text: resource.text,
      };
    } catch (error) {
      cached = {
        until: Date.now() + 60_000,
        httpStatus: 0,
        text: "",
        failureReason:
          error instanceof Error ? error.message : "robots.txt unavailable",
      };
    }
    robotsCache.set(origin, cached);
  }
  if (cached.failureReason)
    return {
      allowed: true,
      reason: "ROBOTS_UNAVAILABLE_FAIL_OPEN",
      fromCache,
    };
  if (cached.httpStatus === 401 || cached.httpStatus === 403)
    return {
      allowed: false,
      reason: "ROBOTS_AUTH_REQUIRED",
      httpStatus: cached.httpStatus,
      fromCache,
    };
  if (cached.httpStatus < 200 || cached.httpStatus >= 300)
    return {
      allowed: true,
      reason: "ROBOTS_UNAVAILABLE_FAIL_OPEN",
      httpStatus: cached.httpStatus,
      fromCache,
    };
  const target = new URL(url);
  const matches = rulesForFgp(cached.text)
    .filter((rule) => matchesRobotPath(target.pathname || "/", rule.path))
    .sort((a, b) => b.path.length - a.path.length);
  const allowed = matches[0]?.allow ?? true;
  return {
    allowed,
    reason: allowed ? "ALLOWED" : "DISALLOWED",
    httpStatus: cached.httpStatus,
    fromCache,
  };
}

export async function robotsAllows(url: string, timeoutMs: number) {
  return (await robotsDecision(url, timeoutMs)).allowed;
}
