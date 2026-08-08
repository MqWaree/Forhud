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
    const isRoot = url.endsWith("/deep-root");
    const isContact = url.endsWith("/contact") && url.includes("23.0.0.1");
    const isAbout = url.endsWith("/about") && url.includes("23.0.0.1");
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
      discordLinks: isRoot
        ? []
        : isContact
          ? ["https://discord.gg/DeepContact"]
          : isAbout
            ? ["https://discord.gg/DeepAbout"]
            : ["https://discord.gg/SharedInvite"],
      discordDetections: (isRoot
        ? []
        : isContact
          ? ["https://discord.gg/DeepContact"]
          : isAbout
            ? ["https://discord.gg/DeepAbout"]
            : ["https://discord.gg/SharedInvite"]
      ).map((value) => ({ url: value, method: "anchor" as const })),
      emails: isContact ? ["hello@example.test"] : [],
      socialLinks: isContact
        ? [{ type: "telegram", url: "https://t.me/example", sourcePage: url }]
        : [],
      internalLinks: isRoot
        ? ["https://23.0.0.1/contact"]
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
    expect(automaticLeads).toHaveLength(1);
    expect(automaticLeads[0]).toMatchObject({
      website: "https://12.0.0.1/contact",
      status: "New",
    });
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
    expect(snapshot.body.items[0]).toMatchObject({
      scanStatus: "Pending",
      pagesVisited: 1,
    });
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
    expect(snapshot.body.items[0].pages.map((page: any) => page.path)).toEqual([
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
    const recovered = snapshot.items.find(
      (item: any) => item.domain.hostname === "24.0.0.1",
    );
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

  it("processes a controlled 100-URL queue without an artificial result limit", async () => {
    await browser.patch("/api/settings").send({
      crawlerConcurrency: 5,
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
      configuredConcurrency: 5,
      currentConcurrency: 5,
      totalCompleted: 100,
      pressureEvents: 0,
      recent: { sampleSize: 100, successRate: 100 },
    });
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
    expect(
      (await browser.get("/api/scanner?status=Excluded&pageSize=100")).body
        .items,
    ).toHaveLength(1);
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
});
