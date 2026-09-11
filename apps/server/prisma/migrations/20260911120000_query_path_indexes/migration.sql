-- Composite indexes for the dashboard's hottest read paths and the scanner claim loop.
CREATE INDEX "Lead_workspaceId_updatedAt_idx" ON "Lead"("workspaceId", "updatedAt");
CREATE INDEX "Lead_workspaceId_createdAt_idx" ON "Lead"("workspaceId", "createdAt");
CREATE INDEX "ScannerResult_workspaceId_scanStatus_firstSeen_idx" ON "ScannerResult"("workspaceId", "scanStatus", "firstSeen");
CREATE INDEX "ScannerResult_workspaceId_lastSeen_idx" ON "ScannerResult"("workspaceId", "lastSeen");
CREATE INDEX "ScannerResult_workspaceId_scannedAt_idx" ON "ScannerResult"("workspaceId", "scannedAt");
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");
CREATE INDEX "Domain_lastSeen_idx" ON "Domain"("lastSeen");
CREATE INDEX "LztRustListing_baseline_itemState_firstSeenAt_idx" ON "LztRustListing"("baseline", "itemState", "firstSeenAt");
CREATE INDEX "LztMarketAverageSnapshot_calculatedAt_idx" ON "LztMarketAverageSnapshot"("calculatedAt");
CREATE INDEX "LztHazeAlert_updatedAt_idx" ON "LztHazeAlert"("updatedAt");
