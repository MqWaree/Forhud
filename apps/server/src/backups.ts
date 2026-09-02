import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { prisma } from "./db.js";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
const SHARED_FILE_MIGRATION_NAME = "20260902033000_shared_files";
const SHARED_FILE_MIGRATION_SQL = readFileSync(
  resolve(
    import.meta.dirname,
    `../prisma/migrations/${SHARED_FILE_MIGRATION_NAME}/migration.sql`,
  ),
  "utf8",
);

export let maintenanceMode = false;
function configuredDatabasePath() {
  const configured = process.env.DATABASE_URL;
  if (!configured)
    return resolve(import.meta.dirname, "../prisma/lead-intelligence.db");
  if (!configured.startsWith("file:"))
    throw new Error("Backups require a file-based SQLite DATABASE_URL");
  const filename = configured.slice(5).replace(/^\/+([A-Za-z]:\/)/, "$1");
  return /^[A-Za-z]:[\\/]/.test(filename)
    ? resolve(filename)
    : resolve(import.meta.dirname, "../prisma", filename);
}
const databasePath = configuredDatabasePath();
const backupDir = resolve(
  process.env.BACKUP_DIR || resolve(import.meta.dirname, "../data/backups"),
);
if (process.env.FGP_MAINTENANCE_PROBE !== "true")
  mkdirSync(backupDir, { recursive: true });

function safePath(filename: string) {
  if (!/^[A-Za-z0-9_.-]+$/.test(filename))
    throw Object.assign(new Error("Invalid backup filename"), {
      statusCode: 400,
    });
  const path = resolve(backupDir, filename);
  const pathFromBackupDir = relative(backupDir, path);
  if (
    !pathFromBackupDir ||
    pathFromBackupDir.startsWith("..") ||
    isAbsolute(pathFromBackupDir)
  )
    throw Object.assign(new Error("Invalid backup path"), { statusCode: 400 });
  return path;
}

export function backupFilePath(filename: string) {
  return safePath(filename);
}

function inspectBackup(path: string, allowLegacy: boolean) {
  if (!existsSync(path))
    throw Object.assign(new Error("Backup file not found"), {
      statusCode: 404,
    });
  const header = readFileSync(path).subarray(0, 16).toString("utf8");
  if (header !== "SQLite format 3\u0000")
    throw Object.assign(new Error("Invalid backup. No data was changed."), {
      statusCode: 400,
    });
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get() as Record<
      string,
      string
    >;
    if (Object.values(integrity)[0] !== "ok")
      throw new Error("Integrity check failed");
    const required = ["Workspace", "User", "Lead", "ScannerResult"];
    const tables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    if (required.some((name) => !tables.has(name)))
      throw new Error("Required tables are missing");
    const legacy = !tables.has("SharedFile");
    if (legacy) {
      if (!allowLegacy) throw new Error("SharedFile table is missing");
      return { legacy: true };
    }
    const sharedFileColumns = new Set(
      (
        db.prepare('PRAGMA table_info("SharedFile")').all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    const requiredSharedFileColumns = [
      "id",
      "workspaceId",
      "uploadedById",
      "storageName",
      "originalName",
      "mimeType",
      "sizeBytes",
      "sha256",
      "downloadCount",
      "lastDownloadedAt",
      "createdAt",
    ];
    if (requiredSharedFileColumns.some((name) => !sharedFileColumns.has(name)))
      throw new Error("SharedFile schema is incompatible");
    return { legacy: false };
  } catch {
    throw Object.assign(new Error("Invalid backup. No data was changed."), {
      statusCode: 400,
    });
  } finally {
    db.close();
  }
}

export function validateBackup(path: string) {
  inspectBackup(path, false);
}

function prepareBackup(path: string) {
  if (inspectBackup(path, true).legacy) {
    const db = new DatabaseSync(path);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(SHARED_FILE_MIGRATION_SQL);
        const hasMigrationLedger = db
          .prepare(
            "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='_AetherMigration'",
          )
          .get();
        if (hasMigrationLedger) {
          const recorded = db
            .prepare(
              'SELECT 1 AS found FROM "_AetherMigration" WHERE name = ? LIMIT 1',
            )
            .get(SHARED_FILE_MIGRATION_NAME);
          if (!recorded)
            db.prepare('INSERT INTO "_AetherMigration" (name) VALUES (?)').run(
              SHARED_FILE_MIGRATION_NAME,
            );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
  }
  validateBackup(path);
}

function parseManifest(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return null;
  }
}

function backupWorkspaceCount(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db
      .prepare('SELECT COUNT(*) AS count FROM "Workspace"')
      .get() as {
      count: number;
    };
    return Number(row.count);
  } finally {
    db.close();
  }
}

