import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../../..");
const python = process.platform === "win32"
  ? resolve(root, "apps/scraper/.venv/Scripts/python.exe")
  : resolve(root, "apps/scraper/.venv/bin/python");
if (!existsSync(python)) {
  console.error("Scrapling environment missing. Run npm run scraper:setup first.");
  process.exit(1);
}
const result = spawnSync(
  python,
  ["-m", "unittest", "apps.scraper.tests.test_service", "-v"],
  { cwd: root, stdio: "inherit" },
);
process.exit(result.status ?? 1);
