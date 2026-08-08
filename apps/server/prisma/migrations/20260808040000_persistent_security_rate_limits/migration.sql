CREATE TABLE "SecurityRateLimit" (
  "keyHash" TEXT NOT NULL PRIMARY KEY,
  "count" INTEGER NOT NULL,
  "resetAt" DATETIME NOT NULL,
  "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "SecurityRateLimit_resetAt_idx" ON "SecurityRateLimit"("resetAt");
