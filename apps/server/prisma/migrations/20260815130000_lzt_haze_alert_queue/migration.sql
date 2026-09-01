CREATE TABLE "LztHazeAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "listingId" TEXT NOT NULL,
    "alertCode" TEXT NOT NULL,
    "alertLabel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" DATETIME,
    "nextAttemptAt" DATETIME,
    "sentAt" DATETIME,
    "discordMessageId" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LztHazeAlert_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "LztRustListing" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "LztHazeAlert_listingId_key" ON "LztHazeAlert"("listingId");
CREATE INDEX "LztHazeAlert_status_createdAt_idx" ON "LztHazeAlert"("status", "createdAt");
