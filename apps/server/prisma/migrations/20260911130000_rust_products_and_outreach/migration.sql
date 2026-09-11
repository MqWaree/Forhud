-- Count of distinct Rust products the scanner saw on a website.
ALTER TABLE "ScannerResult" ADD COLUMN "rustProductCount" INTEGER NOT NULL DEFAULT 0;

-- Per-workspace outreach message templates used to draft specialised messages.
CREATE TABLE "OutreachTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OutreachTemplate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "OutreachTemplate_workspaceId_position_idx" ON "OutreachTemplate"("workspaceId", "position");
