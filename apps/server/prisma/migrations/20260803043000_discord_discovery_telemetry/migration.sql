ALTER TABLE "ScannerResult" ADD COLUMN "originalHttpStatus" INTEGER;
ALTER TABLE "ScannerResult" ADD COLUMN "fallbackUsed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ScannerResult" ADD COLUMN "fallbackUrl" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ScannerResult" ADD COLUMN "fallbackHttpStatus" INTEGER;
ALTER TABLE "ScannerResult" ADD COLUMN "discoveryFailureReason" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ScannerResult" ADD COLUMN "robotsStatus" TEXT NOT NULL DEFAULT '';

ALTER TABLE "ScannerDiscordLink" ADD COLUMN "discoveryMethod" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "ScannerDiscordLink" ADD COLUMN "fetchMode" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ScannerDiscordLink" ADD COLUMN "validationStatus" TEXT NOT NULL DEFAULT 'UNVALIDATED';
ALTER TABLE "ScannerDiscordLink" ADD COLUMN "originalUrl" TEXT NOT NULL DEFAULT '';
