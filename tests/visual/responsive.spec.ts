import { expect, test } from "@playwright/test";
import {
  createDiagnostics,
  expectCleanDiagnostics,
  expectNoHorizontalOverflow,
  installApiMocks,
  openApp,
  setTheme,
} from "./support";

test("Dashboard in Hella is stable and fits the viewport", async ({ page }, testInfo) => {
  const diagnostics = createDiagnostics(page);
  await installApiMocks(page, diagnostics);
  await setTheme(page, "forskin-hella");
  await openApp(page, "/", "Welcome back");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "forskin-hella");
  const viewportWidth = testInfo.project.use.viewport?.width ?? 0;
  await expect(page.locator(".forskin-ornaments")).toHaveCount(viewportWidth <= 1200 ? 0 : 1);
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot(`dashboard-hella-${testInfo.project.use.viewport?.width}x${testInfo.project.use.viewport?.height}.png`);
  expectCleanDiagnostics(diagnostics);
});
