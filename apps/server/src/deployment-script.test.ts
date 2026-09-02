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
});
