import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import request from "supertest";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

const dbPath = resolve(process.cwd(), "work", "auth-integration.db");
const backupDir = resolve(process.cwd(), "work", "auth-test-backups");
rmSync(dbPath, { force: true });
rmSync(backupDir, { recursive: true, force: true });
execFileSync(process.execPath, [
  resolve(process.cwd(), "apps/server/scripts/migrate-local.mjs"),
  dbPath,
]);
process.env.DATABASE_URL = `file:${dbPath.replaceAll("\\", "/")}`;
process.env.BACKUP_DIR = backupDir;

let app: any;
let prisma: any;
let admin: ReturnType<typeof request.agent>;
let manager: ReturnType<typeof request.agent>;
let researcher: ReturnType<typeof request.agent>;
let scannerId = "";
let researcherId = "";
let leadId = "";

beforeAll(async () => {
  const module = await import("./app.js");
  app = module.default;
  prisma = module.prisma;
  await module.scannerReady;
  admin = request.agent(app);
  manager = request.agent(app);
  researcher = request.agent(app);
  const setup = await admin.post("/api/auth/setup").send({
    username: "admin",
    password: "admin password 12345",
  });
  expect(setup.status).toBe(201);
  scannerId = setup.body.workspace.scannerId;
  expect(scannerId).toMatch(/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/);
  await admin.post("/api/admin/users").send({
    username: "manager",
    password: "manager password 123",
    role: "MANAGER",
    requirePasswordChange: false,
  });
  const createdResearcher = await admin.post("/api/admin/users").send({
    username: "researcher",
    password: "research password 123",
    role: "RESEARCHER",
    requirePasswordChange: false,
  });
  researcherId = createdResearcher.body.id;
  expect(
    (
      await manager.post("/api/auth/login").send({
        username: "manager",
        password: "manager password 123",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await researcher.post("/api/auth/login").send({
        username: "researcher",
        password: "research password 123",
      })
    ).status,
  ).toBe(200);
});
afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(dbPath, { force: true });
  rmSync(backupDir, { recursive: true, force: true });
});

