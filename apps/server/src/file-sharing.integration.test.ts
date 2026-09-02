import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import request from "supertest";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const dbPath = resolve(process.cwd(), "work", "file-sharing-integration.db");
const storagePath = resolve(process.cwd(), "work", "file-sharing-storage");
rmSync(dbPath, { force: true });
rmSync(storagePath, { recursive: true, force: true });
execFileSync(process.execPath, [
  resolve(process.cwd(), "apps/server/scripts/migrate-local.mjs"),
  dbPath,
]);
process.env.DATABASE_URL = `file:${dbPath.replaceAll("\\", "/")}`;
process.env.FILE_STORAGE_DIR = storagePath;
process.env.FILE_LINK_SECRET = "test-only-file-link-secret-with-32-characters";
process.env.FILE_MAX_SIZE_BYTES = "64";
process.env.FILE_WORKSPACE_QUOTA_BYTES = "96";
process.env.FILE_WORKSPACE_MAX_FILES = "500";

let app: any;
let prisma: any;
let admin: ReturnType<typeof request.agent>;
let collaborator: ReturnType<typeof request.agent>;
let outsider: ReturnType<typeof request.agent>;

beforeAll(async () => {
  const module = await import("./app.js");
  const { hashPassword } = await import("./auth.js");
  app = module.default;
  prisma = module.prisma;
  await module.scannerReady;
  admin = request.agent(app);
  collaborator = request.agent(app);
  outsider = request.agent(app);
  const setup = await admin.post("/api/auth/setup").send({
    username: "fileadmin",
    password: "correct horse battery staple",
  });
  expect(setup.status).toBe(201);
  await prisma.user.create({
    data: {
      workspaceId: setup.body.workspace.id,
      name: "collaborator",
      username: "collaborator",
      passwordHash: await hashPassword(
        "collaborator correct horse battery staple",
      ),
      role: "RESEARCHER",
    },
  });
  expect(
    (
      await collaborator.post("/api/auth/login").send({
        username: "collaborator",
        password: "collaborator correct horse battery staple",
      })
    ).status,
  ).toBe(200);
  const otherWorkspace = await prisma.workspace.create({
    data: {
      name: "Other workspace",
      scannerId: "ABCD-EFGH-JKMP-QRST",
      scannerState: { create: {} },
    },
  });
  await prisma.user.create({
    data: {
      workspaceId: otherWorkspace.id,
      name: "outsider",
      username: "outsider",
      passwordHash: await hashPassword("another correct horse battery staple"),
      role: "RESEARCHER",
    },
  });
  expect(
    (
      await outsider.post("/api/auth/login").send({
        username: "outsider",
        password: "another correct horse battery staple",
      })
    ).status,
  ).toBe(200);
});

afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(dbPath, { force: true });
  rmSync(storagePath, { recursive: true, force: true });
});

function upload(
  browser: ReturnType<typeof request.agent>,
  name: string,
  contents: Buffer,
  mimeType = "application/octet-stream",
) {
  return browser
    .post("/api/shared-files")
    .set("content-type", "application/octet-stream")
    .set("x-file-name", encodeURIComponent(name))
    .set("x-file-type", mimeType)
    .send(contents);
}

