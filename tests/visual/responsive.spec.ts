import { expect, test } from "@playwright/test";
import {
  createDiagnostics,
  expectCleanDiagnostics,
  expectNoHorizontalOverflow,
  installApiMocks,
  openApp,
} from "./support";

test("Normal Forhud dashboard is stable and fits the viewport", async ({ page }, testInfo) => {
  const diagnostics = createDiagnostics(page);
  await installApiMocks(page, diagnostics);
  await openApp(page, "/", "Welcome back");

  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /forskin/);
  await expect(page.locator(".forskin-ornaments")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot(`dashboard-normal-${testInfo.project.use.viewport?.width}x${testInfo.project.use.viewport?.height}.png`);
  expectCleanDiagnostics(diagnostics);
});