describe("authentication, authorization, isolation, and recovery", () => {
  it("creates one initial admin with a hashed password and secure cookie", async () => {
    expect((await admin.get("/api/auth/me")).body.username).toBe("admin");
    const storedUser = await prisma.user.findUnique({
      where: { username: "admin" },
    });
    expect(storedUser.name).toBe("admin");
    expect(storedUser.passwordHash).toMatch(/^scrypt\$/);
    expect(storedUser.passwordHash).not.toContain("admin password 12345");
    const duplicate = await request(app).post("/api/auth/setup").send({
      username: "other",
      password: "some password 12345",
    });
    expect(duplicate.status).toBe(409);
    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: "admin", password: "admin password 12345" });
    const sessionCookie = login.headers["set-cookie"]?.[0] || "";
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("SameSite=Strict");
    expect(sessionCookie).toContain("Max-Age=2592000");
    await prisma.authSession.updateMany({
      where: { userId: storedUser.id },
      data: { expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
    });
    const renewedSession = await admin.get("/api/auth/me");
    expect(renewedSession.headers["set-cookie"]?.[0]).toContain(
      "Max-Age=2592000",
    );
    const remembered = request.agent(app);
    const rememberedLogin = await remembered.post("/api/auth/login").send({
      username: "admin",
      password: "admin password 12345",
      remember: true,
    });
    expect(rememberedLogin.headers["set-cookie"]?.[0]).toContain(
      "Max-Age=2592000",
    );
    expect((await remembered.get("/api/auth/me")).status).toBe(200);
    expect((await remembered.post("/api/auth/logout")).status).toBe(204);
    expect((await remembered.get("/api/auth/me")).status).toBe(401);
    expect(
      (
        await request(app).post("/api/auth/login").send({
          email: "admin@aether.test",
          password: "admin password 12345",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await admin.post("/api/admin/users").send({
          username: "MANAGER",
          password: "duplicate password 123",
          role: "RESEARCHER",
        })
      ).status,
    ).toBe(409);
    const shortAccount = await admin.post("/api/admin/users").send({
      username: "x",
      password: "y",
      role: "RESEARCHER",
      requirePasswordChange: false,
    });
    expect(shortAccount.status).toBe(400);
    expect(shortAccount.body).toEqual({
      error: "Choose a less predictable password",
    });

    const commonAccount = await admin.post("/api/admin/users").send({
      username: "common-password",
      password: "P@ssw0rd!",
      role: "RESEARCHER",
      requirePasswordChange: false,
    });
    expect(commonAccount.status).toBe(400);
    expect(commonAccount.body).toEqual({
      error: "Choose a less predictable password",
    });

    const strongAccount = await admin.post("/api/admin/users").send({
      username: "x",
      password: "N7!xQ2@p",
      role: "RESEARCHER",
      requirePasswordChange: false,
    });
    expect(strongAccount.status).toBe(201);

    const shortUser = request.agent(app);
    expect(
      (
        await shortUser
          .post("/api/auth/login")
          .send({ username: "x", password: "N7!xQ2@p" })
      ).status,
    ).toBe(200);
    expect(
      (
        await shortUser.post("/api/auth/change-password").send({
          currentPassword: "N7!xQ2@p",
          newPassword: "P@ssw0rd!",
          confirmPassword: "P@ssw0rd!",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await shortUser.post("/api/auth/change-password").send({
          currentPassword: "N7!xQ2@p",
          newPassword: "M4#vR8!q",
          confirmPassword: "M4#vR8!q",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post("/api/auth/login")
          .send({ username: "x", password: "M4#vR8!q" })
      ).status,
    ).toBe(200);
  });

  it("throttles repeated password guessing", async () => {
    for (let attempt = 0; attempt < 5; attempt++)
      expect(
        (
          await request(app)
            .post("/api/auth/login")
            .send({ username: "rate-target", password: "wrong password" })
        ).status,
      ).toBe(401);
    const blocked = await request(app)
      .post("/api/auth/login")
      .send({ username: "rate-target", password: "wrong password" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(await prisma.securityRateLimit.count()).toBeGreaterThan(0);
  });

  it("never turns concurrent invalid logins into database timeout errors", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app)
          .post("/api/auth/login")
          .send({ username: "concurrent-rate-target", password: "wrong" }),
      ),
    );

    expect(
      attempts.every(({ status }) => status === 401 || status === 429),
    ).toBe(true);
    expect(attempts.some(({ status }) => status === 500)).toBe(false);
  });

  it("enforces role permissions and assignment visibility", async () => {
    const lead = await manager
      .post("/api/leads")
      .send({ url: "https://15.0.0.1/contact" });
    leadId = lead.body.id;
    const secondLead = await manager
      .post("/api/leads")
      .send({ url: "https://15.0.0.2/contact" });
    expect((await researcher.get("/api/leads")).body).toHaveLength(0);
    expect((await researcher.delete(`/api/leads/${leadId}`)).status).toBe(403);
    expect(
      (
        await manager.post("/api/leads/bulk-assign").send({
          ids: [leadId, secondLead.body.id],
          assignedToId: researcherId,
        })
      ).status,
    ).toBe(200);
    const visible = await researcher.get("/api/leads");
    expect(visible.body).toHaveLength(2);
    expect(visible.body[0].assignedTo.id).toBe(researcherId);
    expect((await researcher.get("/api/notifications")).body).toHaveLength(1);
    expect(
      (
        await manager.post("/api/leads/bulk-assign").send({
          ids: [leadId],
          assignedToId: null,
        })
      ).body.updated,
    ).toBe(1);
    const reassigned = await manager.get(`/api/leads/${leadId}`);
    expect(reassigned.body.assignedTo).toBeNull();
    expect(
      reassigned.body.activities.filter(
        (activity: any) => activity.type === "assignment",
      ),
    ).toHaveLength(2);
    expect((await researcher.get("/api/admin/users")).status).toBe(403);
  });

  it("enforces LZT rank access and exposes a safe member directory", async () => {
    expect((await researcher.get("/api/lzt-tracker")).status).toBe(403);
    const ranks = await admin.get("/api/admin/ranks");
    expect(ranks.status).toBe(200);
    const lztRank = ranks.body.find(
      (rank: { name: string }) => rank.name === "LZT Access",
    );
    expect(lztRank).toBeTruthy();
    expect(
      (
        await admin
          .put(`/api/admin/users/${researcherId}/ranks`)
          .send({ rankIds: [lztRank.id] })
      ).status,
    ).toBe(200);
    expect((await researcher.get("/api/lzt-tracker")).status).toBe(200);
    const members = await researcher.get("/api/members");
    expect(members.status).toBe(200);
    expect(
      members.body
        .find((member: { id: string }) => member.id === researcherId)
        .ranks.map((rank: { name: string }) => rank.name),
    ).toContain("LZT Access");
    expect(JSON.stringify(members.body)).not.toContain("passwordHash");
  });

  it("pairs revocable extension instances and rejects a revoked token", async () => {
    expect(
      (
        await request(app)
          .post("/api/extension/pair")
          .send({ scannerId: "WRONG-ID", instanceId: "EXT-WRONG" })
      ).status,
    ).toBe(401);
    const paired = await request(app)
      .post("/api/extension/pair")
      .send({ scannerId, instanceId: "EXT-AUTH2" });
    expect(paired.status).toBe(201);
    const second = await request(app)
      .post("/api/extension/pair")
      .send({ scannerId, instanceId: "EXT-AUTH3" });
    expect(second.status).toBe(201);
    const extension = await prisma.extensionInstance.findUnique({
      where: { instanceId: "EXT-AUTH2" },
    });
    expect(extension.tokenHash).not.toBe(paired.body.token);
    expect(
      (
        await request(app)
          .post("/api/extension/heartbeat")
          .set("authorization", `Bearer ${paired.body.token}`)
          .send({ scannerState: "IDLE" })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post("/api/extension/scanner/start")
          .set("authorization", `Bearer ${second.body.token}`)
      ).status,
    ).toBe(202);
    expect(
      (
        await request(app)
          .post("/api/extension/scanner/stop")
          .set("authorization", `Bearer ${second.body.token}`)
      ).body.status,
    ).toBe("STOPPED");
    await admin.post("/api/admin/scanners/stop-all");
    expect(
      (await admin.get("/api/admin/scanners")).body.extensions,
    ).toHaveLength(2);
    await admin
      .patch(`/api/admin/extensions/${extension.id}`)
      .send({ revoke: true });
    expect(
      (
        await request(app)
          .post("/api/extension/heartbeat")
          .set("authorization", `Bearer ${paired.body.token}`)
          .send({ scannerState: "IDLE" })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post("/api/extension/heartbeat")
          .set("authorization", `Bearer ${second.body.token}`)
          .send({ scannerState: "IDLE" })
      ).status,
    ).toBe(200);
  });

  it("throttles repeated invalid extension pairing attempts", async () => {
    for (let attempt = 0; attempt < 10; attempt++)
      expect(
        (
          await request(app)
            .post("/api/extension/pair")
            .send({
              scannerId: `WRONG-${attempt}`,
              instanceId: `EXT-RATE${String(attempt).padStart(2, "0")}`,
            })
        ).status,
      ).toBe(401);
    const blocked = await request(app).post("/api/extension/pair").send({
      scannerId: "WRONG-FINAL",
      instanceId: "EXT-RATE99",
    });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("isolates records belonging to another workspace", async () => {
    const { hashPassword } = await import("./auth.js");
    const otherWorkspace = await prisma.workspace.create({
      data: {
        name: "Other Workspace",
        scannerId: "Z9YX-W8VU",
        scannerState: { create: {} },
      },
    });
    await prisma.user.create({
      data: {
        workspaceId: otherWorkspace.id,
        name: "Other Admin",
        username: "otheradmin",
        passwordHash: await hashPassword("other password 12345"),
        role: "ADMIN",
      },
    });
    const other = request.agent(app);
    expect(
      (
        await other.post("/api/auth/login").send({
          username: "otheradmin",
          password: "other password 12345",
        })
      ).status,
    ).toBe(200);
    expect((await other.get("/api/leads")).body).toHaveLength(0);
    expect((await other.get(`/api/leads/${leadId}`)).status).toBe(404);
    expect((await admin.get("/api/admin/overview")).body.backupsAvailable).toBe(
      false,
    );
    expect((await admin.get("/api/admin/backups")).status).toBe(403);
    expect((await other.get("/api/admin/backups")).status).toBe(403);
    expect((await admin.post("/api/admin/backups")).status).toBe(403);
    const settings = await other.get("/api/settings");
    expect(settings.status).toBe(200);
    expect(settings.body.backupsAvailable).toBe(false);
    expect(settings.body.automaticBackups).toBeUndefined();
    expect(
      (await other.patch("/api/settings").send({ automaticBackups: false }))
        .status,
    ).toBe(403);
    const backupsModule = await import("./backups.js");
    const platformBackup = await backupsModule.createBackup("MANUAL");
    expect(JSON.parse(platformBackup.manifest).platformOnly).toBe(true);
    const platformContents = readFileSync(
      resolve(backupDir, platformBackup.filename),
    );
    await prisma.workspace.delete({ where: { id: otherWorkspace.id } });
    const historicalManifest = {
      ...JSON.parse(platformBackup.manifest),
      platformOnly: false,
    };
    await prisma.backupMetadata.update({
      where: { id: platformBackup.id },
      data: { manifest: JSON.stringify(historicalManifest) },
    });
    expect((await admin.get("/api/admin/overview")).body.backupsAvailable).toBe(
      true,
    );
    expect((await admin.get("/api/admin/backups")).body).toEqual([]);
    expect(
      (await admin.get(`/api/admin/backups/${platformBackup.id}/download`))
        .status,
    ).toBe(404);
    const importedPlatformBackup = await admin
      .post("/api/admin/backups/upload")
      .set("content-type", "application/octet-stream")
      .send(platformContents);
    expect(importedPlatformBackup.status).toBe(201);
    expect(JSON.parse(importedPlatformBackup.body.manifest).platformOnly).toBe(
      true,
    );
    expect((await admin.get("/api/admin/backups")).body).toEqual([]);
  });

  it("creates a valid SQLite snapshot with metadata", async () => {
    const backup = await admin.post("/api/admin/backups");
    expect(backup.status).toBe(201);
    expect(backup.body.status).toBe("COMPLETED");
    expect(backup.body.size).toBeGreaterThan(0);
    expect((await admin.get("/api/admin/backups")).body).toHaveLength(1);
    const download = await admin.get(
      `/api/admin/backups/${backup.body.id}/download`,
    );
    expect(download.status).toBe(200);
    expect(download.body.subarray(0, 16).toString("utf8")).toBe(
      "SQLite format 3\0",
    );
  });

  it("accepts a valid uploaded snapshot and rejects corrupt input without changing data", async () => {
    const source = (await admin.get("/api/admin/backups")).body[0];
    const valid = readFileSync(resolve(backupDir, source.filename));
    const uploaded = await admin
      .post("/api/admin/backups/upload")
      .set("content-type", "application/octet-stream")
      .send(valid);
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.type).toBe("UPLOADED");
    const leadsBefore = await prisma.lead.count();
    const corrupt = await admin
      .post("/api/admin/backups/upload")
      .set("content-type", "application/octet-stream")
      .send(Buffer.from("not a sqlite database"));
    expect(corrupt.status).toBe(400);
    expect(await prisma.lead.count()).toBe(leadsBefore);

    const malformedPath = resolve(backupDir, "malformed-shared-file.db");
    copyFileSync(resolve(backupDir, source.filename), malformedPath);
    const malformed = new DatabaseSync(malformedPath);
    malformed.exec('ALTER TABLE "SharedFile" DROP COLUMN "sha256"');
    malformed.close();
    const incompleteSchema = await admin
      .post("/api/admin/backups/upload")
      .set("content-type", "application/octet-stream")
      .send(readFileSync(malformedPath));
    expect(incompleteSchema.status).toBe(400);
    rmSync(malformedPath, { force: true });

    const legacyPath = resolve(backupDir, "legacy-before-shared-files.db");
    copyFileSync(resolve(backupDir, source.filename), legacyPath);
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec('DROP TABLE "SharedFile"');
    legacy
      .prepare('DELETE FROM "_AetherMigration" WHERE name = ?')
      .run("20260902033000_shared_files");
    legacy.close();
    const migratedLegacy = await admin
      .post("/api/admin/backups/upload")
      .set("content-type", "application/octet-stream")
      .send(readFileSync(legacyPath));
    expect(migratedLegacy.status).toBe(201);
    const migratedDatabase = new DatabaseSync(
      resolve(backupDir, migratedLegacy.body.filename),
      { readOnly: true },
    );
    expect(
      migratedDatabase
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='SharedFile'",
        )
        .get(),
    ).toEqual({ count: 1 });
    const migratedLedger = migratedDatabase
      .prepare('SELECT name FROM "_AetherMigration" WHERE name = ?')
      .get("20260902033000_shared_files");
    expect(migratedLedger).toEqual({ name: "20260902033000_shared_files" });
    migratedDatabase.close();
    rmSync(legacyPath, { force: true });

    const pushStylePath = resolve(backupDir, "legacy-db-push.db");
    copyFileSync(resolve(backupDir, source.filename), pushStylePath);
    const pushStyle = new DatabaseSync(pushStylePath);
    pushStyle.exec('DROP TABLE "SharedFile"; DROP TABLE "_AetherMigration";');
    pushStyle.close();
    const migratedPushStyle = await admin
      .post("/api/admin/backups/upload")
      .set("content-type", "application/octet-stream")
      .send(readFileSync(pushStylePath));
    expect(migratedPushStyle.status).toBe(201);
    const pushStyleDatabase = new DatabaseSync(
      resolve(backupDir, migratedPushStyle.body.filename),
      { readOnly: true },
    );
    expect(
      pushStyleDatabase
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='SharedFile'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      pushStyleDatabase
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='_AetherMigration'",
        )
        .get(),
    ).toEqual({ count: 0 });
    pushStyleDatabase.close();

    const offlineStagedPath = resolve(backupDir, "offline-staged.db");
    execFileSync(process.execPath, [
      resolve(process.cwd(), "apps/server/scripts/prepare-offline-restore.mjs"),
      pushStylePath,
      offlineStagedPath,
      backupDir,
    ]);
    const offlineStaged = new DatabaseSync(offlineStagedPath, {
      readOnly: true,
    });
    expect(
      offlineStaged
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='SharedFile'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      offlineStaged
        .prepare('SELECT COUNT(*) AS count FROM "AuthSession"')
        .get(),
    ).toEqual({ count: 0 });
    offlineStaged.close();
    execFileSync(process.execPath, [
      resolve(process.cwd(), "apps/server/scripts/prepare-offline-restore.mjs"),
      "--validate",
      offlineStagedPath,
      backupDir,
    ]);
    const offlineSafetyPath = resolve(backupDir, "offline-safety.db");
    execFileSync(process.execPath, [
      resolve(process.cwd(), "apps/server/scripts/prepare-offline-restore.mjs"),
      "--snapshot",
      offlineStagedPath,
      offlineSafetyPath,
    ]);
    const offlineSafety = new DatabaseSync(offlineSafetyPath, {
      readOnly: true,
    });
    expect(
      Object.values(
        offlineSafety.prepare("PRAGMA integrity_check").get() || {},
      )[0],
    ).toBe("ok");
    offlineSafety.close();
    const rejectedOfflinePath = resolve(backupDir, "offline-rejected.db");
    writeFileSync(`${pushStylePath}-journal`, "unsafe companion");
    expect(() =>
      execFileSync(
        process.execPath,
        [
          resolve(
            process.cwd(),
            "apps/server/scripts/prepare-offline-restore.mjs",
          ),
          pushStylePath,
          rejectedOfflinePath,
          backupDir,
        ],
        { stdio: "ignore" },
      ),
    ).toThrow();
    expect(existsSync(rejectedOfflinePath)).toBe(false);
    rmSync(`${pushStylePath}-journal`, { force: true });
    rmSync(offlineSafetyPath, { force: true });
    rmSync(offlineStagedPath, { force: true });
    rmSync(pushStylePath, { force: true });
  });

  it("restricts backups to admins and retains the seven newest automatic snapshots", async () => {
    expect((await researcher.get("/api/admin/backups")).status).toBe(403);
    expect((await manager.get("/api/admin/backups")).status).toBe(403);
    const backupsModule = await import("./backups.js");
    for (let index = 0; index < 9; index++)
      await backupsModule.createBackup("AUTOMATIC");
    await backupsModule.runBackupMaintenance();
    expect(
      await prisma.backupMetadata.count({ where: { type: "AUTOMATIC" } }),
    ).toBe(7);
  });

  it("rolls back the database when post-restore validation fails", async () => {
    const backupsModule = await import("./backups.js");
    await prisma.setting.upsert({
      where: { id: "restore-rollback-test" },
      update: { value: JSON.stringify("before") },
      create: {
        id: "restore-rollback-test",
        value: JSON.stringify("before"),
      },
    });
    const source = await backupsModule.createBackup("MANUAL");
    await prisma.setting.update({
      where: { id: "restore-rollback-test" },
      data: { value: JSON.stringify("after") },
    });
    const actor = await prisma.user.findUniqueOrThrow({
      where: { username: "admin" },
    });
    const states: string[] = [];
    await expect(
      backupsModule.restoreBackup(source.filename, actor.id, async (state) => {
        states.push(state);
        if (state === "restored") throw new Error("Simulated storage failure");
      }),
    ).rejects.toThrow("Simulated storage failure");
    expect(states).toEqual(["restored", "recovered"]);
    expect(
      JSON.parse(
        (
          await prisma.setting.findUniqueOrThrow({
            where: { id: "restore-rollback-test" },
          })
        ).value,
      ),
    ).toBe("after");
    await prisma.setting.delete({ where: { id: "restore-rollback-test" } });
  });

  it("disabling a user invalidates active sessions", async () => {
    expect((await researcher.get("/api/auth/me")).status).toBe(200);
    await admin
      .patch(`/api/admin/users/${researcherId}`)
      .send({ status: "DISABLED" });
    expect((await researcher.get("/api/auth/me")).status).toBe(401);
  });

  it("restores a validated backup, makes a safety copy, and invalidates sessions", async () => {
    const freshAdmin = request.agent(app);
    expect(
      (
        await freshAdmin.post("/api/auth/login").send({
          username: "admin",
          password: "admin password 12345",
        })
      ).status,
    ).toBe(200);
    const backups = await freshAdmin.get("/api/admin/backups");
    const originalNodeEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const blockedRestore = await freshAdmin
        .post(`/api/admin/backups/${backups.body[0].id}/restore`)
        .send({ confirm: "RESTORE" });
      expect(blockedRestore.status).toBe(403);
      expect(blockedRestore.body.error).toContain("offline operator");
    } finally {
      if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnvironment;
    }
    const createdAfterBackup = await freshAdmin
      .post("/api/leads")
      .send({ url: "https://16.0.0.1/new-after-backup" });
    expect(createdAfterBackup.status).toBe(201);
    const restored = await freshAdmin
      .post(`/api/admin/backups/${backups.body[0].id}/restore`)
      .send({ confirm: "RESTORE" });
    expect(restored.status).toBe(200);
    expect(restored.body.safetyBackup).toContain("pre_restore");
    expect((await freshAdmin.get("/api/auth/me")).status).toBe(401);
    expect(
      await prisma.lead.findUnique({
        where: { id: createdAfterBackup.body.id },
      }),
    ).toBeNull();
  });

  it("applies the stronger password policy once and clamps legacy sessions", async () => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { username: "admin" },
    });
    const legacy = await prisma.authSession.create({
      data: {
        userId: user.id,
        tokenHash: `legacy-${Date.now()}`,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
    });
    const { applySecurityPolicyV2 } = await import("./app.js");
    const before = Date.now();
    await applySecurityPolicyV2();
    const [updatedUser, updatedSession, marker] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      prisma.authSession.findUniqueOrThrow({ where: { id: legacy.id } }),
      prisma.setting.findUnique({
        where: { id: "security.password-policy-v2" },
      }),
    ]);
    expect(updatedUser.requirePasswordChange).toBe(true);
    expect(updatedSession.expiresAt.getTime()).toBeGreaterThan(before);
    expect(updatedSession.expiresAt.getTime()).toBeLessThanOrEqual(
      before + 30 * 24 * 60 * 60 * 1000 + 5_000,
    );
    expect(marker).not.toBeNull();
    await applySecurityPolicyV2();
    expect(
      (await prisma.authSession.findUniqueOrThrow({ where: { id: legacy.id } }))
        .expiresAt,
    ).toEqual(updatedSession.expiresAt);
  });

  it("rotates a known legacy Scanner ID even when the hardening marker already exists", async () => {
    await prisma.setting.deleteMany({
      where: { id: "security.scanner-id-v3" },
    });
    await prisma.setting.create({
      data: { id: "security.scanner-id-v3", value: JSON.stringify(true) },
    });
    const workspace = await prisma.workspace.create({
      data: {
        name: "Legacy Scanner Workspace",
        scannerId: "A7K9-X2P4",
        scannerState: { create: {} },
      },
    });
    const owner = await prisma.user.create({
      data: {
        workspaceId: workspace.id,
        name: "Legacy Owner",
        username: `legacy-${Date.now()}`,
        passwordHash: "not-used-by-this-migration-test",
        role: "ADMIN",
      },
    });
    const extension = await prisma.extensionInstance.create({
      data: {
        workspaceId: workspace.id,
        ownerUserId: owner.id,
        instanceId: `EXT-${Date.now().toString(36).slice(-8).toUpperCase()}`,
        tokenHash: `legacy-token-${Date.now()}`,
      },
    });
    const { applySecurityPolicyV3 } = await import("./app.js");
    const { pairExtension } = await import("./extension-auth.js");
    await expect(
      pairExtension({ scannerId: "A7K9-X2P4", instanceId: "EXT-LEGACY" }),
    ).rejects.toMatchObject({ statusCode: 401 });
    await applySecurityPolicyV3();
    const [updatedWorkspace, updatedExtension, marker] = await Promise.all([
      prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } }),
      prisma.extensionInstance.findUniqueOrThrow({
        where: { id: extension.id },
      }),
      prisma.setting.findUnique({ where: { id: "security.scanner-id-v3" } }),
    ]);
    expect(updatedWorkspace.scannerId).toMatch(
      /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/,
    );
    expect(updatedWorkspace.scannerId).not.toBe("A7K9-X2P4");
    expect(updatedExtension.revokedAt).not.toBeNull();
    expect(marker).not.toBeNull();
  });
});
