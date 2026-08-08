import { prisma } from "./db.js";
import { discordDestinationKind } from "@lead/shared";

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
    include: { discordLinks: true, sources: true, domain: true },
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
  const telegram = socials.find((link) => link.type === "telegram")?.url || "";
  const otherContact = socials
    .filter((link) => link.type !== "telegram")
    .map((link) => link.url)
    .join("\n");
  const sourceLabel =
    options.sourceLabel || result.sources[0]?.query || "Searcher";
  const website = result.finalUrl || result.url;
  const companyName =
    result.title && result.title !== result.domain.hostname ? result.title : "";
  const discoveredInvite = result.discordLinks.find(
    (link) => discordDestinationKind(link.url) === "invite",
  )?.url;

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
      discordInvite: discoveredInvite || "",
      email: emails[0] || "",
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
        : discoveredInvite || undefined,
      email: existing?.email ? undefined : emails[0] || undefined,
      telegram: existing?.telegram ? undefined : telegram || undefined,
      otherContact: existing?.otherContact
        ? undefined
        : otherContact || undefined,
    },
  });
  return { lead, created: !existing };
}
