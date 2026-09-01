import express from "express";
import cors from "cors";
import helmet from "helmet";
import dns from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  canonicalSiteKey,
  csvEscape,
  discordDestinationKind,
  extractDomain,
  importLinksSchema,
  importSearchSchema,
  leadPatchSchema,
  normalizeDiscordUrl,
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
  passwordStrengthIssue,
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
  recordRateLimitAttempts,
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
  scannerResultDetail,
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
  discoveryProgressPercent,
  getCurrentSearchProgress,
  setCurrentSearchProgress,
  type CurrentSearchProgress,
} from "./search-progress.js";
import {
  getDiscordReconciliationProgress,
  startWorkspaceDiscordInviteReconciliation,
} from "./discord-invite-reconciliation.js";
import {
  defaultExcludedBusinessPlatformCount,
  isExcludedBusinessPlatform,
  isExcludedBusinessSearchResult,
} from "./business-filter.js";
import {
  deleteRustPriceResults,
  resetRustPriceScanner,
  rustPriceDiagnosticExport,
  rustPriceSnapshot,
  startRustPriceScanner,
  stopRustPriceScanner,
} from "./rust-price-scanner.js";
import {
  marketProduct,
  marketProductTypes,
  type MarketProduct,
  type MarketProductType,
} from "./market-products.js";
import {
  lztTrackerSnapshot,
  recalculateLztAverage,
  queueLztHighHoursTestAlert,
  retryLatestFailedHazeTestAlert,
  restartLztTracker,
  startLztTracker,
  stopLztTracker,
  testLztConnection,
} from "./lzt-tracker.js";
import { LztApiError } from "./lzt-client.js";
import { queueHazeManualMessage } from "./haze-notifier.js";
import { syncScannerResultToLead } from "./lead-sync.js";
import {
  ensureWorkspaceRanks,
  publicRanksForUser,
  rankPermissions,
  requireRankPermission,
  workspaceMemberDirectory,
} from "./ranks.js";

export { prisma } from "./db.js";
const defaults = {
  crawlerConcurrency: 32,
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
const newPasswordSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !passwordStrengthIssue(value), {
    message: "Choose a less predictable password",
  });
const accountSchema = z.object({
  username: usernameSchema,
  password: newPasswordSchema,
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
    await ensureWorkspaceRanks(user.workspaceId);
    res.status(201).json(
      publicUser({
        ...user,
        role: "ADMIN",
        ranks: await publicRanksForUser(user.id),
      }),
    );
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
      await recordRateLimitAttempts([accountKey, ipRateKey], now);
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
    await ensureWorkspaceRanks(user.workspaceId);
    res.json(
      publicUser({
        ...user,
        role: user.role as (typeof roles)[number],
        ranks: await publicRanksForUser(user.id),
      }),
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
app.get("/api/auth/me", requireAuth, async (req, res, next) => {
  try {
    const auth = (req as AuthRequest).auth;
    await ensureWorkspaceRanks(auth.workspaceId);
    res.json(publicUser({ ...auth, ranks: await publicRanksForUser(auth.id) }));
  } catch (error) {
    next(error);
  }
});

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
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const auth = (req as AuthRequest).auth;
  connect(res, auth.workspaceId, auth.id);
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

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
) {
  const output = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      async () => {
        while (cursor < items.length) {
          const index = cursor++;
          output[index] = await task(items[index]!);
        }
      },
    ),
  );
  return output;
}

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
    intakeDuplicates = 0,
    excluded = 0,
    rejected = 0;
  const leadsAdded = 0;
  const seen = new Set<string>();
  const seenDomains = new Set<string>();
  const acceptedDomains = new Set<string>();
  const candidates: Array<{
    title: string;
    url: string;
    normalized: string;
    hostname: string;
    position: number;
  }> = [];
  for (const item of body.results) {
    try {
      const normalized = normalizeUrl(item.url);
      if (seen.has(normalized)) {
        intakeDuplicates++;
        continue;
      }
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
      const hostname = extractDomain(normalized);
      if (seenDomains.has(hostname)) {
        intakeDuplicates++;
        continue;
      }
      seenDomains.add(hostname);
      candidates.push({
        title: item.title,
        url: item.url,
        normalized,
        hostname,
        position: item.position,
      });
    } catch {
      rejected++;
    }
  }

  const validated = (
    await mapWithConcurrency(candidates, 16, async (candidate) => {
      try {
        await assertPublicUrl(candidate.normalized);
        return candidate;
      } catch {
        rejected++;
        return undefined;
      }
    })
  ).filter((candidate): candidate is NonNullable<typeof candidate> =>
    Boolean(candidate),
  );

  const domainPairs = await mapWithConcurrency(validated, 6, async (item) => {
    try {
      const domain = await prisma.domain.upsert({
        where: { hostname: item.hostname },
        create: { hostname: item.hostname },
        update: { lastSeen: new Date() },
      });
      return { item, domain };
    } catch {
      rejected++;
      return undefined;
    }
  });
  const ready = domainPairs.filter((pair): pair is NonNullable<typeof pair> =>
    Boolean(pair),
  );
  const domainIds = ready.map((pair) => pair.domain.id);
  const [existingScannerRows, existingLeadRows] = await Promise.all([
    prisma.scannerResult.findMany({
      where: { workspaceId: body.workspaceId, domainId: { in: domainIds } },
      select: { domainId: true },
    }),
    prisma.lead.findMany({
      where: { workspaceId: body.workspaceId, domainId: { in: domainIds } },
      select: {
        domainId: true,
        website: true,
        companyName: true,
        searchResultId: true,
      },
    }),
  ]);
  const existingScanners = new Set(
    existingScannerRows.map((row) => row.domainId),
  );
  const existingLeads = new Map(
    existingLeadRows.map((row) => [row.domainId, row]),
  );

  await mapWithConcurrency(ready, 4, async ({ item, domain }) => {
    try {
      const archived = await prisma.searchResult.upsert({
        where: {
          searchSessionId_normalizedUrl: {
            searchSessionId: session.id,
            normalizedUrl: item.normalized,
          },
        },
        create: {
          searchSessionId: session.id,
          title: item.title,
          url: item.url,
          normalizedUrl: item.normalized,
          domainId: domain.id,
          position: item.position,
        },
        update: { title: item.title, position: item.position },
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
          normalizedUrl: item.normalized,
          title: item.title,
          domainId: domain.id,
        },
        update: {
          title: item.title || undefined,
          url: item.url,
          lastSeen: new Date(),
        },
      });
      const scannerWasPresent = existingScanners.has(domain.id);
      if (!scannerWasPresent) created++;
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
      const existingLead = existingLeads.get(domain.id);
      if (existingLead)
        await prisma.lead.update({
          where: {
            workspaceId_domainId: {
              workspaceId: body.workspaceId,
              domainId: domain.id,
            },
          },
          data: {
            scannerResultId: workspace.id,
            searchResultId: existingLead.searchResultId
              ? undefined
              : archived.id,
            website: existingLead.website ? undefined : workspace.url,
            companyName: existingLead.companyName
              ? undefined
              : workspace.title || undefined,
          },
        });
      imported++;
      acceptedDomains.add(item.hostname);
    } catch {
      // Invalid, unresolvable, and non-public URLs are deliberately rejected.
      rejected++;
    }
  });
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
    duplicates: intakeDuplicates + imported - created,
    excluded,
    leadsAdded,
    rejected,
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

