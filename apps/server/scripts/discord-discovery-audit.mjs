import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { discoverDiscord } from "../dist/discord-discovery.js";

const input =
  process.argv[2] || "tests/fixtures/known-positive-discord-sites.txt";
const outputStem = process.argv[3] || "outputs/discord-discovery-final";
const rawLines = (await readFile(resolve(input), "utf8"))
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
const urls = rawLines.map((line) => new URL(line).toString());

const rows = new Array(urls.length);
let cursor = 0;
await Promise.all(
  Array.from(
    {
      length: Math.max(
        1,
        Math.min(8, Number(process.env.AUDIT_CONCURRENCY || 2)),
      ),
    },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= urls.length) return;
        let report;
        try {
          report = await discoverDiscord(urls[index], {
            timeoutMs: 12_000,
            redirects: 5,
            dynamicFallback: true,
            robotsRespect: true,
            maxPages: 15,
            maxDurationMs: 90_000,
            maxDynamicPages: 2,
            deepScan: true,
            retries: 2,
          });
        } catch (error) {
          const originalUrl = urls[index];
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          rows[index] = {
            url: originalUrl,
            normalizedUrl: originalUrl,
            domain: new URL(originalUrl).hostname.replace(/^www\./, ""),
            originalHttpStatus: "",
            finalUrl: "",
            redirects: [],
            fallbackUsed: false,
            fallbackUrl: "",
            fallbackHttpStatus: "",
            pagesChecked: 0,
            discordFound: false,
            discordUrl: "",
            discoveryPage: "",
            discoveryMethod: "",
            discoverySection: "",
            interaction: "",
            validationStatus: "",
            failureReason: "AUDIT_EXCEPTION",
            errorMessage,
            notTestable: false,
            robotsStatus: "UNKNOWN",
            durationMs: 0,
            staticFetchResult: "",
            dynamicFetchResult: "NOT_ATTEMPTED",
            attempts: [],
            pages: [],
            detections: [],
          };
          console.error(
            `${index + 1}/${urls.length} ${new URL(originalUrl).hostname} AUDIT_EXCEPTION: ${errorMessage}`,
          );
          continue;
        }
        const first = report.detections[0];
        const attempts = report.pages.flatMap((page) => page.attempts || []);
        const redirects = report.pages.flatMap(
          (page) => page.redirectChain || [],
        );
        const failureReason = report.failureReason ?? "";
        const notTestable = [
          "DNS_FAILURE",
          "TLS_FAILURE",
          "CONNECTION_FAILURE",
          "SCRAPER_OFFLINE",
          "ROBOTS_RESTRICTED",
          "REDIRECT_BLOCKED",
          "REDIRECT_LIMIT",
          "HTTP_403",
          "HTTP_429",
        ].includes(failureReason);
        rows[index] = {
          url: urls[index],
          normalizedUrl: report.originalUrl,
          domain: new URL(report.originalUrl).hostname.replace(/^www\./, ""),
          originalHttpStatus: report.originalHttpStatus ?? "",
          finalUrl: report.finalUrl ?? "",
          redirects,
          fallbackUsed: report.fallbackUsed,
          fallbackUrl: report.fallbackUrl ?? "",
          fallbackHttpStatus: report.fallbackHttpStatus ?? "",
          pagesChecked: report.pagesChecked,
          discordFound: report.discordFound,
          discordUrl: first?.url ?? "",
          discoveryPage: first?.discoveryPage ?? "",
          discoveryMethod: first?.discoveryMethod ?? "",
          discoverySection: first?.discoverySection ?? "",
          interaction: first?.interaction ?? "",
          validationStatus: first?.validationStatus ?? "",
          failureReason,
          notTestable,
          robotsStatus: report.robotsStatus,
          durationMs: report.durationMs,
          staticFetchResult:
            attempts
              .map((attempt) => attempt.staticResult)
              .filter(Boolean)
              .at(-1) || "",
          dynamicFetchResult:
            attempts
              .map((attempt) => attempt.dynamicResult)
              .filter((value) => value && value !== "NOT_ATTEMPTED")
              .at(-1) || "NOT_ATTEMPTED",
          attempts,
          pages: report.pages,
          detections: report.detections,
        };
        const outcome = report.discordFound
          ? `FOUND ${first.discoveryMethod}`
          : report.failureReason;
        console.log(
          `${index + 1}/${urls.length} ${new URL(urls[index]).hostname} ${outcome}`,
        );
      }
    },
  ),
);

