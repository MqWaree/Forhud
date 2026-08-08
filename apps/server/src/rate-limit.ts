import { createHash } from "node:crypto";
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
  await prisma.$transaction(async (tx) => {
    const current = await tx.securityRateLimit.findUnique({
      where: { keyHash },
    });
    if (!current || current.resetAt.getTime() <= now) {
      await tx.securityRateLimit.upsert({
        where: { keyHash },
        create: {
          keyHash,
          count: 1,
          resetAt: new Date(now + RATE_WINDOW_MS),
        },
        update: {
          count: 1,
          resetAt: new Date(now + RATE_WINDOW_MS),
        },
      });
      return;
    }
    await tx.securityRateLimit.update({
      where: { keyHash },
      data: { count: { increment: 1 } },
    });
  });
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
