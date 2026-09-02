import { existsSync } from "node:fs";
import { defineConfig, chromium } from "@playwright/test";

const bundledChromiumAvailable = existsSync(chromium.executablePath());
const browserFallback = bundledChromiumAvailable ? {} : { channel: "chrome" };

const viewports = [
  [1920, 1080],
  [2560, 1440],
  [1440, 900],
  [1024, 768],
  [390, 844],
] as const;

export default defineConfig({
  testDir: "./tests/visual",
  outputDir: "./tests/visual/test-results",
  snapshotPathTemplate: "{testDir}/screenshots/{projectName}/{arg}{ext}",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [["line"]],
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      scale: "css",
      maxDiffPixels: 100,
    },
  },
  use: {
    baseURL: "http://127.0.0.1:5173",
    browserName: "chromium",
    colorScheme: "dark",
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "no-preference",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    ...browserFallback,
  },
  projects: viewports.map(([width, height]) => ({
    name: `chromium-${width}x${height}`,
    testMatch:
      width === 1440 && height === 900
        ? /.*\.spec\.ts/
        : /responsive\.spec\.ts/,
    use: { viewport: { width, height } },
  })),
  webServer: {
    command:
      "npm.cmd run dev -w @lead/dashboard -- --host 127.0.0.1 --port 5173 --strictPort",
    url: "http://127.0.0.1:5173",
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