export function backupIsPlatformOnly(backup: {
  filename: string;
  manifest: string;
}) {
  const manifest = parseManifest(backup.manifest);
  if (manifest === null) return true;
  if (manifest.platformOnly === true) return true;
  try {
    return backupWorkspaceCount(safePath(backup.filename)) !== 1;
  } catch {
    return true;
  }
}

export async function workspaceAdminBackupsAvailable() {
  const workspaceCount = await prisma.workspace.count();
  if (workspaceCount > 1) {
    const backups = await prisma.backupMetadata.findMany();
    for (const backup of backups) {
      const existing = parseManifest(backup.manifest) || {};
      if (existing.platformOnly === true) continue;
      const manifest = { ...existing, platformOnly: true };
      await prisma.backupMetadata.update({
        where: { id: backup.id },
        data: { manifest: JSON.stringify(manifest) },
      });
      const sidecar = `${safePath(backup.filename)}.manifest.json`;
      if (existsSync(sidecar))
        writeFileSync(sidecar, JSON.stringify(manifest, null, 2), "utf8");
    }
  }
  return workspaceCount === 1;
}

function manifestFor(
  type: "MANUAL" | "AUTOMATIC" | "PRE_RESTORE" | "UPLOADED",
  path: string,
  createdById?: string,
) {
  return {
    backupVersion: 2,
    applicationVersion: "1.5.0",
    schemaVersion: SHARED_FILE_MIGRATION_NAME,
    createdAt: new Date().toISOString(),
    createdById: createdById || null,
    backupType: type,
    databaseType: "sqlite",
    platformOnly: backupWorkspaceCount(path) !== 1,
  };
}

