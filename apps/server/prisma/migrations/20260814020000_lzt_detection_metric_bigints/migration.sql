-- @foreign_keys_off
CREATE TABLE "new_LztTrackerState" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
  "state" TEXT NOT NULL DEFAULT 'STOPPED',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "initialized" BOOLEAN NOT NULL DEFAULT false,
  "stopRequested" BOOLEAN NOT NULL DEFAULT false,
  "importBaseline" BOOLEAN NOT NULL DEFAULT true,
  "notifyExisting" BOOLEAN NOT NULL DEFAULT false,
  "watermarkPublishedAt" DATETIME,
  "recentItemIdsJson" TEXT NOT NULL DEFAULT '[]',
  "lastSuccessfulPollAt" DATETIME,
  "lastCompleteCatchupAt" DATETIME,
  "lastNewListingAt" DATETIME,
  "nextPollAt" DATETIME,
  "startedAt" DATETIME,
  "stoppedAt" DATETIME,
  "leaseOwner" TEXT,
  "leaseUntil" DATETIME,
  "apiLatencyMs" INTEGER,
  "rateLimitLimit" INTEGER,
  "rateLimitRemaining" INTEGER,
  "rateLimitResetAt" DATETIME,
  "lastErrorCode" TEXT,
  "lastError" TEXT,
  "pollCount" INTEGER NOT NULL DEFAULT 0,
  "successfulPolls" INTEGER NOT NULL DEFAULT 0,
  "failedPolls" INTEGER NOT NULL DEFAULT 0,
  "newListings" INTEGER NOT NULL DEFAULT 0,
  "duplicatesSkipped" INTEGER NOT NULL DEFAULT 0,
  "rateLimitedCount" INTEGER NOT NULL DEFAULT 0,
  "enrichmentSuccesses" INTEGER NOT NULL DEFAULT 0,
  "enrichmentFailures" INTEGER NOT NULL DEFAULT 0,
  "workerRestarts" INTEGER NOT NULL DEFAULT 0,
  "totalApiLatencyMs" INTEGER NOT NULL DEFAULT 0,
  "totalDetectionMs" BIGINT NOT NULL DEFAULT 0,
  "maxDetectionMs" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" DATETIME NOT NULL
);

INSERT INTO "new_LztTrackerState" (
  "id", "state", "enabled", "initialized", "stopRequested",
  "importBaseline", "notifyExisting", "watermarkPublishedAt",
  "recentItemIdsJson", "lastSuccessfulPollAt", "lastCompleteCatchupAt",
  "lastNewListingAt", "nextPollAt", "startedAt", "stoppedAt",
  "leaseOwner", "leaseUntil", "apiLatencyMs", "rateLimitLimit",
  "rateLimitRemaining", "rateLimitResetAt", "lastErrorCode", "lastError",
  "pollCount", "successfulPolls", "failedPolls", "newListings",
  "duplicatesSkipped", "rateLimitedCount", "enrichmentSuccesses",
  "enrichmentFailures", "workerRestarts", "totalApiLatencyMs",
  "totalDetectionMs", "maxDetectionMs", "updatedAt"
)
SELECT
  "id", "state", "enabled", "initialized", "stopRequested",
  "importBaseline", "notifyExisting", "watermarkPublishedAt",
  "recentItemIdsJson", "lastSuccessfulPollAt", "lastCompleteCatchupAt",
  "lastNewListingAt", "nextPollAt", "startedAt", "stoppedAt",
  "leaseOwner", "leaseUntil", "apiLatencyMs", "rateLimitLimit",
  "rateLimitRemaining", "rateLimitResetAt", "lastErrorCode", "lastError",
  "pollCount", "successfulPolls", "failedPolls", "newListings",
  "duplicatesSkipped", "rateLimitedCount", "enrichmentSuccesses",
  "enrichmentFailures", "workerRestarts", "totalApiLatencyMs",
  "totalDetectionMs", "maxDetectionMs", "updatedAt"
FROM "LztTrackerState";

DROP TABLE "LztTrackerState";
ALTER TABLE "new_LztTrackerState" RENAME TO "LztTrackerState";
CREATE INDEX "LztTrackerState_leaseUntil_idx" ON "LztTrackerState"("leaseUntil");
