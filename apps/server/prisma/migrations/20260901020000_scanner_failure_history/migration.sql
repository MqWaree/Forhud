ALTER TABLE "ScannerResult" ADD COLUMN "contactFailureCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ScannerResult" ADD COLUMN "quarantinedAt" DATETIME;

CREATE TABLE "ScannerFailureHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "scannerResultId" TEXT,
    "url" TEXT NOT NULL,
    "normalizedUrl" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "failureReason" TEXT NOT NULL DEFAULT '',
    "error" TEXT NOT NULL DEFAULT '',
    "httpStatus" INTEGER,
    "contactFailureCount" INTEGER NOT NULL DEFAULT 0,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScannerFailureHistory_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ScannerFailureHistory_scannerResultId_fkey" FOREIGN KEY ("scannerResultId") REFERENCES "ScannerResult" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "ScannerFailureHistory_workspaceId_occurredAt_idx" ON "ScannerFailureHistory"("workspaceId", "occurredAt");
CREATE INDEX "ScannerFailureHistory_scannerResultId_occurredAt_idx" ON "ScannerFailureHistory"("scannerResultId", "occurredAt");
CREATE INDEX "ScannerFailureHistory_workspaceId_status_idx" ON "ScannerFailureHistory"("workspaceId", "status");
