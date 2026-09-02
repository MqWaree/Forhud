import { expect, type Page, type Route } from "@playwright/test";

export const fixedTime = "2026-08-02T12:00:00.000Z";
export const themeStorageKey = "fgp.ui.theme.v1";

export type ThemeMode = "default" | "forskin-subtle" | "forskin-hella";

export type MockOptions = {
  authenticated?: boolean;
  authDelayMs?: number;
  fileError?: string;
};

export type Diagnostics = {
  assetFailures: string[];
  consoleErrors: string[];
  externalRequests: string[];
  pageErrors: string[];
  unknownApiRequests: string[];
};

const user = {
  id: "user-admin",
  workspaceId: "workspace-visual",
  username: "visual.admin",
  role: "ADMIN",
  status: "ACTIVE",
  requirePasswordChange: false,
  workspace: {
    id: "workspace-visual",
    name: "Forskin Visual Lab",
    scannerId: "FGP-VISUAL-2026",
  },
  ranks: [
    {
      id: "rank-owner",
      name: "Owner",
      color: "#d7aa5d",
      position: 100,
      permissions: ["LZT_ACCESS"],
    },
  ],
};

const scannerSnapshot = {
  engine: { healthy: true, engine: "Scrapling", version: "0.4.11" },
  state: { status: "IDLE" },
  items: [],
  pagination: { page: 1, pageSize: 50, total: 0, pages: 1 },
  stats: {
    websites: 0,
    scanned: 0,
    pending: 0,
    scanning: 0,
    failed: 0,
    timeouts: 0,
    blocked: 0,
    discord: 0,
    discordServers: 0,
    discordAlternateInvites: 0,
    discordUnresolved: 0,
    leads: 0,
  },
  performance: {
    enabled: true,
    configuredConcurrency: 32,
    currentConcurrency: 4,
    minimumConcurrency: 2,
    totalCompleted: 0,
    successful: 0,
    pressureEvents: 0,
    rateLimited: 0,
    timeoutEvents: 0,
    serverErrors: 0,
    averageDurationMs: 0,
    throughputPerMinute: 0,
    lastAdjustmentReason: "No scan pressure recorded",
    recent: {
      sampleSize: 0,
      medianDurationMs: 0,
      p95DurationMs: 0,
      successRate: 0,
    },
  },
};

const rustSnapshot = {
  product: {
    key: "rust-nfa-accounts",
    name: "Rust NFA accounts",
    type: "RUST_NFA",
  },
  products: [
    {
      key: "rust-nfa-accounts",
      name: "Rust NFA accounts",
      type: "RUST_NFA",
    },
  ],
  conversion: {
    targetCurrency: "USD",
    updatedAt: fixedTime,
    fetchedAt: fixedTime,
    stale: false,
    source: "visual fixture",
  },
  state: { status: "IDLE" },
  sources: [],
  listings: [],
  providers: [],
  pagination: { page: 1, pageSize: 50, total: 0, pages: 1 },
  stats: { sources: 0, completed: 0, pending: 0, failed: 0, listings: 0 },
  marketStats: {
    totalListings: 0,
    publicLinks: 0,
    sourcesRepresented: 0,
    currencies: [],
    converted: {
      currency: "USD",
      listings: 0,
      lowestMinor: 0,
      medianMinor: 0,
      averageMinor: 0,
      highestMinor: 0,
    },
    categories: [],
  },
};

const lztSnapshot = {
  configured: false,
  sourceMode: "PUBLIC_PAGE",
  displayCurrency: "USD",
  conversion: {
    updatedAt: fixedTime,
    fetchedAt: fixedTime,
    stale: false,
    source: "visual fixture",
  },
  state: {
    state: "STOPPED",
    initialized: false,
    newListings: 0,
    failedPolls: 0,
  },
  listings: [],
  notifications: [],
  notificationCount: 0,
  pagination: { page: 1, pageSize: 100, total: 0, pages: 1 },
  queueLength: 0,
  pollIntervalMs: 60_000,
  maxPriceUsdMinor: 500,
  notifyBelowUsdMinor: 500,
  notifyHighHoursBelowUsdMinor: 600,
  notifyHighHoursMinimum: 2_000,
  timezone: "UTC",
  notifyBelowDisplayMinor: 500,
  notifyHighHoursBelowDisplayMinor: 600,
  haze: {
    enabled: false,
    configured: false,
    pending: 0,
    sent: 0,
    failed: 0,
    delivery: "HAZE_CLIENT",
  },
  metrics: { maximumDetectionLatencyMs: 0 },
};

const fileSnapshot = {
  files: [],
  usage: {
    usedBytes: 0,
    fileCount: 0,
    maxFileBytes: 100 * 1024 * 1024,
    quotaBytes: 2 * 1024 * 1024 * 1024,
    maxFiles: 500,
  },
};

const settings = {
  defaultLeadStatus: "New",
  crawlerConcurrency: 32,
  adaptiveConcurrency: true,
  timeoutSeconds: 20,
  retries: 3,
  dynamicFallback: true,
  robotsRespect: true,
  deepScan: true,
  maxPages: 10,
  maxDepth: 2,
  backupsAvailable: false,
  automaticBackups: false,
  backupFrequency: "DAILY",
  backupTime: "02:00",
  backupRetentionDaily: 7,
  backupRetentionWeekly: 4,
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body),
  });
}

