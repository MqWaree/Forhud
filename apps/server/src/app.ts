import express from "express";
import cors from "cors";
import helmet from "helmet";
import dns from "node:dns/promises";
import { z } from "zod";
import {
  csvEscape,
  discordDestinationKind,
  extractDomain,
  importLinksSchema,
  importSearchSchema,
  leadPatchSchema,
  normalizeUrl,
  settingsSchema,
} from "@lead/shared";
import { prisma } from "./db.js";
import { assertPublicUrl } from "./security.js";
import { connect, emit } from "./events.js";
import {
  audit,
  clearSessionCookie,
  createSession,
  generateScannerId,
  hashPassword,
  isSecureScannerId,
  publicUser,
  requireAuth,
  requireRole,
  roles,
  SESSION_MAX_AGE_MS,
  type AuthRequest,
  verifyPassword,
} from "./auth.js";
import {
  cleanupExpiredRateLimits,
  clearRateLimit,
  rateLimitKey,
  recordRateLimitAttempt,
  retryAfterRateLimit,
} from "./rate-limit.js";
import {
  assertInitialSetupAuthorized,
  initialSetupProtection,
} from "./setup-security.js";
import {
  pairExtension,
  requireExtension,
  type ExtensionRequest,
} from "./extension-auth.js";
import {
  backupFilePath,
  createBackup,
  deleteBackup,
  importBackup,
  maintenanceMode,
  restoreBackup,
} from "./backups.js";
import {
  bootstrapScanner,
  resetScanner,
  scannerSnapshot,
  startScanner,
  stopScanner,
} from "./scanner.js";
import { scraperHealth } from "./scraper-client.js";
import {
  braveSearchConfigured,
  MAX_BRAVE_SEARCH_REQUESTS,
  MAX_SEARCH_TARGET_RESULTS,
  searchBrave,
} from "./brave-search.js";
import {
  defaultExcludedBusinessPlatformCount,
  isExcludedBusinessPlatform,
  isExcludedBusinessSearchResult,
} from "./business-filter.js";
import { syncScannerResultToLead } from "./lead-sync.js";

export { prisma } from "./db.js";
const defaults = {
  crawlerConcurrency: 8,
  adaptiveConcurrency: true,
  timeoutSeconds: 10,
  retries: 1,
  dynamicFallback: true,
  robotsRespect: true,
  deepScan: false,
  maxPages: 6,
  maxDepth: 2,
  defaultLeadStatus: "New",
  automaticBackups: true,
  backupFrequency: "DAILY",
  backupTime: "03:00",
  backupRetentionDaily: 7,
  backupRetentionWeekly: 4,
};
async function getSettings(workspaceId?: string) {
  const [rows, workspaceRows] = await Promise.all([
    prisma.setting.findMany(),
    workspaceId
      ? prisma.workspaceSetting.findMany({ where: { workspaceId } })
      : Promise.resolve([]),
  ]);
  return {
    ...defaults,
    ...Object.fromEntries(rows.map((r) => [r.id, JSON.parse(r.value)])),
    ...Object.fromEntries(
      workspaceRows.map((r) => [r.key, JSON.parse(r.value)]),
    ),
  };
}
const SECURITY_POLICY_MARKER = "security.password-policy-v2";
const SECURITY_POLICY_V3_MARKER = "security.scanner-id-v3";

export async function applySecurityPolicyV2() {
  if ((await prisma.user.count()) === 0) return;
  if (
    await prisma.setting.findUnique({ where: { id: SECURITY_POLICY_MARKER } })
  )
    return;
  const sessionCutoff = new Date(Date.now() + SESSION_MAX_AGE_MS);
  await prisma.$transaction(async (tx) => {
    if (await tx.setting.findUnique({ where: { id: SECURITY_POLICY_MARKER } }))
      return;
    await tx.user.updateMany({ data: { requirePasswordChange: true } });
    await tx.authSession.updateMany({
      where: { expiresAt: { gt: sessionCutoff } },
      data: { expiresAt: sessionCutoff },
    });
    await tx.setting.create({
      data: { id: SECURITY_POLICY_MARKER, value: JSON.stringify(true) },
    });
  });
}

export async function applySecurityPolicyV3() {
  const workspaces = await prisma.workspace.findMany({
    select: { id: true, scannerId: true },
  });
  const unsafeWorkspaces = workspaces.filter(
    (workspace) => !isSecureScannerId(workspace.scannerId),
  );
  if (
    unsafeWorkspaces.length === 0 &&
    (await prisma.setting.findUnique({
      where: { id: SECURITY_POLICY_V3_MARKER },
    }))
  )
    return;
  const used = new Set(workspaces.map((workspace) => workspace.scannerId));
  await prisma.$transaction(async (tx) => {
    for (const workspace of unsafeWorkspaces) {
      let scannerId = generateScannerId();
      while (used.has(scannerId)) scannerId = generateScannerId();
      used.add(scannerId);
      await tx.workspace.update({
        where: { id: workspace.id },
        data: { scannerId },
      });
      await tx.extensionInstance.updateMany({
        where: { workspaceId: workspace.id, revokedAt: null },
        data: { revokedAt: new Date(), scannerState: "STOPPED" },
      });
      await tx.auditLog.create({
        data: {
          workspaceId: workspace.id,
          action: "SCANNER_ID_HARDENED",
          targetType: "Workspace",
          targetId: workspace.id,
        },
      });
    }
    await tx.setting.upsert({
      where: { id: SECURITY_POLICY_V3_MARKER },
      update: { value: JSON.stringify(true) },
      create: { id: SECURITY_POLICY_V3_MARKER, value: JSON.stringify(true) },
    });
  });
}

export const scannerReady = bootstrapScanner().then(async () => {
  await applySecurityPolicyV2();
  await applySecurityPolicyV3();
  await cleanupExpiredRateLimits();
});
const app = express();
app.set("trust proxy", "loopback");
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(
  cors({
    origin(origin, callback) {
      const configured =
        process.env.PUBLIC_APP_ORIGIN || "http://localhost:5173";
      const allowed = new Set([
        configured,
        ...(process.env.NODE_ENV === "production"
          ? []
          : ["http://localhost:5173", "http://127.0.0.1:5173"]),
      ]);
      callback(null, !origin || allowed.has(origin));
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: "5mb" }));

app.get("/api/health", async (_req, res) => {
  try {
    await scannerReady;
    await prisma.$queryRaw`SELECT 1`;
    const scraper = await scraperHealth();
    res.json({
      ok: true,
      database: "connected",
      extension: "available",
      scraper,
      version: "1.4.0",
    });
  } catch (error) {
    console.error("Database health check failed", error);
    res.status(503).json({ ok: false, database: "disconnected" });
  }
});

const usernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
    "Username must start with a letter or number and use only letters, numbers, dots, dashes, or underscores",
  )
  .transform((value) => value.toLowerCase());
const accountSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(200),
});

const dummyPasswordHash = await hashPassword(
  "FGP timing-safe password verification placeholder",
);
let setupInProgress = false;

