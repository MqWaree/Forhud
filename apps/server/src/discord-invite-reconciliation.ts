import { normalizeDiscordUrl } from "@lead/shared";
import pLimit from "p-limit";
import { randomUUID } from "node:crypto";
import { prisma } from "./db.js";
import { emit } from "./events.js";

const DISCORD_INVITE_ENDPOINT = "https://discord.com/api/v10/invites";
const PROGRESS_SETTING_KEY = "scanner.discord-reconciliation.current";
const RECONCILE_CONCURRENCY = Math.max(
  1,
  Math.min(4, Number(process.env.DISCORD_INVITE_RECONCILE_CONCURRENCY || 2)),
);
const REQUEST_TIMEOUT_MS = Math.max(
  2_000,
  Math.min(20_000, Number(process.env.DISCORD_INVITE_TIMEOUT_MS || 8_000)),
);
const RECONCILE_DEADLINE_MS = Math.max(
  60_000,
  Math.min(
    30 * 60_000,
    Number(process.env.DISCORD_INVITE_RECONCILE_DEADLINE_MS || 10 * 60_000),
  ),
);

export type DiscordReconciliationProgress = {
  operationId: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  phase: string;
  total: number;
  checked: number;
  uniqueDestinations: number;
  processedDestinations: number;
  requestsSaved: number;
  valid: number;
  invalid: number;
  failed: number;
  rateLimited: number;
  progressPercent: number;
  invites?: number;
  uniqueServers?: number;
  alternateInvites?: number;
  resolved?: number;
  unresolved?: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
};

type DiscordLinkRecord = {
  id: string;
  url: string;
  inviteCode: string;
  discordGuildId: string;
  discordGuildName: string;
  lastValidatedAt: Date | null;
};

type ReconciliationUpdate = Pick<
  DiscordReconciliationProgress,
  | "phase"
  | "total"
  | "checked"
  | "uniqueDestinations"
  | "processedDestinations"
  | "requestsSaved"
  | "valid"
  | "invalid"
  | "failed"
  | "rateLimited"
  | "progressPercent"
>;

const progressByWorkspace = new Map<string, DiscordReconciliationProgress>();
const activeJobs = new Map<string, Promise<void>>();
const pendingProgressWrites = new Map<string, Promise<void>>();

export type DiscordDestinationResolution = {
  status: "VALID" | "INVALID" | "NON_GUILD" | "RATE_LIMITED" | "ERROR";
  guildId: string;
  guildName: string;
};

type DiscordInviteResponse = {
  guild?: { id?: unknown; name?: unknown };
  retry_after?: unknown;
};

const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function channelGuildId(url: string) {
  return normalizeDiscordUrl(url)?.match(/\/channels\/(\d+)/)?.[1] || "";
}

function inviteCode(url: string, storedCode: string) {
  const normalized = normalizeDiscordUrl(url);
  if (!normalized || normalized.includes("/channels/")) return "";
  const code = normalized.split("/").pop() || storedCode;
  return /^[A-Za-z0-9_-]{2,100}$/.test(code) ? code : "";
}

async function retryDelay(response: Response) {
  const headerSeconds = Number(response.headers.get("retry-after"));
  if (Number.isFinite(headerSeconds) && headerSeconds > 0)
    return Math.min(30_000, Math.ceil(headerSeconds * 1_000));
  const body = (await response
    .json()
    .catch(() => ({}))) as DiscordInviteResponse;
  const bodySeconds = Number(body.retry_after);
  return Number.isFinite(bodySeconds) && bodySeconds > 0
    ? Math.min(30_000, Math.ceil(bodySeconds * 1_000))
    : 1_000;
}