app.get("/api/search/brave/current", async (req, res, next) => {
  try {
    const workspaceId = (req as AuthRequest).auth.workspaceId;
    res.json({ current: await getCurrentSearchProgress(workspaceId) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/search/brave", async (req, res, next) => {
  let progressContext:
    { workspaceId: string; progress: CurrentSearchProgress } | undefined;
  const publishProgress = (
    context: NonNullable<typeof progressContext>,
    patch: Partial<CurrentSearchProgress>,
  ) => {
    const progress: CurrentSearchProgress = {
      ...context.progress,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    context.progress = progress;
    void setCurrentSearchProgress(context.workspaceId, progress);
    emit("brave-search-progress", progress, context.workspaceId);
    return progress;
  };
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
        operationId: z.string().uuid().optional(),
      })
      .parse(req.body);
    const auth = (req as AuthRequest).auth;
    const now = new Date().toISOString();
    progressContext = {
      workspaceId: auth.workspaceId,
      progress: {
        operationId: input.operationId || randomUUID(),
        query: input.query,
        status: "RUNNING",
        phase: "Starting web discovery",
        requested: input.maxResults,
        discovered: 0,
        queued: 0,
        duplicates: 0,
        rejected: 0,
        excluded: 0,
        leadsAdded: 0,
        requests: 0,
        failedRequests: 0,
        queryPagesChecked: 0,
        totalVariants: 0,
        activeVariants: 0,
        progressPercent: 2,
        startedAt: now,
        updatedAt: now,
      },
    };
    publishProgress(progressContext, {});
    const discovery = await searchBrave(input.query, input.maxResults, {
      onProgress: (progress) => {
        if (!progressContext) return;
        publishProgress(progressContext, {
          status: "RUNNING",
          phase: "Discovering unique business websites",
          ...progress,
          progressPercent: discoveryProgressPercent({
            ...progress,
            maxRequests: MAX_BRAVE_SEARCH_REQUESTS,
          }),
        });
      },
    });
    publishProgress(progressContext, {
      status: "RUNNING",
      phase: "Queuing discovered websites for scanning",
      requested: input.maxResults,
      discovered: discovery.results.length,
      excluded: discovery.excluded,
      requests: discovery.requests,
      failedRequests: discovery.failedRequests,
      progressPercent: 94,
    });
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
        failedRequests: discovery.failedRequests,
      },
    );
    await setCurrentSearchProgress(
      auth.workspaceId,
      publishProgress(progressContext, {
        status: "COMPLETED",
        phase:
          discovery.results.length >= input.maxResults
            ? "Target reached and websites queued"
            : "Provider search space exhausted",
        requested: input.maxResults,
        discovered: discovery.results.length,
        queued: imported.created,
        duplicates: imported.duplicates,
        rejected: imported.rejected,
        excluded: discovery.excluded + imported.excluded,
        leadsAdded: imported.leadsAdded,
        requests: discovery.requests,
        failedRequests: discovery.failedRequests,
        progressPercent: 100,
        stopReason: discovery.stopReason,
      }),
    );
    res.status(201).json({
      ...imported,
      requested: input.maxResults,
      discovered: discovery.results.length,
      excluded: discovery.excluded + imported.excluded,
      complete: discovery.results.length >= input.maxResults,
      requests: discovery.requests,
      failedRequests: discovery.failedRequests,
      stopReason: discovery.stopReason,
      scanner,
    });
  } catch (error) {
    if (progressContext)
      await setCurrentSearchProgress(
        progressContext.workspaceId,
        publishProgress(progressContext, {
          status: "FAILED",
          phase: error instanceof Error ? error.message : "Search failed",
        }),
      );
    next(error);
  }
});

const marketProductSchema = z.object({
  productName: z.string().trim().min(2).max(120).default("Rust NFA accounts"),
  productType: z.enum(marketProductTypes).default("RUST_NFA"),
});

function parsedMarketProduct(value: unknown): MarketProduct {
  const parsed = marketProductSchema.parse(value);
  return marketProduct(
    parsed.productName,
    parsed.productType as MarketProductType,
  );
}

const rustPriceImportSchema = marketProductSchema.extend({
  urls: z.array(z.string().trim().min(1)).min(1).max(2_000),
});

const rustPriceSourceConsolidations = new Map<string, Promise<number>>();