app.get("/api/auth/setup-status", async (_req, res) => {
  const protection = initialSetupProtection();
  res.json({
    required: (await prisma.user.count()) === 0,
    protected: protection.required,
    configured: protection.configured,
  });
});
app.post("/api/auth/setup", async (req, res, next) => {
  if (setupInProgress)
    return res
      .status(409)
      .json({ error: "Initial setup is already in progress" });
  setupInProgress = true;
  try {
    await scannerReady;
    if ((await prisma.user.count()) > 0)
      return res
        .status(409)
        .json({ error: "Initial setup is already complete" });
    const input = accountSchema
      .extend({ setupToken: z.string().trim().max(200).optional() })
      .parse(req.body);
    assertInitialSetupAuthorized(input.setupToken);
    let workspace = await prisma.workspace.findFirst({
      orderBy: { createdAt: "asc" },
    });
    if (!workspace) {
      let scannerId = generateScannerId();
      while (await prisma.workspace.findUnique({ where: { scannerId } }))
        scannerId = generateScannerId();
      workspace = await prisma.workspace.create({
        data: { name: `${input.username}'s Workspace`, scannerId },
      });
      await prisma.scannerState.create({
        data: { workspaceId: workspace.id },
      });
    }
    const user = await prisma.user.create({
      data: {
        workspaceId: workspace.id,
        name: input.username,
        username: input.username,
        passwordHash: await hashPassword(input.password),
        role: "ADMIN",
      },
      include: { workspace: true },
    });
    await prisma.auditLog.create({
      data: {
        workspaceId: workspace.id,
        actorId: user.id,
        action: "INITIAL_ADMIN_CREATED",
        targetType: "User",
        targetId: user.id,
        ipAddress: req.ip,
      },
    });
    await createSession(user.id, false, res);
    res.status(201).json(publicUser({ ...user, role: "ADMIN" }));
  } catch (error) {
    next(error);
  } finally {
    setupInProgress = false;
  }
});
app.post("/api/auth/login", async (req, res, next) => {
  try {
    const input = z
      .object({
        username: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^\S+$/, "Invalid username")
          .transform((v) => v.toLowerCase()),
        password: z.string().min(1).max(200),
        remember: z.boolean().default(false),
      })
      .parse(req.body);
    const ipKey = req.ip || req.socket.remoteAddress || "unknown";
    const accountKey = rateLimitKey("login-account", ipKey, input.username);
    const ipRateKey = rateLimitKey("login-ip", ipKey);
    const now = Date.now();
    const [accountRetry, ipRetry] = await Promise.all([
      retryAfterRateLimit(accountKey, 5, now),
      retryAfterRateLimit(ipRateKey, 25, now),
    ]);
    const blockedFor = Math.max(accountRetry, ipRetry);
    if (blockedFor) {
      res.set("Retry-After", String(blockedFor));
      return res
        .status(429)
        .json({ error: "Too many login attempts. Try again later." });
    }
    const user = await prisma.user.findUnique({
      where: { username: input.username },
      include: { workspace: true },
    });
    const passwordMatches = await verifyPassword(
      input.password,
      user?.passwordHash ?? dummyPasswordHash,
    );
    const valid = user?.status === "ACTIVE" && passwordMatches;
    if (!user || !valid) {
      await Promise.all([
        recordRateLimitAttempt(accountKey, now),
        recordRateLimitAttempt(ipRateKey, now),
      ]);
      return res.status(401).json({ error: "Invalid username or password." });
    }
    // A successful account login clears only that account bucket. Keep the
    // global IP spray counter until its window expires so one valid credential
    // cannot reset distributed username guessing from the same source.
    await clearRateLimit(accountKey);
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await createSession(user.id, input.remember, res);
    res.json(
      publicUser({ ...user, role: user.role as (typeof roles)[number] }),
    );
  } catch (error) {
    next(error);
  }
});
app.post("/api/auth/logout", requireAuth, async (req, res) => {
  await prisma.authSession.deleteMany({
    where: { id: (req as AuthRequest).sessionId },
  });
  clearSessionCookie(res);
  res.status(204).end();
});
app.get("/api/auth/me", requireAuth, (req, res) =>
  res.json(publicUser((req as AuthRequest).auth)),
);

app.post("/api/extension/pair", async (req, res, next) => {
  try {
    await scannerReady;
    const now = Date.now();
    const ipKey = req.ip || req.socket.remoteAddress || "unknown";
    const key = rateLimitKey("extension-pair", ipKey);
    const blockedFor = await retryAfterRateLimit(key, 10, now);
    if (blockedFor) {
      res.set("Retry-After", String(blockedFor));
      return res
        .status(429)
        .json({ error: "Too many pairing attempts. Try again later." });
    }
    await recordRateLimitAttempt(key, now);
    const input = z
      .object({
        scannerId: z.string().trim().min(4).max(32),
        instanceId: z.string().optional(),
        name: z.string().trim().max(100).optional(),
      })
      .parse(req.body);
    const paired = await pairExtension(input);
    await clearRateLimit(key);
    res.status(201).json(paired);
  } catch (error) {
    next(error);
  }
});
app.post(
  "/api/extension/heartbeat",
  requireExtension,
  async (req, res, next) => {
    try {
      const extension = (req as ExtensionRequest).extension;
      const input = z
        .object({
          scannerState: z.enum([
            "IDLE",
            "RUNNING",
            "STOPPING",
            "STOPPED",
            "ERROR",
          ]),
          currentSearch: z.string().max(300).default(""),
          currentPage: z.number().int().min(0).default(0),
          pagesScanned: z.number().int().min(0).default(0),
          resultsFound: z.number().int().min(0).default(0),
          uniqueUrlsSent: z.number().int().min(0).default(0),
          duplicatesSkipped: z.number().int().min(0).default(0),
        })
        .parse(req.body);
      const current = await prisma.extensionInstance.findUniqueOrThrow({
        where: { id: extension.id },
        select: { scannerState: true },
      });
      if (current.scannerState === "FORCE_STOPPED") {
        await prisma.extensionInstance.update({
          where: { id: extension.id },
          data: { lastSeen: new Date() },
        });
        return res.json({ ok: true, forceStop: true });
      }
      await prisma.extensionInstance.update({
        where: { id: extension.id },
        data: { ...input, lastSeen: new Date() },
      });
      res.json({ ok: true, forceStop: false });
    } catch (error) {
      next(error);
    }
  },
);

app.get("/api/events", requireAuth, (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  connect(res, (req as AuthRequest).auth.workspaceId);
});

type ImportPayload = {
  workspaceId: string;
  extensionInstanceId?: string;
  actorId?: string;
  searchQuery: string;
  source: string;
  clientId: string;
  pageUrl: string;
  capturedAt?: string;
  results: { title: string; url: string; position: number }[];
};

async function persistImport(body: ImportPayload) {
  const session = await prisma.searchSession.create({
    data: {
      workspaceId: body.workspaceId,
      extensionInstanceId: body.extensionInstanceId,
      query: body.searchQuery,
      source: body.source,
      clientId: body.clientId,
      pageUrl: body.pageUrl,
      createdAt: body.capturedAt ? new Date(body.capturedAt) : undefined,
    },
  });
  let imported = 0,
    created = 0,
    excluded = 0,
    leadsAdded = 0;
  const seen = new Set<string>();
  const acceptedDomains = new Set<string>();
  for (const item of body.results) {
    try {
      const normalized = normalizeUrl(item.url);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      const providerResult = ["brave", "google"].includes(
        body.source.toLowerCase(),
      );
      if (
        isExcludedBusinessPlatform(normalized) ||
        (providerResult &&
          isExcludedBusinessSearchResult({
            url: normalized,
            title: item.title,
          }))
      ) {
        excluded++;
        continue;
      }
      await assertPublicUrl(normalized);
      const hostname = extractDomain(normalized);
      const domain = await prisma.domain.upsert({
        where: { hostname },
        create: { hostname },
        update: { lastSeen: new Date() },
      });
      const archived = await prisma.searchResult.upsert({
        where: {
          searchSessionId_normalizedUrl: {
            searchSessionId: session.id,
            normalizedUrl: normalized,
          },
        },
        create: {
          searchSessionId: session.id,
          title: item.title,
          url: item.url,
          normalizedUrl: normalized,
          domainId: domain.id,
          position: item.position,
        },
        update: { title: item.title, position: item.position },
      });
      const existing = await prisma.scannerResult.findUnique({
        where: {
          workspaceId_domainId: {
            workspaceId: body.workspaceId,
            domainId: domain.id,
          },
        },
      });
      const workspace = await prisma.scannerResult.upsert({
        where: {
          workspaceId_domainId: {
            workspaceId: body.workspaceId,
            domainId: domain.id,
          },
        },
        create: {
          workspaceId: body.workspaceId,
          url: item.url,
          normalizedUrl: normalized,
          title: item.title,
          domainId: domain.id,
        },
        update: {
          title: item.title || undefined,
          url: item.url,
          lastSeen: new Date(),
        },
      });
      if (!existing) created++;
      await prisma.scannerSource.upsert({
        where: {
          scannerResultId_searchSessionId: {
            scannerResultId: workspace.id,
            searchSessionId: session.id,
          },
        },
        create: {
          scannerResultId: workspace.id,
          searchSessionId: session.id,
          query: body.searchQuery,
          clientId: body.clientId,
          position: item.position,
        },
        update: {
          position: item.position,
          query: body.searchQuery,
          clientId: body.clientId,
        },
      });
      const synced = await syncScannerResultToLead({
        workspaceId: body.workspaceId,
        scannerResultId: workspace.id,
        searchResultId: archived.id,
        actorId: body.actorId,
        sourceLabel: body.searchQuery,
      });
      if (synced.created) leadsAdded++;
      imported++;
      acceptedDomains.add(hostname);
    } catch {
      // Invalid, unresolvable, and non-public URLs are deliberately rejected.
    }
  }
  const state = await prisma.scannerState.findUniqueOrThrow({
    where: { workspaceId: body.workspaceId },
  });
  if (state.status === "COMPLETED" && created)
    await prisma.scannerState.update({
      where: { workspaceId: body.workspaceId },
      data: { status: "IDLE" },
    });
  emit(
    "import",
    {
      sessionId: session.id,
      count: imported,
      created,
      query: body.searchQuery,
      clientId: body.clientId,
      workspaceId: body.workspaceId,
      excluded,
      leadsAdded,
    },
    body.workspaceId,
  );
  return {
    sessionId: session.id,
    imported,
    created,
    duplicates: imported - created,
    excluded,
    leadsAdded,
    rejected: body.results.length - imported - excluded,
    acceptedDomains: [...acceptedDomains],
  };
}

