CREATE TABLE "RustPriceScanDiagnostic" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "outcomeCode" TEXT NOT NULL,
    "pagesChecked" INTEGER NOT NULL DEFAULT 0,
    "listingsFound" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL,
    "errorCode" TEXT,
    "error" TEXT,
    "reportJson" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "completedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RustPriceScanDiagnostic_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RustPriceScanDiagnostic_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "RustPriceSource" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "RustPriceScanDiagnostic_workspaceId_completedAt_idx" ON "RustPriceScanDiagnostic"("workspaceId", "completedAt");
CREATE INDEX "RustPriceScanDiagnostic_sourceId_completedAt_idx" ON "RustPriceScanDiagnostic"("sourceId", "completedAt");
CREATE INDEX "RustPriceScanDiagnostic_workspaceId_status_idx" ON "RustPriceScanDiagnostic"("workspaceId", "status");
