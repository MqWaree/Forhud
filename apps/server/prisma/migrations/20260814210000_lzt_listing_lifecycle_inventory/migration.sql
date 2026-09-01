-- Track verified listing lifecycle and official LZT inventory values.
ALTER TABLE "LztRustListing" ADD COLUMN "soldAt" DATETIME;
ALTER TABLE "LztRustListing" ADD COLUMN "inventoryCs2EurMinor" INTEGER;
ALTER TABLE "LztRustListing" ADD COLUMN "inventoryRustEurMinor" INTEGER;
ALTER TABLE "LztRustListing" ADD COLUMN "inventoryTotalEurMinor" INTEGER;

CREATE INDEX "LztRustListing_soldAt_idx" ON "LztRustListing"("soldAt");
