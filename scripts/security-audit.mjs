import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const online = process.argv.includes("--online");
const ignoredDirectories = new Set([
  ".git",
  ".pnpm-store",
  ".venv",
  "dist",
  "generated",
  "node_modules",
  "outputs",
  "work",
]);
const textExtensions = new Set([
  "",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".prisma",
  ".ps1",
  ".py",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const secretPatterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["Brave API key", /BSA[A-Za-z0-9]{20,}/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{30,}/],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["OpenAI key", /sk-[A-Za-z0-9_-]{20,}/],
];

async function filesUnder(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".env") && entry.name !== ".env.example")
      continue;
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(absolute)));
    else if (textExtensions.has(extname(entry.name).toLowerCase()))
      files.push(absolute);
  }
  return files;
}

const findings = [];
for (const file of await filesUnder(root)) {
  const source = await readFile(file, "utf8").catch(() => "");
  for (const [name, pattern] of secretPatterns)
    if (pattern.test(source))
      findings.push(`${relative(root, file)}: possible ${name}`);
}

const requiredSecurityText = [
  ["apps/server/src/index.ts", 'process.env.HOST || "127.0.0.1"'],
  ["apps/server/src/auth.ts", "httpOnly: true"],
  ["apps/server/src/auth.ts", 'sameSite: "strict"'],
  ["apps/server/src/auth.ts", "KNOWN_INSECURE_SCANNER_IDS"],
  ["apps/server/src/app.ts", "password: newPasswordSchema"],
  ["apps/server/src/auth.ts", "passwordStrengthIssue"],
  ["apps/server/src/app.ts", "unsafeWorkspaces.length === 0"],
  ["apps/server/src/extension-auth.ts", "!isSecureScannerId(scannerId)"],
  [
    "apps/server/prisma/migrations/20260803020000_multi_user_platform/migration.sql",
    "randomblob(16)",
  ],
  [
    "apps/server/prisma/migrations/20260809010000_rotate_predictable_scanner_id/migration.sql",
    "SET \"revokedAt\" = CURRENT_TIMESTAMP",
  ],
  ["apps/server/src/setup-security.ts", "INITIAL_SETUP_TOKEN"],
  ["apps/server/prisma/schema.prisma", "model SecurityRateLimit"],
  [
    "apps/server/src/scraper-client.ts",
    "unique secret of at least 24 characters",
  ],
  ["apps/scraper/src/service.py", "CurlOpt.RESOLVE"],
  ["apps/scraper/src/service.py", "--host-resolver-rules=MAP"],
  ["deploy/Caddyfile", "Content-Security-Policy"],
  ["deploy/Caddyfile", 'X-Frame-Options "DENY"'],
  ["deploy/fgp-api.service", "NoNewPrivileges=true"],
  ["deploy/fgp-scraper.service", "NoNewPrivileges=true"],
];
for (const [file, expected] of requiredSecurityText) {
  const source = await readFile(join(root, file), "utf8");
  if (!source.includes(expected)) findings.push(`${file}: missing ${expected}`);
}

if (findings.length) {
  console.error("Offline security scan failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(
    "Offline security scan passed: no packaged secrets or missing hardening controls.",
  );
}

if (online) {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const nodeAudit = spawnSync(pnpm, ["audit", "--audit-level", "moderate"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (nodeAudit.status !== 0) process.exitCode = 1;

  const python =
    process.platform === "win32"
      ? join(root, "apps", "scraper", ".venv", "Scripts", "python.exe")
      : join(root, "apps", "scraper", ".venv", "bin", "python");
  const pythonAudit = spawnSync(
    python,
    [
      "-m",
      "pip_audit",
      "--progress-spinner",
      "off",
      "--cache-dir",
      join(root, "outputs", "pip-audit-cache"),
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (pythonAudit.status !== 0) process.exitCode = 1;
}
