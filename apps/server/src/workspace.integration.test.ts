import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import request from "supertest";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const dbPath = resolve(process.cwd(), "work", "scanner-integration.db");
rmSync(dbPath, { force: true });
execFileSync(process.execPath, [
  resolve(process.cwd(), "apps/server/scripts/migrate-local.mjs"),
  dbPath,
]);
process.env.DATABASE_URL = `file:${dbPath.replaceAll("\\", "/")}`;

vi.mock("./crawler.js", () => ({
  robotsAllows: vi.fn(async () => true),
  robotsDecision: vi.fn(async () => ({
    allowed: true,
    reason: "ALLOWED",
    httpStatus: 200,
    fromCache: false,
  })),
  fetchPage: vi.fn(async (url: string) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    if (url === "https://26.0.0.1/slow")
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    const isRoot = url.endsWith("/deep-root");
    const isContact = url.endsWith("/contact") && url.includes("23.0.0.1");
    const isAbout = url.endsWith("/about") && url.includes("23.0.0.1");
    const hasNoDiscord = url.includes("25.0.0.1");
    const hasTelegramOnly = url.includes("26.0.0.1");
    const hasEmailOnly = url.includes("27.0.0.1");
    return {
      requestedUrl: url,
      finalUrl: url,
      redirectUrl: null,
      httpStatus: 200,
      title: isRoot
        ? "Deep root"
        : isContact
          ? "Contact"
          : isAbout
            ? "About"
            : "Test page",
      metaDescription: "Controlled fixture",
      canonicalUrl: url,
      faviconUrl: null,
      contentType: "text/html",
      fetchMode: "HTTP" as const,
      discordLinks:
        isRoot || hasNoDiscord || hasTelegramOnly || hasEmailOnly
          ? []
          : isContact
            ? ["https://discord.gg/DeepContact"]
            : isAbout
              ? ["https://discord.gg/DeepAbout"]
              : ["https://discord.gg/SharedInvite"],
      discordDetections: (isRoot ||
      hasNoDiscord ||
      hasTelegramOnly ||
      hasEmailOnly
        ? []
        : isContact
          ? ["https://discord.gg/DeepContact"]
          : isAbout
            ? ["https://discord.gg/DeepAbout"]
            : ["https://discord.gg/SharedInvite"]
      ).map((value) => ({ url: value, method: "anchor" as const })),
      emails: isContact
        ? ["hello@example.test"]
        : hasEmailOnly
          ? ["email-only@example.test"]
          : [],
      socialLinks: isContact
        ? [{ type: "telegram", url: "https://t.me/example", sourcePage: url }]
        : hasTelegramOnly
          ? [
              {
                type: "telegram",
                url: "https://telegram.me/TelegramOnly",
                sourcePage: url,
              },
            ]
          : [],
      internalLinks: isRoot
        ? ["https://23.0.0.1/contact"]
        : url === "https://26.0.0.1/"
          ? ["https://26.0.0.1/slow"]
          : isContact
            ? ["https://23.0.0.1/about"]
            : [],
      durationMs: 20,
      looksDynamic: false,
      isSoft404: false,
    };
  }),
}));

let app: any;
let prisma: any;
let browser: ReturnType<typeof request.agent>;
let extensionToken = "";

beforeAll(async () => {
  const module = await import("./app.js");
  app = module.default;
  prisma = module.prisma;
  await module.scannerReady;
  browser = request.agent(app);
  const setup = await browser.post("/api/auth/setup").send({
    username: "testadmin",
    password: "correct horse battery staple",
  });
  expect(setup.status).toBe(201);
  const workspace = await browser.get("/api/workspace");
  const paired = await request(app)
    .post("/api/extension/pair")
    .send({ scannerId: workspace.body.scannerId, instanceId: "EXT-TESTA" });
  expect(paired.status).toBe(201);
  extensionToken = paired.body.token;
});
afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(dbPath, { force: true });
});

const extension = () =>
  request(app)
    .post("/api/search/import")
    .set("authorization", `Bearer ${extensionToken}`);
const payload = (query: string, start: number, count: number) => ({
  searchQuery: query,
  clientId: "IGNORED-CLIENT-INPUT",
  source: "google",
  pageUrl: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
  capturedAt: new Date().toISOString(),
  results: Array.from({ length: count }, (_, index) => ({
    title: `Site ${start + index}`,
    url: `https://11.0.0.${start + index}/community`,
    position: index + 1,
  })),
});

