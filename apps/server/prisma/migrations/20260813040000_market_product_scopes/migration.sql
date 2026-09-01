-- Scope price sources and listings by product so searches for different
-- account games or ordinary items never share results or deduplication keys.
ALTER TABLE "RustPriceSource" ADD COLUMN "productKey" TEXT NOT NULL DEFAULT 'rust-nfa-accounts';
ALTER TABLE "RustPriceSource" ADD COLUMN "productName" TEXT NOT NULL DEFAULT 'Rust NFA accounts';
ALTER TABLE "RustPriceSource" ADD COLUMN "productType" TEXT NOT NULL DEFAULT 'RUST_NFA';

DROP INDEX IF EXISTS "RustPriceSource_workspaceId_normalizedUrl_key";
DROP INDEX IF EXISTS "RustPriceSource_workspaceId_scanStatus_idx";
CREATE UNIQUE INDEX "RustPriceSource_workspaceId_productKey_normalizedUrl_key"
  ON "RustPriceSource"("workspaceId", "productKey", "normalizedUrl");
CREATE INDEX "RustPriceSource_workspaceId_productKey_scanStatus_idx"
  ON "RustPriceSource"("workspaceId", "productKey", "scanStatus");

ALTER TABLE "RustAccountListing" ADD COLUMN "productKey" TEXT NOT NULL DEFAULT 'rust-nfa-accounts';
DROP INDEX IF EXISTS "RustAccountListing_workspaceId_fingerprint_key";
DROP INDEX IF EXISTS "RustAccountListing_workspaceId_active_lastSeenAt_idx";
CREATE UNIQUE INDEX "RustAccountListing_workspaceId_productKey_fingerprint_key"
  ON "RustAccountListing"("workspaceId", "productKey", "fingerprint");
CREATE INDEX "RustAccountListing_workspaceId_productKey_active_lastSeenAt_idx"
  ON "RustAccountListing"("workspaceId", "productKey", "active", "lastSeenAt");
