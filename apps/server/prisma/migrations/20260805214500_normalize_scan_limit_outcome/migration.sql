UPDATE "ScannerResult"
SET "discoveryFailureReason" = 'DISCORD_NOT_FOUND'
WHERE "discoveryFailureReason" = 'SCAN_LIMIT_REACHED';
