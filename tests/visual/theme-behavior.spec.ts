import { expect, test } from "@playwright/test";
import {
  createDiagnostics,
  expectCleanDiagnostics,
  installApiMocks,
  openApp,
  setTheme,
  themeStorageKey,
  type ThemeMode,
} from "./support";

test("Default, Subtle, and Hella root modes apply", async ({ page }) => {
  const diagnostics = createDiagnostics(page);
  await installApiMocks(page, diagnostics);
  await setTheme(page, "default");
  await page.clock.setFixedTime(new Date("2026-08-02T12:00:00.000Z"));

  const expectedColors: Record<ThemeMode, string> = {
    default: "#05070b",
    "forskin-subtle": "#0b0b09",
    "forskin-hella": "#070705",
  };
  for (const mode of Object.keys(expectedColors) as ThemeMode[]) {
    await page.goto("/");
    await expect(page.getByText("Welcome back", { exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", expectedColors[mode]);
    if (mode === "forskin-hella") {
      await expect(page.locator(".forskin-ornaments")).toBeAttached();
    } else {
      await expect(page.locator(".forskin-ornaments")).toHaveCount(0);
    }
    const nextMode: ThemeMode = mode === "default" ? "forskin-subtle" : "forskin-hella";
    await page.evaluate(
      ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
      {
        key: themeStorageKey,
        value: { mode: nextMode, decorativeCopy: true, ambientMotion: true },
      },
    );
  }
  expectCleanDiagnostics(diagnostics);
});

test("quick toggle changes theme without changing route", async ({ page }) => {
  const diagnostics = createDiagnostics(page);
  await installApiMocks(page, diagnostics);
  await setTheme(page, "forskin-hella");
  await openApp(page, "/searcher?visual=1", "Searcher / Scanner");
  const before = page.url();

  await page.getByRole("button", { name: /Theme: Forskin - Hella/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "default");
  expect(page.url()).toBe(before);
  expectCleanDiagnostics(diagnostics);
});

test("decorative copy can be disabled", async ({ page }) => {
  const diagnostics = createDiagnostics(page);
  await installApiMocks(page, diagnostics);
  await setTheme(page, "forskin-hella", false, true);
  await openApp(page, "/", "Welcome back");

  await expect(page.locator("html")).toHaveAttribute("data-forskin-copy", "off");
  const decorativeCopy = page.locator(".forskin-decorative-copy");
  expect(await decorativeCopy.count()).toBeGreaterThan(0);
  for (const element of await decorativeCopy.all()) {
    await expect(element).toBeHidden();
  }
  expectCleanDiagnostics(diagnostics);
});

test("reduced motion updates the root attribute and disables ambient CSS", async ({ page }) => {
  const diagnostics = createDiagnostics(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installApiMocks(page, diagnostics);
  await setTheme(page, "forskin-hella", true, true);
  await openApp(page, "/", "Welcome back");

  await expect(page.locator("html")).toHaveAttribute("data-forskin-motion", "off");
  await page.locator("body").evaluate((body) => {
    const spinner = document.createElement("span");
    spinner.className = "spin";
    spinner.dataset.visualSpinner = "true";
    body.append(spinner);
  });
  const ambientStyles = await page.locator(".forskin-ambient, .forskin-ambient *").evaluateAll((elements) =>
    elements.map((element) => {
      const style = getComputedStyle(element);
      return { animationName: style.animationName, transitionDuration: style.transitionDuration };
    }),
  );
  expect(ambientStyles.length).toBeGreaterThan(0);
  expect(ambientStyles.every((style) => style.animationName === "none")).toBe(true);
  expect(ambientStyles.every((style) => style.transitionDuration === "0s")).toBe(true);
  await expect(page.locator('[data-visual-spinner="true"]')).toHaveCSS("animation-name", "spin");
  expectCleanDiagnostics(diagnostics);
});