describe("authenticated persistent scanner workspace", () => {
  it("rejects unauthenticated dashboard and extension writes", async () => {
    expect((await request(app).get("/api/leads")).status).toBe(401);
    expect(
      (
        await request(app)
          .post("/api/search/import")
          .send(payload("blocked", 1, 1))
      ).status,
    ).toBe(401);
  });

  it("runs the Discord checker in the background and exposes persistent progress", async () => {
    expect(
      (await browser.get("/api/scanner/discord-links/reconcile")).body,
    ).toBeNull();
    const started = await browser.post("/api/scanner/discord-links/reconcile");
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({
      started: true,
      progress: { status: "RUNNING", progressPercent: 0 },
    });

    let progress: any;
    for (let attempt = 0; attempt < 50; attempt++) {
      progress = (await browser.get("/api/scanner/discord-links/reconcile"))
        .body;
      if (progress?.status !== "RUNNING") break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    expect(progress).toMatchObject({
      status: "COMPLETED",
      total: 0,
      checked: 0,
      progressPercent: 100,
    });
  });

  it("restores the active web-search operation after a dashboard reload", async () => {
    const workspace = await prisma.workspace.findFirstOrThrow();
    const { setCurrentSearchProgress } = await import("./search-progress.js");
    await setCurrentSearchProgress(workspace.id, {
      operationId: "1781486a-e7df-4b74-a992-8e63601a0fa4",
      query: "security agencies",
      status: "RUNNING",
      phase: "Discovering unique business websites",
      requested: 500,
      discovered: 83,
      queued: 0,
      duplicates: 0,
      rejected: 0,
      excluded: 14,
      leadsAdded: 0,
      requests: 27,
      failedRequests: 1,
      queryPagesChecked: 26,
      totalVariants: 80,
      activeVariants: 64,
      progressPercent: 18,
      startedAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:01.000Z",
    });
    const current = await browser.get("/api/search/brave/current");
    expect(current.status).toBe(200);
    expect(current.body.current).toMatchObject({
      query: "security agencies",
      status: "RUNNING",
      requested: 500,
      discovered: 83,
      excluded: 14,
      requests: 27,
      progressPercent: 18,
    });
  });

  it("imports more than ten results and accumulates across extension pages", async () => {
    expect((await extension().send(payload("search a", 1, 60))).status).toBe(
      201,
    );
    expect((await extension().send(payload("search b", 61, 60))).status).toBe(
      201,
    );
    const workspace = await browser.get("/api/scanner?pageSize=100");
    expect(workspace.status).toBe(200);
    expect(workspace.body.stats.websites).toBe(120);
    expect(workspace.body.items).toHaveLength(100);
  });

  it("deduplicates a domain while retaining both source sessions", async () => {
    await extension().send({
      ...payload("search c", 1, 1),
      results: [
        { title: "Duplicate", url: "https://11.0.0.1/about", position: 3 },
      ],
    });
    const workspace = await browser.get("/api/scanner?pageSize=100");
    const duplicate = workspace.body.items.find(
      (item: any) => item.domain.hostname === "11.0.0.1",
    );
    expect(workspace.body.stats.websites).toBe(120);
    expect(duplicate.sources.map((source: any) => source.query).sort()).toEqual(
      ["search a", "search c"],
    );
    expect(
      duplicate.sources.every((source: any) => source.clientId === "EXT-TESTA"),
    ).toBe(true);
  });

  it("imports manual links and rejects private SSRF targets", async () => {
    const imported = await browser.post("/api/scanner/import-links").send({
      label: "Partner list",
      urls: [
        "https://12.0.0.1/contact",
        "https://11.0.0.1/other",
        "http://127.0.0.1/private",
      ],
    });
    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({
      imported: 2,
      created: 1,
      duplicates: 1,
      rejected: 1,
    });
    const domain = await prisma.domain.findUniqueOrThrow({
      where: { hostname: "12.0.0.1" },
    });
    const automaticLeads = await prisma.lead.findMany({
      where: { domainId: domain.id },
    });
    expect(automaticLeads).toHaveLength(0);
    expect(
      (await browser.get("/api/leads")).body.some(
        (lead: any) => lead.domain.hostname === "12.0.0.1",
      ),
    ).toBe(false);
  });

  it("ignores platform URLs before they enter the scanner workspace", async () => {
    const imported = await browser.post("/api/scanner/import-links").send({
      label: "Business-only list",
      urls: [
        "https://www.reddit.com/r/business",
        "https://discord.gg/example",
        "https://store.steampowered.com/app/123",
        "https://12.0.0.2/contact",
      ],
    });
    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({
      imported: 1,
      created: 1,
      excluded: 3,
      rejected: 0,
    });
    const excludedRows = await prisma.scannerResult.count({
      where: {
        domain: {
          hostname: { in: ["reddit.com", "discord.gg", "steampowered.com"] },
        },
      },
    });
    expect(excludedRows).toBe(0);
  });

  it("resolves and stores hosting infrastructure details for visible domains", async () => {
    const domain = await prisma.domain.findUniqueOrThrow({
      where: { hostname: "11.0.0.1" },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            country: "Testland",
            country_code: "TL",
            region: "Test Region",
            city: "Test City",
            connection: { asn: 64500, isp: "Test Hosting" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as typeof fetch;
    try {
      const checked = await browser
        .post("/api/location/check")
        .send({ domainIds: [domain.id] });
      expect(checked.body).toEqual({ checked: 1, failed: 0 });
      const rows = await browser.get("/api/location");
      expect(
        rows.body.find((item: any) => item.id === domain.id).location,
      ).toMatchObject({ country: "Testland", provider: "Test Hosting" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("stops gracefully, resumes, and continues consuming later imports while running", async () => {
    await browser.post("/api/scanner/start");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    const stopped = await browser.post("/api/scanner/stop");
    expect(stopped.body.status).toBe("STOPPED");
    await browser.post("/api/scanner/start");
    const importAndWait = async (address: string) => {
      const imported = await browser.post("/api/scanner/import-links").send({
        label: `Repeated ${address}`,
        urls: [`https://${address}/contact`],
      });
      expect(imported.body.created).toBe(1);
      for (let attempt = 0; attempt < 80; attempt++) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        const snapshot = await browser.get("/api/scanner?pageSize=100");
        const item = snapshot.body.items.find(
          (row: any) => row.domain.hostname === address,
        );
        if (item?.scanStatus === "Completed") return snapshot.body;
      }
      throw new Error(`Scanner did not process ${address}`);
    };
    expect((await importAndWait("13.0.0.1")).state.status).toBe("RUNNING");
    expect((await importAndWait("14.0.0.1")).state.status).toBe("RUNNING");
    expect((await browser.post("/api/scanner/stop")).body.status).toBe(
      "STOPPED",
    );
  });

  it("persists expanded lead details and preserves leads during scanner reset", async () => {
    const workspace = await browser.get("/api/scanner?pageSize=100");
    await browser
      .post("/api/scanner/leads")
      .send({ ids: [workspace.body.items[0].id] });
    const leads = await browser.get("/api/leads");
    const leadId = leads.body[0].id;
    const updated = await browser.patch(`/api/leads/${leadId}`).send({
      companyName: "FGP Test",
      notes: "Persistent research notes",
      priority: "High",
      tags: ["Software", "High Value"],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.tags.map((item: any) => item.tag.name).sort()).toEqual([
      "High Value",
      "Software",
    ]);
    await browser.post("/api/scanner/reset");
    expect((await browser.get("/api/scanner")).body.stats.websites).toBe(0);
    const persisted = await browser.get(`/api/leads/${leadId}`);
    expect(persisted.body.notes).toBe("Persistent research notes");
  });

  it("accepts a controlled 500-domain import without truncating the workspace", async () => {
    const urls = Array.from({ length: 500 }, (_, index) => {
      const group = Math.floor(index / 250);
      const host = index % 250;
      return `https://21.${group}.0.${host + 1}/contact`;
    });
    const imported = await browser
      .post("/api/scanner/import-links")
      .send({ label: "Controlled 500 URL test", urls });
    expect(imported.status).toBe(201);
    expect(imported.body.created).toBe(500);
    const snapshot = await browser.get("/api/scanner?page=1&pageSize=100");
    expect(snapshot.body.stats.websites).toBe(500);
    expect(snapshot.body.pagination.pages).toBe(5);
    expect(snapshot.body.items).toHaveLength(100);
    expect(
      (await browser.get("/api/leads")).body.some((lead: any) =>
        lead.domain.hostname.startsWith("21."),
      ),
    ).toBe(false);
    await browser.post("/api/scanner/reset");
  });

  it("runs bounded same-domain deep scanning when explicitly enabled", async () => {
    await browser.patch("/api/settings").send({
      deepScan: true,
      maxPages: 3,
      maxDepth: 2,
    });
    await browser
      .post("/api/scanner/import-links")
      .send({ label: "Deep scan", urls: ["https://23.0.0.1/deep-root"] });
    await browser.post("/api/scanner/start");
    for (let attempt = 0; attempt < 80; attempt++) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      const snapshot = await browser.get("/api/scanner");
      if (snapshot.body.items[0]?.scanStatus === "Completed") break;
    }
    await browser.post("/api/scanner/stop");
    const snapshot = await browser.get("/api/scanner");
    expect(
      snapshot.body.items[0].discordLinks.map((link: any) => link.url).sort(),
    ).toEqual([
      "https://discord.gg/DeepAbout",
      "https://discord.gg/DeepContact",
    ]);
    let discoveredLead = (await browser.get("/api/leads")).body.find(
      (lead: any) => lead.domain.hostname === "23.0.0.1",
    );
    expect(discoveredLead).toMatchObject({
      email: "hello@example.test",
      telegram: "https://t.me/example",
    });
    expect([
      "https://discord.gg/DeepContact",
      "https://discord.gg/DeepAbout",
    ]).toContain(discoveredLead.discordInvite);
    const discordExport = await browser.get("/api/export/discord-links.csv");
    expect(discordExport.status).toBe(200);
    expect(discordExport.headers["content-disposition"]).toContain(
      "discord-links.csv",
    );
    expect(discordExport.text).toContain("https://discord.gg/DeepContact");
    expect(discordExport.text).toContain("https://discord.gg/DeepAbout");
    const plainDiscordExport = await browser.get(
      "/api/export/lead-discord-links.txt",
    );
    expect(plainDiscordExport.status).toBe(200);
    expect(plainDiscordExport.headers["content-disposition"]).toContain(
      "discord-links.txt",
    );
    const exportedLinks = plainDiscordExport.text.trim().split(/\r?\n/);
    expect(exportedLinks).toContain("https://discord.gg/DeepContact");
    expect(exportedLinks).toContain("https://discord.gg/DeepAbout");
    expect(
      exportedLinks.every((link: string) =>
        /^https:\/\/(?:discord\.gg|discord\.com)\//.test(link),
      ),
    ).toBe(true);
    expect(plainDiscordExport.text).not.toContain("Discord URL");
    expect(plainDiscordExport.text).not.toContain(",");
    await browser.patch(`/api/leads/${discoveredLead.id}`).send({
      email: "manual@example.test",
      telegram: "manual-telegram",
    });
    await browser
      .post("/api/scanner/leads")
      .send({ ids: [snapshot.body.items[0].id] });
    discoveredLead = await prisma.lead.findUniqueOrThrow({
      where: { id: discoveredLead.id },
    });
    expect(discoveredLead).toMatchObject({
      email: "manual@example.test",
      telegram: "manual-telegram",
    });
    await prisma.lead.delete({ where: { id: discoveredLead.id } });
    await browser.patch("/api/settings").send({ deepScan: false });
    await browser.post("/api/scanner/reset");
  });

  it("enforces max depth and max pages independently", async () => {
    await browser.patch("/api/settings").send({
      crawlerConcurrency: 1,
      robotsRespect: false,
      deepScan: true,
      maxPages: 3,
      maxDepth: 1,
    });
    await browser
      .post("/api/scanner/import-links")
      .send({ label: "Depth one", urls: ["https://23.0.0.1/deep-root"] });
    await browser.post("/api/scanner/start");
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      const snapshot = await browser.get("/api/scanner");
      if (snapshot.body.items[0]?.scanStatus === "Completed") break;
    }
    await browser.post("/api/scanner/stop");
    let snapshot = await browser.get("/api/scanner");
    expect(snapshot.body.items[0].pagesVisited).toBe(2);
    expect(
      snapshot.body.items[0].discordLinks.map((link: any) => link.url),
    ).toEqual(["https://discord.gg/DeepContact"]);
    await browser.post("/api/scanner/reset");

    await browser.patch("/api/settings").send({ maxPages: 2, maxDepth: 2 });
    await browser
      .post("/api/scanner/import-links")
      .send({ label: "Two pages", urls: ["https://23.0.0.1/deep-root"] });
    await browser.post("/api/scanner/start");
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      snapshot = await browser.get("/api/scanner");
      if (snapshot.body.items[0]?.scanStatus === "Completed") break;
    }
    await browser.post("/api/scanner/stop");
    snapshot = await browser.get("/api/scanner");
    expect(snapshot.body.items[0].pagesVisited).toBe(2);
    await browser.post("/api/scanner/reset");
  });

  it("checkpoints an active deep scan on stop and resumes remaining pages", async () => {
    await browser.patch("/api/settings").send({
      crawlerConcurrency: 1,
      robotsRespect: false,
      retries: 0,
      deepScan: true,
      maxPages: 3,
      maxDepth: 2,
    });
    await browser.post("/api/scanner/import-links").send({
      label: "Pause and resume",
      urls: ["https://23.0.0.1/deep-root"],
    });
    await browser.post("/api/scanner/start");
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      const snapshot = await browser.get("/api/scanner");
      if (snapshot.body.items[0]?.pagesVisited === 1) break;
    }
    expect((await browser.post("/api/scanner/stop")).body.status).toBe(
      "STOPPED",
    );
    let snapshot = await browser.get("/api/scanner");
    expect(snapshot.body.items[0].scanStatus).toBe("Pending");
    // A page already in flight can finish while the stop request is arriving.
    // It must be checkpointed rather than discarded, and at least one queued
    // page must remain for the resume assertion below.
    expect(snapshot.body.items[0].pagesVisited).toBeGreaterThanOrEqual(1);
    expect(snapshot.body.items[0].pagesVisited).toBeLessThan(3);
    await browser.post("/api/scanner/start");
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
      snapshot = await browser.get("/api/scanner");
      if (snapshot.body.items[0]?.scanStatus === "Completed") break;
    }
    await browser.post("/api/scanner/stop");
    snapshot = await browser.get("/api/scanner");
    expect(snapshot.body.items[0]).toMatchObject({
      scanStatus: "Completed",
      pagesVisited: 3,
    });
    const detail = await browser.get(
      `/api/scanner/results/${snapshot.body.items[0].id}`,
    );
    expect(detail.body.pages.map((page: any) => page.path)).toEqual([
      "/deep-root",
      "/contact",
      "/about",
    ]);
    await browser.post("/api/scanner/reset");
  });

  it("isolates a Scrapling worker failure and recovers through a fallback page", async () => {
    const crawler = await import("./crawler.js");
    vi.mocked(crawler.fetchPage).mockRejectedValueOnce(
      new Error("Scrapling worker unavailable"),
    );
    await browser.patch("/api/settings").send({
      crawlerConcurrency: 2,
      retries: 0,
      deepScan: false,
      robotsRespect: false,
    });
    await browser.post("/api/scanner/import-links").send({
      label: "Worker recovery",
      urls: ["https://24.0.0.1/", "https://24.0.0.2/"],
    });
    await browser.post("/api/scanner/start");
    let snapshot: any;
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
      snapshot = (await browser.get("/api/scanner")).body;
      if (
        snapshot.items.length === 2 &&
        snapshot.items.every((item: any) =>
          ["Completed", "CompletedWithFallback"].includes(item.scanStatus),
        )
      )
        break;
    }
    expect(snapshot.state.status).toBe("RUNNING");
    expect(snapshot.stats.failed).toBe(0);
    expect((await browser.post("/api/scanner/retry-failed")).body.queued).toBe(
      0,
    );
    // With concurrent workers either queued domain can consume the mocked
    // one-time failure, so assert the fallback outcome rather than a race.
    const recovered = snapshot.items.find((item: any) => item.fallbackUsed);
    expect(recovered).toMatchObject({
      scanStatus: "CompletedWithFallback",
      fallbackUsed: true,
    });
    expect(recovered.discordLinks).toHaveLength(1);
    expect(snapshot.items.map((item: any) => item.scanStatus).sort()).toEqual([
      "Completed",
      "CompletedWithFallback",
    ]);
    await browser.post("/api/scanner/stop");
    await browser.post("/api/scanner/reset");
  });

  it("retries transient failures with a conservative profile and leaves permanent blocks alone", async () => {
    await browser.patch("/api/settings").send({
      crawlerConcurrency: 32,
      timeoutSeconds: 10,
      retries: 1,
      deepScan: false,
      robotsRespect: true,
    });
    await browser.post("/api/scanner/import-links").send({
      label: "Selective recovery",
      urls: [
        "https://24.1.0.1/",
        "https://24.1.0.2/",
        "https://24.1.0.3/",
        "https://24.1.0.4/",
      ],
    });
    const imported = await prisma.scannerResult.findMany({
      where: { domain: { hostname: { startsWith: "24.1.0." } } },
      orderBy: { normalizedUrl: "asc" },
    });
    expect(imported).toHaveLength(4);
    await Promise.all([
      prisma.scannerResult.update({
        where: { id: imported[0].id },
        data: {
          scanStatus: "Timeout",
          discoveryFailureReason: "TIMEOUT",
          error: "Request timed out",
        },
      }),
      prisma.scannerResult.update({
        where: { id: imported[1].id },
        data: {
          scanStatus: "Failed",
          discoveryFailureReason: "HTTP_429",
          error: "Rate limited",
        },
      }),
      prisma.scannerResult.update({
        where: { id: imported[2].id },
        data: {
          scanStatus: "Blocked",
          discoveryFailureReason: "HTTP_403",
          error: "Access forbidden",
        },
      }),
      prisma.scannerResult.update({
        where: { id: imported[3].id },
        data: {
          scanStatus: "Blocked",
          discoveryFailureReason: "ROBOTS_RESTRICTED",
          error: "Robots policy disallows this URL",
        },
      }),
    ]);

    try {
      const response = await browser.post("/api/scanner/retry-failed");
      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({
        queued: 2,
        skippedPermanent: 2,
        recoveryProfile: {
          concurrency: 8,
          timeoutSeconds: 15,
          retries: 2,
        },
      });
      const permanent = await prisma.scannerResult.findMany({
        where: { id: { in: [imported[2].id, imported[3].id] } },
        orderBy: { normalizedUrl: "asc" },
      });
      expect(
        permanent.map((item: any) => [
          item.scanStatus,
          item.discoveryFailureReason,
        ]),
      ).toEqual([
        ["Blocked", "HTTP_403"],
        ["Blocked", "ROBOTS_RESTRICTED"],
      ]);
    } finally {
      await browser.post("/api/scanner/stop");
      await browser.post("/api/scanner/reset");
    }
  });

  it("removes a site after five contact failures while preserving downloadable failure history", async () => {
    await browser.patch("/api/settings").send({
      crawlerConcurrency: 1,
      retries: 0,
      deepScan: false,
      robotsRespect: false,
    });
    await browser.post("/api/scanner/import-links").send({
      label: "Contact-required completion",
      urls: ["https://25.0.0.1/"],
    });
    await browser.post("/api/scanner/start");
    let snapshot: any;
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
      snapshot = (await browser.get("/api/scanner")).body;
      if (snapshot.items[0]?.scanStatus === "Failed") break;
    }
    await browser.post("/api/scanner/stop");
    expect(snapshot.items[0]).toMatchObject({
      scanStatus: "Failed",
      error: "No Discord, Telegram, or email contact found",
      discoveryFailureReason: "CONTACT_NOT_FOUND",
      contactFailureCount: 1,
      discordLinks: [],
    });
    expect(snapshot.stats.failed).toBe(1);
    const scannerResultId = snapshot.items[0].id;
    for (
      let contactFailureCount = 2;
      contactFailureCount <= 5;
      contactFailureCount++
    ) {
      expect(
        (await browser.post("/api/scanner/retry-failed")).body.queued,
      ).toBe(1);
      for (let attempt = 0; attempt < 160; attempt++) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
        const current = await prisma.scannerResult.findUniqueOrThrow({
          where: { id: scannerResultId },
        });
        if (current.contactFailureCount === contactFailureCount) break;
      }
    }
    const quarantined = await prisma.scannerResult.findUniqueOrThrow({
      where: { id: scannerResultId },
    });
    expect(quarantined).toMatchObject({
      scanStatus: "Excluded",
      discoveryFailureReason: "CONTACT_FAILURE_LIMIT",
      contactFailureCount: 5,
    });
    expect(quarantined.quarantinedAt).toBeInstanceOf(Date);
    const activeSnapshot = (await browser.get("/api/scanner")).body;
    expect(
      activeSnapshot.items.some((item: any) => item.id === scannerResultId),
    ).toBe(false);
    expect((await browser.post("/api/scanner/retry-failed")).body.queued).toBe(
      0,
    );
    expect(
      (await browser.post(`/api/scanner/results/${scannerResultId}/rescan`))
        .status,
    ).toBe(409);
    expect(
      await prisma.scannerFailureHistory.count({
        where: { scannerResultId },
      }),
    ).toBe(5);
    const failureExport = await browser.get("/api/export/scanner-failures.csv");
    expect(failureExport.status).toBe(200);
    expect(failureExport.headers["content-disposition"]).toContain(
      "scanner-failure-history.csv",
    );
    expect(failureExport.text).toContain("https://25.0.0.1/");
    expect(failureExport.text).toContain("CONTACT_NOT_FOUND");
    await browser.post("/api/scanner/stop");
    await browser.post("/api/scanner/reset");
    expect(
      await prisma.scannerFailureHistory.count({
        where: { workspaceId: quarantined.workspaceId },
      }),
    ).toBeGreaterThanOrEqual(5);
    expect(
      (await browser.get("/api/export/scanner-failures.csv")).text,
    ).toContain("https://25.0.0.1/");
  });

  it("instantly syncs a Telegram-only discovery while deeper pages are still scanning", async () => {
    await browser.patch("/api/settings").send({
      crawlerConcurrency: 1,
      retries: 0,
      deepScan: true,
      maxPages: 2,
      maxDepth: 1,
      robotsRespect: false,
    });
    await browser.post("/api/scanner/import-links").send({
      label: "Telegram-only contact",
      urls: ["https://26.0.0.1/"],
    });
    await browser.post("/api/scanner/start");
    let lead: any;
    let statusAtSync = "";
    for (let attempt = 0; attempt < 80; attempt++) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      lead = (await browser.get("/api/leads")).body.find(
        (item: any) => item.domain.hostname === "26.0.0.1",
      );
      if (lead) {
        statusAtSync = (
          await browser.get("/api/scanner?pageSize=100")
        ).body.items.find(
          (item: any) => item.domain.hostname === "26.0.0.1",
        )?.scanStatus;
        break;
      }
    }
    expect(lead).toMatchObject({
      telegram: "https://t.me/TelegramOnly",
      discordInvite: "",
    });
    expect(statusAtSync).toBe("Scanning");
    let snapshot: any;
    for (let attempt = 0; attempt < 80; attempt++) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      snapshot = (await browser.get("/api/scanner?pageSize=100")).body;
      if (
        ["Completed", "CompletedWithFallback"].includes(
          snapshot.items.find(
            (item: any) => item.domain.hostname === "26.0.0.1",
          )?.scanStatus,
        )
      )
        break;
    }
    await browser.post("/api/scanner/stop");
    expect(snapshot.stats.leads).toBe(1);
    const exportResponse = await browser.get("/api/export/leads.csv");
    expect(exportResponse.text).toContain("https://t.me/TelegramOnly");
    await browser.post("/api/scanner/reset");
  });

  it("uses email as the fallback when Discord and Telegram are unavailable", async () => {
    await browser.patch("/api/settings").send({
      crawlerConcurrency: 1,
      retries: 0,
      deepScan: false,
      robotsRespect: false,
    });
    await browser.post("/api/scanner/import-links").send({
      label: "Email-only contact",
      urls: ["https://27.0.0.1/"],
    });
    await browser.post("/api/scanner/start");
    let snapshot: any;
    let lead: any;
    let scannerItem: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
      snapshot = (await browser.get("/api/scanner?pageSize=100")).body;
      scannerItem = snapshot.items.find(
        (item: any) => item.domain.hostname === "27.0.0.1",
      );
      lead = (await browser.get("/api/leads")).body.find(
        (item: any) => item.domain.hostname === "27.0.0.1",
      );
      if (
        lead &&
        ["Completed", "CompletedWithFallback"].includes(scannerItem?.scanStatus)
      )
        break;
    }
    await browser.post("/api/scanner/stop");
    const scannerDetail = (
      await browser.get(`/api/scanner/results/${scannerItem.id}`)
    ).body;
    expect(scannerDetail).toMatchObject({
      emails: ["email-only@example.test"],
      discordLinks: [],
    });
    expect(["Completed", "CompletedWithFallback"]).toContain(
      scannerItem.scanStatus,
    );
    expect(lead).toMatchObject({
      email: "email-only@example.test",
      discordInvite: "",
      telegram: "",
    });
    expect((await browser.get("/api/export/leads.csv")).text).toContain(
      "email-only@example.test",
    );
    expect(
      (await browser.get("/api/export/lead-discord-links.txt")).text,
    ).not.toContain("email-only@example.test");
    await browser.post("/api/scanner/reset");
  });

  it("clears every lead in the current workspace without clearing scanner results", async () => {
    await browser
      .post("/api/scanner/import-links")
      .send({ label: "Clear leads", urls: ["https://26.0.0.1/"] });
    await browser.post("/api/scanner/start");
    for (let attempt = 0; attempt < 80; attempt++) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      if ((await browser.get("/api/leads")).body.length) break;
    }
    await browser.post("/api/scanner/stop");
    const scannerCountBefore = (await browser.get("/api/scanner")).body.stats
      .websites;
    const cleared = await browser.delete("/api/leads");
    expect(cleared.status).toBe(200);
    expect(cleared.body.deleted).toBeGreaterThan(0);
    expect((await browser.get("/api/leads")).body).toEqual([]);
    expect((await browser.get("/api/scanner")).body.stats.websites).toBe(
      scannerCountBefore,
    );
    await browser.post("/api/scanner/reset");
    await browser.patch("/api/settings").send({ deepScan: false });
  });

  it("processes a controlled 100-URL queue without an artificial result limit", async () => {
    await browser.patch("/api/settings").send({
      crawlerConcurrency: 32,
      retries: 0,
      deepScan: false,
      robotsRespect: false,
    });
    const urls = Array.from(
      { length: 100 },
      (_, index) => `https://31.0.0.${index + 1}/contact`,
    );
    const imported = await browser
      .post("/api/scanner/import-links")
      .send({ label: "100 URL processing test", urls });
    expect(imported.body.created).toBe(100);
    await browser.post("/api/scanner/start");
    let snapshot: any;
    for (let attempt = 0; attempt < 400; attempt++) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      snapshot = (await browser.get("/api/scanner?pageSize=100")).body;
      if (
        snapshot.stats.scanned === 100 &&
        snapshot.items.every((item: any) => item.scanStatus === "Completed") &&
        snapshot.performance.totalCompleted === 100
      )
        break;
    }
    expect(snapshot.stats).toMatchObject({
      websites: 100,
      scanned: 100,
      pending: 0,
    });
    expect(snapshot.items).toHaveLength(100);
    expect(
      snapshot.items.every((item: any) => item.scanStatus === "Completed"),
    ).toBe(true);
    expect(snapshot.performance).toMatchObject({
      enabled: true,
      configuredConcurrency: 32,
      totalCompleted: 100,
      pressureEvents: 0,
      recent: { sampleSize: 100, successRate: 100 },
    });
    expect(snapshot.performance.currentConcurrency).toBeGreaterThan(8);
    expect(snapshot.performance.currentConcurrency).toBeLessThanOrEqual(32);
    expect(snapshot.performance.throughputPerMinute).toBeGreaterThan(0);
    expect(snapshot.performance.recent.medianDurationMs).toBeGreaterThan(0);
    await browser.post("/api/scanner/stop");
    await browser.post("/api/scanner/reset");
  });

  it("recovers an interrupted queue and resumes a running scanner after restart", async () => {
    await browser
      .post("/api/scanner/import-links")
      .send({ label: "Recovery check", urls: ["https://22.0.0.1/recover"] });
    const item = await prisma.scannerResult.findFirstOrThrow({
      where: { domain: { hostname: "22.0.0.1" } },
    });
    await prisma.scannerResult.update({
      where: { id: item.id },
      data: { scanStatus: "Scanning" },
    });
    await prisma.scannerState.updateMany({
      data: { status: "RUNNING", stopRequested: false },
    });
    const scanner = await import("./scanner.js");
    await scanner.bootstrapScanner();
    expect((await prisma.scannerState.findFirstOrThrow()).status).toBe(
      "RUNNING",
    );
    await browser.post("/api/scanner/stop");
    await browser.post("/api/scanner/reset");
  });

  it("keeps persisted Discord evidence successful when a later attempt timed out", async () => {
    await browser.post("/api/scanner/import-links").send({
      label: "Persisted Discord warning check",
      urls: ["https://24.0.0.1/warning"],
    });
    const item = await prisma.scannerResult.findFirstOrThrow({
      where: { domain: { hostname: "24.0.0.1" } },
    });
    await prisma.scannerDiscordLink.create({
      data: {
        scannerResultId: item.id,
        url: "https://discord.gg/PersistedInvite",
        inviteCode: "PersistedInvite",
        sourcePage: item.url,
      },
    });
    await prisma.scannerResult.update({
      where: { id: item.id },
      data: { scanStatus: "Timeout", error: "Response timeout" },
    });

    const scanner = await import("./scanner.js");
    await scanner.bootstrapScanner();

    expect(
      (
        await prisma.scannerResult.findUniqueOrThrow({
          where: { id: item.id },
        })
      ).scanStatus,
    ).toBe("CompletedWithWarnings");
    await browser.post("/api/scanner/reset");
  });

  it("reconciles alternate invite codes that resolve to the same Discord server", async () => {
    await browser.post("/api/scanner/import-links").send({
      label: "Discord identity check",
      urls: ["https://28.0.0.1/community", "https://29.0.0.1/community"],
    });
    const items = await prisma.scannerResult.findMany({
      where: { domain: { hostname: { in: ["28.0.0.1", "29.0.0.1"] } } },
      orderBy: { url: "asc" },
    });
    expect(items).toHaveLength(2);
    await prisma.scannerDiscordLink.createMany({
      data: [
        {
          scannerResultId: items[0].id,
          url: "https://discord.gg/FirstCode",
          inviteCode: "FirstCode",
          sourcePage: items[0].url,
        },
        {
          scannerResultId: items[1].id,
          url: "https://discord.gg/SecondCode",
          inviteCode: "SecondCode",
          sourcePage: items[1].url,
        },
      ],
    });
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            guild: { id: "123456789012345678", name: "Shared Guild" },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await browser.post(
        "/api/scanner/discord-links/reconcile",
      );
      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({
        started: true,
        progress: { status: "RUNNING" },
      });
      let reconciliation: any;
      for (let attempt = 0; attempt < 100; attempt++) {
        reconciliation = (
          await browser.get("/api/scanner/discord-links/reconcile")
        ).body;
        if (reconciliation?.status !== "RUNNING") break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      expect(reconciliation).toMatchObject({
        status: "COMPLETED",
        checked: 2,
        valid: 2,
        invites: 2,
        uniqueServers: 1,
        alternateInvites: 1,
      });
      const snapshot = await browser.get("/api/scanner");
      expect(snapshot.body.stats).toMatchObject({
        discord: 2,
        discordServers: 1,
        discordAlternateInvites: 1,
        discordUnresolved: 0,
      });
      expect(
        await prisma.scannerDiscordLink.count({
          where: { discordGuildId: "123456789012345678" },
        }),
      ).toBe(2);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
      await browser.post("/api/scanner/reset");
    }
  });

  it("reclassifies existing automatic non-business results without deleting history", async () => {
    const workspace = await prisma.workspace.findFirstOrThrow();
    const domain = await prisma.domain.create({
      data: { hostname: "leetcode.com" },
    });
    const session = await prisma.searchSession.create({
      data: {
        workspaceId: workspace.id,
        query: "Rust cheats",
        source: "google",
        clientId: "EXT-TESTA",
        pageUrl: "https://www.google.com/search?q=rust+cheats",
      },
    });
    const result = await prisma.scannerResult.create({
      data: {
        workspaceId: workspace.id,
        domainId: domain.id,
        url: "https://leetcode.com/discuss/rust",
        normalizedUrl: "https://leetcode.com/discuss/rust",
        title: "Best Rust Cheats - Ranked and Reviewed - Discuss",
      },
    });
    await prisma.scannerSource.create({
      data: {
        scannerResultId: result.id,
        searchSessionId: session.id,
        query: session.query,
        clientId: session.clientId,
        position: 1,
      },
    });
    await prisma.lead.create({
      data: {
        workspaceId: workspace.id,
        domainId: domain.id,
        scannerResultId: result.id,
        website: result.url,
      },
    });

    const scanner = await import("./scanner.js");
    await scanner.bootstrapScanner();

    expect(
      (
        await prisma.scannerResult.findUniqueOrThrow({
          where: { id: result.id },
        })
      ).scanStatus,
    ).toBe("Excluded");
    expect((await browser.get("/api/scanner?pageSize=100")).body.items).toEqual(
      [],
    );
    const unfiltered = (await browser.get("/api/scanner?pageSize=100")).body;
    const filtered = (
      await browser.get("/api/scanner?status=Excluded&pageSize=100")
    ).body;
    expect(filtered.items).toHaveLength(1);
    expect(filtered.stats).toEqual(unfiltered.stats);
    expect(
      (await browser.get("/api/leads")).body.some(
        (lead: any) => lead.domain.hostname === "leetcode.com",
      ),
    ).toBe(false);
  });

  it("clears a stale scanner error state after an application restart", async () => {
    const state = await prisma.scannerState.findFirstOrThrow();
    await prisma.scannerState.update({
      where: { id: state.id },
      data: { status: "ERROR", stopRequested: true },
    });

    const scanner = await import("./scanner.js");
    await scanner.bootstrapScanner();

    expect(
      await prisma.scannerState.findUniqueOrThrow({ where: { id: state.id } }),
    ).toMatchObject({
      status: "STOPPED",
      stopRequested: false,
      currentResultId: null,
    });
  });

  it("stores only one Rust price source per website across different paths", async () => {
    const workspace = await prisma.workspace.findFirstOrThrow();
    const imported = await browser.post("/api/rust-prices/import").send({
      urls: [
        "https://25.0.0.1/rust/accounts",
        "https://25.0.0.1/store/rust-nfa",
      ],
      productName: "Rust NFA accounts",
      productType: "RUST_NFA",
    });
    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({
      created: 1,
      duplicates: 1,
      rejected: 0,
    });
    await expect(
      prisma.rustPriceSource.count({
        where: { workspaceId: workspace.id, productKey: "rust-nfa-accounts" },
      }),
    ).resolves.toBe(1);

    await prisma.rustPriceSource.create({
      data: {
        workspaceId: workspace.id,
        productKey: "rust-nfa-accounts",
        productName: "Rust NFA accounts",
        productType: "RUST_NFA",
        url: "https://25.0.0.1/another/path",
        normalizedUrl: "https://25.0.0.1/another/path",
        domain: "25.0.0.1",
      },
    });
    expect((await browser.get("/api/rust-prices")).status).toBe(200);
    await expect(
      prisma.rustPriceSource.count({
        where: { workspaceId: workspace.id, productKey: "rust-nfa-accounts" },
      }),
    ).resolves.toBe(1);
  });

  it("filters and exports Rust NFA listings using only name, price, and link", async () => {
    const workspace = await prisma.workspace.findFirstOrThrow();
    const source = await prisma.rustPriceSource.create({
      data: {
        workspaceId: workspace.id,
        url: "https://market.example/rust-nfa",
        normalizedUrl: "https://market.example/rust-nfa",
        domain: "market.example",
      },
    });
    for (const [index, name, price] of [
      [1, "0-250 Hours", 120],
      [2, "Premium", 160],
      [3, "Premium, $100+ Inventory", 310],
      [4, "Inactive 15 Days", 260],
    ] as const) {
      await prisma.rustAccountListing.create({
        data: {
          workspaceId: workspace.id,
          sourceId: source.id,
          fingerprint: `nfa-fixture-${index}`,
          name,
          priceAmount: price,
          currency: "USD",
          priceText: `$${(price / 100).toFixed(2)}`,
          link: source.url,
          sourcePage: "",
          method: "VARIANT_CONTROL",
        },
      });
    }

    const filtered = await browser.get(
      "/api/rust-prices?search=Premium&minPrice=1.50&maxPrice=2.00&sort=price-asc",
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body.listings).toEqual([
      expect.objectContaining({
        name: "Premium",
        priceAmount: 160,
        priceText: "$1.60",
        link: source.url,
      }),
    ]);
    expect(Object.keys(filtered.body.listings[0]).sort()).toEqual(
      [
        "convertedPriceAmount",
        "currency",
        "id",
        "link",
        "name",
        "priceAmount",
        "priceText",
      ].sort(),
    );

    const converted = await browser.get(
      "/api/rust-prices?currency=DKK&sort=price-asc",
    );
    expect(converted.status).toBe(200);
    expect(converted.body.conversion.targetCurrency).toBe("DKK");
    expect(
      converted.body.listings.map(
        (listing: any) => listing.convertedPriceAmount,
      ),
    ).toEqual(
      [...converted.body.listings]
        .map((listing: any) => listing.convertedPriceAmount)
        .sort((a: number, b: number) => a - b),
    );
    expect(converted.body.marketStats.converted).toMatchObject({
      currency: "DKK",
      listings: 4,
    });

    const unsupportedCurrency = await browser.get(
      "/api/rust-prices?currency=GBP",
    );
    expect(unsupportedCurrency.status).toBe(400);

    const exported = await browser.get("/api/export/rust-prices.csv");
    expect(exported.status).toBe(200);
    expect(exported.text.split("\n")[0]).toBe("Name,Price,Link");
    expect(exported.text).not.toMatch(
      /seller|availability|region|accountType/i,
    );

    await prisma.rustPriceScanDiagnostic.create({
      data: {
        workspaceId: workspace.id,
        sourceId: source.id,
        status: "Completed",
        outcomeCode: "NO_LISTINGS_FOUND",
        pagesChecked: 1,
        listingsFound: 0,
        durationMs: 321,
        startedAt: new Date("2026-08-13T00:00:00.000Z"),
        completedAt: new Date("2026-08-13T00:00:00.321Z"),
        reportJson: JSON.stringify({
          version: 1,
          pages: [
            {
              requestedUrl: "https://market.example/rust-nfa?token=[REDACTED]",
              finalUrl: "https://market.example/rust-nfa",
              outcome: "NO_LISTINGS_ON_PAGE",
              httpStatus: 200,
              fetchMode: "Dynamic",
              staticFetchResult: "SUCCESS",
              dynamicFetchResult: "SUCCESS",
              durationMs: 300,
              listingsExtracted: 0,
              internalLinksFound: 4,
              priorityLinksQueued: 1,
              attempts: [{ attempt: 1, status: 200, durationMs: 300 }],
              redirects: [],
            },
          ],
        }),
      },
    });

    const debugJson = await browser.get("/api/export/rust-price-debug.json");
    expect(debugJson.status).toBe(200);
    expect(debugJson.headers["content-disposition"]).toContain(
      "rust-price-scan-debug.json",
    );
    expect(debugJson.body).toMatchObject({
      version: 1,
      totalScans: 1,
      scans: [
        expect.objectContaining({
          status: "Completed",
          outcomeCode: "NO_LISTINGS_FOUND",
          pagesChecked: 1,
          listingsFound: 0,
        }),
      ],
    });
    expect(debugJson.text).not.toContain("Bearer ");

    const debugCsv = await browser.get("/api/export/rust-price-debug.csv");
    expect(debugCsv.status).toBe(200);
    expect(debugCsv.text.split("\n")[0]).toContain("Scan Outcome");
    expect(debugCsv.text).toContain("NO_LISTINGS_ON_PAGE");
    expect(debugCsv.text).toContain("Dynamic");
  });
});
