import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const dbPath = resolve(process.cwd(), "work", "fresh-install-integration.db");
rmSync(dbPath, { force: true });
execFileSync(process.execPath, [
  resolve(process.cwd(), "apps/server/scripts/migrate-local.mjs"),
  dbPath,
]);

process.env.DATABASE_URL = `file:${dbPath.replaceAll("\\", "/")}`;

let prisma: typeof import("./db.js").prisma;

beforeAll(async () => {
  ({ prisma } = await import("./db.js"));
  // The historical migrations create a compatibility workspace. Removing it
  // reproduces a brand-new database created directly from the current schema.
  await prisma.workspace.deleteMany();
});

afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(dbPath, { force: true });
});

describe("fresh installation bootstrap", () => {
  it("starts cleanly before the initial administrator creates a workspace", async () => {
    const { bootstrapScanner } = await import("./scanner.js");
    await expect(bootstrapScanner()).resolves.toBeUndefined();
    await expect(prisma.workspace.count()).resolves.toBe(0);
    await expect(
      prisma.setting.findUnique({
        where: { id: "scannerWorkspaceBackfilled" },
      }),
    ).resolves.toMatchObject({ value: "true" });
  });
});
