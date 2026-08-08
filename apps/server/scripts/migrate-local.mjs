import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const prismaDir = resolve(import.meta.dirname, "../prisma");
const db = new DatabaseSync(
  process.argv[2]
    ? resolve(process.argv[2])
    : resolve(prismaDir, "lead-intelligence.db"),
);
db.exec(
  'PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS "_AetherMigration" ("name" TEXT NOT NULL PRIMARY KEY,"appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);',
);
const applied = new Set(
  db
    .prepare('SELECT name FROM "_AetherMigration"')
    .all()
    .map((row) => row.name),
);
for (const name of readdirSync(resolve(prismaDir, "migrations")).sort()) {
  if (!statSync(resolve(prismaDir, "migrations", name)).isDirectory()) continue;
  const path = resolve(prismaDir, "migrations", name, "migration.sql");
  if (applied.has(name)) continue;
  try {
    const sql = readFileSync(path, "utf8");
    const foreignKeysOff = sql.includes("-- @foreign_keys_off");
    if (foreignKeysOff) db.exec("PRAGMA foreign_keys=OFF");
    db.exec("BEGIN");
    db.exec(sql);
    db.prepare('INSERT INTO "_AetherMigration" (name) VALUES (?)').run(name);
    db.exec("COMMIT");
    if (foreignKeysOff) {
      db.exec("PRAGMA foreign_keys=ON");
      const problems = db.prepare("PRAGMA foreign_key_check").all();
      if (problems.length)
        throw new Error(
          `Foreign key validation failed after ${name}: ${JSON.stringify(problems)}`,
        );
    }
    console.log(`Applied ${name}`);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    try {
      db.exec("PRAGMA foreign_keys=ON");
    } catch {}
    if (
      name.startsWith("20260802224000") &&
      String(error).includes("already exists")
    ) {
      db.prepare(
        'INSERT OR IGNORE INTO "_AetherMigration" (name) VALUES (?)',
      ).run(name);
      console.log(`Recorded existing ${name}`);
      continue;
    }
    throw error;
  }
}
db.close();
