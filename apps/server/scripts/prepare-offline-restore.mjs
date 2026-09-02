#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
} from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const migrationName = "20260902033000_shared_files";
const migrationSql = readFileSync(
  resolve(
    import.meta.dirname,
    `../prisma/migrations/${migrationName}/migration.sql`,
  ),
  "utf8",
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

function assertDatabaseHeader(path) {
  const descriptor = openRegularFile(path, "Database file");
  const header = Buffer.alloc(16);
  try {
    readSync(descriptor, header, 0, header.length, 0);
  } finally {
    closeSync(descriptor);
  }
  if (header.toString("utf8") !== "SQLite format 3\0")
    throw new Error("The selected file is not a SQLite database");
}

function openRegularFile(path, label) {
  const details = lstatSync(path);
  if (!details.isFile() || details.nlink !== 1)
    throw new Error(`${label} must be a regular, unlinked file`);
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  const opened = fstatSync(descriptor);
  if (opened.dev !== details.dev || opened.ino !== details.ino) {
    closeSync(descriptor);
    throw new Error(`${label} changed while it was being opened`);
  }
  return descriptor;
}

function assertSqliteArtifacts(path, requireMain = true) {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const artifact = `${path}${suffix}`;
    if (!pathExists(artifact)) {
      if (!suffix && requireMain) throw new Error("Database file not found");
      continue;
    }
    const details = lstatSync(artifact);
    if (!details.isFile() || details.nlink !== 1)
      throw new Error(`Unsafe SQLite artifact: ${artifact}`);
  }
}

function assertStandaloneDatabase(path) {
  assertSqliteArtifacts(path);
  for (const suffix of ["-journal", "-wal", "-shm"])
    if (pathExists(`${path}${suffix}`))
      throw new Error("Restore source contains SQLite companion files");
}

function removeSqliteArtifacts(path) {
  for (const suffix of ["", "-journal", "-wal", "-shm"])
    rmSync(`${path}${suffix}`, { force: true });
}

function fsyncFile(path) {
  const descriptor = openSync(path, constants.O_RDWR);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function tables(database) {
  return new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name),
  );
}

function assertIntegrity(database) {
  const integrity = database.prepare("PRAGMA integrity_check").get();
  if (Object.values(integrity || {})[0] !== "ok")
    throw new Error("SQLite integrity check failed");
  const available = tables(database);
  const required = [
    "Workspace",
    "User",
    "AuthSession",
    "Lead",
    "ScannerResult",
    "BackupMetadata",
  ];
  if (required.some((name) => !available.has(name)))
    throw new Error("Required application tables are missing");
  if (available.has("SharedFile")) {
    const columns = new Set(
      database
        .prepare('PRAGMA table_info("SharedFile")')
        .all()
        .map((column) => column.name),
    );
    if (requiredSharedFileColumns.some((name) => !columns.has(name)))
      throw new Error("SharedFile schema is incompatible");
  }
  return available;
}