export async function createBackup(
  type: "MANUAL" | "AUTOMATIC" | "PRE_RESTORE",
  createdById?: string,
) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "");
  const filename = `lead-platform_backup_${stamp}_${randomBytes(3).toString("hex")}_${type.toLowerCase()}.db`;
  const path = safePath(filename);
  try {
    const source = new DatabaseSync(databasePath, { readOnly: true });
    try {
      source.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
    } finally {
      source.close();
    }
    validateBackup(path);
    const manifest = manifestFor(type, path, createdById);
    writeFileSync(`${path}.manifest.json`, JSON.stringify(manifest, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    return await prisma.backupMetadata.create({
      data: {
        filename,
        type,
        size: statSync(path).size,
        createdById,
        manifest: JSON.stringify(manifest),
      },
    });
  } catch (error) {
    rmSync(path, { force: true });
    rmSync(`${path}.manifest.json`, { force: true });
    throw error;
  }
}

export async function importBackup(contents: Buffer, createdById: string) {
  if (!contents.length || contents.length > 100 * 1024 * 1024)
    throw Object.assign(
      new Error("Backup upload must be between 1 byte and 100 MB"),
      {
        statusCode: 413,
      },
    );
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "");
  const filename = `lead-platform_backup_${stamp}_${randomBytes(3).toString("hex")}_uploaded.db`;
  const path = safePath(filename);
  try {
    writeFileSync(path, contents, { flag: "wx" });
    prepareBackup(path);
    const manifest = manifestFor("UPLOADED", path, createdById);
    writeFileSync(`${path}.manifest.json`, JSON.stringify(manifest, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    return await prisma.backupMetadata.create({
      data: {
        filename,
        type: "UPLOADED",
        size: statSync(path).size,
        createdById,
        manifest: JSON.stringify(manifest),
      },
    });
  } catch (error) {
    rmSync(path, { force: true });
    rmSync(`${path}.manifest.json`, { force: true });
    throw error;
  }
}

export async function deleteBackup(filename: string) {
  const path = safePath(filename);
  rmSync(path, { force: true });
  rmSync(`${path}.manifest.json`, { force: true });
}

type BackupRecord = Awaited<ReturnType<typeof createBackup>>;

async function registerBackupMetadata(backup: BackupRecord) {
  await prisma.backupMetadata.upsert({
    where: { filename: backup.filename },
    update: {},
    create: {
      id: backup.id,
      filename: backup.filename,
      type: backup.type,
      size: backup.size,
      status: backup.status,
      createdById: backup.createdById,
      createdAt: backup.createdAt,
      manifest: backup.manifest,
    },
  });
}

export async function restoreBackup(
  filename: string,
  actorId: string,
  afterDatabaseReady?: (state: "restored" | "recovered") => Promise<void>,
) {
  const selected = safePath(filename);
  inspectBackup(selected, true);
  const prepared = resolve(
    dirname(databasePath),
    `.fgp-restore-${randomBytes(8).toString("hex")}.db`,
  );
  try {
    copyFileSync(selected, prepared);
    prepareBackup(prepared);
  } catch (error) {
    rmSync(prepared, { force: true });
    throw error;
  }
  maintenanceMode = true;
  let disconnected = false;
  let safety: BackupRecord | undefined;
  try {
    safety = await createBackup("PRE_RESTORE", actorId);
    await prisma.$disconnect();
    disconnected = true;
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    copyFileSync(prepared, databasePath);
    validateBackup(databasePath);
    await prisma.$connect();
    disconnected = false;
    await afterDatabaseReady?.("restored");
    await registerBackupMetadata(safety);
    await prisma.authSession.deleteMany();
    return { restored: true, safetyBackup: safety.filename };
  } catch (error) {
    if (safety) {
      if (!disconnected) {
        await prisma.$disconnect().catch(() => undefined);
        disconnected = true;
      }
      rmSync(`${databasePath}-wal`, { force: true });
      rmSync(`${databasePath}-shm`, { force: true });
      copyFileSync(safePath(safety.filename), databasePath);
      validateBackup(databasePath);
      await prisma.$connect();
      disconnected = false;
      try {
        await afterDatabaseReady?.("recovered");
        await registerBackupMetadata(safety);
      } catch (recoveryError) {
        console.error("Post-restore safety recovery failed", recoveryError);
        throw Object.assign(
          new Error(
            "Restore failed. The database was recovered, but file storage requires operator review.",
          ),
          { statusCode: 500, cause: error },
        );
      }
    }
    throw error;
  } finally {
    if (disconnected) await prisma.$connect().catch(() => undefined);
    rmSync(prepared, { force: true });
    maintenanceMode = false;
  }
}

let scheduler: ReturnType<typeof setInterval> | undefined;
export async function runBackupMaintenance() {
  if (!(await workspaceAdminBackupsAvailable())) return;
  const settings = Object.fromEntries(
    (
      await prisma.setting.findMany({
        where: {
          id: {
            in: [
              "automaticBackups",
              "backupFrequency",
              "backupTime",
              "backupRetentionDaily",
              "backupRetentionWeekly",
            ],
          },
        },
      })
    ).map((row) => [row.id, JSON.parse(row.value)]),
  );
  if (settings.automaticBackups === false) return;
  const frequency = settings.backupFrequency === "WEEKLY" ? "WEEKLY" : "DAILY";
  const intervalDays = frequency === "WEEKLY" ? 7 : 1;
  const [hour, minute] = String(settings.backupTime || "03:00")
    .split(":")
    .map(Number);
  const dueBoundary = new Date();
  dueBoundary.setHours(hour || 0, minute || 0, 0, 0);
  if (Date.now() < dueBoundary.getTime())
    dueBoundary.setDate(dueBoundary.getDate() - 1);
  dueBoundary.setDate(dueBoundary.getDate() - (intervalDays - 1));
  const latest = await prisma.backupMetadata.findFirst({
    where: { type: "AUTOMATIC", status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
  });
  if (!latest || latest.createdAt < dueBoundary)
    await createBackup("AUTOMATIC");
  const automatic = await prisma.backupMetadata.findMany({
    where: { type: "AUTOMATIC" },
    orderBy: { createdAt: "desc" },
  });
  const retention = Math.max(
    1,
    Number(
      frequency === "WEEKLY"
        ? settings.backupRetentionWeekly || 4
        : settings.backupRetentionDaily || 7,
    ),
  );
  for (const old of automatic.slice(retention)) {
    await deleteBackup(old.filename);
    await prisma.backupMetadata.delete({ where: { id: old.id } });
  }
}
export function startBackupScheduler() {
  if (scheduler) return;
  void runBackupMaintenance().catch((error) =>
    console.error("Automatic backup failed", error),
  );
  scheduler = setInterval(
    async () => {
      try {
        await runBackupMaintenance();
      } catch (error) {
        console.error("Automatic backup failed", error);
      }
    },
    60 * 60 * 1000,
  );
  scheduler.unref?.();
}
