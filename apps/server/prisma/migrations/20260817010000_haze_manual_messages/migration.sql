CREATE TABLE "HazeManualMessage" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "content" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "claimedAt" DATETIME,
  "nextAttemptAt" DATETIME,
  "sentAt" DATETIME,
  "discordMessageId" TEXT,
  "lastError" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "HazeManualMessage_status_createdAt_idx"
ON "HazeManualMessage"("status", "createdAt");
