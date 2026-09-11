import type { NextFunction, Request, Response } from "express";
import { prisma } from "./db.js";
import type { AuthRequest } from "./auth.js";

export const rankPermissions = ["LZT_ACCESS"] as const;
export type RankPermission = (typeof rankPermissions)[number];

const defaults = [
  { name: "Owner", color: "#F3B85C", position: 300, permissions: ["LZT_ACCESS"], managed: true },
  { name: "LZT Access", color: "#AA8CFF", position: 200, permissions: ["LZT_ACCESS"], managed: true },
  { name: "Researcher", color: "#55C6FF", position: 100, permissions: [], managed: true },
  { name: "Member", color: "#8792A6", position: 0, permissions: [], managed: true },
] as const;

function parsePermissions(value: string): RankPermission[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((permission): permission is RankPermission => rankPermissions.includes(permission)) : [];
  } catch { return []; }
}

// Rank reconciliation runs a chain of SQLite writes. It used to run on every
// /auth/me and /members request; now it runs at most once per workspace per
// window unless a caller forces it (user or rank mutations).
const ENSURE_RANKS_INTERVAL_MS = 60_000;
const ensuredWorkspaces = new Map<string, number>();
const PERMISSION_CACHE_TTL_MS = 3_000;
const permissionUserIdCache = new Map<RankPermission, { expiresAt: number; userIds: string[] }>();

/** Drop memoized rank data after any rank, assignment, or user mutation. */
export function invalidateRankCaches(workspaceId?: string) {
  if (workspaceId) ensuredWorkspaces.delete(workspaceId);
  else ensuredWorkspaces.clear();
  permissionUserIdCache.clear();
}

export async function ensureWorkspaceRanks(workspaceId: string, options: { force?: boolean } = {}) {
  const lastRun = ensuredWorkspaces.get(workspaceId);
  if (!options.force && lastRun !== undefined && Date.now() - lastRun < ENSURE_RANKS_INTERVAL_MS) return;
  ensuredWorkspaces.set(workspaceId, Date.now());
  for (const item of defaults) {
    await prisma.workspaceRank.upsert({
      where: { workspaceId_name: { workspaceId, name: item.name } },
      update: item.managed ? { color: item.color, position: item.position, permissionsJson: JSON.stringify(item.permissions), managed: true } : {},
      create: { workspaceId, name: item.name, color: item.color, position: item.position, permissionsJson: JSON.stringify(item.permissions), managed: item.managed },
    });
  }
  const owner = await prisma.workspaceRank.findUnique({ where: { workspaceId_name: { workspaceId, name: "Owner" } } });
  const member = await prisma.workspaceRank.findUnique({ where: { workspaceId_name: { workspaceId, name: "Member" } } });
  if (owner) {
    const admins = await prisma.user.findMany({ where: { workspaceId, role: "ADMIN" }, select: { id: true } });
    for (const user of admins) await prisma.userRank.upsert({ where: { userId_rankId: { userId: user.id, rankId: owner.id } }, update: {}, create: { userId: user.id, rankId: owner.id } });
  }
  if (member) {
    const users = await prisma.user.findMany({ where: { workspaceId }, select: { id: true, rankAssignments: { select: { userId: true } } } });
    for (const user of users.filter((candidate) => !candidate.rankAssignments.length)) await prisma.userRank.create({ data: { userId: user.id, rankId: member.id } });
  }
}

export async function userHasRankPermission(userId: string, permission: RankPermission) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, rankAssignments: { select: { rank: { select: { permissionsJson: true } } } } } });
  if (!user) return false;
  if (user.role === "ADMIN") return true;
  return user.rankAssignments.some(({ rank }) => parsePermissions(rank.permissionsJson).includes(permission));
}

export async function userIdsWithRankPermission(permission: RankPermission) {
  const cached = permissionUserIdCache.get(permission);
  if (cached && cached.expiresAt > Date.now()) return cached.userIds;
  const users = await prisma.user.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true,
      role: true,
      rankAssignments: { select: { rank: { select: { permissionsJson: true } } } },
    },
  });
  const userIds = users
    .filter((user) => user.role === "ADMIN" || user.rankAssignments.some(({ rank }) => parsePermissions(rank.permissionsJson).includes(permission)))
    .map((user) => user.id);
  permissionUserIdCache.set(permission, { expiresAt: Date.now() + PERMISSION_CACHE_TTL_MS, userIds });
  return userIds;
}

export function requireRankPermission(permission: RankPermission) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = (req as AuthRequest).auth;
      if (!auth || !(await userHasRankPermission(auth.id, permission)))
        return res.status(403).json({ error: `Requires the ${permission === "LZT_ACCESS" ? "LZT Access" : permission} rank` });
      next();
    } catch (error) { next(error); }
  };
}

export async function publicRanksForUser(userId: string) {
  const rows = await prisma.userRank.findMany({ where: { userId }, orderBy: { rank: { position: "desc" } }, select: { rank: { select: { id: true, name: true, color: true, position: true, permissionsJson: true } } } });
  return rows.map(({ rank }) => ({ ...rank, permissions: parsePermissions(rank.permissionsJson), permissionsJson: undefined }));
}

export async function workspaceMemberDirectory(workspaceId: string) {
  await ensureWorkspaceRanks(workspaceId);
  const activeSince = new Date(Date.now() - 10 * 60_000);
  const users = await prisma.user.findMany({
    where: { workspaceId }, orderBy: [{ status: "asc" }, { username: "asc" }],
    select: { id: true, username: true, role: true, status: true, lastLoginAt: true, sessions: { where: { expiresAt: { gt: new Date() }, lastSeen: { gte: activeSince } }, select: { id: true }, take: 1 }, rankAssignments: { select: { rank: { select: { id: true, name: true, color: true, position: true, permissionsJson: true } } } } },
  });
  return users.map((user) => ({
    id: user.id, username: user.username, systemRole: user.role, status: user.status,
    online: user.status === "ACTIVE" && user.sessions.length > 0, lastLoginAt: user.lastLoginAt,
    ranks: user.rankAssignments.map(({ rank }) => ({ ...rank, permissions: parsePermissions(rank.permissionsJson), permissionsJson: undefined })).sort((a, b) => b.position - a.position),
  }));
}
