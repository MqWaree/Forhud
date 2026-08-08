import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "../../..");
const candidates = process.platform === "win32"
  ? [resolve(root, "apps/scraper/.venv/Scripts/python.exe"), "python"]
  : [resolve(root, "apps/scraper/.venv/bin/python"), "python3"];
const python = candidates.find((candidate) => !candidate.includes(".venv") || existsSync(candidate));
if (!python) throw new Error("Python was not found. Run npm run scraper:setup first.");

const child = spawn(python, ["-m", "apps.scraper.src.service"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    PYTHONUNBUFFERED: "1",
    SCRAPER_TOKEN: process.env.SCRAPER_TOKEN || "aether-dev-local-worker",
    SCRAPER_PORT: process.env.SCRAPER_PORT || "3011",
  },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));

