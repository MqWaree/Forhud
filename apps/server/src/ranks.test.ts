import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const dbPath = resolve(process.cwd(), "work", "ranks-test.db");
rmSync(dbPath, { force: true });
execFileSync(process.execPath, [
  resolve(process.cwd(), "apps/server/scripts/migrate-local.mjs"),
  dbPath,
]);
process.env.DATABASE_URL = `file:${dbPath.replaceAll("\\", "/")}`;

let prisma: (typeof import("./db.js"))["prisma"];
let ranks: typeof import("./ranks.js");

describe("workspace ranks", () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  let workspaceId = "", adminId = "", memberId = "";

  beforeAll(async () => {
    prisma = (await import("./db.js")).prisma;
    ranks = await import("./ranks.js");
    const workspace = await prisma.workspace.create({ data: { name: `Rank test ${suffix}`, scannerId: `RANK-${suffix.toUpperCase().padEnd(4, "X").slice(0, 4)}-TEST-X123` } });
    workspaceId = workspace.id;
    const admin = await prisma.user.create({ data: { workspaceId, name: "Admin", username: `rank_admin_${suffix}`, passwordHash: "test", role: "ADMIN" } });
    const member = await prisma.user.create({ data: { workspaceId, name: "Member", username: `rank_member_${suffix}`, passwordHash: "test", role: "RESEARCHER" } });
    adminId = admin.id;
    memberId = member.id;
    await ranks.ensureWorkspaceRanks(workspaceId);
  });

  afterAll(async () => {
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } });
    await prisma.$disconnect();
  });

  it("seeds built-in ranks and grants administrators owner access", async () => {
    const names = (await prisma.workspaceRank.findMany({ where: { workspaceId }, orderBy: { position: "desc" } })).map((rank) => rank.name);
    expect(names).toEqual(["Owner", "LZT Access", "Researcher", "Member"]);
    expect(await ranks.userHasRankPermission(adminId, "LZT_ACCESS")).toBe(true);
    expect(await ranks.userHasRankPermission(memberId, "LZT_ACCESS")).toBe(false);
  });

  it("grants LZT access only after rank assignment", async () => {
    const rank = await prisma.workspaceRank.findUniqueOrThrow({ where: { workspaceId_name: { workspaceId, name: "LZT Access" } } });
    await prisma.userRank.create({ data: { userId: memberId, rankId: rank.id } });
    expect(await ranks.userHasRankPermission(memberId, "LZT_ACCESS")).toBe(true);
    expect(await ranks.userIdsWithRankPermission("LZT_ACCESS")).toEqual(
      expect.arrayContaining([adminId, memberId]),
    );
  });

  it("serves LZT recipients from a short-lived cache that mutations invalidate", async () => {
    const before = await ranks.userIdsWithRankPermission("LZT_ACCESS");
    expect(before).toEqual(expect.arrayContaining([adminId, memberId]));
    const rank = await prisma.workspaceRank.findUniqueOrThrow({ where: { workspaceId_name: { workspaceId, name: "LZT Access" } } });
    await prisma.userRank.delete({ where: { userId_rankId: { userId: memberId, rankId: rank.id } } });
    // Without invalidation the cached recipient list is still served.
    expect(await ranks.userIdsWithRankPermission("LZT_ACCESS")).toBe(before);
    ranks.invalidateRankCaches();
    const after = await ranks.userIdsWithRankPermission("LZT_ACCESS");
    expect(after).toContain(adminId);
    expect(after).not.toContain(memberId);
    // Restore the assignment for the directory assertions below.
    await prisma.userRank.create({ data: { userId: memberId, rankId: rank.id } });
    ranks.invalidateRankCaches();
  });

  it("does not repeat rank reconciliation writes on every call within the window", async () => {
    // Remove the managed Owner assignment for the admin; a throttled call must
    // not restore it, a forced call must.
    const owner = await prisma.workspaceRank.findUniqueOrThrow({ where: { workspaceId_name: { workspaceId, name: "Owner" } } });
    // The previous test invalidated the caches, so this call performs a real
    // reconciliation and starts the throttle window.
    await ranks.ensureWorkspaceRanks(workspaceId);
    await prisma.userRank.delete({ where: { userId_rankId: { userId: adminId, rankId: owner.id } } });
    await ranks.ensureWorkspaceRanks(workspaceId);
    expect(await prisma.userRank.findUnique({ where: { userId_rankId: { userId: adminId, rankId: owner.id } } })).toBeNull();
    await ranks.ensureWorkspaceRanks(workspaceId, { force: true });
    expect(await prisma.userRank.findUnique({ where: { userId_rankId: { userId: adminId, rankId: owner.id } } })).not.toBeNull();
  });

  it("returns directory data without password fields", async () => {
    const directory = await ranks.workspaceMemberDirectory(workspaceId);
    expect(directory).toHaveLength(2);
    expect(directory.find((user) => user.id === memberId)?.ranks.map((rank) => rank.name)).toContain("LZT Access");
    expect(directory.some((user) => "passwordHash" in user)).toBe(false);
  });
});
