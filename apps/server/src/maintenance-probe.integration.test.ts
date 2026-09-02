import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databasePath = resolve(process.cwd(), "work", "maintenance-probe.db");
const storagePath = resolve(process.cwd(), "work", "maintenance-probe-files");
const backupPath = resolve(process.cwd(), "work", "maintenance-probe-backups");
rmSync(databasePath, { force: true });
rmSync(storagePath, { recursive: true, force: true });
rmSync(backupPath, { recursive: true, force: true });
mkdirSync(storagePath, { recursive: true });
execFileSync(process.execPath, [
  resolve(process.cwd(), "apps/server/scripts/migrate-local.mjs"),
  databasePath,
]);
process.env.DATABASE_URL = `file:${databasePath.replaceAll("\\", "/")}`;
process.env.FILE_STORAGE_DIR = storagePath;
process.env.FILE_LINK_SECRET = "maintenance-probe-test-signing-secret";
process.env.BACKUP_DIR = backupPath;
process.env.FGP_MAINTENANCE_PROBE = "true";

let app: any;
let prisma: any;

beforeAll(async () => {
  const module = await import("./app.js");
  app = module.default;
  prisma = module.prisma;
  await module.scannerReady;
});

afterAll(async () => {
  await prisma.$disconnect();
  delete process.env.FGP_MAINTENANCE_PROBE;
  rmSync(databasePath, { force: true });
  rmSync(storagePath, { recursive: true, force: true });
  rmSync(backupPath, { recursive: true, force: true });
});

describe("maintenance probe", () => {
  it("reports probe mode without applying startup security mutations", async () => {
    expect(
      await prisma.setting.count({
        where: { id: "security.scanner-id-v3" },
      }),
    ).toBe(0);

    const health = await request(app).get("/api/health");
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      ok: true,
      database: "connected",
      maintenanceProbe: true,
    });
    expect((await request(app).post("/api/shared-files")).status).toBe(503);
    expect(existsSync(backupPath)).toBe(false);
  });
});