async function runRustPriceSourceConsolidation(
  workspaceId: string,
  productKey: string,
) {
  let removed = 0;
  const existingSources = await prisma.rustPriceSource.findMany({
    where: { workspaceId, productKey },
    include: { _count: { select: { listings: true } } },
    orderBy: { createdAt: "asc" },
  });
  const groupedExisting = new Map<string, typeof existingSources>();
  for (const source of existingSources) {
    const key = canonicalSiteKey(source.normalizedUrl);
    const group = groupedExisting.get(key) ?? [];
    group.push(source);
    groupedExisting.set(key, group);
  }
  // Keep the source with the most retained evidence, then prefer a root URL.
  // Listings and diagnostic history are moved before the duplicate is removed.
  for (const group of groupedExisting.values()) {
    if (group.length < 2) continue;
    const ranked = [...group].sort(
      (a, b) =>
        b._count.listings - a._count.listings ||
        new URL(a.normalizedUrl).pathname.length -
          new URL(b.normalizedUrl).pathname.length ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
    const keeper = ranked[0]!;
    for (const duplicate of ranked.slice(1)) {
      await prisma.$transaction([
        prisma.rustAccountListing.updateMany({
          where: { sourceId: duplicate.id },
          data: { sourceId: keeper.id },
        }),
        prisma.rustPriceScanDiagnostic.updateMany({
          where: { sourceId: duplicate.id },
          data: { sourceId: keeper.id },
        }),
        prisma.rustPriceSource.delete({ where: { id: duplicate.id } }),
      ]);
      removed++;
    }
  }
  return removed;
}

async function consolidateRustPriceSources(
  workspaceId: string,
  productKey: string,
) {
  const key = `${workspaceId}:${productKey}`;
  const running = rustPriceSourceConsolidations.get(key);
  if (running) return running;
  const task = runRustPriceSourceConsolidation(workspaceId, productKey);
  rustPriceSourceConsolidations.set(key, task);
  try {
    return await task;
  } finally {
    rustPriceSourceConsolidations.delete(key);
  }
}

async function importRustPriceSources(
  workspaceId: string,
  urls: string[],
  product: MarketProduct,
) {
  let created = 0;
  let duplicates = 0;
  let rejected = 0;

  duplicates += await consolidateRustPriceSources(workspaceId, product.key);

  type Candidate = {
    input: string;
    normalized: string;
    domain: string;
    siteKey: string;
  };
  const validateOne = async (input: string): Promise<Candidate | undefined> => {
    try {
      const approved = await assertPublicUrl(input);
      const normalized = normalizeUrl(approved.toString());
      return {
        input: approved.toString(),
        normalized,
        domain: extractDomain(normalized),
        siteKey: canonicalSiteKey(normalized),
      };
    } catch {
      rejected++;
      return undefined;
    }
  };
  const validated: Candidate[] = [];
  const validationConcurrency = 12;
  for (let offset = 0; offset < urls.length; offset += validationConcurrency) {
    const batch = await Promise.all(
      urls.slice(offset, offset + validationConcurrency).map(validateOne),
    );
    validated.push(
      ...batch.filter((candidate): candidate is Candidate =>
        Boolean(candidate),
      ),
    );
  }

  const uniqueCandidates = new Map<string, Candidate>();
  for (const candidate of validated) {
    const current = uniqueCandidates.get(candidate.siteKey);
    if (!current) uniqueCandidates.set(candidate.siteKey, candidate);
    else {
      duplicates++;
      // Prefer a root/shorter path because the scanner discovers priority
      // product pages from there and can recover from stale search-result URLs.
      if (
        new URL(candidate.normalized).pathname.length <
        new URL(current.normalized).pathname.length
      )
        uniqueCandidates.set(candidate.siteKey, candidate);
    }
  }

  const refreshedExisting = await prisma.rustPriceSource.findMany({
    where: { workspaceId, productKey: product.key },
  });
  const existingBySite = new Map(
    refreshedExisting.map((source) => [
      canonicalSiteKey(source.normalizedUrl),
      source,
    ]),
  );
  for (const candidate of uniqueCandidates.values()) {
    const existing = existingBySite.get(candidate.siteKey);
    if (existing) {
      duplicates++;
      const replaceUrl =
        ["Failed", "Blocked", "Timeout"].includes(existing.scanStatus) ||
        new URL(candidate.normalized).pathname.length <
          new URL(existing.normalizedUrl).pathname.length;
      await prisma.rustPriceSource.update({
        where: { id: existing.id },
        data: {
          scanStatus: "Pending",
          error: null,
          ...(replaceUrl
            ? {
                url: candidate.input,
                normalizedUrl: candidate.normalized,
                domain: candidate.domain,
              }
            : {}),
        },
      });
      continue;
    }
    const source = await prisma.rustPriceSource.create({
      data: {
        workspaceId,
        productKey: product.key,
        productName: product.name,
        productType: product.type,
        url: candidate.input,
        normalizedUrl: candidate.normalized,
        domain: candidate.domain,
        scanStatus: "Pending",
      },
    });
    existingBySite.set(candidate.siteKey, source);
    created++;
  }
  return { imported: urls.length, created, duplicates, rejected };
}

app.get("/api/rust-prices", async (req, res, next) => {
  try {
    const product = parsedMarketProduct({
      productName: req.query.productName || "Rust NFA accounts",
      productType: req.query.productType || "RUST_NFA",
    });
    await consolidateRustPriceSources(
      (req as unknown as AuthRequest).auth.workspaceId,
      product.key,
    );
    const supportedCurrencies = ["DKK", "EUR", "USD", "RUB"] as const;
    const requestedCurrency = String(req.query.currency || "USD").toUpperCase();
    if (
      !supportedCurrencies.includes(
        requestedCurrency as (typeof supportedCurrencies)[number],
      )
    )
      return res
        .status(400)
        .json({ error: "Currency must be DKK, EUR, USD, or RUB" });
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(
      100,
      Math.max(10, Number(req.query.pageSize) || 50),
    );
    const optionalMoney = (value: unknown) => {
      if (value === undefined || value === "") return undefined;
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount < 0) return Number.NaN;
      return Math.round(amount * 100);
    };
    const minPrice = optionalMoney(req.query.minPrice);
    const maxPrice = optionalMoney(req.query.maxPrice);
    if (Number.isNaN(minPrice) || Number.isNaN(maxPrice))
      return res
        .status(400)
        .json({ error: "Price filters must be positive numbers" });
    if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice)
      return res
        .status(400)
        .json({ error: "Minimum price cannot exceed maximum price" });
    res.json(
      await rustPriceSnapshot(
        (req as AuthRequest).auth.workspaceId,
        page,
        pageSize,
        String(req.query.search || ""),
        {
          preset: String(req.query.preset || "All NFA"),
          minPrice,
          maxPrice,
          sort: String(req.query.sort || "newest"),
          displayCurrency:
            requestedCurrency as (typeof supportedCurrencies)[number],
          product,
        },
      ),
    );
  } catch (error) {
    next(error);
  }
});

