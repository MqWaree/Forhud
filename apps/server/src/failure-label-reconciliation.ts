import { prisma } from "./db.js";
import { failureMessage, statusForFailureReason } from "./scanner.js";

export type StoredPageEvidence = {
  depth?: number;
  kind?: string;
  httpStatus?: number;
  error?: string;
  errorDetail?: string;
  attempts?: Array<{ status?: number; errorCode?: string; error?: string }>;
};

const LEGACY_REASONS = ["HTTP_5XX", "TIMEOUT"];

function parsePages(pagesJson: string | null | undefined) {
  if (typeof pagesJson !== "string" || !pagesJson) return [];
  try {
    const parsed: unknown = JSON.parse(pagesJson);
    return Array.isArray(parsed) ? (parsed as StoredPageEvidence[]) : [];
  } catch {
    return [];
  }
}

function isWorkerTimeoutText(value?: unknown) {
  const text = String(value ?? "");
  return (
    /scrapling worker timeout/i.test(text) && !/\(http 5\d\d\)/i.test(text)
  );
}

function specificHttpStatus(value?: number | null) {
  if (value != null && value >= 500 && value <= 599) return `HTTP_${value}`;
  if (value === 403) return "HTTP_403";
  if (value === 429) return "HTTP_429";
  return null;
}

/**
 * Re-derives a precise failure label for rows stored by releases that used the
 * legacy coarse labels (HTTP_5XX, and TIMEOUT for what were actually 403/429
 * access outcomes or local worker timeouts), plus rows whose stored reason no
 * longer matches the entry-page evidence. Returns null when the stored
 * evidence does not support a correction, so ambiguous rows stay untouched.
 */
export function correctLegacyFailureReason(input: {
  reason?: string | null;
  originalHttpStatus?: number | null;
  fallbackHttpStatus?: number | null;
  pagesJson?: string | null;
}): string | null {
  const reason = String(input.reason ?? "").toUpperCase();
  if (!reason) return null;
  const pages = parsePages(input.pagesJson);
  const entryPage =
    pages.find((page) => page.depth === 0) ??
    pages.find((page) => page.kind === "original") ??
    pages[0];

  const entryStatus = input.originalHttpStatus ?? entryPage?.httpStatus ?? null;
  const entryStatusReason = specificHttpStatus(entryStatus);
  if (entryStatusReason && entryStatusReason !== reason)
    return entryStatusReason;

  if (!LEGACY_REASONS.includes(reason)) return null;

  if (input.originalHttpStatus == null) {
    const entryWorkerTimeout =
      isWorkerTimeoutText(entryPage?.error) ||
      isWorkerTimeoutText(entryPage?.errorDetail) ||
      (entryPage?.attempts ?? []).some((attempt) =>
        isWorkerTimeoutText(attempt.error),
      );
    if (entryWorkerTimeout) return "SCRAPER_TIMEOUT";
  }

  if (reason === "HTTP_5XX") {
    const fiveHundred = pages.find(
      (page) =>
        page.httpStatus != null && page.httpStatus >= 500 && page.httpStatus <= 599,
    );
    if (fiveHundred?.httpStatus != null)
      return `HTTP_${fiveHundred.httpStatus}`;
    const fallbackReason = specificHttpStatus(input.fallbackHttpStatus);
    if (fallbackReason) return fallbackReason;
  }

  return null;
}

export async function reconcileLegacyFailureLabels() {
  const candidates = await prisma.scannerResult.findMany({
    where: {
      OR: [
        { discoveryFailureReason: { in: LEGACY_REASONS } },
        {
          discoveryFailureReason: { notIn: ["", "HTTP_403", "HTTP_429"] },
          originalHttpStatus: { in: [403, 429] },
        },
        {
          discoveryFailureReason: {
            notIn: [
              "",
              "HTTP_500",
              "HTTP_501",
              "HTTP_502",
              "HTTP_503",
              "HTTP_504",
              "HTTP_505",
              "HTTP_5XX",
            ],
          },
          originalHttpStatus: { gte: 500, lte: 599 },
        },
      ],
    },
    select: {
      id: true,
      discoveryFailureReason: true,
      originalHttpStatus: true,
      fallbackHttpStatus: true,
      pagesJson: true,
    },
    take: 5_000,
  });
  let corrected = 0;
  const byReason: Record<string, number> = {};
  for (const row of candidates) {
    const reason = correctLegacyFailureReason({
      reason: row.discoveryFailureReason,
      originalHttpStatus: row.originalHttpStatus,
      fallbackHttpStatus: row.fallbackHttpStatus,
      pagesJson: row.pagesJson,
    });
    if (!reason || reason === row.discoveryFailureReason) continue;
    await prisma.scannerResult.update({
      where: { id: row.id },
      data: {
        discoveryFailureReason: reason,
        scanStatus: statusForFailureReason(reason),
        error: failureMessage(reason),
      },
    });
    corrected += 1;
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  }
  return { inspected: candidates.length, corrected, byReason };
}
