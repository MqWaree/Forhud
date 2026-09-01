import { createHash } from "node:crypto";
import { Prisma } from "./generated/client/client.js";
import { prisma } from "./db.js";

export const RATE_WINDOW_MS = 15 * 60 * 1000;

export function rateLimitKey(scope: string, ...parts: string[]) {
  return createHash("sha256")
    .update([scope, ...parts].join("\0"))
    .digest("hex");
}

export async function retryAfterRateLimit(
  keyHash: string,
  limit: number,
  now = Date.now(),
) {
  const bucket = await prisma.securityRateLimit.findUnique({
    where: { keyHash },
  });
  if (!bucket) return 0;
  if (bucket.resetAt.getTime() <= now) {
    await prisma.securityRateLimit.deleteMany({ where: { keyHash } });
    return 0;
  }
  return bucket.count >= limit
    ? Math.max(1, Math.ceil((bucket.resetAt.getTime() - now) / 1000))
    : 0;
}

export async function recordRateLimitAttempt(
  keyHash: string,
  now = Date.now(),
) {
  await recordRateLimitAttempts([keyHash], now);
}

export async function recordRateLimitAttempts(
  keyHashes: string[],
  now = Date.now(),
) {
  const uniqueKeys = [...new Set(keyHashes)];
  const nowDate = new Date(now);
  const resetAt = new Date(now + RATE_WINDOW_MS);

  // SQLite permits only one writer at a time. Avoid parallel interactive
  // transactions here: they can deadlock one another and surface as Prisma
  // P1008 timeouts during an otherwise ordinary invalid login. Each UPSERT is
  // one short atomic statement, and multiple buckets are deliberately written
  // in sequence.
  for (const keyHash of uniqueKeys)
    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO "SecurityRateLimit"
          ("keyHash", "count", "resetAt", "updatedAt")
        VALUES
          (${keyHash}, 1, ${resetAt}, ${nowDate})
        ON CONFLICT("keyHash") DO UPDATE SET
          "count" = CASE
            WHEN "resetAt" <= ${nowDate} THEN 1
            ELSE "count" + 1
          END,
          "resetAt" = CASE
            WHEN "resetAt" <= ${nowDate} THEN ${resetAt}
            ELSE "resetAt"
          END,
          "updatedAt" = ${nowDate}
      `,
    );
}

export async function clearRateLimit(...keyHashes: string[]) {
  if (!keyHashes.length) return;
  await prisma.securityRateLimit.deleteMany({
    where: { keyHash: { in: keyHashes } },
  });
}

export async function cleanupExpiredRateLimits(now = new Date()) {
  await prisma.securityRateLimit.deleteMany({
    where: { resetAt: { lte: now } },
  });
}
