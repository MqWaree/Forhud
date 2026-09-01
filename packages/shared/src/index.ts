import { z } from "zod";

export const leadStatuses = [
  "New",
  "Researching",
  "Contacted",
  "Replied",
  "Interested",
  "Negotiating",
  "Won",
  "Lost",
  "Ignore",
] as const;
export const priorities = ["Low", "Medium", "High"] as const;
export const scanStatuses = [
  "Queued",
  "Scanning",
  "Completed",
  "CompletedWithFallback",
  "CompletedWithWarnings",
  "Excluded",
  "Failed",
  "Blocked",
  "Timeout",
] as const;
export type LeadStatus = (typeof leadStatuses)[number];
export type Priority = (typeof priorities)[number];

export const importSearchSchema = z.object({
  searchQuery: z.string().trim().min(1).max(300),
  source: z.literal("google").default("google"),
  clientId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{2,32}$/)
    .default("DEFAULT"),
  pageUrl: z.string().url(),
  capturedAt: z.string().datetime().optional(),
  results: z
    .array(
      z.object({
        title: z.string().max(500).default(""),
        url: z.string().url(),
        position: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(10000),
});
export const importLinksSchema = z.object({
  clientId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{2,32}$/)
    .default("DEFAULT"),
  label: z.string().trim().min(1).max(300).default("Manual link import"),
  urls: z
    .array(
      z
        .string()
        .trim()
        .transform((value) =>
          /^https?:\/\//i.test(value) ? value : `https://${value}`,
        )
        .pipe(z.string().url()),
    )
    .min(1)
    .max(5000),
});
export const leadPatchSchema = z
  .object({
    status: z.enum(leadStatuses).optional(),
    priority: z.enum(priorities).optional(),
    notes: z.string().max(10000).optional(),
    companyName: z.string().max(300).optional(),
    contactName: z.string().max(300).optional(),
    email: z.union([z.string().email(), z.literal("")]).optional(),
    discordUsername: z.string().max(300).optional(),
    telegram: z.string().max(500).optional(),
    otherContact: z.string().max(2000).optional(),
    website: z.union([z.string().url(), z.literal("")]).optional(),
    discordInvite: z.string().max(500).optional(),
    tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
  })
  .refine((v) => Object.keys(v).length > 0);
export const settingsSchema = z
  .object({
    crawlerConcurrency: z.number().int().min(1).max(32),
    adaptiveConcurrency: z.boolean(),
    timeoutSeconds: z.number().int().min(2).max(60),
    retries: z.number().int().min(0).max(3),
    dynamicFallback: z.boolean(),
    robotsRespect: z.boolean(),
    deepScan: z.boolean(),
    maxPages: z.number().int().min(1).max(25),
    maxDepth: z.number().int().min(0).max(3),
    defaultLeadStatus: z.enum(leadStatuses),
    automaticBackups: z.boolean(),
    backupFrequency: z.enum(["DAILY", "WEEKLY"]),
    backupTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    backupRetentionDaily: z.number().int().min(1).max(30),
    backupRetentionWeekly: z.number().int().min(1).max(12),
  })
  .partial();

export function normalizeUrl(value: string) {
  const u = new URL(value);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  u.protocol = u.protocol.toLowerCase();
  if (
    (u.protocol === "https:" && u.port === "443") ||
    (u.protocol === "http:" && u.port === "80")
  )
    u.port = "";
  u.pathname = u.pathname.replace(/\/{2,}/g, "/");
  if (u.pathname !== "/") u.pathname = u.pathname.replace(/\/$/, "");
  [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "gclid",
    "fbclid",
  ].forEach((k) => u.searchParams.delete(k));
  u.searchParams.sort();
  return u.toString();
}
export function extractDomain(value: string) {
  const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  return host;
}

const COMMON_SITE_PREFIXES = new Set([
  "account",
  "accounts",
  "app",
  "en",
  "fr",
  "de",
  "m",
  "market",
  "marketplace",
  "mobile",
  "ru",
  "shop",
  "store",
]);
const MULTI_TENANT_HOST_SUFFIXES = [
  "blogspot.com",
  "carrd.co",
  "github.io",
  "gitlab.io",
  "myshopify.com",
  "netlify.app",
  "notion.site",
  "pages.dev",
  "square.site",
  "vercel.app",
  "webflow.io",
  "wixsite.com",
  "wordpress.com",
];

/**
 * Returns a stable website identity without merging unrelated hosted tenants.
 * Paths, ports and common presentation/shop prefixes do not create another
 * site, while arbitrary subdomains remain distinct unless they are a known
 * prefix. This is intentionally narrower than guessing from a short TLD list.
 */
export function canonicalSiteKey(value: string) {
  const hostname = new URL(value).hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\d*\./, "");
  if (
    MULTI_TENANT_HOST_SUFFIXES.some(
      (suffix) => hostname !== suffix && hostname.endsWith(`.${suffix}`),
    )
  )
    return hostname;
  const labels = hostname.split(".").filter(Boolean);
  while (labels.length > 2 && COMMON_SITE_PREFIXES.has(labels[0]!))
    labels.shift();
  return labels.join(".");
}
export function extractHttpUrls(input: string) {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of input.matchAll(/https?:\/\/[^\s<>"'\x5b\x5d()]+/gi)) {
    const candidate = match[0].replace(/[),.;\]]+$/, "");
    try {
      const normalized = normalizeUrl(candidate);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        urls.push(candidate);
      }
    } catch {}
  }
  for (const raw of input.split(/[\s,;]+/)) {
    const token = raw.replace(/^["'[(]+|["')\].]+$/g, "").trim();
    if (
      !token ||
      /^https?:\/\//i.test(token) ||
      !/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s]*)?$/i.test(token)
    )
      continue;
    try {
      const candidate = `https://${token}`;
      const normalized = normalizeUrl(candidate);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        urls.push(candidate);
      }
    } catch {}
  }
  return urls;
}
export function splitRows(input: string, delimiter: string, all = false) {
  const rows: { left: string; right: string; original: string }[] = [];
  const malformed: string[] = [];
  for (const original of input.split(/\r?\n/)) {
    if (!original.trim()) continue;
    const at = original.indexOf(delimiter);
    if (!delimiter || at < 0) {
      malformed.push(original);
      continue;
    }
    const left = original.slice(0, at);
    const right = all
      ? original
          .slice(at + delimiter.length)
          .split(delimiter)
          .join(", ")
      : original.slice(at + delimiter.length);
    rows.push({ left, right, original });
  }
  return { rows, malformed, total: rows.length + malformed.length };
}

