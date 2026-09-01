import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const databaseUrl = process.env.DATABASE_URL || "";
if (!databaseUrl.startsWith("file:")) {
  throw new Error("DATABASE_URL must use SQLite's file: format");
}

const configuredPath = databaseUrl.slice("file:".length);
const databasePath = isAbsolute(configuredPath)
  ? configuredPath
  : resolve(process.cwd(), configuredPath);
const migrationName = "20260814020000_lzt_detection_metric_bigints";
const migrationPath = resolve(
  import.meta.dirname,
  "../prisma/migrations",
  migrationName,
  "migration.sql",
);
const database = new DatabaseSync(databasePath);

try {
  const table = database.prepare("PRAGMA table_info('LztTrackerState')").all();
  if (!table.length) {
    console.log(
      "LztTrackerState does not exist yet; schema sync will create it.",
    );
    process.exitCode = 0;
  } else {
    const types = new Map(
      table.map((column) => [
        String(column.name),
        String(column.type).toUpperCase(),
      ]),
    );
    const alreadyMigrated =
      types.get("totalDetectionMs") === "BIGINT" &&
      types.get("maxDetectionMs") === "BIGINT";

    if (alreadyMigrated) {
      console.log("LZT detection counters already use BIGINT.");
    } else {
      const sql = readFileSync(migrationPath, "utf8");
      database.exec("PRAGMA foreign_keys=OFF; BEGIN");
      try {
        database.exec(sql);
        database.exec("COMMIT; PRAGMA foreign_keys=ON");
      } catch (error) {
        try {
          database.exec("ROLLBACK; PRAGMA foreign_keys=ON");
        } catch {}
        throw error;
      }

      const foreignKeyProblems = database
        .prepare("PRAGMA foreign_key_check")
        .all();
      if (foreignKeyProblems.length) {
        throw new Error(
          `Foreign-key validation failed: ${JSON.stringify(foreignKeyProblems)}`,
        );
      }

      const migrationTable = database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='_AetherMigration'",
        )
        .get();
      if (migrationTable) {
        database
          .prepare(
            'INSERT OR IGNORE INTO "_AetherMigration" ("name") VALUES (?)',
          )
          .run(migrationName);
      }
      console.log("Migrated LZT detection counters to BIGINT.");
    }
  }
} finally {
  database.close();
}