app.get(
  "/api/lzt-tracker",
  requireRankPermission("LZT_ACCESS"),
  async (req, res, next) => {
    try {
      const query = z
        .object({
          page: z.coerce.number().int().positive().default(1),
          pageSize: z.coerce.number().int().positive().max(200).default(50),
          search: z.string().max(300).default(""),
          minEur: z
            .union([z.literal(""), z.coerce.number().nonnegative()])
            .optional(),
          maxEur: z
            .union([z.literal(""), z.coerce.number().nonnegative()])
            .optional(),
          maxHours: z
            .union([z.literal(""), z.coerce.number().nonnegative()])
            .optional(),
          sort: z
            .enum(["newest", "price-asc", "price-desc", "hours-asc"])
            .default("newest"),
          currency: z.enum(["DKK", "EUR", "USD", "RUB"]).default("EUR"),
        })
        .parse(req.query);
      const minEur =
        query.minEur === "" || query.minEur === undefined
          ? undefined
          : Math.round(query.minEur * 100);
      const maxEur =
        query.maxEur === "" || query.maxEur === undefined
          ? undefined
          : Math.round(query.maxEur * 100);
      if (minEur !== undefined && maxEur !== undefined && minEur > maxEur)
        return res
          .status(400)
          .json({ error: "Minimum EUR price cannot exceed maximum EUR price" });
      res.json(
        await lztTrackerSnapshot({
          page: query.page,
          pageSize: query.pageSize,
          search: query.search,
          minEur,
          maxEur,
          maxHours: query.maxHours === "" ? undefined : query.maxHours,
          sort: query.sort,
          displayCurrency: query.currency,
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);
app.post(
  "/api/lzt-tracker/start",
  requireRankPermission("LZT_ACCESS"),
  async (req, res, next) => {
    try {
      const options = z
        .object({
          importBaseline: z.boolean().default(true),
          notifyExisting: z.boolean().default(false),
        })
        .parse(req.body || {});
      res.status(202).json(await startLztTracker(options));
    } catch (error) {
      next(error);
    }
  },
);
app.post(
  "/api/lzt-tracker/stop",
  requireRankPermission("LZT_ACCESS"),
  async (_req, res, next) => {
    try {
      await stopLztTracker();
      res.json(await lztTrackerSnapshot());
    } catch (error) {
      next(error);
    }
  },
);
app.post(
  "/api/lzt-tracker/restart",
  requireRankPermission("LZT_ACCESS"),
  async (_req, res, next) => {
    try {
      res.status(202).json(await restartLztTracker());
    } catch (error) {
      next(error);
    }
  },
);
app.post(
  "/api/lzt-tracker/test",
  requireRole("ADMIN"),
  async (_req, res, next) => {
    try {
      res.json(await testLztConnection());
    } catch (error) {
      if (error instanceof LztApiError)
        return res
          .status(error.status || 503)
          .json({ status: error.code, error: error.message });
      next(error);
    }
  },
);
app.post(
  "/api/lzt-tracker/test-alert",
  requireRole("ADMIN"),
  async (req, res, next) => {
    try {
      const criteria = z
        .object({
          maximumPriceUsd: z.number().positive().max(1_000),
          minimumGames: z.number().int().min(0).max(10_000),
          minimumRustHours: z.number().int().min(0).max(100_000),
        })
        .parse(req.body);
      res.status(202).json(await queueLztHighHoursTestAlert(criteria));
    } catch (error) {
      if (error instanceof LztApiError)
        return res
          .status(error.status || 503)
          .json({ status: error.code, error: error.message });
      next(error);
    }
  },
);
app.post(
  "/api/lzt-tracker/haze-message",
  requireRole("ADMIN"),
  async (req, res, next) => {
    try {
      const { content } = z
        .object({ content: z.string().trim().min(1).max(2_000) })
        .parse(req.body);
      res.status(202).json(await queueHazeManualMessage(content));
    } catch (error) {
      next(error);
    }
  },
);
app.post(
  "/api/lzt-tracker/retry-test-alert",
  requireRole("ADMIN"),
  async (_req, res, next) => {
    try {
      res.status(202).json(await retryLatestFailedHazeTestAlert());
    } catch (error) {
      if (error instanceof LztApiError)
        return res
          .status(error.status || 503)
          .json({ status: error.code, error: error.message });
      next(error);
    }
  },
);
app.post(
  "/api/lzt-tracker/recalculate",
  requireRankPermission("LZT_ACCESS"),
  async (_req, res, next) => {
    try {
      res.json(await recalculateLztAverage());
    } catch (error) {
      next(error);
    }
  },
);
app.get(
  "/api/admin/lzt-tracker/health",
  requireRole("ADMIN"),
  async (_req, res, next) => {
    try {
      const snapshot = await lztTrackerSnapshot({ pageSize: 1 });
      res.json({
        state: snapshot.state,
        metrics: snapshot.metrics,
        queueLength: snapshot.queueLength,
        configured: snapshot.configured,
        database: "connected",
        liveDelivery: "SSE",
        pollIntervalMs: snapshot.pollIntervalMs,
      });
    } catch (error) {
      next(error);
    }
  },
);

app.post("/api/rust-prices/import", async (req, res, next) => {
  try {
    const body = rustPriceImportSchema.parse(req.body);
    const auth = (req as AuthRequest).auth;
    const product = marketProduct(body.productName, body.productType);
    const result = await importRustPriceSources(
      auth.workspaceId,
      body.urls,
      product,
    );
    await audit(
      req,
      "RUST_PRICE_SOURCES_IMPORTED",
      "Workspace",
      auth.workspaceId,
      result,
    );
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/rust-prices/search", async (req, res, next) => {
  try {
    const input = z
      .object({
        query: z.string().trim().min(2).max(300),
        maxResults: z
          .number()
          .int()
          .positive()
          .max(MAX_SEARCH_TARGET_RESULTS)
          .default(25),
        productName: z
          .string()
          .trim()
          .min(2)
          .max(120)
          .default("Rust NFA accounts"),
        productType: z.enum(marketProductTypes).default("RUST_NFA"),
      })
      .parse(req.body);
    const auth = (req as AuthRequest).auth;
    const product = marketProduct(input.productName, input.productType);
    const discovery = await searchBrave(input.query, input.maxResults);
    const imported = await importRustPriceSources(
      auth.workspaceId,
      discovery.results.map((result) => result.url),
      product,
    );
    const settings = await getSettings(auth.workspaceId);
    const scanner = await startRustPriceScanner(auth.workspaceId, {
      crawlerConcurrency: Number(settings.crawlerConcurrency),
      timeoutSeconds: Number(settings.timeoutSeconds),
      retries: Number(settings.retries),
      dynamicFallback: Boolean(settings.dynamicFallback),
      robotsRespect: Boolean(settings.robotsRespect),
      maxPages: settings.deepScan ? Number(settings.maxPages) : 4,
    });
    await audit(
      req,
      "RUST_PRICE_SEARCH_STARTED",
      "Workspace",
      auth.workspaceId,
      {
        query: input.query,
        requested: input.maxResults,
        discovered: discovery.results.length,
        ...imported,
      },
    );
    res.status(201).json({
      ...imported,
      requested: input.maxResults,
      discovered: discovery.results.length,
      complete: discovery.results.length >= input.maxResults,
      excluded: discovery.excluded,
      requests: discovery.requests,
      scanner,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/rust-prices/start", async (req, res, next) => {
  try {
    const auth = (req as AuthRequest).auth;
    parsedMarketProduct(req.body);
    const settings = await getSettings(auth.workspaceId);
    res.status(202).json(
      await startRustPriceScanner(auth.workspaceId, {
        crawlerConcurrency: Number(settings.crawlerConcurrency),
        timeoutSeconds: Number(settings.timeoutSeconds),
        retries: Number(settings.retries),
        dynamicFallback: Boolean(settings.dynamicFallback),
        robotsRespect: Boolean(settings.robotsRespect),
        maxPages: settings.deepScan ? Number(settings.maxPages) : 4,
      }),
    );
  } catch (error) {
    next(error);
  }
});

app.post("/api/rust-prices/stop", async (req, res, next) => {
  try {
    res.json(await stopRustPriceScanner((req as AuthRequest).auth.workspaceId));
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/rust-prices/reset",
  requireRole("ADMIN", "MANAGER"),
  async (req, res, next) => {
    try {
      const auth = (req as AuthRequest).auth;
      const product = parsedMarketProduct(req.body);
      await resetRustPriceScanner(auth.workspaceId, product.key);
      await audit(
        req,
        "RUST_PRICE_SCANNER_RESET",
        "Workspace",
        auth.workspaceId,
      );
      res.json({ reset: true });
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  "/api/rust-prices/delete-results",
  requireRole("ADMIN", "MANAGER"),
  async (req, res, next) => {
    try {
      const auth = (req as AuthRequest).auth;
      const input = marketProductSchema
        .extend({ confirm: z.literal("DELETE") })
        .parse(req.body);
      const state = await prisma.rustPriceScannerState.findUnique({
        where: { workspaceId: auth.workspaceId },
        select: { status: true },
      });
      if (["RUNNING", "STOPPING"].includes(state?.status || ""))
        return res
          .status(409)
          .json({ error: "Stop the price scanner before deleting results" });
      const product = marketProduct(input.productName, input.productType);
      const deleted = await deleteRustPriceResults(
        auth.workspaceId,
        product.key,
      );
      await audit(
        req,
        "MARKET_PRICE_RESULTS_DELETED",
        "Workspace",
        auth.workspaceId,
        {
          productKey: product.key,
          deleted,
        },
      );
      res.json({ deleted });
    } catch (error) {
      next(error);
    }
  },
);

app.post("/api/rust-prices/retry-failed", async (req, res, next) => {
  try {
    const auth = (req as AuthRequest).auth;
    const product = parsedMarketProduct(req.body);
    const updated = await prisma.rustPriceSource.updateMany({
      where: {
        workspaceId: auth.workspaceId,
        productKey: product.key,
        scanStatus: { in: ["Failed", "Blocked", "Timeout"] },
      },
      data: { scanStatus: "Pending", error: null },
    });
    if (!updated.count) return res.json({ queued: 0, scanner: null });
    const settings = await getSettings(auth.workspaceId);
    const scanner = await startRustPriceScanner(auth.workspaceId, {
      crawlerConcurrency: Number(settings.crawlerConcurrency),
      timeoutSeconds: Number(settings.timeoutSeconds),
      retries: Number(settings.retries),
      dynamicFallback: Boolean(settings.dynamicFallback),
      robotsRespect: Boolean(settings.robotsRespect),
      maxPages: settings.deepScan ? Number(settings.maxPages) : 4,
    });
    res.status(202).json({ queued: updated.count, scanner });
  } catch (error) {
    next(error);
  }
});

app.post("/api/rust-prices/rescan-all", async (req, res, next) => {
  try {
    const auth = (req as AuthRequest).auth;
    const product = parsedMarketProduct(req.body);
    const state = await prisma.rustPriceScannerState.findUnique({
      where: { workspaceId: auth.workspaceId },
      select: { status: true },
    });
    if (["RUNNING", "STOPPING"].includes(state?.status || ""))
      return res
        .status(409)
        .json({ error: "Stop the current price scan first" });
    const queued = await prisma.rustPriceSource.updateMany({
      where: { workspaceId: auth.workspaceId, productKey: product.key },
      data: { scanStatus: "Pending", error: null },
    });
    const settings = await getSettings(auth.workspaceId);
    const scanner = await startRustPriceScanner(auth.workspaceId, {
      crawlerConcurrency: Number(settings.crawlerConcurrency),
      timeoutSeconds: Number(settings.timeoutSeconds),
      retries: Number(settings.retries),
      dynamicFallback: Boolean(settings.dynamicFallback),
      robotsRespect: Boolean(settings.robotsRespect),
      maxPages: settings.deepScan ? Number(settings.maxPages) : 4,
    });
    await audit(
      req,
      "RUST_PRICE_DIAGNOSTIC_RESCAN_STARTED",
      "Workspace",
      auth.workspaceId,
      {
        queued: queued.count,
      },
    );
    res.status(202).json({ queued: queued.count, scanner });
  } catch (error) {
    next(error);
  }
});

app.post("/api/rust-prices/sources/:id/rescan", async (req, res, next) => {
  try {
    const auth = (req as unknown as AuthRequest).auth;
    const source = await prisma.rustPriceSource.findFirst({
      where: {
        id: String(req.params.id),
        workspaceId: auth.workspaceId,
      },
    });
    if (!source) return res.status(404).json({ error: "Not found" });
    await prisma.rustPriceSource.update({
      where: { id: source.id },
      data: { scanStatus: "Pending", error: null },
    });
    const settings = await getSettings(auth.workspaceId);
    const scanner = await startRustPriceScanner(auth.workspaceId, {
      crawlerConcurrency: Number(settings.crawlerConcurrency),
      timeoutSeconds: Number(settings.timeoutSeconds),
      retries: Number(settings.retries),
      dynamicFallback: Boolean(settings.dynamicFallback),
      robotsRespect: Boolean(settings.robotsRespect),
      maxPages: settings.deepScan ? Number(settings.maxPages) : 4,
    });
    res.status(202).json({ queued: 1, scanner });
  } catch (error) {
    next(error);
  }
});

app.get("/api/export/rust-prices.csv", async (req, res) => {
  const product = parsedMarketProduct({
    productName: req.query.productName || "Rust NFA accounts",
    productType: req.query.productType || "RUST_NFA",
  });
  const listings = await prisma.rustAccountListing.findMany({
    where: {
      workspaceId: (req as AuthRequest).auth.workspaceId,
      productKey: product.key,
      active: true,
    },
    select: { name: true, priceText: true, link: true },
    orderBy: { lastSeenAt: "desc" },
  });
  const rows = [
    ["Name", "Price", "Link"],
    ...listings.map((listing) => [
      listing.name,
      listing.priceText,
      listing.link,
    ]),
  ];
  res
    .set({
      "content-type": "text/csv",
      "content-disposition": `attachment; filename="${product.key}-prices.csv"`,
    })
    .send(rows.map((row) => row.map(csvEscape).join(",")).join("\n"));
});

app.get("/api/export/rust-price-debug.json", async (req, res, next) => {
  try {
    const report = await rustPriceDiagnosticExport(
      (req as AuthRequest).auth.workspaceId,
    );
    res
      .set({
        "content-type": "application/json; charset=utf-8",
        "content-disposition":
          'attachment; filename="rust-price-scan-debug.json"',
        "cache-control": "no-store",
      })
      .send(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    next(error);
  }
});

app.get("/api/export/rust-price-debug.csv", async (req, res, next) => {
  try {
    const report = await rustPriceDiagnosticExport(
      (req as AuthRequest).auth.workspaceId,
    );
    const rows: unknown[][] = [
      [
        "Scan ID",
        "Source",
        "Domain",
        "Scan Status",
        "Scan Outcome",
        "Started At",
        "Completed At",
        "Total Duration Ms",
        "Pages Checked",
        "Total Listings Found",
        "Page Number",
        "Requested URL",
        "Final URL",
        "Page Outcome",
        "HTTP Status",
        "Fetch Mode",
        "Static Fetch",
        "Dynamic Fetch",
        "Dynamic Error",
        "Page Duration Ms",
        "Listings Extracted",
        "Extraction Methods JSON",
        "Listing Samples JSON",
        "Internal Links Found",
        "Priority Links Queued",
        "Fetch Attempts JSON",
        "Redirects JSON",
        "Error Code",
        "Error",
      ],
    ];
    for (const scan of report.scans) {
      const diagnostic = scan.report as {
        pages?: Array<Record<string, unknown>>;
      };
      const pages = diagnostic.pages?.length ? diagnostic.pages : [{}];
      pages.forEach((page, index) => {
        rows.push([
          scan.id,
          scan.source.normalizedUrl,
          scan.source.domain,
          scan.status,
          scan.outcomeCode,
          scan.startedAt.toISOString(),
          scan.completedAt.toISOString(),
          scan.durationMs,
          scan.pagesChecked,
          scan.listingsFound,
          index + 1,
          page.requestedUrl || "",
          page.finalUrl || "",
          page.outcome || "",
          page.httpStatus || "",
          page.fetchMode || "",
          page.staticFetchResult || "",
          page.dynamicFetchResult || "",
          page.dynamicError || "",
          page.durationMs || 0,
          page.listingsExtracted || 0,
          JSON.stringify(page.extractionMethods || {}),
          JSON.stringify(page.listingSamples || []),
          page.internalLinksFound || 0,
          page.priorityLinksQueued || 0,
          JSON.stringify(page.attempts || []),
          JSON.stringify(page.redirects || []),
          page.errorCode || scan.errorCode || "",
          page.error || scan.error || "",
        ]);
      });
    }
    res
      .set({
        "content-type": "text/csv; charset=utf-8",
        "content-disposition":
          'attachment; filename="rust-price-scan-debug.csv"',
        "cache-control": "no-store",
      })
      .send(rows.map((row) => row.map(csvEscape).join(",")).join("\n"));
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
app.get("/api/scanner/results/:id", async (req, res, next) => {
  try {
    await scannerReady;
    const item = await scannerResultDetail(
      (req as unknown as AuthRequest).auth.workspaceId,
      String(req.params.id),
    );
    item ? res.json(item) : res.status(404).json({ error: "Not found" });
  } catch (error) {
    next(error);
  }
});
app.get("/api/scanner/discord-links/reconcile", async (req, res, next) => {
  try {
    await scannerReady;
    const workspaceId = (req as AuthRequest).auth.workspaceId;
    res.json(await getDiscordReconciliationProgress(workspaceId));
  } catch (error) {
    next(error);
  }
});
app.post("/api/scanner/discord-links/reconcile", async (req, res, next) => {
  try {
    await scannerReady;
    const auth = (req as AuthRequest).auth;
    const result = await startWorkspaceDiscordInviteReconciliation(
      auth.workspaceId,
    );
    await audit(
      req,
      result.started
        ? "DISCORD_INVITE_RECONCILIATION_STARTED"
        : "DISCORD_INVITE_RECONCILIATION_ALREADY_RUNNING",
      "Workspace",
      auth.workspaceId,
      { operationId: result.progress?.operationId },
    );
    res.status(result.started ? 202 : 200).json(result);
  } catch (error) {
    next(error);
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
    const auth = (req as AuthRequest).auth;
    // Retry failures that can plausibly change on a later, slower pass. A 403,
    // robots restriction, or safe redirect-boundary rejection is terminal until
    // the target owner changes it; immediately replaying those rows only steals
    // capacity from timeouts and temporary infrastructure failures.
    const retryableReasons = [
      "",
      "CONTACT_NOT_FOUND",
      "DISCORD_NOT_FOUND",
      "NO_DISCORD_FOUND",
      "TIMEOUT",
      "HTTP_408",
      "HTTP_425",
      "HTTP_429",
      "HTTP_5XX",
      "DNS_FAILURE",
      "CONNECTION_FAILURE",
      "TLS_FAILURE",
      "REDIRECT_LIMIT",
      "INVALID_RESPONSE",
      "SCRAPER_OFFLINE",
      "SCRAPER_BUSY",
      "SCRAPER_ERROR",
      "UNEXPECTED_SCAN_FAILURE",
    ];
    const updated = await prisma.scannerResult.updateMany({
      where: {
        workspaceId: auth.workspaceId,
        quarantinedAt: null,
        OR: [
          { scanStatus: "Timeout" },
          {
            scanStatus: { in: ["Failed", "Blocked"] },
            discoveryFailureReason: { in: retryableReasons },
          },
        ],
      },
      data: { scanStatus: "Pending", error: null },
    });
    const skippedPermanent = await prisma.scannerResult.count({
      where: {
        workspaceId: auth.workspaceId,
        quarantinedAt: null,
        scanStatus: { in: ["Failed", "Blocked"] },
        NOT: { discoveryFailureReason: { in: retryableReasons } },
      },
    });
    const settings = await getSettings(auth.workspaceId);
    const recoverySettings = {
      crawlerConcurrency: Math.max(
        1,
        Math.min(8, Number(settings.crawlerConcurrency)),
      ),
      adaptiveConcurrency: true,
      timeoutSeconds: Math.max(15, Number(settings.timeoutSeconds)),
      retries: Math.max(2, Number(settings.retries)),
      dynamicFallback: Boolean(settings.dynamicFallback),
      robotsRespect: Boolean(settings.robotsRespect),
      deepScan: Boolean(settings.deepScan),
      maxPages: Number(settings.maxPages),
      maxDepth: Number(settings.maxDepth),
    };
    const scanner = updated.count
      ? await startScanner(auth.workspaceId, recoverySettings)
      : null;
    res
      .status(updated.count ? 202 : 200)
      .json({
        queued: updated.count,
        skippedPermanent,
        recoveryProfile: updated.count
          ? {
              concurrency: recoverySettings.crawlerConcurrency,
              timeoutSeconds: recoverySettings.timeoutSeconds,
              retries: recoverySettings.retries,
            }
          : null,
        scanner,
      });
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
    if (item.quarantinedAt)
      return res.status(409).json({
        error:
          "This website was removed after five unsuccessful contact extraction attempts. Its failures remain available in Failed history.",
      });
    await prisma.scannerResult.update({
      where: { id: item.id },
      data: { scanStatus: "Pending", error: null },
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
    res.status(202).json({ queued: 1, scanner });
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

app.get("/api/export/scanner-failures.csv", async (req, res) => {
  const items = await prisma.scannerFailureHistory.findMany({
    where: { workspaceId: (req as AuthRequest).auth.workspaceId },
    orderBy: { occurredAt: "desc" },
  });
  const rows = [
    [
      "Website",
      "Normalized URL",
      "Domain",
      "Status",
      "Failure Reason",
      "Error",
      "HTTP Status",
      "Contact Failure Count",
      "Occurred At",
      "Scanner Result ID",
    ],
    ...items.map((item) => [
      item.url,
      item.normalizedUrl,
      item.domain,
      item.status,
      item.failureReason,
      item.error,
      item.httpStatus ?? "",
      item.contactFailureCount,
      item.occurredAt.toISOString(),
      item.scannerResultId || "",
    ]),
  ];
  res
    .set({
      "content-type": "text/csv",
      "content-disposition":
        'attachment; filename="scanner-failure-history.csv"',
      "cache-control": "no-store",
    })
    .send(rows.map((row) => row.map(csvEscape).join(",")).join("\n"));
});

app.post("/api/scanner/leads", async (req, res, next) => {
  try {
    const auth = (req as AuthRequest).auth;
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    const results = await prisma.scannerResult.findMany({
      where: {
        id: { in: ids },
        workspaceId: auth.workspaceId,
      },
      select: { id: true },
    });
    let added = 0;
    let skipped = 0;
    for (const result of results) {
      const synced = await syncScannerResultToLead({
        workspaceId: auth.workspaceId,
        scannerResultId: result.id,
        actorId: auth.id,
        sourceLabel: "Scanner selection",
      });
      if (synced.created) added++;
      if (synced.skipped) skipped++;
    }
    emit("lead-update", { count: results.length }, auth.workspaceId);
    res.json({
      processed: results.length,
      added,
      skipped: ids.length - results.length + skipped,
    });
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
const leadListInclude = {
  domain: { include: { location: true } },
  scannerResult: {
    select: {
      discordLinks: {
        take: 1,
        orderBy: { createdAt: "desc" as const },
        select: { id: true, url: true },
      },
    },
  },
  assignedTo: { select: { id: true, username: true, role: true } },
  activities: {
    take: 25,
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
          {
            AND: [
              { scannerResult: { scanStatus: { not: "Excluded" } } },
              {
                OR: [
                  { discordInvite: { not: "" } },
                  { telegram: { not: "" } },
                  { email: { not: "" } },
                  { scannerResult: { discordLinks: { some: {} } } },
                ],
              },
            ],
          },
        ],
        ...(auth.role === "RESEARCHER" ? { assignedToId: auth.id } : {}),
        ...(tag ? { tags: { some: { tag: { name: tag } } } } : {}),
      },
      orderBy: { updatedAt: "desc" },
      include: leadListInclude,
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
app.delete(
  "/api/leads",
  requireRole("ADMIN", "MANAGER"),
  async (req, res, next) => {
    try {
      const auth = (req as AuthRequest).auth;
      const deleted = await prisma.lead.deleteMany({
        where: { workspaceId: auth.workspaceId },
      });
      await audit(req, "LEADS_CLEARED", "Workspace", auth.workspaceId, {
        deleted: deleted.count,
      });
      emit(
        "lead-update",
        { cleared: true, count: deleted.count },
        auth.workspaceId,
      );
      res.json({ deleted: deleted.count });
    } catch (error) {
      next(error);
    }
  },
);
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
        newPassword: newPasswordSchema,
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
        {
          AND: [
            { scannerResult: { scanStatus: { not: "Excluded" } } },
            {
              OR: [
                { discordInvite: { not: "" } },
                { telegram: { not: "" } },
                { email: { not: "" } },
                { scannerResult: { discordLinks: { some: {} } } },
              ],
            },
          ],
        },
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
      "Telegram",
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
      l.telegram,
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
app.get("/api/export/discord-links.csv", async (req, res) => {
  const auth = (req as AuthRequest).auth;
  const [scannerLinks, historyLinks, savedLeads] = await Promise.all([
    prisma.scannerDiscordLink.findMany({
      where: {
        scannerResult: {
          workspaceId: auth.workspaceId,
          scanStatus: { not: "Excluded" },
        },
      },
      include: {
        scannerResult: {
          select: {
            url: true,
            finalUrl: true,
            domain: { select: { hostname: true } },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.discordLink.findMany({
      where: {
        searchResult: {
          searchSession: { workspaceId: auth.workspaceId },
        },
      },
      include: {
        searchResult: {
          select: {
            url: true,
            domain: { select: { hostname: true } },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.lead.findMany({
      where: {
        workspaceId: auth.workspaceId,
        discordInvite: { not: "" },
      },
      select: {
        discordInvite: true,
        website: true,
        createdAt: true,
        domain: { select: { hostname: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const unique = new Map<
    string,
    [string, string, string, string, string, string, string, string, string]
  >();
  const add = (
    rawUrl: string,
    domain: string,
    website: string,
    evidenceSource: string,
    sourcePage: string,
    discoveryMethod: string,
    validationStatus: string,
    firstSeen: Date,
  ) => {
    const normalized = normalizeDiscordUrl(rawUrl);
    if (!normalized || unique.has(normalized)) return;
    unique.set(normalized, [
      normalized,
      discordDestinationKind(normalized) || "unknown",
      domain,
      website,
      evidenceSource,
      sourcePage,
      discoveryMethod,
      validationStatus,
      firstSeen.toISOString(),
    ]);
  };
  scannerLinks.forEach((link) =>
    add(
      link.url,
      link.scannerResult.domain.hostname,
      link.scannerResult.finalUrl || link.scannerResult.url,
      "Scanner",
      link.sourcePage,
      link.discoveryMethod,
      link.validationStatus,
      link.createdAt,
    ),
  );
  historyLinks.forEach((link) =>
    add(
      link.url,
      link.searchResult.domain.hostname,
      link.searchResult.url,
      "Search history",
      link.sourcePage,
      "legacy-search",
      "",
      link.createdAt,
    ),
  );
  savedLeads.forEach((lead) =>
    add(
      lead.discordInvite,
      lead.domain.hostname,
      lead.website,
      "Saved lead",
      lead.website,
      "manual-or-saved",
      "",
      lead.createdAt,
    ),
  );
  const rows = [
    [
      "Discord URL",
      "Type",
      "Domain",
      "Website",
      "Evidence Source",
      "Source Page",
      "Discovery Method",
      "Validation Status",
      "First Seen",
    ],
    ...unique.values(),
  ];
  res
    .set({
      "content-type": "text/csv",
      "content-disposition": 'attachment; filename="discord-links.csv"',
    })
    .send(rows.map((row) => row.map(csvEscape).join(",")).join("\n"));
});
app.get("/api/export/lead-discord-links.txt", async (req, res) => {
  const auth = (req as AuthRequest).auth;
  const leads = await prisma.lead.findMany({
    where: {
      workspaceId: auth.workspaceId,
      OR: [
        { scannerResultId: null },
        {
          AND: [
            { scannerResult: { scanStatus: { not: "Excluded" } } },
            {
              OR: [
                { discordInvite: { not: "" } },
                { telegram: { not: "" } },
                { email: { not: "" } },
                { scannerResult: { discordLinks: { some: {} } } },
              ],
            },
          ],
        },
      ],
      ...(auth.role === "RESEARCHER" ? { assignedToId: auth.id } : {}),
    },
    select: {
      discordInvite: true,
      scannerResult: {
        select: {
          discordLinks: {
            select: { url: true },
            orderBy: { createdAt: "asc" },
          },
        },
      },
    },
  });
  const links = new Set<string>();
  for (const lead of leads)
    for (const rawUrl of [
      lead.discordInvite,
      ...(lead.scannerResult?.discordLinks.map((link) => link.url) || []),
    ]) {
      const normalized = normalizeDiscordUrl(rawUrl);
      if (normalized) links.add(normalized);
    }
  const body = [...links].sort().join("\n");
  res
    .set({
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": 'attachment; filename="discord-links.txt"',
      "cache-control": "no-store",
    })
    .send(body ? `${body}\n` : "");
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
app.get("/api/members", async (req, res, next) => {
  try {
    res.json(
      await workspaceMemberDirectory((req as AuthRequest).auth.workspaceId),
    );
  } catch (error) {
    next(error);
  }
});
app.get("/api/admin/ranks", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const workspaceId = (req as AuthRequest).auth.workspaceId;
    await ensureWorkspaceRanks(workspaceId);
    const ranks = await prisma.workspaceRank.findMany({
      where: { workspaceId },
      orderBy: { position: "desc" },
      include: { _count: { select: { users: true } } },
    });
    res.json(
      ranks.map((rank) => ({
        ...rank,
        permissions: JSON.parse(rank.permissionsJson),
        permissionsJson: undefined,
      })),
    );
  } catch (error) {
    next(error);
  }
});
app.post("/api/admin/ranks", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const auth = (req as AuthRequest).auth;
    const input = z
      .object({
        name: z.string().trim().min(1).max(40),
        color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
        position: z.number().int().min(-1000).max(1000).default(0),
        permissions: z.array(z.enum(rankPermissions)).default([]),
      })
      .parse(req.body);
    const rank = await prisma.workspaceRank.create({
      data: {
        workspaceId: auth.workspaceId,
        name: input.name,
        color: input.color.toUpperCase(),
        position: input.position,
        permissionsJson: JSON.stringify(input.permissions),
      },
    });
    await audit(req, "RANK_CREATED", "WorkspaceRank", rank.id, {
      name: rank.name,
      permissions: input.permissions,
    });
    res.status(201).json(rank);
  } catch (error) {
    next(error);
  }
});
app.patch(
  "/api/admin/ranks/:id",
  requireRole("ADMIN"),
  async (req, res, next) => {
    try {
      const auth = (req as AuthRequest).auth;
      const rank = await prisma.workspaceRank.findFirst({
        where: { id: String(req.params.id), workspaceId: auth.workspaceId },
      });
      if (!rank) return res.status(404).json({ error: "Rank not found" });
      const input = z
        .object({
          name: z.string().trim().min(1).max(40).optional(),
          color: z
            .string()
            .regex(/^#[0-9A-Fa-f]{6}$/)
            .optional(),
          position: z.number().int().min(-1000).max(1000).optional(),
          permissions: z.array(z.enum(rankPermissions)).optional(),
        })
        .parse(req.body);
      const updated = await prisma.workspaceRank.update({
        where: { id: rank.id },
        data: {
          name: input.name,
          color: input.color?.toUpperCase(),
          position: input.position,
          permissionsJson: input.permissions
            ? JSON.stringify(input.permissions)
            : undefined,
        },
      });
      await audit(req, "RANK_UPDATED", "WorkspaceRank", rank.id, input);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  },
);
app.delete(
  "/api/admin/ranks/:id",
  requireRole("ADMIN"),
  async (req, res, next) => {
    try {
      const auth = (req as AuthRequest).auth;
      const rank = await prisma.workspaceRank.findFirst({
        where: { id: String(req.params.id), workspaceId: auth.workspaceId },
      });
      if (!rank) return res.status(404).json({ error: "Rank not found" });
      if (rank.managed)
        return res
          .status(400)
          .json({ error: "Built-in ranks cannot be deleted" });
      await prisma.workspaceRank.delete({ where: { id: rank.id } });
      await audit(req, "RANK_DELETED", "WorkspaceRank", rank.id, {
        name: rank.name,
      });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  },
);
app.put(
  "/api/admin/users/:id/ranks",
  requireRole("ADMIN"),
  async (req, res, next) => {
    try {
      const auth = (req as AuthRequest).auth;
      const user = await prisma.user.findFirst({
        where: { id: String(req.params.id), workspaceId: auth.workspaceId },
      });
      if (!user) return res.status(404).json({ error: "User not found" });
      const input = z
        .object({ rankIds: z.array(z.string()).max(25) })
        .parse(req.body);
      const valid = await prisma.workspaceRank.findMany({
        where: { workspaceId: auth.workspaceId, id: { in: input.rankIds } },
        select: { id: true },
      });
      if (valid.length !== new Set(input.rankIds).size)
        return res.status(400).json({ error: "One or more ranks are invalid" });
      await prisma.$transaction([
        prisma.userRank.deleteMany({ where: { userId: user.id } }),
        prisma.userRank.createMany({
          data: valid.map((rank) => ({ userId: user.id, rankId: rank.id })),
        }),
      ]);
      await audit(req, "USER_RANKS_UPDATED", "User", user.id, {
        rankIds: valid.map((rank) => rank.id),
      });
      res.json({ ranks: await publicRanksForUser(user.id) });
    } catch (error) {
      next(error);
    }
  },
);
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
        rankAssignments: {
          select: {
            rank: {
              select: { id: true, name: true, color: true, position: true },
            },
          },
        },
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
          temporaryPassword: newPasswordSchema.optional(),
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
    const validationMessage =
      err?.name === "ZodError" && Array.isArray(err?.issues)
        ? err.issues.find(
            (issue: unknown) =>
              typeof issue === "object" &&
              issue !== null &&
              "message" in issue &&
              typeof issue.message === "string",
          )?.message
        : undefined;
    const status =
      err?.statusCode ??
      (err?.name === "ZodError" ? 400 : duplicateUsername ? 409 : 500);
    if (status >= 500) console.error(err);
    const exposedError = err?.expose === true;
    res.status(status).json({
      error: duplicateUsername
        ? "Username is already in use."
        : validationMessage
          ? validationMessage
          : status >= 500 &&
              process.env.NODE_ENV === "production" &&
              !exposedError
            ? "Unexpected server error"
            : err instanceof Error
              ? err.message
              : "Unexpected server error",
    });
  },
);
export default app;