export function splitWebsiteDiscordRows(input: string) {
  const rows: { left: string; right: string; original: string }[] = [];
  const malformed: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let pending = "";

  const process = (original: string) => {
    const urls = extractHttpUrls(original);
    const discord = urls.find((url) => normalizeDiscordUrl(url));
    const website = urls.find((url) => url !== discord);
    if (!website || !discord) return false;
    const left = normalizeUrl(website);
    const right = normalizeDiscordUrl(discord)!;
    const key = `${left}\n${right}`;
    if (seen.has(key)) duplicates += 1;
    else {
      seen.add(key);
      rows.push({ left, right, original });
    }
    return true;
  };

  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const combined = pending ? `${pending} ${line}` : line;
    if (process(combined)) {
      pending = "";
      continue;
    }
    if (pending) malformed.push(pending);
    pending = line;
  }
  if (pending) malformed.push(pending);
  return {
    rows,
    malformed,
    duplicates,
    total: rows.length + duplicates + malformed.length,
  };
}
export function csvEscape(value: unknown) {
  const raw = String(value ?? "");
  const s = /^[\t\r ]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function normalizeDiscordUrl(value: string) {
  const decoded = value
    .replace(/&amp;/gi, "&")
    .replace(/\\u002[fF]|\\x2[fF]/g, "/")
    .replace(/\\\//g, "/");
  const invite =
    decoded.match(
      /(?:https?:)?\/\/(?:www\.)?(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)([A-Za-z0-9_-]+)/i,
    ) ||
    decoded.match(
      /(?:www\.)?(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)([A-Za-z0-9_-]+)/i,
    );
  if (invite?.[1]) return `https://discord.gg/${invite[1]}`;
  const channel =
    decoded.match(
      /(?:https?:)?\/\/(?:www\.)?discord(?:app)?\.com\/channels\/(\d+)(?:\/(\d+))?/i,
    ) ||
    decoded.match(
      /(?:www\.)?discord(?:app)?\.com\/channels\/(\d+)(?:\/(\d+))?/i,
    );
  if (!channel?.[1]) return null;
  return `https://discord.com/channels/${channel[1]}${channel[2] ? `/${channel[2]}` : ""}`;
}
export function normalizeTelegramUrl(value: string) {
  const decoded = value
    .replace(/&amp;/gi, "&")
    .replace(/\\u002[fF]|\\x2[fF]/g, "/")
    .replace(/\\\//g, "/")
    .trim()
    .replace(/[),.;\]}]+$/, "");
  const match = decoded.match(
    /(?:(?:https?:)?\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog|(?:web\.)?telegram\.org)\/[^\s"'<>]+/i,
  );
  if (!match) return null;
  const candidate = /^https?:\/\//i.test(match[0])
    ? match[0]
    : match[0].startsWith("//")
      ? `https:${match[0]}`
      : `https://${match[0]}`;
  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "");
    if (["t.me", "telegram.me", "telegram.dog"].includes(host)) {
      if (!path || path === "/") return null;
      return `https://t.me${path}${parsed.search}${parsed.hash}`;
    }
    if (host === "telegram.org" || host === "web.telegram.org") {
      if ((!path || path === "/") && !parsed.hash) return null;
      return `https://${host}${path || "/"}${parsed.search}${parsed.hash}`;
    }
  } catch {}
  return null;
}
export function detectTelegramUrls(input: string) {
  const found = new Set<string>();
  const re =
    /(?:(?:https?:)?\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog|(?:web\.)?telegram\.org)\/[^\s"'<>]+/gi;
  for (const match of input.matchAll(re)) {
    const url = normalizeTelegramUrl(match[0]);
    if (url) found.add(url);
  }
  return [...found];
}
export type DiscordDestinationKind = "invite" | "channel";
export function discordDestinationKind(
  value: string,
): DiscordDestinationKind | null {
  const normalized = normalizeDiscordUrl(value);
  if (!normalized) return null;
  return normalized.includes("/channels/") ? "channel" : "invite";
}
export function detectDiscordUrls(html: string) {
  const found = new Set<string>();
  const re =
    /(?:(?:https?:)?\/\/)?(?:www\.)?(?:discord\.gg\/[A-Za-z0-9_-]+|discord(?:app)?\.com\/(?:invite\/[A-Za-z0-9_-]+|channels\/\d+(?:\/\d+)?))[^\s"'<>]*/gi;
  for (const match of html.matchAll(re)) {
    const url = normalizeDiscordUrl(match[0]);
    if (url) found.add(url);
  }
  return [...found];
}
