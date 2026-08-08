import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../../..");
const venvPython = process.platform === "win32"
  ? resolve(root, "apps/scraper/.venv/Scripts/python.exe")
  : resolve(root, "apps/scraper/.venv/bin/python");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(venvPython)) {
  const candidates = process.env.PYTHON
    ? [process.env.PYTHON]
    : process.platform === "win32"
      ? ["python", "py"]
      : ["python3", "python"];
  const python = candidates.find(
    (candidate) => spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0,
  );
  if (!python) {
    console.error("Python 3.10–3.13 was not found. Install Python, then run this command again.");
    process.exit(1);
  }
  run(python, ["-m", "venv", resolve(root, "apps/scraper/.venv")]);
}

run(venvPython, ["-m", "pip", "install", "-e", resolve(root, "apps/scraper")]);
const scrapling = process.platform === "win32"
  ? resolve(root, "apps/scraper/.venv/Scripts/scrapling.exe")
  : resolve(root, "apps/scraper/.venv/bin/scrapling");
const configuredBrowser = process.env.SCRAPER_BROWSER_EXECUTABLE;
if (configuredBrowser && existsSync(configuredBrowser)) {
  // A system-managed Chrome installation avoids downloading a duplicate
  // Playwright browser, but its Linux runtime libraries are still required.
  if (process.platform !== "win32") {
    run(venvPython, ["-m", "playwright", "install-deps", "chromium"]);
  }
  console.log(`Using the configured browser executable: ${configuredBrowser}`);
} else {
  run(scrapling, ["install"]);
}
