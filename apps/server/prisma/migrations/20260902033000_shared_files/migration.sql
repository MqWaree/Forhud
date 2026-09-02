CREATE TABLE "SharedFile" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "uploadedById" TEXT,
  "storageName" TEXT NOT NULL,
  "originalName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
  "sizeBytes" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "downloadCount" INTEGER NOT NULL DEFAULT 0,
  "lastDownloadedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SharedFile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SharedFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SharedFile_storageName_key" ON "SharedFile"("storageName");
CREATE INDEX "SharedFile_workspaceId_createdAt_idx" ON "SharedFile"("workspaceId", "createdAt");
CREATE INDEX "SharedFile_uploadedById_idx" ON "SharedFile"("uploadedById");