describe("workspace file sharing", () => {
  it("requires authentication and validates the binary upload contract", async () => {
    expect((await request(app).get("/api/shared-files")).status).toBe(401);
    expect(
      (
        await request(app)
          .post("/api/shared-files")
          .set("content-type", "application/octet-stream")
          .set("x-file-name", "test.txt")
          .send(Buffer.from("blocked"))
      ).status,
    ).toBe(401);
    expect(
      (await admin.post("/api/shared-files").send({ filename: "nope" })).status,
    ).toBe(415);
    expect(
      (
        await admin
          .post("/api/shared-files")
          .set("content-type", "application/octet-stream")
          .send(Buffer.from("missing name"))
      ).status,
    ).toBe(400);
    expect(
      (await request(app).get("/api/shared-files/public/not-a-token")).status,
    ).toBe(404);
  });

  it("uploads, lists, downloads, isolates, and revokes a shared file", async () => {
    const contents = Buffer.from("safe shared payload");
    const created = await upload(
      admin,
      "../../Quarterly\u202e report Q3.html",
      contents,
      "text/html",
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      originalName: "Quarterly report Q3.html",
      mimeType: "text/html",
      sizeBytes: contents.length,
      downloadCount: 0,
      canDelete: true,
      uploadedBy: { username: "fileadmin" },
    });
    expect(created.body.downloadPath).toMatch(
      /^\/api\/shared-files\/public\/[a-z0-9]{20,32}\.[A-Za-z0-9_-]{43}$/,
    );

    const stored = await prisma.sharedFile.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(stored.sha256).toBe(
      createHash("sha256").update(contents).digest("hex"),
    );
    expect(stored.storageName).toMatch(/^[0-9a-f-]{36}$/);
    expect(stored.publicId).toBeUndefined();
    expect(readdirSync(storagePath)).toEqual([stored.storageName]);

    const ownList = await admin.get("/api/shared-files");
    expect(ownList.status).toBe(200);
    expect(ownList.body.usage).toMatchObject({
      usedBytes: contents.length,
      fileCount: 1,
      maxFileBytes: 64,
      quotaBytes: 96,
      maxFiles: 500,
    });
    expect(ownList.body.files).toHaveLength(1);
    expect((await outsider.get("/api/shared-files")).body.files).toHaveLength(
      0,
    );
    expect(
      (await outsider.delete(`/api/shared-files/${created.body.id}`)).status,
    ).toBe(404);
    expect(
      (await collaborator.delete(`/api/shared-files/${created.body.id}`))
        .status,
    ).toBe(403);

    const head = await request(app).head(created.body.downloadPath);
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe(String(contents.length));
    expect(head.headers["content-disposition"]).toContain("attachment;");
    expect(head.headers["content-disposition"]).toContain(
      "filename*=UTF-8''Quarterly%20report%20Q3.html",
    );
    const downloaded = await request(app).get(created.body.downloadPath);
    expect(downloaded.status).toBe(200);
    expect(downloaded.text).toBe(contents.toString());
    expect(downloaded.headers["x-content-type-options"]).toBe("nosniff");
    expect(downloaded.headers["content-security-policy"]).toContain("sandbox");
    const tamperedPath = `${created.body.downloadPath.slice(0, -1)}${created.body.downloadPath.endsWith("A") ? "B" : "A"}`;
    expect((await request(app).get(tamperedPath)).status).toBe(404);

    for (let attempt = 0; attempt < 20; attempt++) {
      const refreshed = await prisma.sharedFile.findUnique({
        where: { id: created.body.id },
      });
      if (refreshed?.downloadCount === 1) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    expect(
      (
        await prisma.sharedFile.findUniqueOrThrow({
          where: { id: created.body.id },
        })
      ).downloadCount,
    ).toBe(1);

    expect(
      (await admin.delete(`/api/shared-files/${created.body.id}`)).status,
    ).toBe(204);
    expect((await request(app).get(created.body.downloadPath)).status).toBe(
      404,
    );
    expect(readdirSync(storagePath)).toEqual([]);
  });

  it("lets an uploader revoke their own file without broader delete access", async () => {
    const created = await upload(
      collaborator,
      "research-note.txt",
      Buffer.from("owned"),
      "text/plain",
    );
    expect(created.status).toBe(201);
    expect(created.body.canDelete).toBe(true);
    const listed = await collaborator.get("/api/shared-files");
    expect(
      listed.body.files.find((file: any) => file.id === created.body.id)
        .canDelete,
    ).toBe(true);
    expect(
      (await collaborator.delete(`/api/shared-files/${created.body.id}`))
        .status,
    ).toBe(204);
  });

  it("enforces both per-file and total workspace storage limits", async () => {
    const tooLarge = await upload(admin, "too-large.bin", Buffer.alloc(65));
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.error).toContain("upload size limit");

    const accepted = await upload(admin, "accepted.bin", Buffer.alloc(64));
    expect(accepted.status).toBe(201);
    const overQuota = await upload(admin, "over-quota.bin", Buffer.alloc(33));
    expect(overQuota.status).toBe(413);
    expect(overQuota.body.error).toContain("quota");
    expect(
      readdirSync(storagePath).every((name) => !name.endsWith(".uploading")),
    ).toBe(true);
    expect(
      (await admin.delete(`/api/shared-files/${accepted.body.id}`)).status,
    ).toBe(204);
  });

  it("caps file count and reconciles payloads without destructive cleanup", async () => {
    process.env.FILE_WORKSPACE_MAX_FILES = "1";
    try {
      const accepted = await upload(admin, "only.bin", Buffer.from("one"));
      expect(accepted.status).toBe(201);
      const overCount = await upload(admin, "extra.bin", Buffer.from("two"));
      expect(overCount.status).toBe(409);
      expect(overCount.body.error).toContain("file-count limit");

      const row = await prisma.sharedFile.findUniqueOrThrow({
        where: { id: accepted.body.id },
      });
      rmSync(resolve(storagePath, row.storageName), { force: true });
      const orphan = "11111111-1111-4111-8111-111111111111.uploading";
      const unreferenced = "22222222-2222-4222-8222-222222222222";
      writeFileSync(resolve(storagePath, orphan), "partial");
      writeFileSync(resolve(storagePath, unreferenced), "recoverable orphan");
      const { reconcileSharedFileStorage, withSharedFileMaintenance } =
        await import("./file-sharing.js");
      await expect(reconcileSharedFileStorage()).resolves.toEqual({
        missingPayloads: 1,
        corruptPayloads: 0,
        removedTemporary: 1,
        quarantinedOrphans: 1,
        quarantinedCorruptPayloads: 0,
        restoredPayloads: 0,
      });
      expect(await prisma.sharedFile.count()).toBe(1);
      expect(readdirSync(storagePath)).toEqual([".orphaned"]);
      expect(readdirSync(resolve(storagePath, ".orphaned"))).toEqual([
        unreferenced,
      ]);
      const missingHealth = await request(app).get("/api/health");
      expect(missingHealth.status).toBe(503);
      expect(missingHealth.body.sharedFiles.missingPayloads).toBe(1);

      writeFileSync(
        resolve(storagePath, ".orphaned", row.storageName),
        "substituted payload",
      );
      await expect(reconcileSharedFileStorage()).resolves.toEqual({
        missingPayloads: 1,
        corruptPayloads: 1,
        removedTemporary: 0,
        quarantinedOrphans: 0,
        quarantinedCorruptPayloads: 0,
        restoredPayloads: 0,
      });
      rmSync(resolve(storagePath, ".orphaned", row.storageName), {
        force: true,
      });
      writeFileSync(resolve(storagePath, ".orphaned", row.storageName), "one");
      await expect(reconcileSharedFileStorage()).resolves.toEqual({
        missingPayloads: 0,
        corruptPayloads: 0,
        removedTemporary: 0,
        quarantinedOrphans: 0,
        quarantinedCorruptPayloads: 0,
        restoredPayloads: 1,
      });
      expect(readdirSync(storagePath).sort()).toEqual([
        ".orphaned",
        row.storageName,
      ]);
      expect((await request(app).get("/api/health")).status).toBe(200);
      await withSharedFileMaintenance(async () => {
        expect((await admin.get("/api/shared-files")).status).toBe(503);
        expect(
          (await request(app).get(accepted.body.downloadPath)).status,
        ).toBe(503);
      });
      expect(
        (await admin.delete(`/api/shared-files/${accepted.body.id}`)).status,
      ).toBe(204);
    } finally {
      process.env.FILE_WORKSPACE_MAX_FILES = "500";
    }
  });
});
