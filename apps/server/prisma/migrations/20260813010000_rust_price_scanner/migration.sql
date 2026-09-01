CREATE TABLE "RustPriceScannerState" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'IDLE',
  "stopRequested" BOOLEAN NOT NULL DEFAULT false,
  "currentSourceId" TEXT,
  "startedAt" DATETIME,
  "stoppedAt" DATETIME,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "RustPriceScannerState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RustPriceScannerState_workspaceId_key" ON "RustPriceScannerState"("workspaceId");

CREATE TABLE "RustPriceSource" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "normalizedUrl" TEXT NOT NULL,
  "domain" TEXT NOT NULL,
  "title" TEXT NOT NULL DEFAULT '',
  "scanStatus" TEXT NOT NULL DEFAULT 'Pending',
  "fetchMode" TEXT NOT NULL DEFAULT '',
  "httpStatus" INTEGER,
  "finalUrl" TEXT NOT NULL DEFAULT '',
  "pagesChecked" INTEGER NOT NULL DEFAULT 0,
  "durationMs" INTEGER,
  "error" TEXT,
  "scannedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "RustPriceSource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RustPriceSource_workspaceId_normalizedUrl_key" ON "RustPriceSource"("workspaceId", "normalizedUrl");
CREATE INDEX "RustPriceSource_workspaceId_scanStatus_idx" ON "RustPriceSource"("workspaceId", "scanStatus");
CREATE INDEX "RustPriceSource_workspaceId_domain_idx" ON "RustPriceSource"("workspaceId", "domain");

CREATE TABLE "RustAccountListing" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "priceMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "priceText" TEXT NOT NULL,
  "accountType" TEXT NOT NULL DEFAULT 'Rust account',
  "seller" TEXT NOT NULL DEFAULT '',
  "availability" TEXT NOT NULL DEFAULT 'Unknown',
  "listingUrl" TEXT NOT NULL,
  "sourcePage" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" DATETIME NOT NULL,
  CONSTRAINT "RustAccountListing_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RustAccountListing_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "RustPriceSource" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RustAccountListing_workspaceId_fingerprint_key" ON "RustAccountListing"("workspaceId", "fingerprint");
CREATE INDEX "RustAccountListing_workspaceId_active_lastSeenAt_idx" ON "RustAccountListing"("workspaceId", "active", "lastSeenAt");
CREATE INDEX "RustAccountListing_sourceId_idx" ON "RustAccountListing"("sourceId");
CREATE INDEX "RustAccountListing_currency_priceMinor_idx" ON "RustAccountListing"("currency", "priceMinor");

CREATE TABLE "RustPriceSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "listingId" TEXT NOT NULL,
  "priceMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "observedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RustPriceSnapshot_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "RustAccountListing" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "RustPriceSnapshot_listingId_observedAt_idx" ON "RustPriceSnapshot"("listingId", "observedAt");