export function createDiagnostics(page: Page): Diagnostics {
  const diagnostics: Diagnostics = {
    assetFailures: [],
    consoleErrors: [],
    externalRequests: [],
    pageErrors: [],
    unknownApiRequests: [],
  };
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      ["http:", "https:", "ws:", "wss:"].includes(url.protocol) &&
      url.hostname !== "127.0.0.1"
    ) {
      diagnostics.externalRequests.push(request.url());
    }
  });
  page.on("requestfailed", (request) => {
    if (["document", "script", "stylesheet", "image", "font"].includes(request.resourceType())) {
      diagnostics.assetFailures.push(
        `${request.url()} (${request.failure()?.errorText || "request failed"})`,
      );
    }
  });
  page.on("response", (response) => {
    const request = response.request();
    if (
      response.status() === 404 &&
      ["document", "script", "stylesheet", "image", "font"].includes(request.resourceType())
    ) {
      diagnostics.assetFailures.push(`${response.url()} (HTTP 404)`);
    }
  });
  return diagnostics;
}

export async function installApiMocks(
  page: Page,
  diagnostics: Diagnostics,
  options: MockOptions = {},
) {
  const authenticated = options.authenticated !== false;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(4);

    if (path === "/events") {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        headers: { "cache-control": "no-cache", connection: "keep-alive" },
        body: "event: ready\ndata: {}\n\n",
      });
      return;
    }
    if (path === "/auth/setup-status") {
      if (options.authDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.authDelayMs));
      }
      await json(route, { required: false, protected: false, configured: true });
      return;
    }
    if (path === "/auth/me") {
      await json(route, authenticated ? user : null);
      return;
    }
    if (path === "/health") {
      await json(route, {
        ok: true,
        database: { connected: true },
        scraper: { healthy: true, engine: "Scrapling", version: "0.4.11" },
      });
      return;
    }
    if (path === "/workspace") {
      await json(route, {
        id: user.workspace.id,
        name: user.workspace.name,
        scannerId: user.workspace.scannerId,
        connectedExtensions: 0,
      });
      return;
    }
    if (path === "/members") {
      await json(route, [
        {
          id: user.id,
          username: user.username,
          systemRole: user.role,
          status: user.status,
          online: true,
          lastLoginAt: fixedTime,
          ranks: user.ranks,
        },
      ]);
      return;
    }
    if (path === "/clients" || path === "/search/sessions" || path === "/leads" || path === "/location") {
      await json(route, []);
      return;
    }
    if (path === "/notifications") {
      await json(route, []);
      return;
    }
    if (path === "/settings") {
      await json(route, settings);
      return;
    }
    if (path === "/team/users") {
      await json(route, [{ id: user.id, username: user.username }]);
      return;
    }
    if (path === "/search/brave/status") {
      await json(route, {
        configured: true,
        provider: "Brave Search",
        maxRequests: 300,
        maxResults: 5_000,
      });
      return;
    }
    if (path === "/search/brave/current" || path === "/scanner/discord-links/reconcile") {
      await json(route, path.endsWith("current") ? { current: null } : null);
      return;
    }
    if (path === "/scanner") {
      await json(route, scannerSnapshot);
      return;
    }
    if (path === "/rust-prices") {
      await json(route, rustSnapshot);
      return;
    }
    if (path === "/lzt-tracker") {
      await json(route, lztSnapshot);
      return;
    }
    if (path === "/shared-files") {
      if (options.fileError) {
        await json(route, { error: options.fileError }, 503);
      } else {
        await json(route, fileSnapshot);
      }
      return;
    }
    if (path === "/admin/overview") {
      await json(route, {
        users: 0,
        activeUsers: 0,
        connectedExtensions: 0,
        scannerResults: 0,
        leads: 0,
        scannersRunning: 0,
        backupsAvailable: false,
        restoreAvailable: false,
      });
      return;
    }
    if (
      [
        "/admin/users",
        "/admin/extensions",
        "/admin/backups",
        "/admin/audit",
        "/admin/ranks",
      ].includes(path)
    ) {
      await json(route, []);
      return;
    }

    diagnostics.unknownApiRequests.push(`${request.method()} ${url.pathname}${url.search}`);
    await json(route, { error: `No visual mock for ${path}` }, 501);
  });
}

export async function setTheme(page: Page, mode: ThemeMode, decorativeCopy = true, ambientMotion = true) {
  await page.addInitScript(
    ({ key, value }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(value));
    },
    {
      key: themeStorageKey,
      value: { mode, decorativeCopy, ambientMotion },
    },
  );
}

export async function openApp(page: Page, path: string, readyText: string | RegExp) {
  await page.clock.setFixedTime(new Date(fixedTime));
  await page.goto(path);
  await expect(page.getByRole("heading", { name: readyText, exact: typeof readyText === "string" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-forskin-assets", "ready");
  await page.locator("img:visible").evaluateAll(async (images: HTMLImageElement[]) => {
    await Promise.all(
      images.map((image) =>
        image.complete
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              image.addEventListener("load", () => resolve(), { once: true });
              image.addEventListener("error", () => resolve(), { once: true });
            }),
      ),
    );
  });
  await page.waitForTimeout(100);
}

export async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    bodyClient: document.body.clientWidth,
    bodyScroll: document.body.scrollWidth,
    rootClient: document.documentElement.clientWidth,
    rootScroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.bodyScroll, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.bodyClient);
  expect(dimensions.rootScroll, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.rootClient);
}

export function expectCleanDiagnostics(diagnostics: Diagnostics) {
  expect(diagnostics.pageErrors, "uncaught page errors").toEqual([]);
  expect(diagnostics.consoleErrors, "browser console errors").toEqual([]);
  expect(diagnostics.assetFailures, "failed assets or asset 404s").toEqual([]);
  expect(diagnostics.externalRequests, "external network requests").toEqual([]);
  expect(diagnostics.unknownApiRequests, "unmocked API requests").toEqual([]);
}
