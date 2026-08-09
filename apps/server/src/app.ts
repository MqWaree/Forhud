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
 ×m¸ÞÚ$z{-®éÜj×6W76–öç2Òv—B&—6Öç6V&6…6W76–öâæf–æDÖç’‡°¢v†W&S¢²v÷&·76T–C¢‡&W2WF…&WVW7B’æWF‚çv÷&·76T–BÒÀ¢–æ6ÇVFS¢²&W7VÇG3¢²–æ6ÇVFS¢²F—66÷&DÆ–æ·3¢G'VRÒÒÒÀ¢Ò“°¢6öç7B&÷w2Ò°¢²$FFR"Â%6V&6‚VW'’"Â%U$Ç2f÷VæB"Â$F—66÷&BÆ–æ·2"Â$GW&F–öâ%ÒÀ¢ââç6W76–öç2æÖ‚‡2’Óâ°¢2æ7&VFVDBçFô•4õ7G&–ær‚’À¢2çVW'’À¢2ç&W7VÇG2æÆVæwF‚À¢2ç&W7VÇG2ç&VGV6R‚†âÂ"’Óââ²"æF—66÷&DÆ–æ·2æÆVæwF‚Â’À¢2æ6ö×ÆWFVD@¢ò7G&–ær‡2æ6ö×ÆWFVDBævWEF–ÖR‚’Ò2æ7&VFVDBævWEF–ÖR‚’¢¢""À¢Ò’À¢Ó°¢&W0¢çG—R‚'FW‡Bö77b"¢ç6VæB‡&÷w2æÖ‚‡"’Óâ"æÖ†77dW66R’æ¦ö–â‚"Â"’’æ¦ö–â‚%Æâ"’“°§Ò“° ¦ævWB‚"ö’÷v÷&·76R"Â7–æ2‡&WÂ&W2’Óâ°¢6öç7BWF‚Ò‡&W2WF…&WVW7B’æWFƒ°¢6öç7B¶W‡FVç6–öç2Â66ææW%ÒÒv—B&öÖ—6RæÆÂ…°¢&—6ÖæW‡FVç6–öä–ç7Fæ6Ræ6÷VçB‡°¢v†W&S¢°¢v÷&·76T–C¢WF‚çv÷&·76T–BÀ¢&Wfö¶VDC¢çVÆÂÀ¢Æ7E6VVã¢²wFS¢æWrFFR„FFRææ÷r‚’Ò"¢c¢’ÒÀ¢ÒÀ¢Ò’À¢&—6Öç66ææW%7FFRæf–æEVæ—VR‡°¢v†W&S¢²v÷&·76T–C¢WF‚çv÷&·76T–BÒÀ¢Ò’À¢Ò“°¢&W2æ§6öâ‡²ââæWF‚çv÷&·76RÂ6öææV7FVDW‡FVç6–öç3¢W‡FVç6–öç2Â66ææW"Ò“°§Ò“°¦ç÷7B€¢"ö’÷v÷&·76R÷&VvVæW&FR×66ææW"Ö–B"À¢&WV—&U&öÆR‚$DÔ”â"’À¢7–æ2‡&WÂ&W2ÂæW‡B’Óâ°¢G'’°¢6öç7BWF‚Ò‡&W2WF…&WVW7B’æWFƒ°¢6öç7B6öæf—&ÖF–öâÒ ¢æö&¦V7B‡²6öæf—&Ó¢¢æÆ—FW&Â‚%$TtTäU$DR"’Ò¢ç'6R‡&Wæ&öG’“°¢fö–B6öæf—&ÖF–öã°¢ÆWB66ææW$–BÒvVæW&FU66ææW$–B‚“°¢v†–ÆR†v—B&—6Öçv÷&·76Ræf–æEVæ—VR‡²v†W&S¢²66ææW$–BÒÒ’¢66ææW$–BÒvVæW&FU66ææW$–B‚“°¢6öç7B·v÷&·76UÒÒv—B&—6ÖâGG&ç67F–öâ…°¢&—6Öçv÷&·76RçWFFR‡°¢v†W&S¢²–C¢WF‚çv÷&·76T–BÒÀ¢FF¢²66ææW$–BÒÀ¢Ò’À¢&—6ÖæW‡FVç6–öä–ç7Fæ6RçWFFTÖç’‡°¢v†W&S¢²v÷&·76T–C¢WF‚çv÷&·76T–BÂ&Wfö¶VDC¢çVÆÂÒÀ¢FF¢²&Wfö¶VDC¢æWrFFR‚’Â66ææW%7FFS¢%5DõTB"ÒÀ¢Ò’À¢Ò“°¢v—BVF—B‡&WÂ%44ääU%ô”Eõ$TtTäU$DTB"Â%v÷&·76R"ÂWF‚çv÷&·76T–B“°¢&W2æ§6öâ‡²66ææW$–C¢v÷&·76Rç66ææW$–BÒ“°¢Ò6F6‚†W'&÷"’°¢æW‡B†W'&÷"“°¢Ð¢ÒÀ¢“° ¦ævWB‚"ö’öFÖ–âö÷fW'f–Wr"Â&WV—&U&öÆR‚$DÔ”â"’Â7–æ2‡&WÂ&W2’Óâ°¢6öç7Bv÷&·76T–BÒ‡&W2WF…&WVW7B’æWF‚çv÷&·76T–C°¢6öç7B°¢W6W'2À¢7F—fUW6W'2À¢W‡FVç6–öç2À¢66ææW%&W7VÇG2À¢ÆVG2À¢66ææW"À¢&6·WÀ¢ÒÒv—B&öÖ—6RæÆÂ…°¢&—6ÖçW6W"æ6÷VçB‡²v†W&S¢²v÷&·76T–BÒÒ’À¢&—6ÖçW6W"æ6÷VçB‡²v†W&S¢²v÷&·76T–BÂ7FGW3¢$5D•dR"ÒÒ’À¢&—6ÖæW‡FVç6–öä–ç7Fæ6Ræ6÷VçB‡°¢v†W&S¢°¢v÷&·76T–BÀ¢&Wfö¶VDC¢çVÆÂÀ¢Æ7E6VVã¢²wFS¢æWrFFR„FFRææ÷r‚’Ò"¢c¢’ÒÀ¢ÒÀ¢Ò’À¢&—6Öç66ææW%&W7VÇBæ6÷VçB‡²v†W&S¢²v÷&·76T–BÒÒ’À¢&—6ÖæÆVBæ6÷VçB‡²v†W&S¢²v÷&·76T–BÒÒ’À¢&—6Öç66ææW%7FFRæf–æEVæ—VR‡²v†W&S¢²v÷&·76T–BÒÒ’À¢&—6Öæ&6·WÖWFFFæf–æDf—'7B‡°¢v†W&S¢²7FGW3¢$4ôÕÄUDTB"ÒÀ¢÷&FW$'“¢²7&VFVDC¢&FW62"ÒÀ¢Ò’À¢Ò“°¢&W2æ§6öâ‡°¢W6W'2À¢7F—fUW6W'2À¢6öææV7FVDW‡FVç6–öç3¢W‡FVç6–öç2À¢66ææW%&W7VÇG2À¢ÆVG2À¢66ææW'5'Vææ–æs¢66ææW#òç7FGW2ÓÓÒ%%Tää”är"ò¢À¢Æ7D&6·W¢&6·Wòæ7&VFVDBÇÂçVÆÂÀ¢Ò“°§Ò“°¦ævWB‚"ö’öFÖ–â÷W6W'2"Â&WV—&U&öÆR‚$DÔ”â"’Â7–æ2‡&WÂ&W2’Óâ°¢6öç7Bv÷&·76T–BÒ‡&W2WF…&WVW7B’æWF‚çv÷&·76T–C°¢&W2æ§6öâ€¢v—B&—6ÖçW6W"æf–æDÖç’‡°¢v†W&S¢²v÷&·76T–BÒÀ¢÷&FW$'“¢²7&VFVDC¢&FW62"ÒÀ¢6VÆV7C¢°¢–C¢G'VRÀ¢W6W&æÖS¢G'VRÀ¢&öÆS¢G'VRÀ¢7FGW3¢G'VRÀ¢&WV—&U77v÷&D6†ævS¢G'VRÀ¢Æ7DÆöv–äC¢G'VRÀ¢7&VFVDC¢G'VRÀ¢ö6÷VçC¢²6VÆV7C¢²76–væVDÆVG3¢G'VRÂW‡FVç6–öä–ç7Fæ6W3¢G'VRÒÒÀ¢ÒÀ¢Ò’À¢“°§Ò“°¦ç÷7B‚"ö’öFÖ–â÷W6W'2"Â&WV—&U&öÆR‚$DÔ”â"’Â7–æ2‡&WÂ&W2ÂæW‡B’Óâ°¢G'’°¢6öç7BWF‚Ò‡&W2WF…&WVW7B’æWFƒ°¢6öç7B–çWBÒ66÷VçE66†VÖ¢æW‡FVæB‡°¢&öÆS¢¢æVçVÒ‡&öÆW2’À¢&WV—&U77v÷&D6†ævS¢¢æ&ööÆVâ‚’æFVfVÇB‡G'VR’À¢Ò¢ç'6R‡&Wæ&öG’“°¢6öç7BW6W"Òv—B&—6ÖçW6W"æ7&VFR‡°¢FF¢°¢v÷&·76T–C¢WF‚çv÷&·76T–BÀ¢æÖS¢–çWBçW6W&æÖRÀ¢W6W&æÖS¢–çWBçW6W&æÖRÀ¢77v÷&D†6ƒ¢v—B†6…77v÷&B†–çWBç77v÷&B’À¢&öÆS¢–çWBç&öÆRÀ¢&WV—&U77v÷&D6†ævS¢–çWBç&WV—&U77v÷&D6†ævRÀ¢ÒÀ¢6VÆV7C¢°¢–C¢G'VRÀ¢W6W&æÖS¢G'VRÀ¢&öÆS¢G'VRÀ¢7FGW3¢G'VRÀ¢ÒÀ¢Ò“°¢v—BVF—B‡&WÂ%U4U%ô5$TDTB"Â%W6W""ÂW6W"æ–BÂ²&öÆS¢W6W"ç&öÆRÒ“°¢&W2ç7FGW2ƒ#’æ§6öâ‡W6W"“°¢Ò6F6‚†W'&÷"’°¢æW‡B†W'&÷"“°¢Ð§Ò“°¦çF6‚€¢"ö’öFÖ–â÷W6W'2ó¦–B"À¢&WV—&U&öÆR‚$DÔ”â"’À¢7–æ2‡&WÂ&W2ÂæW‡B’Óâ°¢G'’°¢6öç7BWF‚Ò‡&W2WF…&WVW7B’æWFƒ°¢6öç7BF&vWBÒv—B&—6ÖçW6W"æf–æDf—'7B‡°¢v†W&S¢²–C¢7G&–ær‡&Wç&×2æ–B’Âv÷&·76T–C¢WF‚çv÷&·76T–BÒÀ¢Ò“°¢–b‚F&vWB’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²W'&÷#¢$æ÷Bf÷VæB"Ò“°¢6öç7B–çWBÒ ¢æö&¦V7B‡°¢W6W&æÖS¢W6W&æÖU66†VÖæ÷F–öæÂ‚’À¢&öÆS¢¢æVçVÒ‡&öÆW2’æ÷F–öæÂ‚’À¢7FGW3¢¢æVçVÒ…²$5D•dR"Â$D•4$ÄTB%Ò’æ÷F–öæÂ‚’À¢FV×÷&'•77v÷&C¢æWu77v÷&E66†VÖæ÷F–öæÂ‚’À¢Ò¢ç'6R‡&Wæ&öG’“°¢–b‡F&vWBæ–BÓÓÒWF‚æ–Bbb–çWBç7FGW2ÓÓÒ$D•4$ÄTB"¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡²W'&÷#¢%–÷R6ææ÷BF—6&ÆR–÷W"÷vâ66÷VçB"Ò“°¢6öç7BW6W"Òv—B&—6ÖçW6W"çWFFR‡°¢v†W&S¢²–C¢F&vWBæ–BÒÀ¢FF¢°¢âââ†–çWBçW6W&æÖP¢ò²æÖS¢–çWBçW6W&æÖRÂW6W&æÖS¢–çWBçW6W&æÖRÐ¢¢·Ò’À¢&öÆS¢–çWBç&öÆRÀ¢7FGW3¢–çWBç7FGW2À¢âââ†–çWBçFV×÷&'•77v÷&@¢ò°¢77v÷&D†6ƒ¢v—B†6…77v÷&B†–çWBçFV×÷&'•77v÷&B’À¢&WV—&U77v÷&D6†ævS¢G'VRÀ¢Ð¢¢·Ò’À¢ÒÀ¢6VÆV7C¢°¢–C¢G'VRÀ¢W6W&æÖS¢G'VRÀ¢&öÆS¢G'VRÀ¢7FGW3¢G'VRÀ¢ÒÀ¢Ò“°¢–b†–çWBç7FGW2ÓÓÒ$D•4$ÄTB"¢v—B&—6ÖâGG&ç67F–öâ…°¢&—6ÖæWF…6W76–öâæFVÆWFTÖç’‡²v†W&S¢²W6W$–C¢F&vWBæ–BÒÒ’À¢&—6ÖæW‡FVç6–öä–ç7Fæ6RçWFFTÖç’‡°¢v†W&S¢²÷væW%W6W$–C¢F&vWBæ–BÂ&Wfö¶VDC¢çVÆÂÒÀ¢FF¢²&Wfö¶VDC¢æWrFFR‚’Â66ææW%7FFS¢%5DõTB"ÒÀ¢Ò’À¢Ò“°¢v—BVF—B‡&WÂ%U4U%õUDDTB"Â%W6W""ÂF&vWBæ–BÂ°¢&öÆS¢–çWBç&öÆRÀ¢7FGW3¢–çWBç7FGW2À¢77v÷&E&W6WC¢&ööÆVâ†–çWBçFV×÷&'•77v÷&B’À¢Ò“°¢&W2æ§6öâ‡W6W"“°¢Ò6F6‚†W'&÷"’°¢æW‡B†W'&÷"“°¢Ð¢ÒÀ¢“° ¦ævWB‚"ö’öFÖ–âöW‡FVç6–öç2"Â&WV—&U&öÆR‚$DÔ”â"’Â7–æ2‡&WÂ&W2’Óâ°¢6öç7Bv÷&·76T–BÒ‡&W2WF…&WVW7B’æWF‚çv÷&·76T–C°¢6öç7BW‡FVç6–öç2Òv—B&—6ÖæW‡FVç6–öä–ç7Fæ6Ræf–æDÖç’‡°¢v†W&S¢²v÷&·76T–BÒÀ¢÷&FW$'“¢²Æ7E6VVã¢&FW62"ÒÀ¢6VÆV7C¢°¢–C¢G'VRÀ¢–ç7Fæ6T–C¢G'VRÀ¢æÖS¢G'VRÀ¢66ææW%7FFS¢G'VRÀ¢7W'&VçE6V&6ƒ¢G'VRÀ¢7W'&VçEvS¢G'VRÀ¢vW566ææVC¢G'VRÀ¢&W7VÇG4f÷VæC¢G'VRÀ¢Væ—VUW&Ç56VçC¢G'VRÀ¢GWÆ–6FW56¶—VC¢G'VRÀ¢Æ7E6VVã¢G'VRÀ¢&Wfö¶VDC¢G'VRÀ¢7&VFVDC¢G'VRÀ¢÷væW%W6W#¢²6VÆV7C¢²–C¢G'VRÂW6W&æÖS¢G'VRÒÒÀ¢ÒÀ¢Ò“°¢&W2æ§6öâ€¢W‡FVç6–öç2æÖ‚†W‡FVç6–öâ’Óâ‡°¢ââæW‡FVç6–öâÀ¢6öææV7FVC ¢W‡FVç6–öâç&Wfö¶VDBb`¢W‡FVç6–öâæÆ7E6VVâævWEF–ÖR‚’ãÒFFRææ÷r‚’Ò"¢c¢À¢Ò’’À¢“°§Ò“°¦çF6‚€¢"ö’öFÖ–âöW‡FVç6–öç2ó¦–B"À¢&WV—&U&öÆR‚$DÔ”â"’À¢7–æ2‡&WÂ&W2ÂæW‡B’Óâ°¢G'’°¢6öç7BWF‚Ò‡&W2WF…&WVW7B’æWFƒ°¢6öç7BW‡FVç6–öâÒv—B&—6ÖæW‡FVç6–öä–ç7Fæ6Ræf–æDf—'7B‡°¢v†W&S¢²–C¢7G&–ær‡&Wç&×2æ–B’Âv÷&·76T–C¢WF‚çv÷&·76T–BÒÀ¢Ò“°¢–b‚W‡FVç6–öâ’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²W'&÷#¢$æ÷Bf÷VæB"Ò“°¢6öç7B–çWBÒ ¢æö&¦V7B‡°¢æÖS¢¢ç7G&–ær‚’çG&–Ò‚’æÖ–âƒ’æÖ‚ƒ’æ÷F–öæÂ‚’À¢&Wfö¶S¢¢æ&ööÆVâ‚’æ÷F–öæÂ‚’À¢Ò¢ç'6R‡&Wæ&öG’“°¢6öç7BWFFVBÒv—B&—6ÖæW‡FVç6–öä–ç7Fæ6RçWFFR‡°¢v†W&S¢²–C¢W‡FVç6–öâæ–BÒÀ¢FF¢°¢æÖS¢–çWBææÖRÀ¢âââ†–çWBç&Wfö¶P¢ò²&Wfö¶VDC¢æWrFFR‚’Â66ææW%7FFS¢%5DõTB"Ð¢¢·Ò’À¢ÒÀ¢6VÆV7C¢°¢–C¢G'VRÀ¢–ç7Fæ6T–C¢G'VRÀ¢æÖS¢G'VRÀ¢66ææW%7FFS¢G'VRÀ¢&Wfö¶VDC¢G'VRÀ¢ÒÀ¢Ò“°¢v—BVF—B€¢&WÀ¢–çWBç&Wfö¶Rò$U…DTå4”ôåõ$Udô´TB"¢$U…DTå4”ôåõ$TäÔTB"À¢$W‡FVç6–öä–ç7Fæ6R"À¢W‡FVç6–öâæ–BÀ¢“°¢&W2æ§6öâ‡WFFVB“°¢Ò6F6‚†W'&÷"’°¢æW‡B†W'&÷"“°¢Ð¢ÒÀ¢“°¦ç÷7B€¢"ö’öFÖ–âöW‡FVç6–öç2ó¦–Böf÷&6R×7F÷"À¢&WV—&U&öÆR‚$DÔ”â"’À¢7–æ2‡&WÂ&W2’Óâ°¢6öç7BWF‚Ò‡&W2WF…&WVW7B’æWFƒ°¢6öç7B&W7VÇBÒv—B&—6ÖæW‡FVç6–öä–ç7Fæ6RçWFFTÖç’‡°¢v†W&S¢²–C¢7G&–ær‡&Wç&×2æ–B’Âv÷&·76T–C¢WF‚çv÷&·76T–BÒÀ¢FF¢²66ææW%7FFS¢$dõ$4Uõ5DõTB"ÒÀ¢Ò“°¢–b‚&W7VÇBæ6÷VçB’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²W'&÷#¢$æ÷Bf÷VæB"Ò“°¢v—BVF—B€¢&WÀ¢%44ääU%ôdõ$4Uõ5DõTB"À¢$W‡FVç6–öä–ç7Fæ6R"À¢7G&–ær‡&Wç&×2æ–B’À¢“°¢&W2æ§6öâ‡²7F÷VC¢G'VRÒ“°¢ÒÀ¢“°¦ç÷7B€¢"ö’öFÖ–â÷66ææW'2÷7F÷ÖÆÂ"À¢&WV—&U&öÆR‚$DÔ”â"’À¢7–æ2‡&WÂ&W2ÂæW‡B’Óâ°¢G'’°¢6öç7BWF‚Ò‡&W2WF…&WVW7B’æWFƒ°¢v—B&—6ÖæW‡FVç6–öä–ç7Fæ6RçWFFTÖç’‡°¢v†W&S¢²v÷&·76T–C¢WF‚çv÷&·76T–BÂ&Wfö¶VDC¢çVÆÂÒÀ¢FF¢²66ææW%7FFS¢$dõ$4Uõ5DõTB"ÒÀ¢Ò“°¢v—B7F÷66ææW"†WF‚çv÷&·76T–B“°¢v—BVF—B‡&WÂ$ÄÅõ44ääU%5õ5DõTB"Â%v÷&·76R"ÂWF‚çv÷&·76T–B“°¢&W2æ§6öâ‡²7F÷VC¢G'VRÒ“°¢Ò6F6‚†W'&÷"’°¢æW‡B†W'&÷"“°¢Ð¢ÒÀ¢“°¦ævWB‚"ö’öFÖ–â÷66ææW'2"Â&WV—&U&öÆR‚$DÔ”â"’Â7–æ2‡&WÂ&W2’Óâ°¢6öç7Bv÷&·76T–BÒ‡&W2WF…&WVW7B’æWF‚çv÷&·76T–C°¢6öç7B·v÷&·76U66ææW"ÂW‡FVç6–öç5ÒÒv—B&öÖ—6RæÆÂ…°¢&—6Öç66ææW%7FFRæf–æEVæ—VR‡²v†W&S¢²v÷&·76T–BÒÒ’À¢&—6ÖæW‡FVç6–öä–ç7Fæ6Ræf–æDÖç’‡°¢v†W&S¢²v÷&·76T–BÂ&Wfö¶VDC¢çVÆÂÒÀ¢÷&FW$'“¢²Æ7E6VVã¢&FW62"ÒÀ¢6VÆV7C¢°¢–C¢G'VRÀ¢–ç7Fæ6T–C¢G'VRÀ¢æÖS¢G'VRÀ¢66ææW%7FFS¢G'VRÀ¢7W'&VçE6V&6ƒ¢G'VRÀ¢7W'&VçEvS¢G'VRÀ¢vW566ææVC¢G'VRÀ¢&W7VÇG4f÷VæC¢G'VRÀ¢Æ7E6VVã¢G'VRÀ¢ÒÀ¢Ò’À¢Ò“°¢&W2æ§6öâ‡²v÷&·76U66ææW"ÂW‡FVç6–öç2Ò“°§Ò“°¦ævWB‚"ö’öFÖ–âöVF—B"Â&WV—&U&öÆR‚$DÔ”â"’Â7–æ2‡&WÂ&W2’Óâ°¢&W2æ§6öâ€¢v—B&—6ÖæVF—DÆöræf–æDÖç’‡°¢v†W&S¢²v÷&·76T–C¢‡&W2WF…&WVW7B’æWF‚çv÷&·76T–BÒÀ¢÷&FW$'“¢²7&VFVDC¢&FW62"ÒÀ¢F¶S¢SÀ¢–æ6ÇVFS¢°¢7F÷#¢²6VÆV7C¢²–C¢G'VRÂW6W&æÖS¢G'VRÒÒÀ¢ÒÀ¢Ò’À¢“°§Ò“° ¦ævWB‚"ö’öFÖ–âö&6·W2"Â&WV—&U&öÆR‚$DÔ”â"’Â7–æ2…÷&WÂ&W2’Óà¢&W2æ§6öâ€¢v—B&—6Öæ&6·WÖWFFFæf–æDÖç’‡²÷&FW$'“¢²7&VFVDC¢&FW62"ÒÒ’À¢’À¢“°¦ç÷7B‚"ö’öFÖ–âö&6·W2"Â&WV—&U&öÆR‚$DÔ”â"’Â7–æ2‡&WÂ&W2ÂæW‡B’Óâ°¢G'’°¢6öç7BWF‚Ò‡&W2WF…&WVW7B’æWFƒ°¢6öç7B&6·WÒv—B7&VFT&6·W‚$ÔåTÂ"ÂWF‚æ–B“°¢v—BVF—B‡&WÂ$$4µUô5$TDTB"Â$&6·WÖWFFF"Â&6·Wæ–B“°¢&W2ç7FGW2ƒ#’æ§6öâ†&6·W“°¢Ò6F6‚†W'&÷"’°¢æW‡B†W'&÷"“°¢Ð§Ò“°¦ç÷7B€¢"ö’öFÖ–âö&6·W2÷WÆöB"À¢&WV—&U&öÆR‚$DÔ”â"’À¢W‡&W72ç&r‡²G—S¢&Æ–6F–öâöö7FWB×7G&VÒ"ÂÆ–Ö—C¢#Ö""Ò’À¢7–æ2‡&WÂ&W2ÂæW‡B’Óâ°¢G'’°¢6öç7BWF‚Ò‡&W2WF…&WVW7B’æWFƒ°¢–b‚'VffW"æ—4'VffW"‡&Wæ&öG’’¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡²W'&÷#¢$5Æ—FR&6·Wf–ÆR—2&WV—&VB"Ò“°¢6öç7B&6·WÒv—B–×÷'D&6·W‡&Wæ&öG’ÂWF‚æ–B“°¢v—BVF—B‡&WÂ$$4µUõUÄôDTB"Â$&6·WÖWFFF"Â&6·Wæ–B“°¢&W2ç7FGW2ƒ#’æ§6öâ†&6·W“°¢Ò6F6‚†W'&÷"’°¢æW‡B†W'&÷"“°¢Ð¢ÒÀ¢“°¦ævWB€¢"ö’öFÖ–âö&6·W2ó¦–BöF÷væÆöB"À¢&WV—&U&öÆR‚$DÔ”â"’À¢7–æ2‡&WÂ&W2’Óâ°¢6öç7B&6·WÒv—B&—6Öæ&6·WÖWFFFæf–æEVæ—VR‡°¢v†W&S¢²–C¢7G&–ær‡&Wç&×2æ–B’ÒÀ¢Ò“°¢–b‚&6·W’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²W'&÷#¢$æ÷Bf÷VæB"Ò“°¢&W2æF÷væÆöB†&6·Wf–ÆUF‚†&6·Wæf–ÆVæÖR’Â&6·Wæf–ÆVæÖR“°¢ÒÀ¢“°¦æFVÆWFR‚"ö’öFÖ–âö&6·W2ó¦–B"Â&WV—&U&öÆR‚$DÔ”â"’Â7–æ2‡&WÂ&W2’Óâ°¢6öç7B&6·WÒv—B&—6Öæ&6·WÖWFFFæf–æEVæ—VR‡°¢v†W&S¢²–C¢7G&–ær‡&Wç&×2æ–B’ÒÀ¢Ò“°¢–b‚&6·W’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²W'&÷#¢$æ÷Bf÷VæB"Ò“°¢v—BFVÆWFT&6·W†&6·Wæf–ÆVæÖR“°¢v—B&—6Öæ&6·WÖWFFFæFVÆWFR‡²v†W&S¢²–C¢&6·Wæ–BÒÒ“°¢v—BVF—B‡&WÂ$$4µUôDTÄUDTB"Â$&6·WÖWFFF"Â&6·Wæ–B“°¢&W2ç7FGW2ƒ#B’æVæB‚“°§Ò“°¦ç÷7B€¢"ö’öFÖ–âö&6·W2ó¦–B÷&W7F÷&R"À¢&WV—&U&öÆR‚$DÔ”â"’À¢7–æ2‡&WÂ&W2ÂæW‡B’Óâ°¢G'’°¢6öç7BWF‚Ò‡&W2WF…&WVW7B’æWFƒ°¢¢æö&¦V7B‡²6öæf—&Ó¢¢æÆ—FW&Â‚%$U5Dõ$R"’Ò’ç'6R‡&Wæ&öG’“°¢6öç7B&6·WÒv—B&—6Öæ&6·WÖWFFFæf–æEVæ—VR‡°¢v†W&S¢²–C¢7G&–ær‡&Wç&×2æ–B’ÒÀ¢Ò“°¢–b‚&6·W’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²W'&÷#¢$æ÷Bf÷VæB"Ò“°¢v—B7F÷66ææW"†WF‚çv÷&·76T–B“°¢6öç7B&W7VÇBÒv—B&W7F÷&T&6·W†&6·Wæf–ÆVæÖRÂWF‚æ–B“°¢6öç7B·&W7F÷&VD7F÷"Â&W7F÷&VEv÷&·76UÒÒv—B&öÖ—6RæÆÂ…°¢&—6ÖçW6W"æf–æEVæ—VR‡°¢v†W&S¢²–C¢WF‚æ–BÒÀ¢6VÆV7C¢²–C¢G'VRÒÀ¢Ò’À¢&—6Öçv÷&·76Ræf–æEVæ—VR‡°¢v†W&S¢²–C¢WF‚çv÷&·76T–BÒÀ¢6VÆV7C¢²–C¢G'VRÒÀ¢Ò’À¢Ò“°¢v—B&—6ÖæVF—DÆöræ7&VFR‡°¢FF¢°¢v÷&·76T–C¢&W7F÷&VEv÷&·76Sòæ–BÀ¢7F÷$–C¢&W7F÷&VD7F÷#òæ–BÀ¢7F–öã¢$$4µUõ$U5Dõ$TB"À¢F&vWEG—S¢$&6·WÖWFFF"À¢F&vWD–C¢&6·Wæ–BÀ¢ÒÀ¢Ò“°¢6ÆV%6W76–öä6öö¶–R‡&W2“°¢&W2æ§6öâ‡&W7VÇB“°¢Ò6F6‚†W'&÷"’°¢æW‡B†W'&÷"“°¢Ð¢ÒÀ¢“°¦çW6R‚…÷&WÂ&W2’Óâ°¢&W2ç7FGW2ƒCB’æ§6öâ‡²W'&÷#¢$’&÷WFRæ÷Bf÷VæB"Ò“°§Ò“°¦çW6R€¢€¢W'#¢ç’À¢÷&W¢W‡&W72å&WVW7BÀ¢&W3¢W‡&W72å&W7öç6RÀ¢öæW‡C¢W‡&W72äæW‡DgVæ7F–öâÀ¢’Óâ°¢6öç7BGWÆ–6FUW6W&æÖRÐ¢W'#òæ6öFRÓÓÒ%#""b`¢¥4ôâç7G&–æv–g’†W'#òæÖWFòçF&vWBÇÂ""’æ–æ6ÇVFW2‚'W6W&æÖR"“°¢6öç7B7FGW2Ð¢W'#òç7FGW46öFRóð¢†W'#òææÖRÓÓÒ%¦öDW'&÷""òC¢GWÆ–6FUW6W&æÖRòC’¢S“°¢–b‡7FGW2ãÒS’6öç6öÆRæW'&÷"†W'"“°¢&W2ç7FGW2‡7FGW2’æ§6öâ‡°¢W'&÷#¢GWÆ–6FUW6W&æÖP¢ò%W6W&æÖR—2Ç&VG’–âW6Râ ¢¢7FGW2ãÒSbb&ö6W72æVçbääôDUôTåbÓÓÒ'&öGV7F–öâ ¢ò%VæW‡V7FVB6W'fW"W'&÷" ¢¢W'"–ç7Fæ6VöbW'&÷ ¢òW'"æÖW76vP¢¢%VæW‡V7FVB6W'fW"W'&÷""À¢Ò“°¢ÒÀ¢“°¦W‡÷'BFVfVÇB° 