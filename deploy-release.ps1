param(
  [string]$Server = "162.35.162.136",
  [string]$User = "root",
  [string]$Archive = (Join-Path $PSScriptRoot "deploy\fgp-release.tar.gz"),
  [string]$GitRemote = "origin",
  [string]$GitCommitMessage = "",
  [switch]$SkipGitPublish
)

$ErrorActionPreference = "Stop"

$releasePaths = @(
  ".gitattributes",
  ".env.example",
  ".gitignore",
  "AGENTS.md",
  "DEEPSEEK-ATTEMPT-LEDGER.md",
  "DEEPSEEK-V4-PRO-HANDOFF.md",
  "DEEPSEEK-V4-PRO-START-PROMPT.md",
  "OPENCODE-HANDOFF.md",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "apps",
  "deploy",
  "eslint.config.js",
  "package.json",
  "packages",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts",
  "tests",
  "tsconfig.base.json",
  "vitest.config.ts",
  "deploy-release.ps1",
  "DEPLOY-FGP.cmd",
  "DEPLOY-CORRECTED-RELEASE.cmd",
  "deploy-now.cmd",
  "invoke-fgp-deployment.ps1",
  "OPEN-DEPLOY.vbs",
  "run-deploy-interactive.ps1"
) | Where-Object { Test-Path -LiteralPath (Join-Path $PSScriptRoot $_) }

function Invoke-Git {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

  & git -C $PSScriptRoot @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Git command failed: git $($Arguments -join ' ')"
  }
}

function Assert-ReleaseTreeClean {
  & git -C $PSScriptRoot diff --quiet --exit-code HEAD -- @releasePaths
  if ($LASTEXITCODE -ne 0) {
    throw "Release source differs from HEAD after publishing."
  }
  $untracked = @(& git -C $PSScriptRoot ls-files --others --exclude-standard -- @releasePaths)
  if ($LASTEXITCODE -ne 0) {
    throw "Could not inspect untracked release source."
  }
  if ($untracked.Count -gt 0) {
    throw "Untracked release source remains after publishing: $($untracked -join ', ')"
  }
}

function Publish-GitRelease {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git is required so the archive can be bound to a source commit."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot ".git"))) {
    throw "The deployment folder is not a Git working tree."
  }
  if ($SkipGitPublish) {
    Write-Warning "GitHub publishing was explicitly skipped; only clean HEAD source is allowed."
    Assert-ReleaseTreeClean
    return
  }

  $branch = (& git -C $PSScriptRoot branch --show-current).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($branch)) {
    throw "Deployments require a named Git branch; detached HEAD is not supported."
  }

  Write-Host "Checking GitHub branch $GitRemote/$branch"
  Invoke-Git fetch --prune $GitRemote $branch
  & git -C $PSScriptRoot show-ref --verify --quiet "refs/remotes/$GitRemote/$branch"
  $remoteBranchExists = $LASTEXITCODE -eq 0
  if ($remoteBranchExists) {
    & git -C $PSScriptRoot merge-base --is-ancestor "$GitRemote/$branch" HEAD
    if ($LASTEXITCODE -ne 0) {
      throw "Local $branch is behind or has diverged from $GitRemote/$branch. Reconcile it before deploying; no force-push will be attempted."
    }
  }

  $staged = @(& git -C $PSScriptRoot diff --cached --name-only)
  if ($LASTEXITCODE -ne 0) {
    throw "Could not inspect the Git index before publishing."
  }
  if ($staged.Count -gt 0) {
    throw "Publishing requires an empty Git index; existing staged files were not changed."
  }
  Invoke-Git add -- @releasePaths
  & git -C $PSScriptRoot diff --cached --quiet --exit-code
  if ($LASTEXITCODE -ne 0) {
    $message = $GitCommitMessage
    if ([string]::IsNullOrWhiteSpace($message)) {
      $message = "Deploy FGP " + (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss 'UTC'")
    }
    Invoke-Git commit -m $message
  }
  else {
    Write-Host "No new release source changes to commit."
  }

  Invoke-Git push $GitRemote "HEAD:$branch"
  Assert-ReleaseTreeClean
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  }
  finally {
    $stream.Dispose()
    $sha256.Dispose()
  }
}

