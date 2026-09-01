import { prisma } from "./db.js";

const CURRENT_SEARCH_KEY = "search.brave.current";
const MAX_PAGES_PER_QUERY_VARIANT = 10;

export type CurrentSearchProgress = {
  operationId: string;
  query: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  phase: string;
  requested: number;
  discovered: number;
  queued: number;
  duplicates: number;
  rejected: number;
  excluded: number;
  leadsAdded: number;
  requests: number;
  failedRequests: number;
  queryPagesChecked: number;
  totalVariants: number;
  activeVariants: number;
  progressPercent: number;
  stopReason?: string;
  startedAt: string;
  updatedAt: string;
};

const currentByWorkspace = new Map<string, CurrentSearchProgress>();
const pendingWrites = new Map<string, Promise<void>>();

function boundedPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function discoveryProgressPercent(input: {
  requested: number;
  discovered: number;
  queryPagesChecked: number;
  totalVariants: number;
  maxRequests: number;
}) {
  const targetShare = input.discovered / Math.max(1, input.requested);
  const plannedChecks = Math.max(
    1,
    Math.min(
      input.maxRequests,
      Math.max(1, input.totalVariants) * MAX_PAGES_PER_QUERY_VARIANT,
    ),
  );
  const workShare = input.queryPagesChecked / plannedChecks;
  return boundedPercent(4 + Math.min(1, Math.max(targetShare, workShare)) * 86);
}

export function setCurrentSearchProgress(
  workspaceId: string,
  progress: CurrentSearchProgress,
) {
  currentByWorkspace.set(workspaceId, progress);
  const previous = pendingWrites.get(workspaceId) || Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(async () => {
      await prisma.workspaceSetting.upsert({
        where: {
          workspaceId_key: { workspaceId, key: CURRENT_SEARCH_KEY },
        },
        create: {
          workspaceId,
          key: CURRENT_SEARCH_KEY,
          value: JSON.stringify(progress),
        },
        update: { value: JSON.stringify(progress) },
      });
    })
    .catch((error) => {
      console.error("Current search progress could not be persisted", error);
    });
  pendingWrites.set(workspaceId, write);
  void write.finally(() => {
    if (pendingWrites.get(workspaceId) === write)
      pendingWrites.delete(workspaceId);
  });
  return write;
}

export async function getCurrentSearchProgress(workspaceId: string) {
  const current = currentByWorkspace.get(workspaceId);
  if (current) return current;
  const saved = await prisma.workspaceSetting.findUnique({
    where: {
      workspaceId_key: { workspaceId, key: CURRENT_SEARCH_KEY },
    },
    select: { value: true },
  });
  if (!saved) return null;
  try {
    const parsed = JSON.parse(saved.value) as CurrentSearchProgress;
    if (
      !parsed ||
      typeof parsed.operationId !== "string" ||
      typeof parsed.query !== "string"
    )
      return null;
    if (parsed.status === "RUNNING") {
      const interrupted: CurrentSearchProgress = {
        ...parsed,
        status: "FAILED",
        phase: "Search interrupted by a server restart",
        updatedAt: new Date().toISOString(),
      };
      currentByWorkspace.set(workspaceId, interrupted);
      void setCurrentSearchProgress(workspaceId, interrupted);
      return interrupted;
    }
    currentByWorkspace.set(workspaceId, parsed);
    return parsed;
  } catch {
    return null;
  }
}
