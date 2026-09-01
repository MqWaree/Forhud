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

  it("returns directory data without password fields", async () => {
    const directory = await ranks.workspaceMemberDirectory(workspaceId);
    expect(directory).toHaveLength(2);
    expect(directory.find((user) => user.id === memberId)?.ranks.map((rank) => rank.name)).toContain("LZT Access");
    expect(directory.some((user) => "passwordHash" in user)).toBe(false);
  });
});