Publish-GitRelease
$releaseCommit = (& git -C $PSScriptRoot rev-parse HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $releaseCommit -notmatch '^[0-9a-f]{40}$') {
  throw "Could not resolve the release commit."
}
Write-Host "GitHub release commit: $releaseCommit"

$defaultArchive = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "deploy\fgp-release.tar.gz"))
$requestedArchive = [System.IO.Path]::GetFullPath($Archive)
if (-not $requestedArchive.Equals($defaultArchive, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Deployments must use the archive produced by the audited release builder: $defaultArchive"
}
$pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if (-not $pnpm) {
  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
}
if (-not $pnpm) {
  throw "pnpm is required to build the audited release archive."
}
& $pnpm.Source run release:build
if ($LASTEXITCODE -ne 0) {
  throw "Release archive creation failed."
}

$resolvedArchive = (Resolve-Path -LiteralPath $defaultArchive).Path
$resolvedScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "deploy\deploy-fgp-release.sh")).Path
$archiveHash = Get-Sha256 -Path $resolvedArchive
$scriptHash = Get-Sha256 -Path $resolvedScript
$workingScriptBlob = (& git -C $PSScriptRoot hash-object -- $resolvedScript).Trim()
$committedScriptBlob = (& git -C $PSScriptRoot rev-parse "HEAD:deploy/deploy-fgp-release.sh").Trim()
if ($LASTEXITCODE -ne 0 -or $workingScriptBlob -ne $committedScriptBlob) {
  throw "The uploaded deployment script does not match the published commit."
}
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outputDirectory = Join-Path $PSScriptRoot "outputs"
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$log = Join-Path $outputDirectory "deploy-release-$stamp.log"

$remoteUploadDirectory = (& ssh "${User}@${Server}" "umask 077; mktemp -d /tmp/fgp-upload.XXXXXX").Trim()
if ($LASTEXITCODE -ne 0 -or $remoteUploadDirectory -notmatch '^/tmp/fgp-upload\.[A-Za-z0-9]+$') {
  throw "Could not create a private remote upload directory."
}
$remoteArchive = "$remoteUploadDirectory/fgp-release.tar.gz"
$remoteScript = "$remoteUploadDirectory/deploy-fgp-release.sh"

try {
  Write-Host "Uploading release $archiveHash"
  & scp -- $resolvedArchive "${User}@${Server}:$remoteArchive"
  if ($LASTEXITCODE -ne 0) {
    throw "Archive upload failed."
  }
  & scp -- $resolvedScript "${User}@${Server}:$remoteScript"
  if ($LASTEXITCODE -ne 0) {
    throw "Deployment-script upload failed."
  }
}
catch {
  & ssh "${User}@${Server}" "rm -rf -- '$remoteUploadDirectory'" 2>$null
  throw
}

$bootstrapTemplate = @'
set -Eeuo pipefail
script="__REMOTE_SCRIPT__"
archive="__REMOTE_ARCHIVE__"
upload_dir="__REMOTE_UPLOAD_DIR__"
expected_script_sha="__SCRIPT_HASH__"
actual_script_sha="$(sha256sum "$script" | awk '{print $1}')"
if [ "$actual_script_sha" != "$expected_script_sha" ]; then
  echo "Deployment script checksum mismatch."
  rm -rf -- "$upload_dir"
  exit 1
fi
chmod 0700 "$script"
exec "$script" "$archive" "__ARCHIVE_HASH__" "__STAMP__" "__RELEASE_COMMIT__"
'@
$remoteCommand = $bootstrapTemplate.Replace("__REMOTE_SCRIPT__", $remoteScript).Replace("__REMOTE_ARCHIVE__", $remoteArchive).Replace("__REMOTE_UPLOAD_DIR__", $remoteUploadDirectory).Replace("__SCRIPT_HASH__", $scriptHash).Replace("__ARCHIVE_HASH__", $archiveHash).Replace("__STAMP__", $stamp).Replace("__RELEASE_COMMIT__", $releaseCommit).Replace("`r", "")

$previousPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  & ssh "${User}@${Server}" $remoteCommand 2>&1 | Tee-Object -FilePath $log
  $sshExit = $LASTEXITCODE
}
finally {
  $ErrorActionPreference = $previousPreference
}

if ($sshExit -ne 0) {
  throw "Deployment failed or was rolled back. Full log: $log"
}

Write-Host "Deployment completed. Full log: $log"