const jsonPath = resolve(`${outputStem}.json`);
const csvPath = resolve(`${outputStem}.csv`);
await mkdir(resolve(jsonPath, ".."), { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(rows, null, 2)}\n`);
const fields = [
  "url",
  "normalizedUrl",
  "domain",
  "originalHttpStatus",
  "finalUrl",
  "fallbackUsed",
  "fallbackUrl",
  "fallbackHttpStatus",
  "pagesChecked",
  "discordFound",
  "discordUrl",
  "discoveryPage",
  "discoveryMethod",
  "discoverySection",
  "interaction",
  "validationStatus",
  "failureReason",
  "errorMessage",
  "robotsStatus",
  "staticFetchResult",
  "dynamicFetchResult",
  "notTestable",
  "durationMs",
];
const csv = [
  fields.join(","),
  ...rows.map((row) =>
    fields
      .map((field) => {
        const value = row[field] ?? "";
        return JSON.stringify(
          value && typeof value === "object" ? JSON.stringify(value) : value,
        );
      })
      .join(","),
  ),
].join("\n");
await writeFile(csvPath, `${csv}\n`);

function counts(field, predicate = () => true) {
  return Object.fromEntries(
    Object.entries(
      rows.filter(predicate).reduce((all, row) => {
        const value = row[field] || "UNKNOWN";
        all[value] = (all[value] || 0) + 1;
        return all;
      }, {}),
    ).sort((a, b) => b[1] - a[1]),
  );
}

const found = rows.filter((row) => row.discordFound).length;
const notTestable = rows.filter((row) => row.notTestable).length;
const testable = rows.length - notTestable;
const recoveredBy = {
  iconOnly: rows.filter((row) => /ICON_ANCHOR/.test(row.discoveryMethod))
    .length,
  rawHtml: rows.filter((row) => row.discoveryMethod === "RAW_HTML").length,
  embeddedJson: rows.filter((row) => row.discoveryMethod === "EMBEDDED_JSON")
    .length,
  scriptAsset: rows.filter((row) => row.discoveryMethod === "SCRIPT_ASSET")
    .length,
  externalSocialProfile: rows.filter(
    (row) => row.discoveryMethod === "SOCIAL_AGGREGATOR",
  ).length,
  priorityPage: rows.filter(
    (row) =>
      row.discordFound &&
      row.discoveryPage &&
      new URL(row.discoveryPage).pathname !==
        new URL(row.normalizedUrl).pathname,
  ).length,
  dynamicRendering: rows.filter((row) => /RENDERED/.test(row.discoveryMethod))
    .length,
  fallback: rows.filter((row) => row.discordFound && row.fallbackUsed).length,
  robotsAwareFallback: rows.filter(
    (row) =>
      row.discordFound && row.robotsStatus === "RESTRICTED_WITH_FALLBACK",
  ).length,
};
const summary = {
  input: basename(input),
  rawInputLines: rawLines.length,
  uniqueNormalizedUrls: new Set(urls).size,
  uniqueDomains: new Set(
    urls.map((url) =>
      new URL(url).hostname.toLowerCase().replace(/^www\./, ""),
    ),
  ).size,
  knownPositive: rows.length,
  tested: rows.length,
  testable,
  found,
  notFound: rows.length - found,
  notTestable,
  rate: Number(((found / Math.max(1, rows.length)) * 100).toFixed(1)),
  testableRate: Number(((found / Math.max(1, testable)) * 100).toFixed(1)),
  recoveredBy,
  methods: counts("discoveryMethod", (row) => row.discordFound),
  failures: counts("failureReason", (row) => !row.discordFound),
  reports: { json: jsonPath, csv: csvPath },
};
const summaryPath = resolve(`${outputStem}-summary.json`);
summary.reports.summary = summaryPath;
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
