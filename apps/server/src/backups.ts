import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { prisma } from "./db.js";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

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

export function validateBackup(path: string) {
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
  } catch {
    throw Object.assign(new Error("Invalid backup. No data was changed."), {
      statusCode: 400,
    });
  } finally {
    db.close();
  }
}

export async function createBackup(
  type: "MANUAL" | "AUTOMATIC" | "PRE_RESTORE",
  createdById?: string,
) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "");
  const filename = `lead-platform_backup_${stamp}_${randomBytes(3).toString("hex")}_${type.toLowerCase()}.db`;
  const path = safePath(filename);
  const source = new DatabaseSync(databasePath, { readOnly: true });
  try {
    source.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }
  validateBackup(path);
  const manifest = {
    backupVersion: 1,
    applicationVersion: "1.4.0",
    schemaVersion: "20260803020000_multi_user_platform",
    createdAt: new Date().toISOString(),
    createdById: createdById || null,
    backupType: type,
    databaseType: "sqlite",
  };
  writeFileSync(`${path}.manifest.json`, JSON.stringify(manifest, null, 2), {
    encoding: "utf8",
    flag: "wx",
  });
  return prisma.backupMetadata.create({
    data: {
      filename,
      type,
      size: statSync(path).size,
      createdById,
      manifest: JSON.stringify(manifest),
    },
  });
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
    validateBackup(path);
    const manifest = {
      backupVersion: 1,
      applicationVersion: "1.4.0",
      schemaVersion: "20260803020000_multi_user_platform",
      createdAt: new Date().toISOString(),
      createdById,
      backupType: "UPLOADED",
      databaseType: "sqlite",
    };
    writeFileSync(`${path}.manifest.json`, JSON.stringify(manifest, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    return await prisma.backupMetadata.create({
      data: {
        filename,
        type: "UPLOADED",
        size: contents.length,
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

export async function restoreBackup(filename: string, actorId: string) {
  const selected = safePath(filename);
  validateBackup(selected);
  maintenanceMode = true;
  const safety = await createBackup("PRE_RESTORE", actorId);
  const safetyPath = safePath(safety.filename);
  try {
    await prisma.$disconnect();
    copyFileSync(selected, databasePath);
    validateBackup(databasePath);
    await prisma.$connect();
    await prisma.authSession.deleteMany();
    return { restored: true, safetyBackup: safety.filename };
  } catch (error) {
    copyFileSync(safetyPath, databasePath);
    await prisma.$connect();
    throw error;
  } finally {
    maintenanceMode = false;
  }
}

let scheduler: ReturnType<typeof setInterval> | undefined;
export async function runBackupMaintenance() {
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
