-- @foreign_keys_off
CREATE TABLE "Workspace" ("id" TEXT NOT NULL PRIMARY KEY,"name" TEXT NOT NULL,"scannerId" TEXT NOT NULL,"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "Workspace_scannerId_key" ON "Workspace"("scannerId");
INSERT INTO "Workspace" ("id","name","scannerId") VALUES ('legacy-workspace','Default Workspace','A7K9-X2P4');

CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY,"workspaceId" TEXT NOT NULL,"name" TEXT NOT NULL,"email" TEXT NOT NULL,"passwordHash" TEXT NOT NULL,"role" TEXT NOT NULL DEFAULT 'RESEARCHER',"status" TEXT NOT NULL DEFAULT 'ACTIVE',"requirePasswordChange" BOOLEAN NOT NULL DEFAULT false,"lastLoginAt" DATETIME,"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "User_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_workspaceId_idx" ON "User"("workspaceId");
CREATE INDEX "User_role_status_idx" ON "User"("role","status");

CREATE TABLE "AuthSession" ("id" TEXT NOT NULL PRIMARY KEY,"tokenHash" TEXT NOT NULL,"userId" TEXT NOT NULL,"expiresAt" DATETIME NOT NULL,"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"lastSeen" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE UNIQUE INDEX "AuthSession_tokenHash_key" ON "AuthSession"("tokenHash");
CREATE INDEX "AuthSession_userId_idx" ON "AuthSession"("userId");
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");

CREATE TABLE "ExtensionInstance" ("id" TEXT NOT NULL PRIMARY KEY,"instanceId" TEXT NOT NULL,"workspaceId" TEXT NOT NULL,"ownerUserId" TEXT,"tokenHash" TEXT NOT NULL,"name" TEXT NOT NULL DEFAULT 'Chrome Extension',"scannerState" TEXT NOT NULL DEFAULT 'IDLE',"currentSearch" TEXT NOT NULL DEFAULT '',"currentPage" INTEGER NOT NULL DEFAULT 0,"pagesScanned" INTEGER NOT NULL DEFAULT 0,"resultsFound" INTEGER NOT NULL DEFAULT 0,"uniqueUrlsSent" INTEGER NOT NULL DEFAULT 0,"duplicatesSkipped" INTEGER NOT NULL DEFAULT 0,"lastSeen" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"revokedAt" DATETIME,"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "ExtensionInstance_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,CONSTRAINT "ExtensionInstance_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE);
CREATE UNIQUE INDEX "ExtensionInstance_instanceId_key" ON "ExtensionInstance"("instanceId");
CREATE UNIQUE INDEX "ExtensionInstance_tokenHash_key" ON "ExtensionInstance"("tokenHash");
CREATE INDEX "ExtensionInstance_workspaceId_lastSeen_idx" ON "ExtensionInstance"("workspaceId","lastSeen");
CREATE INDEX "ExtensionInstance_ownerUserId_idx" ON "ExtensionInstance"("ownerUserId");

ALTER TABLE "SearchSession" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "SearchSession" ADD COLUMN "extensionInstanceId" TEXT;
ALTER TABLE "SearchSession" ADD COLUMN "pages" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "SearchSession" ADD COLUMN "durationMs" INTEGER;
ALTER TABLE "SearchSession" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'Captured';
UPDATE "SearchSession" SET "workspaceId"='legacy-workspace' WHERE "workspaceId" IS NULL;
CREATE INDEX "SearchSession_workspaceId_createdAt_idx" ON "SearchSession"("workspaceId","createdAt");
CREATE INDEX "SearchSession_extensionInstanceId_idx" ON "SearchSession"("extensionInstanceId");

ALTER TABLE "ScannerState" RENAME TO "ScannerState_old";
CREATE TABLE "ScannerState" ("id" TEXT NOT NULL PRIMARY KEY,"workspaceId" TEXT NOT NULL,"status" TEXT NOT NULL DEFAULT 'IDLE',"stopRequested" BOOLEAN NOT NULL DEFAULT false,"currentResultId" TEXT,"startedAt" DATETIME,"stoppedAt" DATETIME,"updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "ScannerState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE);
INSERT INTO "ScannerState" ("id","workspaceId","status","stopRequested","currentResultId","startedAt","stoppedAt","updatedAt") SELECT "id",'legacy-workspace',"status","stopRequested","currentResultId","startedAt","stoppedAt","updatedAt" FROM "ScannerState_old";
CREATE UNIQUE INDEX "ScannerState_workspaceId_key" ON "ScannerState"("workspaceId");
DROP TABLE "ScannerState_old";

ALTER TABLE "ScannerSource" RENAME TO "ScannerSource_old";
ALTER TABLE "ScannerDiscordLink" RENAME TO "ScannerDiscordLink_old";
ALTER TABLE "LeadTag" RENAME TO "LeadTag_old";
ALTER TABLE "LeadActivity" RENAME TO "LeadActivity_old";
ALTER TABLE "Lead" RENAME TO "Lead_old";
ALTER TABLE "Tag" RENAME TO "Tag_old";
ALTER TABLE "ScannerResult" RENAME TO "ScannerResult_old";
DROP INDEX IF EXISTS "ScannerResult_scanStatus_idx";
DROP INDEX IF EXISTS "ScannerResult_normalizedUrl_key";
DROP INDEX IF EXISTS "ScannerResult_domainId_key";
DROP INDEX IF EXISTS "Lead_scannerResultId_idx";
DROP INDEX IF EXISTS "Lead_domainId_key";
DROP INDEX IF EXISTS "ScannerSource_clientId_idx";
DROP INDEX IF EXISTS "ScannerSource_scannerResultId_searchSessionId_key";
DROP INDEX IF EXISTS "ScannerDiscordLink_scannerResultId_url_key";
DROP INDEX IF EXISTS "Tag_name_key";

CREATE TABLE "ScannerResult" ("id" TEXT NOT NULL PRIMARY KEY,"workspaceId" TEXT NOT NULL,"url" TEXT NOT NULL,"normalizedUrl" TEXT NOT NULL,"title" TEXT NOT NULL DEFAULT '',"domainId" TEXT NOT NULL,"scanStatus" TEXT NOT NULL DEFAULT 'Pending',"httpStatus" INTEGER,"scanDuration" INTEGER,"error" TEXT,"scannedAt" DATETIME,"firstSeen" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"lastSeen" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "ScannerResult_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,CONSTRAINT "ScannerResult_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE);
INSERT INTO "ScannerResult" ("id","workspaceId","url","normalizedUrl","title","domainId","scanStatus","httpStatus","scanDuration","error","scannedAt","firstSeen","lastSeen","createdAt","updatedAt") SELECT "id",'legacy-workspace',"url","normalizedUrl","title","domainId","scanStatus","httpStatus","scanDuration","error","scannedAt","firstSeen","lastSeen","createdAt","updatedAt" FROM "ScannerResult_old";
CREATE UNIQUE INDEX "ScannerResult_workspaceId_normalizedUrl_key" ON "ScannerResult"("workspaceId","normalizedUrl");
CREATE UNIQUE INDEX "ScannerResult_workspaceId_domainId_key" ON "ScannerResult"("workspaceId","domainId");
CREATE INDEX "ScannerResult_workspaceId_scanStatus_idx" ON "ScannerResult"("workspaceId","scanStatus");

CREATE TABLE "Lead" ("id" TEXT NOT NULL PRIMARY KEY,"workspaceId" TEXT NOT NULL,"domainId" TEXT NOT NULL,"searchResultId" TEXT,"scannerResultId" TEXT,"assignedToId" TEXT,"status" TEXT NOT NULL DEFAULT 'New',"priority" TEXT NOT NULL DEFAULT 'Medium',"notes" TEXT NOT NULL DEFAULT '',"companyName" TEXT NOT NULL DEFAULT '',"contactName" TEXT NOT NULL DEFAULT '',"email" TEXT NOT NULL DEFAULT '',"discordUsername" TEXT NOT NULL DEFAULT '',"telegram" TEXT NOT NULL DEFAULT '',"otherContact" TEXT NOT NULL DEFAULT '',"website" TEXT NOT NULL DEFAULT '',"discordInvite" TEXT NOT NULL DEFAULT '',"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "Lead_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,CONSTRAINT "Lead_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE,CONSTRAINT "Lead_searchResultId_fkey" FOREIGN KEY ("searchResultId") REFERENCES "SearchResult"("id") ON DELETE SET NULL ON UPDATE CASCADE,CONSTRAINT "Lead_scannerResultId_fkey" FOREIGN KEY ("scannerResultId") REFERENCES "ScannerResult"("id") ON DELETE SET NULL ON UPDATE CASCADE,CONSTRAINT "Lead_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE);
INSERT INTO "Lead" ("id","workspaceId","domainId","searchResultId","scannerResultId","status","priority","notes","companyName","contactName","email","discordUsername","telegram","otherContact","website","discordInvite","createdAt","updatedAt") SELECT "id",'legacy-workspace',"domainId","searchResultId","scannerResultId","status","priority","notes","companyName","contactName","email","discordUsername","telegram","otherContact","website","discordInvite","createdAt","updatedAt" FROM "Lead_old";
CREATE UNIQUE INDEX "Lead_workspaceId_domainId_key" ON "Lead"("workspaceId","domainId");
CREATE INDEX "Lead_workspaceId_status_idx" ON "Lead"("workspaceId","status");
CREATE INDEX "Lead_assignedToId_idx" ON "Lead"("assignedToId");
CREATE INDEX "Lead_scannerResultId_idx" ON "Lead"("scannerResultId");

CREATE TABLE "LeadActivity" ("id" TEXT NOT NULL PRIMARY KEY,"leadId" TEXT NOT NULL,"actorId" TEXT,"previousAssigneeId" TEXT,"newAssigneeId" TEXT,"type" TEXT NOT NULL,"description" TEXT NOT NULL,"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "LeadActivity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE,CONSTRAINT "LeadActivity_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE);
INSERT INTO "LeadActivity" ("id","leadId","type","description","createdAt") SELECT "id","leadId","type","description","createdAt" FROM "LeadActivity_old";
CREATE INDEX "LeadActivity_leadId_createdAt_idx" ON "LeadActivity"("leadId","createdAt");
CREATE INDEX "LeadActivity_actorId_idx" ON "LeadActivity"("actorId");

CREATE TABLE "Tag" ("id" TEXT NOT NULL PRIMARY KEY,"workspaceId" TEXT NOT NULL,"name" TEXT NOT NULL,"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "Tag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE);
INSERT INTO "Tag" ("id","workspaceId","name","createdAt") SELECT "id",'legacy-workspace',"name","createdAt" FROM "Tag_old";
CREATE UNIQUE INDEX "Tag_workspaceId_name_key" ON "Tag"("workspaceId","name");

CREATE TABLE "ScannerSource" ("id" TEXT NOT NULL PRIMARY KEY,"scannerResultId" TEXT NOT NULL,"searchSessionId" TEXT NOT NULL,"query" TEXT NOT NULL,"clientId" TEXT NOT NULL DEFAULT 'DEFAULT',"position" INTEGER NOT NULL,"discoveredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "ScannerSource_scannerResultId_fkey" FOREIGN KEY ("scannerResultId") REFERENCES "ScannerResult"("id") ON DELETE CASCADE ON UPDATE CASCADE,CONSTRAINT "ScannerSource_searchSessionId_fkey" FOREIGN KEY ("searchSessionId") REFERENCES "SearchSession"("id") ON DELETE CASCADE ON UPDATE CASCADE);
INSERT INTO "ScannerSource" SELECT "id","scannerResultId","searchSessionId","query","clientId","position","discoveredAt" FROM "ScannerSource_old";
CREATE UNIQUE INDEX "ScannerSource_scannerResultId_searchSessionId_key" ON "ScannerSource"("scannerResultId","searchSessionId");
CREATE INDEX "ScannerSource_clientId_idx" ON "ScannerSource"("clientId");

CREATE TABLE "ScannerDiscordLink" ("id" TEXT NOT NULL PRIMARY KEY,"scannerResultId" TEXT NOT NULL,"url" TEXT NOT NULL,"inviteCode" TEXT NOT NULL,"sourcePage" TEXT NOT NULL,"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "ScannerDiscordLink_scannerResultId_fkey" FOREIGN KEY ("scannerResultId") REFERENCES "ScannerResult"("id") ON DELETE CASCADE ON UPDATE CASCADE);
INSERT INTO "ScannerDiscordLink" SELECT "id","scannerResultId","url","inviteCode","sourcePage","createdAt" FROM "ScannerDiscordLink_old";
CREATE UNIQUE INDEX "ScannerDiscordLink_scannerResultId_url_key" ON "ScannerDiscordLink"("scannerResultId","url");

CREATE TABLE "LeadTag" ("leadId" TEXT NOT NULL,"tagId" TEXT NOT NULL,"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY ("leadId","tagId"),CONSTRAINT "LeadTag_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE,CONSTRAINT "LeadTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE);
INSERT INTO "LeadTag" SELECT "leadId","tagId","createdAt" FROM "LeadTag_old";

DROP TABLE "ScannerSource_old";
DROP TABLE "ScannerDiscordLink_old";
DROP TABLE "LeadTag_old";
DROP TABLE "LeadActivity_old";
DROP TABLE "Lead_old";
DROP TABLE "Tag_old";
DROP TABLE "ScannerResult_old";

CREATE TABLE "WorkspaceSetting" ("workspaceId" TEXT NOT NULL,"key" TEXT NOT NULL,"value" TEXT NOT NULL,"updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY ("workspaceId","key"),CONSTRAINT "WorkspaceSetting_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE TABLE "Notification" ("id" TEXT NOT NULL PRIMARY KEY,"workspaceId" TEXT NOT NULL,"userId" TEXT NOT NULL,"type" TEXT NOT NULL,"title" TEXT NOT NULL,"body" TEXT NOT NULL,"readAt" DATETIME,"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "Notification_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId","readAt","createdAt");
CREATE TABLE "AuditLog" ("id" TEXT NOT NULL PRIMARY KEY,"workspaceId" TEXT,"actorId" TEXT,"action" TEXT NOT NULL,"targetType" TEXT NOT NULL,"targetId" TEXT,"metadata" TEXT NOT NULL DEFAULT '{}',"ipAddress" TEXT,"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "AuditLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE,CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE);
CREATE INDEX "AuditLog_workspaceId_createdAt_idx" ON "AuditLog"("workspaceId","createdAt");
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");
CREATE TABLE "BackupMetadata" ("id" TEXT NOT NULL PRIMARY KEY,"filename" TEXT NOT NULL,"type" TEXT NOT NULL DEFAULT 'MANUAL',"size" INTEGER NOT NULL,"status" TEXT NOT NULL DEFAULT 'COMPLETED',"createdById" TEXT,"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"manifest" TEXT NOT NULL);
CREATE UNIQUE INDEX "BackupMetadata_filename_key" ON "BackupMetadata"("filename");
CREATE INDEX "BackupMetadata_createdAt_idx" ON "BackupMetadata"("createdAt");
