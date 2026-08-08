-- Revoke tokens first so an installation upgraded from the public legacy
-- Scanner ID cannot retain an extension identity obtained with that value.
UPDATE "ExtensionInstance"
SET "revokedAt" = CURRENT_TIMESTAMP, "scannerState" = 'STOPPED'
WHERE "workspaceId" IN (
  SELECT "id" FROM "Workspace" WHERE "scannerId" = 'A7K9-X2P4'
);

-- Use a random, deliberately non-pairable transitional value. The runtime
-- security policy converts it to the normal 80-bit readable format before
-- setup or extension pairing can proceed.
UPDATE "Workspace"
SET "scannerId" = 'bootstrap-' || lower(hex(randomblob(16))),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "scannerId" = 'A7K9-X2P4';
