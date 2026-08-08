-- @foreign_keys_off
-- Replace user email identity with a case-normalized username while preserving
-- accounts, password hashes, sessions, assignments, and audit relationships.
PRAGMA legacy_alter_table=ON;

ALTER TABLE "User" RENAME TO "User_email_auth";

CREATE TABLE "User" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'RESEARCHER',
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "requirePasswordChange" BOOLEAN NOT NULL DEFAULT false,
  "lastLoginAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "User_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

WITH candidates AS (
  SELECT
    *,
    lower(
      replace(
        CASE
          WHEN instr("email", '@') > 1 THEN substr("email", 1, instr("email", '@') - 1)
          ELSE "email"
        END,
        '+',
        '-'
      )
    ) AS candidate
  FROM "User_email_auth"
), migrated AS (
  SELECT
    *,
    CASE
      WHEN count(*) OVER (PARTITION BY candidate) = 1 THEN candidate
      ELSE candidate || '-' || lower("id")
    END AS migratedUsername
  FROM candidates
)
INSERT INTO "User" (
  "id", "workspaceId", "name", "username", "passwordHash", "role",
  "status", "requirePasswordChange", "lastLoginAt", "createdAt", "updatedAt"
)
SELECT
  "id", "workspaceId", "name", "migratedUsername", "passwordHash", "role",
  "status", "requirePasswordChange", "lastLoginAt", "createdAt", "updatedAt"
FROM migrated;

DROP TABLE "User_email_auth";
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE INDEX "User_workspaceId_idx" ON "User"("workspaceId");
CREATE INDEX "User_role_status_idx" ON "User"("role", "status");

PRAGMA legacy_alter_table=OFF;
