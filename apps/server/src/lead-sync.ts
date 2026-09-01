import { prisma } from "./db.js";
import { discordDestinationKind, normalizeTelegramUrl } from "@lead/shared";
import { emit } from "./events.js";

type SyncLeadOptions = {
  workspaceId: string;
  scannerResultId: string;
  searchResultId?: string;
  actorId?: string;
  sourceLabel?: string;
};

function jsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Ensures a scanner domain is represented by exactly one workspace lead.
 * The database's workspace/domain unique key is the final concurrency guard.
 * Repeated searches attach to and enrich the existing lead without replacing
 * any value that a researcher has already entered.
 */
export async function syncScannerResultToLead(options: SyncLeadOptions) {
  const result = await prisma.scannerResult.findFirstOrThrow({
    where: {
      id: options.scannerResultId,
      workspaceId: options.workspaceId,
    },
    select: {
      id: true,
      domainId: true,
      url: true,
      finalUrl: true,
      title: true,
      emailsJson: true,
      socialLinksJson: true,
      discordLinks: {
        select: { url: true },
        orderBy: { createdAt: "asc" },
      },
      sources: {
        select: { query: true },
        orderBy: { discoveredAt: "asc" },
        take: 1,
      },
      domain: { select: { hostname: true } },
    },
  });
  const existing = await prisma.lead.findUnique({
    where: {
      workspaceId_domainId: {
        workspaceId: options.workspaceId,
        domainId: result.domainId,
      },
    },
  });
  const emails = jsonArray<string>(result.emailsJson);
  const socials = jsonArray<{ type: string; url: string }>(
    result.socialLinksJson,
  );
  const telegram =
    socials
      .filter((link) => link.type === "telegram")
      .map((link) => normalizeTelegramUrl(link.url))
      .find(Boolean) || "";
  const otherContact = socials
    .filter((link) => link.type !== "telegram")
    .map((link) => link.url)
    .join("\n");
  const sourceLabel =
    options.sourceLabel || result.sources[0]?.query || "Searcher";
  const website = result.finalUrl || result.url;
  const companyName =
    result.title && result.title !== result.domain.hostname ? result.title : "";
  const discoveredDiscord =
    result.discordLinks.find(
      (link) => discordDestinationKind(link.url) === "invite",
    )?.url || result.discordLinks[0]?.url;
  const discoveredEmail = emails[0] || "";

  // Manually created leads remain valid. Scanner discoveries become leads as
  // soon as Discord or Telegram is verified, with email as the fallback when
  // neither messaging destination is available.
  if (!existing && !discoveredDiscord && !telegram && !discoveredEmail)
    return { lead: null, created: false, skipped: true };

  const lead = await prisma.lead.upsert({
    where: {
      workspaceId_domainId: {
        workspaceId: options.workspaceId,
        domainId: result.domainId,
      },
    },
    create: {
      workspaceId: options.workspaceId,
      domainId: result.domainId,
      scannerResultId: result.id,
      searchResultId: options.searchResultId,
      status: "New",
      priority: "Medium",
      website,
      companyName,
      discordInvite: discoveredDiscord || "",
      email: discoveredEmail,
      telegram,
      otherContact,
      activities: {
        create: {
          actorId: options.actorId,
          type: "created",
          description: `Lead added automatically from Searcher · ${sourceLabel}`,
        },
      },
    },
    update: {
      scannerResultId: result.id,
      searchResultId: existing?.searchResultId
        ? undefined
        : options.searchResultId,
      website: existing?.website ? undefined : website,
      companyName: existing?.companyName ? undefined : companyName || undefined,
      discordInvite: existing?.discordInvite
        ? undefined
        : discoveredDiscord || undefined,
      email: existing?.email ? undefined : discoveredEmail || undefined,
      telegram: existing?.telegram ? undefined : telegram || undefined,
      otherContact: existing?.otherContact
        ? undefined
        : otherContact || undefined,
    },
  });
  emit("lead-update", { id: lead.id, created: !existing }, options.workspaceId);
  return { lead, created: !existing, skipped: false };
}
