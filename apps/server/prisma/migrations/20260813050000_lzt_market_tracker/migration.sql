CREATE TABLE "LztTrackerState" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global', "state" TEXT NOT NULL DEFAULT 'STOPPED',
  "enabled" BOOLEAN NOT NULL DEFAULT false, "initialized" BOOLEAN NOT NULL DEFAULT false,
  "stopRequested" BOOLEAN NOT NULL DEFAULT false, "importBaseline" BOOLEAN NOT NULL DEFAULT true,
  "notifyExisting" BOOLEAN NOT NULL DEFAULT false, "watermarkPublishedAt" DATETIME,
  "recentItemIdsJson" TEXT NOT NULL DEFAULT '[]', "lastSuccessfulPollAt" DATETIME,
  "lastCompleteCatchupAt" DATETIME, "lastNewListingAt" DATETIME, "nextPollAt" DATETIME,
  "startedAt" DATETIME, "stoppedAt" DATETIME, "leaseOwner" TEXT, "leaseUntil" DATETIME,
  "apiLatencyMs" INTEGER, "rateLimitLimit" INTEGER, "rateLimitRemaining" INTEGER,
  "rateLimitResetAt" DATETIME, "lastErrorCode" TEXT, "lastError" TEXT,
  "pollCount" INTEGER NOT NULL DEFAULT 0, "successfulPolls" INTEGER NOT NULL DEFAULT 0,
  "failedPolls" INTEGER NOT NULL DEFAULT 0, "newListings" INTEGER NOT NULL DEFAULT 0,
  "duplicatesSkipped" INTEGER NOT NULL DEFAULT 0, "rateLimitedCount" INTEGER NOT NULL DEFAULT 0,
  "enrichmentSuccesses" INTEGER NOT NULL DEFAULT 0, "enrichmentFailures" INTEGER NOT NULL DEFAULT 0,
  "workerRestarts" INTEGER NOT NULL DEFAULT 0, "totalApiLatencyMs" INTEGER NOT NULL DEFAULT 0,
  "totalDetectionMs" INTEGER NOT NULL DEFAULT 0, "maxDetectionMs" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "LztTrackerState_leaseUntil_idx" ON "LztTrackerState"("leaseUntil");

CREATE TABLE "LztRustListing" (
  "id" TEXT NOT NULL PRIMARY KEY, "lztItemId" TEXT NOT NULL, "title" TEXT NOT NULL,
  "publicUrl" TEXT NOT NULL, "itemState" TEXT NOT NULL DEFAULT 'ACTIVE',
  "originalPriceMinor" INTEGER NOT NULL, "originalCurrency" TEXT NOT NULL,
  "priceEurMinor" INTEGER NOT NULL, "priceUsdMinor" INTEGER, "conversionSource" TEXT NOT NULL,
  "conversionTimestamp" DATETIME NOT NULL, "gamesCount" INTEGER, "rustHours" INTEGER,
  "publishedAt" DATETIME NOT NULL, "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "originalApiPosition" INTEGER NOT NULL,
  "baseline" BOOLEAN NOT NULL DEFAULT false, "enriched" BOOLEAN NOT NULL DEFAULT false,
  "enrichmentFailure" TEXT, "rawResponseHash" TEXT, "reconciliationMisses" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "LztRustListing_lztItemId_key" ON "LztRustListing"("lztItemId");
CREATE INDEX "LztRustListing_publishedAt_idx" ON "LztRustListing"("publishedAt");
CREATE INDEX "LztRustListing_firstSeenAt_idx" ON "LztRustListing"("firstSeenAt");
CREATE INDEX "LztRustListing_priceEurMinor_idx" ON "LztRustListing"("priceEurMinor");
CREATE INDEX "LztRustListing_priceUsdMinor_idx" ON "LztRustListing"("priceUsdMinor");
CREATE INDEX "LztRustListing_rustHours_idx" ON "LztRustListing"("rustHours");
CREATE INDEX "LztRustListing_itemState_idx" ON "LztRustListing"("itemState");

CREATE TABLE "LztMarketAverageSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY, "date" TEXT NOT NULL, "timezone" TEXT NOT NULL,
  "maxPriceUsdMinor" INTEGER NOT NULL, "eligibleCount" INTEGER NOT NULL,
  "averagePriceEurMinor" INTEGER, "lowestPriceEurMinor" INTEGER,
  "calculatedAt" DATETIME NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "LztMarketAverageSnapshot_date_calculatedAt_idx" ON "LztMarketAverageSnapshot"("date", "calculatedAt");