export async function resolveDiscordDestination(
  destination: { url: string; inviteCode: string },
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<DiscordDestinationResolution> {
  const guildIdFromChannel = channelGuildId(destination.url);
  if (guildIdFromChannel)
    return {
      status: "VALID",
      guildId: guildIdFromChannel,
      guildName: "",
    };

  const code = inviteCode(destination.url, destination.inviteCode);
  if (!code) return { status: "INVALID", guildId: "", guildName: "" };

  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetcher(
        `${DISCORD_INVITE_ENDPOINT}/${encodeURIComponent(code)}?with_counts=true`,
        {
          headers: {
            Accept: "application/json",
            "User-Agent": "FGP/1.0 (+https://forhud.shop)",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch {
      if (attempt < 2) {
        await wait(300 * 2 ** attempt);
        continue;
      }
      return { status: "ERROR", guildId: "", guildName: "" };
    }

    if (response.status === 404)
      return { status: "INVALID", guildId: "", guildName: "" };
    if (response.status === 429) {
      if (attempt < 2) {
        await wait(await retryDelay(response));
        continue;
      }
      return { status: "RATE_LIMITED", guildId: "", guildName: "" };
    }
    if ((response.status === 403 || response.status >= 500) && attempt < 2) {
      await wait(500 * 2 ** attempt);
      continue;
    }
    if (!response.ok) return { status: "ERROR", guildId: "", guildName: "" };

    const payload = (await response
      .json()
      .catch(() => ({}))) as DiscordInviteResponse;
    const guildId =
      typeof payload.guild?.id === "string" ? payload.guild.id : "";
    if (!guildId) return { status: "NON_GUILD", guildId: "", guildName: "" };
    return {
      status: "VALID",
      guildId,
      guildName:
        typeof payload.guild?.name === "string"
          ? payload.guild.name.slice(0, 500)
          : "",
    };
  }
  return { status: "ERROR", guildId: "", guildName: "" };
}

export function summarizeDiscordDestinations(
  links: Array<{
    id?: string;
    url: string;
    discordGuildId: string;
    lastValidatedAt?: Date | null;
  }>,
) {
  const guildIds = new Set<string>();
  let resolved = 0;
  let lastReconciledAt: Date | null = null;
  for (const link of links) {
    if (link.discordGuildId) {
      guildIds.add(link.discordGuildId);
      resolved++;
    }
    if (
      link.lastValidatedAt &&
      (!lastReconciledAt || link.lastValidatedAt > lastReconciledAt)
    )
      lastReconciledAt = link.lastValidatedAt;
  }
  return {
    invites: links.length,
    uniqueServers: guildIds.size,
    alternateInvites: Math.max(0, resolved - guildIds.size),
    resolved,
    unresolved: links.length - resolved,
    lastReconciledAt,
  };
}

export function groupDiscordDestinations(links: DiscordLinkRecord[]) {
  const groups = new Map<string, DiscordLinkRecord[]>();
  for (const link of links) {
    const guildId = channelGuildId(link.url);
    const code = inviteCode(link.url, link.inviteCode);
    const normalized = normalizeDiscordUrl(link.url);
    const key = guildId
      ? `guild:${guildId}`
      : code
        ? `invite:${code}`
        : `invalid:${normalized || link.url}`;
    const group = groups.get(key);
    if (group) group.push(link);
    else groups.set(key, [link]);
  }
  return [...groups.values()];
}

async function updateLinks(
  links: DiscordLinkRecord[],
  resolution: DiscordDestinationResolution,
  checkedAt: Date,
) {
  const data = {
    validationStatus: resolution.status,
    lastValidatedAt: checkedAt,
    ...(resolution.status === "VALID"
      ? {
          discordGuildId: resolution.guildId,
          discordGuildName: resolution.guildName,
        }
      : resolution.status === "INVALID" || resolution.status === "NON_GUILD"
        ? { discordGuildId: "", discordGuildName: "" }
        : {}),
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++)
    try {
      await prisma.scannerDiscordLink.updateMany({
        where: { id: { in: links.map((link) => link.id) } },
        data,
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await wait(100 * 2 ** attempt);
    }
  throw lastError;
}

function persistProgress(
  workspaceId: string,
  progress: DiscordReconciliationProgress,
) {
  const previous = pendingProgressWrites.get(workspaceId) || Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(() =>
      prisma.workspaceSetting.upsert({
        where: {
          workspaceId_key: {
            workspaceId,
            key: PROGRESS_SETTING_KEY,
          },
        },
        create: {
          workspaceId,
          key: PROGRESS_SETTING_KEY,
          value: JSON.stringify(progress),
        },
        update: { value: JSON.stringify(progress) },
      }),
    )
    .then(() => undefined)
    .catch((error) => {
      console.error(
        "Discord reconciliation progress could not be persisted",
        error,
      );
    });
  pendingProgressWrites.set(workspaceId, write);
  void write.finally(() => {
    if (pendingProgressWrites.get(workspaceId) === write)
      pendingProgressWrites.delete(workspaceId);
  });
  return write;
}

function publishProgress(
  workspaceId: string,
  progress: DiscordReconciliationProgress,
  persist = false,
) {
  progressByWorkspace.set(workspaceId, progress);
  emit("discord-reconciliation-progress", progress, workspaceId);
  return persist ? persistProgress(workspaceId, progress) : Promise.resolve();
}

export async function getDiscordReconciliationProgress(workspaceId: string) {
  const current = progressByWorkspace.get(workspaceId);
  if (current) return current;
  const saved = await prisma.workspaceSetting.findUnique({
    where: {
      workspaceId_key: { workspaceId, key: PROGRESS_SETTING_KEY },
    },
    select: { value: true },
  });
  if (!saved) return null;
  try {
    const progress = JSON.parse(saved.value) as DiscordReconciliationProgress;
    if (!progress.operationId || !progress.status) return null;
    if (progress.status === "RUNNING" && !activeJobs.has(workspaceId)) {
      const interrupted: DiscordReconciliationProgress = {
        ...progress,
        status: "FAILED",
        phase: "Checker interrupted by a server restart",
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: "The previous checker run was interrupted. Start it again.",
      };
      await publishProgress(workspaceId, interrupted, true);
      return interrupted;
    }
    progressByWorkspace.set(workspaceId, progress);
    return progress;
  } catch {
    return null;
  }
}

export async function reconcileWorkspaceDiscordInvites(
  workspaceId: string,
  onProgress?: (progress: ReconciliationUpdate) => void,
) {
  const links = await prisma.scannerDiscordLink.findMany({
    where: {
      scannerResult: { workspaceId, scanStatus: { not: "Excluded" } },
    },
    select: {
      id: true,
      url: true,
      inviteCode: true,
      discordGuildId: true,
      discordGuildName: true,
      lastValidatedAt: true,
    },
  });
  const groups = groupDiscordDestinations(links);
  const limit = pLimit(RECONCILE_CONCURRENCY);
  const deadline = Date.now() + RECONCILE_DEADLINE_MS;
  const counters = {
    checked: 0,
    processedDestinations: 0,
    valid: 0,
    invalid: 0,
    failed: 0,
    rateLimited: 0,
  };
  const report = (phase: string) =>
    onProgress?.({
      phase,
      total: links.length,
      checked: counters.checked,
      uniqueDestinations: groups.length,
      processedDestinations: counters.processedDestinations,
      requestsSaved: Math.max(0, links.length - groups.length),
      valid: counters.valid,
      invalid: counters.invalid,
      failed: counters.failed,
      rateLimited: counters.rateLimited,
      progressPercent: links.length
        ? Math.min(100, Math.round((counters.checked / links.length) * 100))
        : 100,
    });
  report(
    links.length
      ? "Preparing unique Discord destinations"
      : "No Discord links to check",
  );

  await Promise.all(
    groups.map((group) =>
      limit(async () => {
        const resolution =
          Date.now() >= deadline
            ? ({
                status: "ERROR",
                guildId: "",
                guildName: "",
              } satisfies DiscordDestinationResolution)
            : await resolveDiscordDestination(group[0]!);
        await updateLinks(group, resolution, new Date());
        counters.checked += group.length;
        counters.processedDestinations += 1;
        if (resolution.status === "VALID") counters.valid += group.length;
        else if (
          resolution.status === "INVALID" ||
          resolution.status === "NON_GUILD"
        )
          counters.invalid += group.length;
        else {
          counters.failed += group.length;
          if (resolution.status === "RATE_LIMITED")
            counters.rateLimited += group.length;
        }
        report(
          resolution.status === "RATE_LIMITED"
            ? "Discord asked the checker to slow down"
            : "Checking unique Discord destinations",
        );
      }),
    ),
  );

  const refreshed = await prisma.scannerDiscordLink.findMany({
    where: {
      scannerResult: { workspaceId, scanStatus: { not: "Excluded" } },
    },
    select: {
      url: true,
      discordGuildId: true,
      lastValidatedAt: true,
    },
  });
  const summary = summarizeDiscordDestinations(refreshed);
  return {
    ...summary,
    checked: counters.checked,
    valid: counters.valid,
    invalid: counters.invalid,
    failed: counters.failed,
    rateLimited: counters.rateLimited,
    uniqueDestinations: groups.length,
    requestsSaved: Math.max(0, links.length - groups.length),
  };
}

export async function startWorkspaceDiscordInviteReconciliation(
  workspaceId: string,
) {
  const existingJob = activeJobs.get(workspaceId);
  if (existingJob) {
    return {
      started: false,
      progress: await getDiscordReconciliationProgress(workspaceId),
    };
  }

  const now = new Date().toISOString();
  let progress: DiscordReconciliationProgress = {
    operationId: randomUUID(),
    status: "RUNNING",
    phase: "Loading Discord destinations",
    total: 0,
    checked: 0,
    uniqueDestinations: 0,
    processedDestinations: 0,
    requestsSaved: 0,
    valid: 0,
    invalid: 0,
    failed: 0,
    rateLimited: 0,
    progressPercent: 0,
    startedAt: now,
    updatedAt: now,
  };
  await publishProgress(workspaceId, progress, true);

  const job = (async () => {
    try {
      const result = await reconcileWorkspaceDiscordInvites(
        workspaceId,
        (update) => {
          progress = {
            ...progress,
            ...update,
            updatedAt: new Date().toISOString(),
          };
          const persist =
            update.processedDestinations % 5 === 0 ||
            update.checked === update.total;
          void publishProgress(workspaceId, progress, persist);
        },
      );
      const completedAt = new Date().toISOString();
      progress = {
        ...progress,
        ...result,
        status: "COMPLETED",
        phase: result.failed
          ? "Check completed with temporary errors"
          : "Discord link check completed",
        progressPercent: 100,
        updatedAt: completedAt,
        completedAt,
      };
      await publishProgress(workspaceId, progress, true);
      emit("discord-links-reconciled", result, workspaceId);
    } catch (error) {
      const completedAt = new Date().toISOString();
      progress = {
        ...progress,
        status: "FAILED",
        phase: "Discord link check failed",
        updatedAt: completedAt,
        completedAt,
        error: error instanceof Error ? error.message : "Checker failed",
      };
      await publishProgress(workspaceId, progress, true);
    } finally {
      activeJobs.delete(workspaceId);
    }
  })();
  activeJobs.set(workspaceId, job);
  return { started: true, progress };
}
