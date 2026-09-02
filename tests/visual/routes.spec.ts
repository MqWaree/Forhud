import { expect, test } from "@playwright/test";
import {
  createDiagnostics,
  expectCleanDiagnostics,
  installApiMocks,
  openApp,
  setTheme,
} from "./support";

const routes = [
  ["searcher", "/searcher", "Searcher / Scanner"],
  ["splitter", "/splitter", "Splitter"],
  ["leads", "/leads", "Leads funnel"],
  ["my-leads", "/my-leads", "Leads funnel"],
  ["location-checker", "/location", "Hosting location"],
  ["history", "/history", "Search history"],
  ["settings", "/settings", "Settings"],
  ["control-center-admin", "/admin", "Workspace control center"],
  ["price-scanner", "/rust-prices", "Product Price Scanner"],
  ["file-sharing", "/files", "File sharing"],
] as const;

for (const [name, path, heading] of routes) {
  test(`${name} renders without browser failures`, async ({ page }) => {
    const diagnostics = createDiagnostics(page);
    await installApiMocks(page, diagnostics);
    await setTheme(page, "forskin-hella");
    await openApp(page, path, heading);

    await expect(page).toHaveScreenshot(`${name}-hella-1440x900.png`);
    expectCleanDiagnostics(diagnostics);
  });
}

test("login state", async ({ page }) => {
  const diagnostics = createDiagnostics(page);
  await installApiMocks(page, diagnostics, { authenticated: false });
  await setTheme(page, "forskin-hella");
  await page.clock.setFixedTime(new Date("2026-08-02T12:00:00.000Z"));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();

  await expect(page).toHaveScreenshot("login-hella-1440x900.png");
  expectCleanDiagnostics(diagnostics);
});

test("notification dropdown", async ({ page }) => {
  const diagnostics = createDiagnostics(page);
  await installApiMocks(page, diagnostics);
  await setTheme(page, "forskin-hella");
  await openApp(page, "/", "Welcome back");
  await page.getByRole("button", { name: "Notifications" }).click();
  await expect(page.locator(".notification-menu")).toBeVisible();

  await expect(page).toHaveScreenshot("notification-dropdown-hella-1440x900.png");
  expectCleanDiagnostics(diagnostics);
});

test("Searcher Import Links drawer", async ({ page }) => {
  const diagnostics = createDiagnostics(page);
  await installApiMocks(page, diagnostics);
  await setTheme(page, "forskin-hella");
  await openApp(page, "/searcher", "Searcher / Scanner");
  await page.getByRole("button", { name: "Import links" }).click();
  await expect(page.getByRole("dialog", { name: "Import links" })).toBeVisible();

  await expect(page).toHaveScreenshot("searcher-import-links-drawer-hella-1440x900.png");
  expectCleanDiagnostics(diagnostics);
});

test("file-sharing error state", async ({ page }) => {
  const diagnostics = createDiagnostics(page);
  await installApiMocks(page, diagnostics);
  await setTheme(page, "forskin-hella");
  await openApp(page, "/files", "File sharing");
  await page.locator('input[type="file"]').setInputFiles({
    name: "empty.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(""),
  });
  await expect(page.getByRole("alert")).toContainText("Empty files cannot be shared.");

  await expect(page).toHaveScreenshot("file-sharing-error-hella-1440x900.png");
  expectCleanDiagnostics(diagnostics);
});

test("auth loading state", async ({ page }) => {
  const diagnostics = createDiagnostics(page);
  await installApiMocks(page, diagnostics, { authDelayMs: 10_000 });
  await setTheme(page, "forskin-hella");
  await page.clock.setFixedTime(new Date("2026-08-02T12:00:00.000Z"));
  await page.goto("/");
  await expect(page.getByText("Loading secure workspace…")).toBeVisible();

  await expect(page).toHaveScreenshot("auth-loading-hella-1440x900.png");
  expectCleanDiagnostics(diagnostics);
});
