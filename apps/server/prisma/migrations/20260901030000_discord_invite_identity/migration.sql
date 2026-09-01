ALTER TABLE "ScannerDiscordLink" ADD COLUMN "discordGuildId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ScannerDiscordLink" ADD COLUMN "discordGuildName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ScannerDiscordLink" ADD COLUMN "lastValidatedAt" DATETIME;

CREATE INDEX "ScannerDiscordLink_discordGuildId_idx" ON "ScannerDiscordLink"("discordGuildId");
