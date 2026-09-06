import { expect, test } from "@playwright/test";
import {
  createDiagnostics,
  expectCleanDiagnostics,
  installApiMocks,
  openApp,
} from "./support";

test("retired Forskin preferences cannot change the normal interface", async ({ page }) => {
  const diagnostics = createDiagnostics(page);
  await installApiMocks(page, diagnostics);
  await page.addInitScript(() => {
    localStorage.setItem(
      "fgp.ui.theme.v1",
      JSON.stringify({
        mode: "forskin-hella",
        decorativeCopy: true,
        ambientMotion: true,
      }),
    );
  });
  await openApp(page, "/", "Welcome back");

  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /forskin/);
  await expect(page.locator(".forskin-ornaments")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Theme:/ })).toHaveCount(0);
  await expect(page.locator(".brand-logo")).toBeVisible();
  await expect(page.getByText("Forhuds Panel", { exact: true })).toBeVisible();
  expectCleanDiagnostics(diagnostics);
});

test("Settings no longer offers a Forskin appearance mode", async ({ page }) => {
  const diagnostics = createDiagnostics(page);
  await installApiMocks(page, diagnostics);
  await openApp(page, "/settings", "Settings");

  await expect(page.getByText("Appearance", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Forskin -/)).toHaveCount(0);
  expectCleanDiagnostics(diagnostics);
});