app.post("/api/search/import", requireExtension, async (req, res, next) => {
  try {
    await scannerReady;
    const body = importSearchSchema.parse(req.body);
    const extension = (req as ExtensionRequest).extension;
    const result = await persistImport({
      ...body,
      workspaceId: extension.workspaceId,
      extensionInstanceId: extension.id,
      clientId: extension.instanceId,
    });
    await prisma.extensionInstance.update({
      where: { id: extension.id },
      data: {
        lastSeen: new Date(),
        currentSearch: body.searchQuery,
        scannerState: "RUNNING",
        pagesScanned: { increment: 1 },
        resultsFound: { increment: body.results.length },
        uniqueUrlsSent: { increment: result.created },
        duplicatesSkipped: { increment: result.duplicates },
      },
    });
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

app.post(
  "/api/extension/scanner/start",
  requireExtension,
  async (req, res, next) => {
    try {
      await scannerReady;
      const extension = (req as ExtensionRequest).extension;
      const settings = await getSettings(extension.workspaceId);
      await prisma.extensionInstance.update({
        where: { id: extension.id },
        data: { scannerState: "RUNNING", lastSeen: new Date() },
      });
      res.status(202).json(
        await startScanner(extension.workspaceId, {
          crawlerConcurrency: Number(settings.crawlerConcurrency),
          adaptiveConcurrency: Boolean(settings.adaptiveConcurrency),
          timeoutSeconds: Number(settings.timeoutSeconds),
          retries: Number(settings.retries),
          dynamicFallback: Boolean(settings.dynamicFallback),
          robotsRespect: Boolean(settings.robotsRespect),
          deepScan: Boolean(settings.deepScan),
          maxPages: Number(settings.maxPages),
          maxDepth: Number(settings.maxDepth),
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  "/api/extension/scanner/stop",
  requireExtension,
  async (req, res, next) => {
    try {
      const extension = (req as ExtensionRequest).extension;
      await prisma.extensionInstance.update({
        where: { id: extension.id },
        data: { scannerState: "STOPPED", lastSeen: new Date() },
      });
      res.json(await stopScanner(extension.workspaceId));
    } catch (error) {
      next(error);
    }
  },
);

app.use("/api", (req, res, next) => {
  if (maintenanceMode)
    return res.status(503).json({ error: "Maintenance in progress" });
  next();
});
app.use("/api", requireAuth);
app.use("/api", (req, res, next) => {
  const auth = (req as AuthRequest).auth;
  const allowed = new Set([
    "/auth/me",
    "/auth/logout",
    "/auth/change-password",
  ]);
  if (auth.requirePasswordChange && !allowed.has(req.path))
    return res.status(403).json({
      error: "You must change your temporary password before continuing",
      code: "PASSWORD_CHANGE_REQUIRED",
    });
  next();
});

app.post("/api/scanner/import-links", async (req, res, next) => {
  try {
    await scannerReady;
    const body = importLinksSchema.parse(req.body);
    const auth = (req as AuthRequest).auth;
    const result = await persistImport({
      workspaceId: auth.workspaceId,
      actorId: auth.id,
      searchQuery: body.label,
      source: "manual",
      clientId: auth.workspace.scannerId,
      pageUrl: "http://localhost/manual-link-import",
      capturedAt: new Date().toISOString(),
      results: body.urls.map((url, index) => ({
        title: extractDomain(url),
        url,
        position: index + 1,
      })),
    });
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

app.get("/api/search/brave/status", (_req, res) => {
  res.json({
    configured: braveSearchConfigured(),
    provider: "Brave Search",
    maxResults: MAX_SEARCH_TARGET_RESULTS,
    resultsPerRequest: 20,
    maxRequests: MAX_BRAVE_SEARCH_REQUESTS,
    businessFilter: true,
    defaultExcludedPlatforms: defaultExcludedBusinessPlatformCount,
  });
});

app.post("/api/search/brave", async (req, res, next) => {
  try {
    await scannerReady;
    const input = z
      .object({
        query: z.string().trim().min(2).max(300),
        maxResults: z
          .number()
          .int()
          .positive()
          .max(MAX_SEARCH_TARGET_RESULTS)
          .default(25),
      })
      .parse(req.body);
    const auth = (req as AuthRequest).auth;
    const discovery = await searchBrave(input.query, input.maxResults);
    const imported = await persistImport({
      workspaceId: auth.workspaceId,
      actorId: auth.id,
      searchQuery: input.query,
      source: "brave",
      clientId: auth.workspace.scannerId,
      pageUrl: `https://search.brave.com/search?q=${encodeURIComponent(input.query)}`,
      capturedAt: new Date().toISOString(),
      results: discovery.results,
    });
    const settings = await getSettings(auth.workspaceId);
    const scanner = await startScanner(auth.workspaceId, {
      crawlerConcurrency: Number(settings.crawlerConcurrency),
      adaptiveConcurrency: Boolean(settings.adaptiveConcurrency),
      timeoutSeconds: Number(settings.timeoutSeconds),
      retries: Number(settings.retries),
      dynamicFallback: Boolean(settings.dynamicFallback),
      robotsRespect: Boolean(settings.robotsRespect),
      deepScan: Boolean(settings.deepScan),
      maxPages: Number(settings.maxPages),
      maxDepth: Number(settings.maxDepth),
    });
    await audit(
      req,
      "BRAVE_SEARCH_STARTED",
      "SearchSession",
      imported.sessionId,
      {
        query: input.query,
        requestedResults: input.maxResults,
        discoveredResults: discovery.results.length,
        excludedPlatforms: discovery.excluded + imported.excluded,
        requests: discovery.requests,
      },
    );
    res.status(201).json({
      ...imported,
      requested: input.maxResults,
      discovered: discovery.results.length,
      excluded: discovery.excluded + imported.excluded,
      complete: discovery.results.length >= input.maxResults,
      requests: discovery.requests,
      scanner,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/scanner", async (req, res, next) => {
  try {
    await scannerReady;
    const page = Math.max(1, Number(req.query.page) || 1),
      pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize) || 50));
    res.json(
      await scannerSnapshot(
        (req as AuthRequest).auth.workspaceId,
        page,
        pageSize,
        String(req.query.search || ""),
        String(req.query.status || "All"),
      ),
    );
  } catch (e) {
    next(e);
  }
});
app.get("/api/clients", async (_req, res) => {
  const auth = (_req as AuthRequest).auth;
  res.json([auth.workspace.scannerId]);
});
app.post("/api/scanner/start", async (req, res, next) => {
  try {
    await scannerReady;
    const workspaceId = (req as AuthRequest).auth.workspaceId;
    const s = await getSettings(workspaceId);
    res.status(202).json(
      await startScanner(workspaceId, {
        crawlerConcurrency: Number(s.crawlerConcurrency),
        adaptiveConcurrency: Boolean(s.adaptiveConcurrency),
        timeoutSeconds: Number(s.timeoutSeconds),
        retries: Number(s.retries),
        dynamicFallback: Boolean(s.dynamicFallback),
        robotsRespect: Boolean(s.robotsRespect),
        deepScan: Boolean(s.deepScan),
        maxPages: Number(s.maxPages),
        maxDepth: Number(s.maxDepth),
      }),
    );
  } catch (e) {
    next(e);
  }
});
app.post("/api/scanner/stop", async (req, res, next) => {
  try {
    res.json(await stopScanner((req as AuthRequest).auth.workspaceId));
  } catch (e) {
    next(e);
  }
});
app.post(
  "/api/scanner/reset",
  requireRole("ADMIN", "MANAGER"),
  async (req, res, next) => {
    try {
      const auth = (req as AuthRequest).auth;
      await resetScanner(auth.workspaceId);
      await audit(req, "SCANNER_RESET", "Workspace", auth.workspaceId);
      res.json({ reset: true });
    } catch (e) {
      next(e);
    }
  },
);
app.post("/api/scanner/retry-failed", async (req, res, next) => {
  try {
    const updated = await prisma.scannerResult.updateMany({
      where: {
        workspaceId: (req as AuthRequest).auth.workspaceId,
        scanStatus: { in: ["Failed", "Timeout"] },
      },
      data: { scanStatus: "Pending", error: null },
    });
    res.json({ queued: updated.count });
  } catch (e) {
    next(e);
  }
});
app.post("/api/scanner/results/:id/rescan", async (req, res, next) => {
  try {
    const auth = (req as unknown as AuthRequest).auth;
    const item = await prisma.scannerResult.findFirst({
      where: {
        id: String(req.params.id),
        workspaceId: auth.workspaceId,
      },
    });
    if (!item) return res.status(404).json({ error: "Not found" });
    await prisma.scannerResult.update({
      where: { id: item.id },
      data: { scanStatus: "Pending", error: null },
    });
    res.status(202).json({ queued: 1 });
  } catch (e) {
    next(e);
  }
});
app.get("/api/export/scanner.csv", async (req, res) => {
  const items = await prisma.scannerResult.findMany({
    where: {
      workspaceId: (req as AuthRequest).auth.workspaceId,
      scanStatus: { not: "Excluded" },
    },
    include: {
      domain: { include: { location: true } },
      discordLinks: true,
      sources: true,
    },
  });
  const rows = [
    [
      "Website",
      "Domain",
      "Discord",
      "Hosting Country",
      "Status",
      "Scan Engine",
      "Fetch Mode",
      "Final URL",
      "Emails",
      "Social Links",
      "Pages Visited",
      "Source Searches",
      "First Seen",
      "Last Seen",
    ],
    ...items.map((x) => [
      x.url,
      x.domain.hostname,
      x.discordLinks.map((d) => d.url).join(" "),
      x.domain.location?.country || "",
      x.scanStatus,
      x.scanEngine,
      x.fetchMode,
      x.finalUrl,
      (() => {
        try {
          return (JSON.parse(x.emailsJson) as string[]).join(" ");
        } catch {
          return "";
        }
      })(),
      (() => {
        try {
          return (JSON.parse(x.socialLinksJson) as { url: string }[])
            .map((link) => link.url)
            .join(" ");
        } catch {
          return "";
        }
      })(),
      x.pagesVisited,
      x.sources.map((s) => s.query).join(" | "),
      x.firstSeen.toISOString(),
      x.lastSeen.toISOString(),
    ]),
  ];
  res
    .set({
      "content-type": "text/csv",
      "content-disposition": 'attachment; filename="scanner-workspace.csv"',
    })
    .send(rows.map((r) => r.map(csvEscape).join(",")).join("\n"));
});

app.post("/api/scanner/leads", async (req, res, next) => {
  try {
    const auth = (req as AuthRequest).auth;
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    const results = await prisma.scannerResult.findMany({
      where: { id: { in: ids }, workspaceId: auth.workspaceId },
      include: { discordLinks: true, sources: true },
    });
    let added = 0;
    for (const result of results) {
      let discoveredEmails: string[] = [];
      let discoveredSocials: { type: string; url: string }[] = [];
      try {
        discoveredEmails = JSON.parse(result.emailsJson);
      } catch {}
      try {
        discoveredSocials = JSON.parse(result.socialLinksJson);
      } catch {}
      const discoveredTelegram = discoveredSocials.find(
        (link) => link.type === "telegram",
      )?.url;
      const otherSocials = discoveredSocials
        .filter((link) => link.type !== "telegram")
        .map((link) => link.url)
        .join("\n");
      const existing = await prisma.lead.findUnique({
        where: {
          workspaceId_domainId: {
            workspaceId: auth.workspaceId,
            domainId: result.domainId,
          },
        },
      });
      await prisma.lead.upsert({
        where: {
          workspaceId_domainId: {
            workspaceId: auth.workspaceId,
            domainId: result.domainId,
          },
        },
        create: {
          workspaceId: auth.workspaceId,
          domainId: result.domainId,
          scannerResultId: result.id,
          status: "New",
          priority: "Medium",
          website: result.finalUrl || result.url,
          discordInvite:
            result.discordLinks.find(
              (link) => discordDestinationKind(link.url) === "invite",
            )?.url || "",
          email: discoveredEmails[0] || "",
          telegram: discoveredTelegram || "",
          otherContact: otherSocials,
          activities: {
            create: {
              actorId: auth.id,
              type: "created",
              description: `Lead added from scanner${result.sources[0]?.query ? ` · ${result.sources[0].query}` : ""}`,
            },
          },
        },
        update: {
          scannerResultId: result.id,
          website: existing?.website
            ? undefined
            : result.finalUrl || result.url,
          discordInvite: existing?.discordInvite
            ? undefined
            : result.discordLinks.find(
                (link) => discordDestinationKind(link.url) === "invite",
              )?.url || undefined,
          email: existing?.email ? undefined : discoveredEmails[0] || undefined,
          telegram: existing?.telegram ? undefined : discoveredTelegram,
          otherContact: existing?.otherContact
            ? undefined
            : otherSocials || undefined,
        },
      });
      if (!existing) added++;
    }
    emit("lead-update", { count: results.length }, auth.workspaceId);
    res.json({ processed: results.length, added });
  } catch (e) {
    next(e);
  }
});

app.get("/api/search/sessions", async (req, res) =>
  res.json(
    await prisma.searchSession.findMany({
      where: { workspaceId: (req as AuthRequest).auth.workspaceId },
      orderBy: { createdAt: "desc" },
      include: {
        results: {
          include: {
            discordLinks: true,
            domain: { include: { location: true } },
          },
        },
      },
    }),
  ),
);
app.get("/api/search/sessions/:id", async (req, res) => {
  const auth = (req as unknown as AuthRequest).auth;
  const item = await prisma.searchSession.findFirst({
    where: {
      id: String(req.params.id),
      workspaceId: auth.workspaceId,
    },
    include: {
      results: {
        include: {
          discordLinks: true,
          domain: { include: { location: true } },
        },
      },
    },
  });
  item ? res.json(item) : res.status(404).json({ error: "Not found" });
});

const leadInclude = {
  domain: { include: { location: true } },
  searchResult: { include: { discordLinks: true, searchSession: true } },
  scannerResult: { include: { discordLinks: true, sources: true } },
  assignedTo: { select: { id: true, username: true, role: true } },
  activities: {
    orderBy: { createdAt: "desc" as const },
    include: { actor: { select: { id: true, username: true } } },
  },
  tags: { include: { tag: true } },
};
app.get("/api/leads", async (req, res) => {
  const auth = (req as AuthRequest).auth;
  const tag = String(req.query.tag || "");
  res.json(
    await prisma.lead.findMany({
      where: {
        workspaceId: auth.workspaceId,
        OR: [
          { scannerResultId: null },
          { scannerResult: { scanStatus: { not: "Excluded" } } },
        ],
        ...(auth.role === "RESEARCHER" ? { assignedToId: auth.id } : {}),
        ...(tag ? { tags: { some: { tag: { name: tag } } } } : {}),
      },
      orderBy: { updatedAt: "desc" },
      include: leadInclude,
    }),
  );
});
app.get("/api/leads/:id", async (req, res) => {
  const auth = (req as unknown as AuthRequest).auth;
  const item = await prisma.lead.findFirst({
    where: {
      id: String(req.params.id),
      workspaceId: auth.workspaceId,
      ...(auth.role === "RESEARCHER" ? { assignedToId: auth.id } : {}),
    },
    include: leadInclude,
  });
  item ? res.json(item) : res.status(404).json({ error: "Not found" });
});
app.post("/api/leads", async (req, res, next) => {
  try {
    const auth = (req as AuthRequest).auth;
    const url = normalizeUrl(String(req.body.url));
    await assertPublicUrl(url);
    const hostname = extractDomain(url);
    const domain = await prisma.domain.upsert({
      where: { hostname },
      create: { hostname },
      update: {},
    });
    const lead = await prisma.lead.upsert({
      where: {
        workspaceId_domainId: {
          workspaceId: auth.workspaceId,
          domainId: domain.id,
        },
      },
      create: {
        workspaceId: auth.workspaceId,
        domainId: domain.id,
        website: url,
        status: "New",
        priority: "Medium",
        activities: {
          create: {
            actorId: auth.id,
            type: "created",
            description: "Lead added manually",
          },
        },
      },
      update: {},
    });
    res.status(201).json(lead);
  } catch (e) {
    next(e);
  }
});
app.patch("/api/leads/:id", async (req, res, next) => {
  try {
    const auth = (req as unknown as AuthRequest).auth;
    const parsed = leadPatchSchema.parse(req.body);
    const { tags, ...data } = parsed;
    const before = await prisma.lead.findFirst({
      where: {
        id: String(req.params.id),
        workspaceId: auth.workspaceId,
        ...(auth.role === "RESEARCHER" ? { assignedToId: auth.id } : {}),
      },
      include: { tags: { include: { tag: true } } },
    });
    if (!before) return res.status(404).json({ error: "Not found" });
    const lead = await prisma.lead.update({
      where: { id: String(req.params.id) },
      data,
    });
    const labels: Record<string, string> = {
      status: "Status",
      priority: "Priority",
      notes: "Notes",
      companyName: "Company name",
      contactName: "Contact name",
      email: "Email",
      discordUsername: "Discord username",
      telegram: "Telegram",
      otherContact: "Other contact",
      website: "Website",
      discordInvite: "Discord invite",
    };
    for (const [key, value] of Object.entries(data))
      if (value !== undefined && value !== (before as any)[key])
        await prisma.leadActivity.create({
          data: {
            leadId: lead.id,
            actorId: auth.id,
            type: key,
            description:
              key === "status" || key === "priority"
                ? `${labels[key]} changed: ${(before as any)[key]} → ${value}`
                : key === "notes"
                  ? "Notes updated"
                  : `${labels[key]} updated`,
          },
        });
    if (tags) {
      const cleaned = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
      const old = before.tags.map((x) => x.tag.name);
      for (const name of cleaned.filter((x) => !old.includes(x))) {
        const tag = await prisma.tag.upsert({
          where: {
            workspaceId_name: { workspaceId: auth.workspaceId, name },
          },
          create: { workspaceId: auth.workspaceId, name },
          update: {},
        });
        await prisma.leadTag.create({
          data: { leadId: lead.id, tagId: tag.id },
        });
        await prisma.leadActivity.create({
          data: {
            leadId: lead.id,
            actorId: auth.id,
            type: "tag",
            description: `Tag added: ${name}`,
          },
        });
      }
      for (const name of old.filter((x) => !cleaned.includes(x))) {
        const tag = await prisma.tag.findUnique({
          where: {
            workspaceId_name: { workspaceId: auth.workspaceId, name },
          },
        });
        if (tag)
          await prisma.leadTag.delete({
            where: { leadId_tagId: { leadId: lead.id, tagId: tag.id } },
          });
        await prisma.leadActivity.create({
          data: {
            leadId: lead.id,
            actorId: auth.id,
            type: "tag",
            description: `Tag removed: ${name}`,
          },
        });
      }
    }
    emit("lead-update", { id: lead.id }, auth.workspaceId);
    res.json(
      await prisma.lead.findUnique({
        where: { id: lead.id },
        include: leadInclude,
      }),
    );
  } catch (e) {
    next(e);
  }
});
app.delete(
  "/api/leads/:id",
  requireRole("ADMIN", "MANAGER"),
  async (req, res) => {
    await prisma.lead.deleteMany({
      where: {
        id: String(req.params.id),
        workspaceId: (req as AuthRequest).auth.workspaceId,
      },
    });
    res.status(204).end();
  },
);
app.post(
  "/api/leads/bulk",
  requireRole("ADMIN", "MANAGER"),
  async (req, res, next) => {
    try {
      const workspaceId = (req as AuthRequest).auth.workspaceId;
      const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
      if (req.body.action === "delete")
        await prisma.lead.deleteMany({
          where: { id: { in: ids }, workspaceId },
        });
      else {
        const { tags, ...data } = leadPatchSchema.parse(req.body.data);
        void tags;
        await prisma.lead.updateMany({
          where: { id: { in: ids }, workspaceId },
          data,
        });
      }
      res.json({ updated: ids.length });
    } catch (e) {
      next(e);
    }
  },
);
app.get(
  "/api/team/users",
  requireRole("ADMIN", "MANAGER"),
  async (req, res) => {
    const workspaceId = (req as AuthRequest).auth.workspaceId;
    const users = await prisma.user.findMany({
      where: { workspaceId, status: "ACTIVE" },
      orderBy: { username: "asc" },
      select: {
        id: true,
        username: true,
        role: true,
        _count: {
          select: {
            assignedLeads: {
              where: { status: { notIn: ["Won", "Lost", "Ignore"] } },
            },
          },
        },
      },
    });
    res.json(users);
  },
);
app.post(
  "/api/leads/bulk-assign",
  requireRole("ADMIN", "MANAGER"),
  async (req, res, next) => {
    try {
      const auth = (req as AuthRequest).auth;
      const input = z
        .object({
          ids: z.array(z.string()).min(1).max(5000),
          assignedToId: z.string().nullable(),
        })
        .parse(req.body);
      const assignee = input.assignedToId
        ? await prisma.user.findFirst({
            where: {
              id: input.assignedToId,
              workspaceId: auth.workspaceId,
              status: "ACTIVE",
            },
          })
        : null;
      if (input.assignedToId && !assignee)
        return res.status(400).json({ error: "Invalid assignee" });
      const leads = await prisma.lead.findMany({
        where: { id: { in: input.ids }, workspaceId: auth.workspaceId },
        select: { id: true, assignedToId: true },
      });
      await prisma.$transaction([
        prisma.lead.updateMany({
          where: {
            id: { in: leads.map((lead) => lead.id) },
            workspaceId: auth.workspaceId,
          },
          data: { assignedToId: assignee?.id || null },
        }),
        ...leads.map((lead) =>
          prisma.leadActivity.create({
            data: {
              leadId: lead.id,
              actorId: auth.id,
              previousAssigneeId: lead.assignedToId,
              newAssigneeId: assignee?.id,
              type: "assignment",
              description: assignee
                ? `Assigned to ${assignee.username} by ${auth.username}`
                : `Unassigned by ${auth.username}`,
            },
          }),
        ),
      ]);
      if (assignee && assignee.id !== auth.id)
        await prisma.notification.create({
          data: {
            workspaceId: auth.workspaceId,
            userId: assignee.id,
            type: "assignment",
            title: `${leads.length} lead${leads.length === 1 ? "" : "s"} assigned`,
            body: `${auth.username} assigned ${leads.length} lead${leads.length === 1 ? "" : "s"} to you.`,
          },
        });
      await audit(req, "LEADS_ASSIGNED", "Lead", undefined, {
        count: leads.length,
        assignedToId: assignee?.id || null,
      });
      emit("lead-update", { count: leads.length }, auth.workspaceId);
      res.json({ updated: leads.length });
    } catch (error) {
      next(error);
    }
  },
);
app.get("/api/notifications", async (req, res) => {
  const auth = (req as AuthRequest).auth;
  res.json(
    await prisma.notification.findMany({
      where: { userId: auth.id, workspaceId: auth.workspaceId },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  );
});
app.post("/api/notifications/read", async (req, res) => {
  const auth = (req as AuthRequest).auth;
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const result = await prisma.notification.updateMany({
    where: { id: { in: ids }, userId: auth.id },
    data: { readAt: new Date() },
  });
  res.json({ updated: result.count });
});
app.get("/api/tags", async (req, res) =>
  res.json(
    await prisma.tag.findMany({
      where: { workspaceId: (req as AuthRequest).auth.workspaceId },
      orderBy: { name: "asc" },
    }),
  ),
);

async function locateDomain(domainId: string, workspaceId: string) {
  const domain = await prisma.domain.findUniqueOrThrow({
    where: { id: domainId },
  });
  const addresses = await dns.lookup(domain.hostname, { all: true });
  const ip =
    addresses.find((a) => !a.address.includes(":"))?.address ??
    addresses[0]?.address;
  if (!ip) throw new Error("DNS lookup returned no address");
  await assertPublicUrl(`http://${domain.hostname}`);
  let data: any = {};
  try {
    const template = process.env.IP_GEOLOCATION_URL || "https://ipwho.is/{ip}";
    const r = await fetch(template.replace("{ip}", encodeURIComponent(ip)), {
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) data = await r.json();
  } catch {}
  const location = await prisma.hostingLocation.upsert({
    where: { domainId },
    create: {
      domainId,
      ipAddress: ip,
      country: data.country,
      countryCode: data.country_code,
      region: data.region,
      city: data.city,
      asn: data.connection?.asn ? String(data.connection.asn) : undefined,
      provider: data.connection?.isp || data.connection?.org,
      status: "Completed",
    },
    update: {
      ipAddress: ip,
      country: data.country,
      countryCode: data.country_code,
      region: data.region,
      city: data.city,
      asn: data.connection?.asn ? String(data.connection.asn) : undefined,
      provider: data.connection?.isp || data.connection?.org,
      status: "Completed",
      checkedAt: new Date(),
    },
  });
  const leads = await prisma.lead.findMany({
    where: { domainId, workspaceId },
  });
  for (const lead of leads)
    await prisma.leadActivity.create({
      data: {
        leadId: lead.id,
        type: "location",
        description: `Hosting location resolved${location.country ? `: ${location.country}` : ""}`,
      },
    });
  return location;
}
app.get("/api/location", async (req, res) =>
  res.json(
    await prisma.domain.findMany({
      where: {
        OR: [
          {
            scannerResults: {
              some: { workspaceId: (req as AuthRequest).auth.workspaceId },
            },
          },
          {
            leads: {
              some: { workspaceId: (req as AuthRequest).auth.workspaceId },
            },
          },
        ],
      },
      orderBy: { lastSeen: "desc" },
      include: { location: true },
    }),
  ),
);
app.post("/api/location/check", async (req, res, next) => {
  try {
    const workspaceId = (req as AuthRequest).auth.workspaceId;
    const visibleWhere = {
      OR: [
        { scannerResults: { some: { workspaceId } } },
        { leads: { some: { workspaceId } } },
      ],
    };
    const requested: Array<string> = req.body.domainIds?.length
      ? req.body.domainIds
      : (
          await prisma.domain.findMany({
            where: visibleWhere,
            select: { id: true },
          })
        ).map((x) => x.id);
    const ids = (
      await prisma.domain.findMany({
        where: { id: { in: requested }, ...visibleWhere },
        select: { id: true },
      })
    ).map((item) => item.id);
    const results = await Promise.allSettled(
      ids.map((id) => locateDomain(id, workspaceId)),
    );
    emit(
      "location-complete",
      {
        count: results.filter((x) => x.status === "fulfilled").length,
      },
      workspaceId,
    );
    res.json({
      checked: results.filter((x) => x.status === "fulfilled").length,
      failed: results.filter((x) => x.status === "rejected").length,
    });
  } catch (e) {
    next(e);
  }
});
app.patch("/api/auth/account", async (req, res, next) => {
  try {
    const auth = (req as AuthRequest).auth;
    const input = z.object({ username: usernameSchema }).parse(req.body);
    await prisma.user.update({
      where: { id: auth.id },
      data: { username: input.username, name: input.username },
    });
    res.json({
      ...publicUser(auth),
      username: input.username,
    });
  } catch (error) {
    next(error);
  }
});
app.post("/api/auth/change-password", async (req, res, next) => {
  try {
    const auth = (req as AuthRequest).auth;
    const input = z
      .object({
        currentPassword: z.string().min(1).max(200),
        newPassword: z.string().min(1).max(200),
        confirmPassword: z.string().min(1).max(200),
      })
      .refine((value) => value.newPassword === value.confirmPassword, {
        message: "New passwords do not match",
      })
      .parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: auth.id },
    });
    if (!(await verifyPassword(input.currentPassword, user.passwordHash)))
      return res.status(400).json({ error: "Current password is incorrect" });
    await prisma.$transaction([
      prisma.user.update({
        where: { id: auth.id },
        data: {
          passwordHash: await hashPassword(input.newPassword),
          requirePasswordChange: false,
        },
      }),
      prisma.authSession.deleteMany({
        where: { userId: auth.id, id: { not: (req as AuthRequest).sessionId } },
      }),
    ]);
    await audit(req, "PASSWORD_CHANGED", "User", auth.id);
    res.json({ changed: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/settings", requireRole("ADMIN"), async (req, res) =>
  res.json(await getSettings((req as AuthRequest).auth.workspaceId)),
);
app.patch("/api/settings", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const auth = (req as AuthRequest).auth;
    const data = settingsSchema.parse(req.body);
    await Promise.all(
      Object.entries(data).map(([id, value]) => {
        if (id === "automaticBackups" || id.startsWith("backup"))
          return prisma.setting.upsert({
            where: { id },
            create: { id, value: JSON.stringify(value) },
            update: { value: JSON.stringify(value) },
          });
        return prisma.workspaceSetting.upsert({
          where: {
            workspaceId_key: { workspaceId: auth.workspaceId, key: id },
          },
          create: {
            workspaceId: auth.workspaceId,
            key: id,
            value: JSON.stringify(value),
          },
          update: { value: JSON.stringify(value) },
        });
      }),
    );
    await audit(req, "SETTINGS_UPDATED", "Workspace", auth.workspaceId, {
      keys: Object.keys(data),
    });
    res.json(await getSettings(auth.workspaceId));
  } catch (e) {
    next(e);
  }
});
app.get("/api/export/leads.csv", async (req, res) => {
  const auth = (req as AuthRequest).auth;
  const leads = await prisma.lead.findMany({
    where: {
      workspaceId: auth.workspaceId,
      OR: [
        { scannerResultId: null },
        { scannerResult: { scanStatus: { not: "Excluded" } } },
      ],
      ...(auth.role === "RESEARCHER" ? { assignedToId: auth.id } : {}),
    },
    include: leadInclude,
  });
  const rows = [
    [
      "Website",
      "Domain",
      "Discord",
      "Company",
      "Contact",
      "Email",
      "Tags",
      "Hosting Country",
      "Search Query",
      "Status",
      "Priority",
      "Notes",
      "Added",
    ],
    ...leads.map((l) => [
      l.website || l.searchResult?.url || "",
      l.domain.hostname,
      l.discordInvite ||
        l.scannerResult?.discordLinks.map((d) => d.url).join(" ") ||
        "",
      l.companyName,
      l.contactName,
      l.email,
      l.tags.map((t) => t.tag.name).join(" | "),
      l.domain.location?.country || "",
      l.searchResult?.searchSession.query ||
        l.scannerResult?.sources[0]?.query ||
        "",
      l.status,
      l.priority,
      l.notes,
      l.createdAt.toISOString(),
    ]),
  ];
  res
    .set({
      "content-type": "text/csv",
      "content-disposition": 'attachment; filename="leads.csv"',
    })
    .send(rows.map((r) => r.map(csvEscape).join(",")).join("\n"));
});
app.get("/api/export/history.csv", async (req, res) => {
  const sessions = await prisma.searchSession.findMany({
    where: { workspaceId: (req as AuthRequest).auth.workspaceId },
    include: { results: { include: { discordLinks: true } } },
  });
  const rows = [
    ["Date", "Search Query", "URLs Found", "Discord Links", "Duration"],
    ...sessions.map((s) => [
      s.createdAt.toISOString(),
      s.query,
      s.results.length,
      s.results.reduce((n, r) => n + r.discordLinks.length, 0),
      s.completedAt
        ? String(s.completedAt.getTime() - s.createdAt.getTime())
        : "",
    ]),
  ];
  res
    .type("text/csv")
    .send(rows.map((r) => r.map(csvEscape).join(",")).join("\n"));
});

app.get("/api/workspace", async (req, res) => {
  const auth = (req as AuthRequest).auth;
  const [extensions, scanner] = await Promise.all([
    prisma.extensionInstance.count({
      where: {
        workspaceId: auth.workspaceId,
        revokedAt: null,
        lastSeen: { gte: new Date(Date.now() - 2 * 60 * 1000) },
      },
    }),
    prisma.scannerState.findUnique({
      where: { workspaceId: auth.workspaceId },
    }),
  ]);
  res.json({ ...auth.workspace, connectedExtensions: extensions, scanner });
});
app.post(
  "/api/workspace/regenerate-scanner-id",
  requireRole("ADMIN"),
  async (req, res, next) => {
    try {
      const auth = (req as AuthRequest).auth;
      const confirmation = z
        .object({ confirm: z.literal("REGENERATE") })
        .parse(req.body);
      void confirmation;
      let scannerId = generateScannerId();
      while (await prisma.workspace.findUnique({ where: { scannerId } }))
        scannerId = generateScannerId();
      const [workspace] = await prisma.$transaction([
        prisma.workspace.update({
          where: { id: auth.workspaceId },
          data: { scannerId },
        }),
        prisma.extensionInstance.updateMany({
          where: { workspaceId: auth.workspaceId, revokedAt: null },
          data: { revokedAt: new Date(), scannerState: "STOPPED" },
        }),
      ]);
      await audit(req, "SCANNER_ID_REGENERATED", "Workspace", auth.workspaceId);
      res.json({ scannerId: workspace.scannerId });
    } catch (error) {
      next(error);
    }
  },
);

app.get("/api/admin/overview", requireRole("ADMIN"), async (req, res) => {
  const workspaceId = (req as AuthRequest).auth.workspaceId;
  const [
    users,
    activeUsers,
    extensions,
    scannerResults,
    leads,
    scanner,
    backup,
  ] = await Promise.all([
    prisma.user.count({ where: { workspaceId } }),
    prisma.user.count({ where: { workspaceId, status: "ACTIVE" } }),
    prisma.extensionInstance.count({
      where: {
        workspaceId,
        revokedAt: null,
        lastSeen: { gte: new Date(Date.now() - 2 * 60 * 1000) },
      },
    }),
    prisma.scannerResult.count({ where: { workspaceId } }),
    prisma.lead.count({ where: { workspaceId } }),
    prisma.scannerState.findUnique({ where: { workspaceId } }),
    prisma.backupMetadata.findFirst({
      where: { status: "COMPLETED" },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  res.json({
    users,
    activeUsers,
    connectedExtensions: extensions,
    scannerResults,
    leads,
    scannersRunning: scanner?.status === "RUNNING" ? 1 : 0,
    lastBackup: backup?.createdAt || null,
  });
});
app.get("/api/admin/users", requireRole("ADMIN"), async (req, res) => {
  const workspaceId = (req as AuthRequest).auth.workspaceId;
  res.json(
    await prisma.user.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
        requirePasswordChange: true,
        lastLoginAt: true,
        createdAt: true,
        _count: { select: { assignedLeads: true, extensionInstances: true } },
      },
    }),
  );
});
app.post("/api/admin/users", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const auth = (req as AuthRequest).auth;
    const input = accountSchema
      .extend({
        role: z.enum(roles),
        requirePasswordChange: z.boolean().default(true),
      })
      .parse(req.body);
    const user = await prisma.user.create({
      data: {
        workspaceId: auth.workspaceId,
        name: input.username,
        username: input.username,
        passwordHash: await hashPassword(input.password),
        role: input.role,
        requirePasswordChange: input.requirePasswordChange,
      },
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
      },
    });
    await audit(req, "USER_CREATED", "User", user.id, { role: user.role });
    res.status(201).json(user);
  } catch (error) {
    next(error);
  }
});
app.patch(
  "/api/admin/users/:id",
  requireRole("ADMIN"),
  async (req, res, next) => {
    try {
      const auth = (req as AuthRequest).auth;
      const target = await prisma.user.findFirst({
        where: { id: String(req.params.id), workspaceId: auth.workspaceId },
      });
      if (!target) return res.status(404).json({ error: "Not found" });
      const input = z
        .object({
          username: usernameSchema.optional(),
          role: z.enum(roles).optional(),
          status: z.enum(["ACTIVE", "DISABLED"]).optional(),
          temporaryPassword: z
            .string()
            .min(1)
            .max(200)
            .optional(),
        })
        .parse(req.body);
      if (target.id === auth.id && input.status === "DISABLED")
        return res
          .status(400)
          .json({ error: "You cannot disable your own account" });
      const user = await prisma.user.update({
        where: { id: target.id },
        data: {
          ...(input.username
            ? { name: input.username, username: input.username }
            : {}),
          role: input.role,
          status: input.status,
          ...(input.temporaryPassword
            ? {
                passwordHash: await hashPassword(input.temporaryPassword),
                requirePasswordChange: true,
              }
            : {}),
        },
        select: {
          id: true,
          username: true,
          role: true,
          status: true,
        },
      });
      if (input.status === "DISABLED")
        await prisma.$transaction([
          prisma.authSession.deleteMany({ where: { userId: target.id } }),
          prisma.extensionInstance.updateMany({
            where: { ownerUserId: target.id, revokedAt: null },
            data: { revokedAt: new Date(), scannerState: "STOPPED" },
          }),
        ]);
      await audit(req, "USER_UPDATED", "User", target.id, {
        role: input.role,
        status: input.status,
        passwordReset: Boolean(input.temporaryPassword),
      });
      res.json(user);
    } catch (error) {
      next(error);
    }
  },
);

app.get("/api/admin/extensions", requireRole("ADMIN"), async (req, res) => {
  const workspaceId = (req as AuthRequest).auth.workspaceId;
  const extensions = await prisma.extensionInstance.findMany({
    where: { workspaceId },
    orderBy: { lastSeen: "desc" },
    select: {
      id: true,
      instanceId: true,
      name: true,
      scannerState: true,
      currentSearch: true,
      currentPage: true,
      pagesScanned: true,
      resultsFound: true,
      uniqueUrlsSent: true,
      duplicatesSkipped: true,
      lastSeen: true,
      revokedAt: true,
      createdAt: true,
      ownerUser: { select: { id: true, username: true } },
    },
  });
  res.json(
    extensions.map((extension) => ({
      ...extension,
      connected:
        !extension.revokedAt &&
        extension.lastSeen.getTime() >= Date.now() - 2 * 60 * 1000,
    })),
  );
});
app.patch(
  "/api/admin/extensions/:id",
  requireRole("ADMIN"),
  async (req, res, next) => {
    try {
      const auth = (req as AuthRequest).auth;
      const extension = await prisma.extensionInstance.findFirst({
        where: { id: String(req.params.id), workspaceId: auth.workspaceId },
      });
      if (!extension) return res.status(404).json({ error: "Not found" });
      const input = z
        .object({
          name: z.string().trim().min(1).max(100).optional(),
          revoke: z.boolean().optional(),
        })
        .parse(req.body);
      const updated = await prisma.extensionInstance.update({
        where: { id: extension.id },
        data: {
          name: input.name,
          ...(input.revoke
            ? { revokedAt: new Date(), scannerState: "STOPPED" }
            : {}),
        },
        select: {
          id: true,
          instanceId: true,
          name: true,
          scannerState: true,
          revokedAt: true,
        },
      });
      await audit(
        req,
        input.revoke ? "EXTENSION_REVOKED" : "EXTENSION_RENAMED",
        "ExtensionInstance",
        extension.id,
      );
      res.json(updated);
    } catch (error) {
      next(error);
    }
  },
);
app.post(
  "/api/admin/extensions/:id/force-stop",
  requireRole("ADMIN"),
  async (req, res) => {
    const auth = (req as AuthRequest).auth;
    const result = await prisma.extensionInstance.updateMany({
      where: { id: String(req.params.id), workspaceId: auth.workspaceId },
      data: { scannerState: "FORCE_STOPPED" },
    });
    if (!result.count) return res.status(404).json({ error: "Not found" });
    await audit(
      req,
      "SCANNER_FORCE_STOPPED",
      "ExtensionInstance",
      String(req.params.id),
    );
    res.json({ stopped: true });
  },
);
app.post(
  "/api/admin/scanners/stop-all",
  requireRole("ADMIN"),
  async (req, res, next) => {
    try {
      const auth = (req as AuthRequest).auth;
      await prisma.extensionInstance.updateMany({
        where: { workspaceId: auth.workspaceId, revokedAt: null },
        data: { scannerState: "FORCE_STOPPED" },
      });
      await stopScanner(auth.workspaceId);
      await audit(req, "ALL_SCANNERS_STOPPED", "Workspace", auth.workspaceId);
      res.json({ stopped: true });
    } catch (error) {
      next(error);
    }
  },
);
app.get("/api/admin/scanners", requireRole("ADMIN"), async (req, res) => {
  const workspaceId = (req as AuthRequest).auth.workspaceId;
  const [workspaceScanner, extensions] = await Promise.all([
    prisma.scannerState.findUnique({ where: { workspaceId } }),
    prisma.extensionInstance.findMany({
      where: { workspaceId, revokedAt: null },
      orderBy: { lastSeen: "desc" },
      select: {
        id: true,
        instanceId: true,
        name: true,
        scannerState: true,
        currentSearch: true,
        currentPage: true,
        pagesScanned: true,
        resultsFound: true,
        lastSeen: true,
      },
    }),
  ]);
  res.json({ workspaceScanner, extensions });
});
app.get("/api/admin/audit", requireRole("ADMIN"), async (req, res) => {
  res.json(
    await prisma.auditLog.findMany({
      where: { workspaceId: (req as AuthRequest).auth.workspaceId },
      orderBy: { createdAt: "desc" },
      take: 500,
      include: {
        actor: { select: { id: true, username: true } },
      },
    }),
  );
});

app.get("/api/admin/backups", requireRole("ADMIN"), async (_req, res) =>
  res.json(
    await prisma.backupMetadata.findMany({ orderBy: { createdAt: "desc" } }),
  ),
);
app.post("/api/admin/backups", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const auth = (req as AuthRequest).auth;
    const backup = await createBackup("MANUAL", auth.id);
    await audit(req, "BACKUP_CREATED", "BackupMetadata", backup.id);
    res.status(201).json(backup);
  } catch (error) {
    next(error);
  }
});
app.post(
  "/api/admin/backups/upload",
  requireRole("ADMIN"),
  express.raw({ type: "application/octet-stream", limit: "100mb" }),
  async (req, res, next) => {
    try {
      const auth = (req as AuthRequest).auth;
      if (!Buffer.isBuffer(req.body))
        return res
          .status(400)
          .json({ error: "A SQLite backup file is required" });
      const backup = await importBackup(req.body, auth.id);
      await audit(req, "BACKUP_UPLOADED", "BackupMetadata", backup.id);
      res.status(201).json(backup);
    } catch (error) {
      next(error);
    }
  },
);
app.get(
  "/api/admin/backups/:id/download",
  requireRole("ADMIN"),
  async (req, res) => {
    const backup = await prisma.backupMetadata.findUnique({
      where: { id: String(req.params.id) },
    });
    if (!backup) return res.status(404).json({ error: "Not found" });
    res.download(backupFilePath(backup.filename), backup.filename);
  },
);
app.delete("/api/admin/backups/:id", requireRole("ADMIN"), async (req, res) => {
  const backup = await prisma.backupMetadata.findUnique({
    where: { id: String(req.params.id) },
  });
  if (!backup) return res.status(404).json({ error: "Not found" });
  await deleteBackup(backup.filename);
  await prisma.backupMetadata.delete({ where: { id: backup.id } });
  await audit(req, "BACKUP_DELETED", "BackupMetadata", backup.id);
  res.status(204).end();
});
app.post(
  "/api/admin/backups/:id/restore",
  requireRole("ADMIN"),
  async (req, res, next) => {
    try {
      const auth = (req as AuthRequest).auth;
      z.object({ confirm: z.literal("RESTORE") }).parse(req.body);
      const backup = await prisma.backupMetadata.findUnique({
        where: { id: String(req.params.id) },
      });
      if (!backup) return res.status(404).json({ error: "Not found" });
      await stopScanner(auth.workspaceId);
      const result = await restoreBackup(backup.filename, auth.id);
      const [restoredActor, restoredWorkspace] = await Promise.all([
        prisma.user.findUnique({
          where: { id: auth.id },
          select: { id: true },
        }),
        prisma.workspace.findUnique({
          where: { id: auth.workspaceId },
          select: { id: true },
        }),
      ]);
      await prisma.auditLog.create({
        data: {
          workspaceId: restoredWorkspace?.id,
          actorId: restoredActor?.id,
          action: "BACKUP_RESTORED",
          targetType: "BackupMetadata",
          targetId: backup.id,
        },
      });
      clearSessionCookie(res);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);
app.use((_req, res) => {
  res.status(404).json({ error: "API route not found" });
});
app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const duplicateUsername =
      err?.code === "P2002" &&
      JSON.stringify(err?.meta?.target || "").includes("username");
    const status =
      err?.statusCode ??
      (err?.name === "ZodError" ? 400 : duplicateUsername ? 409 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({
      error: duplicateUsername
        ? "Username is already in use."
        : status >= 500 && process.env.NODE_ENV === "production"
          ? "Unexpected server error"
          : err instanceof Error
            ? err.message
            : "Unexpected server error",
    });
  },
);
export default app;
