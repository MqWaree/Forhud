CREATE TABLE "WorkspaceRank" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "color" TEXT NOT NULL DEFAULT '#8792A6',
  "position" INTEGER NOT NULL DEFAULT 0,
  "permissionsJson" TEXT NOT NULL DEFAULT '[]',
  "managed" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "WorkspaceRank_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WorkspaceRank_workspaceId_name_key" ON "WorkspaceRank"("workspaceId", "name");
CREATE INDEX "WorkspaceRank_workspaceId_position_idx" ON "WorkspaceRank"("workspaceId", "position");

CREATE TABLE "UserRank" (
  "userId" TEXT NOT NULL,
  "rankId" TEXT NOT NULL,
  "assignedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", "rankId"),
  CONSTRAINT "UserRank_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "UserRank_rankId_fkey" FOREIGN KEY ("rankId") REFERENCES "WorkspaceRank" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "UserRank_rankId_idx" ON "UserRank"("rankId");
