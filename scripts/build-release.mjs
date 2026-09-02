import {
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(projectRoot, "deploy", "fgp-release.tar.gz");
const stagingParent = await mkdtemp(join(tmpdir(), "fgp-release-"));
const stagingRoot = join(stagingParent, "package");
const sourceRoot = join(stagingParent, "source");
const sourceArchive = join(stagingParent, "source.tar");
const commit = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: projectRoot,
  encoding: "utf8",
});
if (commit.status !== 0 || !/^[0-9a-f]{40}\s*$/i.test(commit.stdout))
  throw new Error(commit.stderr || "Could not resolve the release commit");
const sourceCommit = commit.stdout.trim().toLowerCase();

const rootEntries = [
  ".env.example",
  ".gitignore",
  "AGENTS.md",
  "DEEPSEEK-ATTEMPT-LEDGER.md",
  "DEEPSEEK-V4-PRO-HANDOFF.md",
  "DEEPSEEK-V4-PRO-START-PROMPT.md",
  "OPENCODE-HANDOFF.md",
  "apps",
  "deploy",
  "eslint.config.js",
  "package.json",
  "packages",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "README.md",
  "tests",
  "THIRD_PARTY_NOTICES.md",
  "tsconfig.base.json",
  "vitest.config.ts",
];

const deniedDirectories = new Set([
  ".agents",
  ".codex",
  ".git",
  ".pnpm-store",
  ".venv",
  "__pycache__",
  "backups",
  "data",
  "dist",
  "generated",
  "node_modules",
  "outputs",
  "work",
]);

const deniedFile = (name) =>
  (name.startsWith(".env") && name !== ".env.example") ||
  /(?:\.db(?:-journal|-shm|-wal)?|\.sqlite\d*|\.log|\.pyc|\.tsbuildinfo|\.tar\.gz)$/i.test(
    name,
  ) ||
  /^query_engine-.*\.tmp/i.test(name);

async function includeSource(source) {
  const pathFromRoot = relative(sourceRoot, source);
  if (!pathFromRoot) return true;
  const parts = pathFromRoot.split(sep);
  if (parts.some((part) => deniedDirectories.has(part))) return false;
  if (deniedFile(basename(source))) return false;
  if ((await lstat(source)).isSymbolicLink())
    throw new Error(`Release source contains a symlink: ${pathFromRoot}`);
  return true;
}

async function materializeCommittedSource() {
  await mkdir(sourceRoot, { recursive: true });
  const archived = spawnSync(
    "git",
    ["archive", "--format=tar", `--output=${sourceArchive}`, sourceCommit],
    { cwd: projectRoot, encoding: "utf8" },
  );
  if (archived.status !== 0)
    throw new Error(archived.stderr || "Could not archive the release commit");
  const extracted = spawnSync("tar", ["-xf", sourceArchive, "-C", sourceRoot], {
    encoding: "utf8",
  });
  if (extracted.status !== 0)
    throw new Error(
      extracted.stderr || "Could not extract committed release source",
    );
}

async function copyReleaseSource() {
  await mkdir(stagingRoot, { recursive: true });
  for (const entry of rootEntries) {
    const source = join(sourceRoot, entry);
    const destination = join(stagingRoot, entry);
    await cp(source, destination, {
      recursive: true,
      filter: includeSource,
    });
  }

  const metadata = {
    builtAt: new Date().toISOString(),
    source: "npm run release:build",
    sourceCommit,
    policy: "allowlisted-source-only",
  };
  await writeFile(
    join(stagingRoot, "RELEASE-METADATA.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
}

function createArchive() {
  const result = spawnSync(
    "tar",
    ["-czf", outputPath, "-C", stagingRoot, "."],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "tar failed");
  }
}

function inspectArchive() {
  const result = spawnSync("tar", ["-tzf", outputPath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || "archive inspection failed",
    );
  }
  const entries = result.stdout.split(/\r?\n/).filter(Boolean);
  const unsafe = entries.filter((entry) => {
    const normalized = entry.replace(/^\.\//, "");
    const parts = normalized.split("/").filter(Boolean);
    return (
      parts.some((part) => deniedDirectories.has(part)) ||
      deniedFile(parts.at(-1) || "")
    );
  });
  if (unsafe.length) {
    throw new Error(`Unsafe release entries detected:\n${unsafe.join("\n")}`);
  }
  return entries.length;
}

try {
  await mkdir(dirname(outputPath), { recursive: true });
  await materializeCommittedSource();
  await copyReleaseSource();
  createArchive();
  const entryCount = inspectArchive();
  const packageJson = JSON.parse(
    await readFile(join(projectRoot, "package.json"), "utf8"),
  );
  console.log(
    `Created safe ${packageJson.name} release with ${entryCount} entries: ${outputPath}`,
  );
} finally {
  await rm(stagingParent, { recursive: true, force: true });
}