function applySharedFileMigration(database, available) {
  if (available.has("SharedFile")) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(migrationSql);
    if (available.has("_AetherMigration"))
      database
        .prepare('INSERT OR IGNORE INTO "_AetherMigration" (name) VALUES (?)')
        .run(migrationName);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function fileSha256(path) {
  const digest = createHash("sha256");
  const descriptor = openRegularFile(path, "Shared-file payload");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest("hex");
}

function assertSharedFilePayloads(database, storageArgument) {
  const storage = resolve(storageArgument);
  if (!existsSync(storage) || !lstatSync(storage).isDirectory())
    throw new Error("Shared-file storage directory is unavailable");
  const files = database
    .prepare('SELECT "storageName", "sizeBytes", "sha256" FROM "SharedFile"')
    .all();
  for (const file of files) {
    if (!/^[0-9a-f-]{36}$/.test(file.storageName))
      throw new Error("Shared-file storage metadata is invalid");
    const path = resolve(storage, file.storageName);
    if (!existsSync(path))
      throw new Error(`Shared-file payload is missing: ${file.storageName}`);
    const details = lstatSync(path);
    if (!details.isFile() || details.size !== Number(file.sizeBytes))
      throw new Error(
        `Shared-file payload size is invalid: ${file.storageName}`,
      );
    if (fileSha256(path) !== file.sha256)
      throw new Error(
        `Shared-file payload checksum is invalid: ${file.storageName}`,
      );
  }
}

function createSafetySnapshot(source, destination) {
  assertSqliteArtifacts(source);
  assertDatabaseHeader(source);
  assertSqliteArtifacts(destination, false);
  if (
    ["", "-journal", "-wal", "-shm"].some((suffix) =>
      pathExists(`${destination}${suffix}`),
    )
  )
    throw new Error("Safety snapshot path already exists");
  try {
    const database = new DatabaseSync(source);
    try {
      const checkpoint = database
        .prepare("PRAGMA wal_checkpoint(TRUNCATE)")
        .get();
      const busy = Number(
        checkpoint?.busy ?? Object.values(checkpoint || {})[0] ?? 0,
      );
      if (busy !== 0)
        throw new Error(
          "SQLite WAL checkpoint is busy; a writer is still active",
        );
      assertIntegrity(database);
      database.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
    } finally {
      database.close();
    }
    const snapshot = new DatabaseSync(destination, { readOnly: true });
    try {
      assertIntegrity(snapshot);
    } finally {
      snapshot.close();
    }
    fsyncFile(source);
    fsyncFile(destination);
    console.log("Created and validated the offline safety snapshot.");
  } catch (error) {
    removeSqliteArtifacts(destination);
    throw error;
  }
}

function prepareRestore(source, staged, storage) {
  assertStandaloneDatabase(source);
  assertDatabaseHeader(source);
  if (source === staged)
    throw new Error("Restore staging path must be separate");
  if (
    ["", "-journal", "-wal", "-shm"].some((suffix) =>
      pathExists(`${staged}${suffix}`),
    )
  )
    throw new Error("Restore staging path already exists");
  try {
    copyFileSync(source, staged, constants.COPYFILE_EXCL);
    const database = new DatabaseSync(staged);
    try {
      const available = assertIntegrity(database);
      applySharedFileMigration(database, available);
      database.exec('DELETE FROM "AuthSession"');
      assertIntegrity(database);
      const foreignKeyProblems = database
        .prepare("PRAGMA foreign_key_check")
        .all();
      if (foreignKeyProblems.length)
        throw new Error("SQLite foreign-key validation failed");
      assertSharedFilePayloads(database, storage);
    } finally {
      database.close();
    }
    fsyncFile(staged);
    console.log("Prepared and validated the offline restore database.");
  } catch (error) {
    removeSqliteArtifacts(staged);
    throw error;
  }
}

function validateRestoreTarget(source, storage) {
  assertSqliteArtifacts(source);
  assertDatabaseHeader(source);
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    const available = assertIntegrity(database);
    if (!available.has("SharedFile"))
      throw new Error("SharedFile schema is missing after migration");
    const foreignKeyProblems = database
      .prepare("PRAGMA foreign_key_check")
      .all();
    if (foreignKeyProblems.length)
      throw new Error("SQLite foreign-key validation failed");
    assertSharedFilePayloads(database, storage);
  } finally {
    database.close();
  }
  console.log("Validated the live restore database and shared-file payloads.");
}

const arguments_ = process.argv.slice(2);
if (arguments_[0] === "--snapshot") {
  if (!arguments_[1] || !arguments_[2])
    throw new Error(
      "Usage: prepare-offline-restore.mjs --snapshot <live.db> <safety.db>",
    );
  createSafetySnapshot(resolve(arguments_[1]), resolve(arguments_[2]));
} else if (arguments_[0] === "--validate") {
  if (!arguments_[1] || !arguments_[2])
    throw new Error(
      "Usage: prepare-offline-restore.mjs --validate <live.db> <shared-file-directory>",
    );
  validateRestoreTarget(resolve(arguments_[1]), resolve(arguments_[2]));
} else {
  if (!arguments_[0] || !arguments_[1] || !arguments_[2])
    throw new Error(
      "Usage: prepare-offline-restore.mjs <backup.db> <staged.db> <shared-file-directory>",
    );
  prepareRestore(
    resolve(arguments_[0]),
    resolve(arguments_[1]),
    resolve(arguments_[2]),
  );
}
