ALTER TABLE "SearchSession" ADD COLUMN "clientId" TEXT NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE "ScannerSource" ADD COLUMN "clientId" TEXT NOT NULL DEFAULT 'DEFAULT';
CREATE INDEX "SearchSession_clientId_idx" ON "SearchSession"("clientId");
CREATE INDEX "ScannerSource_clientId_idx" ON "ScannerSource"("clientId");
