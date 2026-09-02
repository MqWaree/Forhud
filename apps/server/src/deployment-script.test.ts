import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const deploymentScript = readFileSync(
  new URL("../../../deploy/deploy-fgp-release.sh", import.meta.url),
  "utf8",
);
const scraperSetupScript = readFileSync(
  new URL("../../scraper/scripts/setup.mjs", import.meta.url),
  "utf8",
);
const windowsDeploymentScript = readFileSync(
  new URL("../../../deploy-release.ps1", import.meta.url),
  "utf8",
);

describe("production Python preflight installation", () => {
  it("keeps the release source locked while building from a disposable unprivileged copy", () => {
    const lockSource = deploymentScript.indexOf(
      'chmod -R a+rX,go-w "$preflight"',
    );
    const createBuildCopy = deploymentScript.indexOf(
      'scraper_build_source="$venv_home/scraper-source"',
    );
    const copyAsNobody = deploymentScript.indexOf(
      "runuser -u nobody -- cp -R --no-preserve=ownership",
    );
    const installAsNobody = deploymentScript.indexOf(
      "runuser -u nobody -- env",
      copyAsNobody,
    );
    const selectBuildCopy = deploymentScript.indexOf(
      'SCRAPER_PACKAGE_SOURCE="$scraper_build_source"',
      installAsNobody,
    );
    const relockSource = deploymentScript.indexOf(
      'chmod -R a+rX,go-w "$preflight"',
      installAsNobody,
    );

    expect(lockSource).toBeGreaterThan(-1);
    expect(createBuildCopy).toBeGreaterThan(lockSource);
    expect(copyAsNobody).toBeGreaterThan(createBuildCopy);
    expect(installAsNobody).toBeGreaterThan(copyAsNobody);
    expect(selectBuildCopy).toBeGreaterThan(installAsNobody);
    expect(relockSource).toBeGreaterThan(selectBuildCopy);
  });

  it("allows production to override only the package build source, not the virtualenv destination", () => {
    expect(scraperSetupScript).toContain(
      "process.env.SCRAPER_PACKAGE_SOURCE",
    );
    expect(scraperSetupScript).toContain(
      'resolve(root, "apps/scraper/.venv/bin/python")',
    );
    expect(scraperSetupScript).toContain(
      'resolve(packageSource, "pyproject.toml")',
    );
    expect(scraperSetupScript).toContain(
      'process.env.SCRAPER_INSTALL_EDITABLE === "false"',
    );
  });

  it("handles an SSH connection failure without trimming null command output", () => {
    expect(windowsDeploymentScript).toContain(
      '$remoteUploadOutput = @(& ssh @sshOptions "${User}@${Server}"',
    );
    expect(windowsDeploymentScript).toContain(
      "$remoteUploadDirectory = (($remoteUploadOutput | Out-String).Trim())",
    );
    expect(windowsDeploymentScript).toContain(
      "SSH exit code $remoteUploadExit",
    );
    expect(windowsDeploymentScript).not.toContain(
      '$remoteUploadDirectory = (& ssh "${User}@${Server}"',
    );
  });

  it("uses the real Windows user profile host-key file for every SSH transport", () => {
    expect(windowsDeploymentScript).toContain(
      "[Environment+SpecialFolder]::UserProfile",
    );
    expect(windowsDeploymentScript).toContain(
      '(Join-Path $sshDirectory "known_hosts").Replace("\\", "/")',
    );
    expect(windowsDeploymentScript).toContain(
      '"-o", "UserKnownHostsFile=$sshKnownHostsFile"',
    );
    expect(windowsDeploymentScript).toContain(
      '"-o", "StrictHostKeyChecking=ask"',
    );
    expect(windowsDeploymentScript.match(/& ssh @sshOptions/g)).toHaveLength(3);
    expect(windowsDeploymentScript.match(/& scp @sshOptions/g)).toHaveLength(2);
  });
});
