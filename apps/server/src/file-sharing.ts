import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Router, type Request, type Response } from "express";
import type { AuthContext, AuthRequest } from "./auth.js";
import { prisma } from "./db.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const DEFAULT_MAX_FILE_BYTES = 100 * MIB;
const DEFAULT_WORKSPACE_QUOTA_BYTES = 2 * GIB;
const MAX_CONFIGURED_FILE_BYTES = GIB;
const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_DOWNLOADS = 20;
const DEFAULT_MAX_DOWNLOADS_PER_FILE = 4;
const DEFAULT_MAX_DOWNLOADS_PER_WORKSPACE = 10;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const INVALID_PRODUCTION_LINK_SECRETS = new Set([
  "replace-with-at-least-32-random-characters",
  "REPLACE_WITH_A_LONG_RANDOM_FILE_LINK_SECRET",
  "fgp-local-file-link-secret-for-development-only",
]);
const PUBLIC_TOKEN_PATTERN = /^([a-z0-9]{20,32})\.([A-Za-z0-9_-]{43})$/;
const uploadQueues = new Map<string, Promise<void>>();
const activeDownloadsByFile = new Map<string, number>();
const activeDownloadsByWorkspace = new Map<string, number>();
const sharedFileIdleWaiters = new Set<() => void>();
let activeDownloads = 0;
let activeSharedFileOperations = 0;
let sharedFileMaintenance = false;

type SharedFileView = {
  id: string;
  uploadedById: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  downloadCount: number;
  lastDownloadedAt: Date | null;
  createdAt: Date;
  uploadedBy: { username: string } | null;
};
type SharedFileReconciliation = {
  missingPayloads: number;
  corruptPayloads: number;
  removedTemporary: number;
  quarantinedOrphans: number;
  quarantinedCorruptPayloads: number;
  restoredPayloads: number;
};
let latestReconciliation: SharedFileReconciliation | null = null;

function httpError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode, expose: true });
}

function configuredInteger(name: string, fallback: number, maximum: number) {
  const configured = process.env[name];
  if (!configured) return fallback;
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum)
    throw new Error(
      `${name} must be a positive integer no larger than ${maximum}`,
    );
  return value;
}

export function sharedFileLimits() {
  const quotaBytes = configuredInteger(
    "FILE_WORKSPACE_QUOTA_BYTES",
    DEFAULT_WORKSPACE_QUOTA_BYTES,
    Number.MAX_SAFE_INTEGER,
  );
  return {
    maxFileBytes: Math.min(
      configuredInteger(
        "FILE_MAX_SIZE_BYTES",
        DEFAULT_MAX_FILE_BYTES,
        MAX_CONFIGURED_FILE_BYTES,
      ),
      quotaBytes,
    ),
    quotaBytes,
    maxFiles: configuredInteger(
      "FILE_WORKSPACE_MAX_FILES",
      DEFAULT_MAX_FILES,
      DEFAULT_MAX_FILES,
    ),
  };
}

export function sharedFileStorageDirectory() {
  const directory = resolve(
    process.env.FILE_STORAGE_DIR ||
      (process.env.NODE_ENV === "production"
        ? "/var/lib/fgp/shared-files"
        : resolve(import.meta.dirname, "../data/shared-files")),
  );
  if (process.env.NODE_ENV === "production") {
    const persistentRoot = resolve("/var/lib/fgp");
    const fromPersistentRoot = relative(persistentRoot, directory);
    if (
      !fromPersistentRoot ||
      fromPersistentRoot.startsWith("..") ||
      isAbsolute(fromPersistentRoot)
    )
      throw new Error(
        "FILE_STORAGE_DIR must be inside /var/lib/fgp in production",
      );
  }
  return directory;
}

function fileLinkSecret() {
  const configured = process.env.FILE_LINK_SECRET || "";
  if (
    process.env.NODE_ENV === "production" &&
    (configured.length < 32 || INVALID_PRODUCTION_LINK_SECRETS.has(configured))
  )
    throw new Error("FILE_LINK_SECRET must contain a unique random secret");
  return configured || "fgp-local-file-link-secret-for-development-only";
}

function filePublicToken(id: string) {
  const signature = createHmac("sha256", fileLinkSecret())
    .update(`fgp-shared-file:${id}`)
    .digest("base64url");
  return `${id}.${signature}`;
}

function validPublicToken(value: string) {
  const match = PUBLIC_TOKEN_PATTERN.exec(value);
  if (!match) return null;
  const [, id, providedSignature] = match;
  const expectedSignature = filePublicToken(id!).split(".")[1]!;
  const provided = Buffer.from(providedSignature!, "base64url");
  const expected = Buffer.from(expectedSignature, "base64url");
  if (
    provided.toString("base64url") !== providedSignature ||
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  )
    return null;
  return id!;
}

function storagePath(storageName: string) {
  if (!/^[0-9a-f-]{36}$/.test(storageName))
    throw new Error("Invalid shared-file storage name");
  return resolve(sharedFileStorageDirectory(), storageName);
}

function originalFilename(req: Request) {
  const encoded = req.get("x-file-name");
  if (!encoded) throw httpError("Choose a file to upload", 400);
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw httpError("The file name is invalid", 400);
  }
  const leaf = decoded.replaceAll("\\", "/").split("/").at(-1)?.trim() || "";
  const cleaned = Array.from(leaf.normalize("NFC"))
    .filter((character) => {
      const codePoint = character.codePointAt(0) || 0;
      const formatControl =
        codePoint === 0x061c ||
        (codePoint >= 0x200b && codePoint <= 0x200f) ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2060 && codePoint <= 0x206f) ||
        codePoint === 0xfeff;
      return codePoint > 31 && codePoint !== 127 && !formatControl;
    })
    .slice(0, 255)
    .join("");
  if (!cleaned || /^\.{1,2}$/.test(cleaned))
    throw httpError("The file name is invalid", 400);
  return cleaned;
}

function uploadedMimeType(req: Request) {
  const value = (req.get("x-file-type") || "application/octet-stream")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value))
    throw httpError("The file type is invalid", 400);
  return value.slice(0, 200);
}

function attachmentHeader(filename: string) {
  const fallback =
    filename
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "_") || "download";
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function canDeleteFile(
  file: Pick<SharedFileView, "uploadedById">,
  auth: Pick<AuthContext, "id" | "role">,
) {
  return (
    file.uploadedById === auth.id ||
    auth.role === "ADMIN" ||
    auth.role === "MANAGER"
  );
}

function publicFile(
  file: SharedFileView,
  auth: Pick<AuthContext, "id" | "role">,
) {
  return {
    id: file.id,
    originalName: file.originalName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    downloadCount: file.downloadCount,
    lastDownloadedAt: file.lastDownloadedAt,
    createdAt: file.createdAt,
    uploadedBy: file.uploadedBy,
    canDelete: canDeleteFile(file, auth),
    downloadPath: `/api/shared-files/public/${filePublicToken(file.id)}`,
  };
}

async function withWorkspaceUploadQueue<T>(
  workspaceId: string,
  operation: () => Promise<T>,
) {
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const previous = uploadQueues.get(workspaceId) || Promise.resolve();
  const queued = previous.catch(() => undefined).then(() => gate);
  uploadQueues.set(workspaceId, queued);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (uploadQueues.get(workspaceId) === queued)
      uploadQueues.delete(workspaceId);
  }
}

class UploadLimiter extends Transform {
  size = 0;
  readonly digest = createHash("sha256");

  constructor(
    private readonly maximum: number,
    private readonly limitMessage: string,
  ) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
    this.size += chunk.length;
    if (this.size > this.maximum)
      return callback(httpError(this.limitMessage, 413));
    this.digest.update(chunk);
    callback(null, chunk);
  }
}

async function fileUsage(workspaceId: string) {
  const aggregate = await prisma.sharedFile.aggregate({
    where: { workspaceId },
    _sum: { sizeBytes: true },
    _count: true,
  });
  return {
    usedBytes: aggregate._sum.sizeBytes || 0,
    fileCount: aggregate._count,
  };
}

async function findPublicFile(publicToken: string) {
  const id = validPublicToken(publicToken);
  if (!id) return null;
  return prisma.sharedFile.findUnique({ where: { id } });
}

function acquireDownload(fileId: string, workspaceId: string) {
  const maximum = configuredInteger(
    "FILE_MAX_CONCURRENT_DOWNLOADS",
    DEFAULT_MAX_DOWNLOADS,
    1_000,
  );
  const maximumForFile = configuredInteger(
    "FILE_MAX_CONCURRENT_DOWNLOADS_PER_FILE",
    DEFAULT_MAX_DOWNLOADS_PER_FILE,
    100,
  );
  const maximumForWorkspace = configuredInteger(
    "FILE_MAX_CONCURRENT_DOWNLOADS_PER_WORKSPACE",
    DEFAULT_MAX_DOWNLOADS_PER_WORKSPACE,
    500,
  );
  const forFile = activeDownloadsByFile.get(fileId) || 0;
  const forWorkspace = activeDownloadsByWorkspace.get(workspaceId) || 0;
  if (
    activeDownloads >= maximum ||
    forFile >= maximumForFile ||
    forWorkspace >= maximumForWorkspace
  )
    return null;
  activeDownloads += 1;
  activeDownloadsByFile.set(fileId, forFile + 1);
  activeDownloadsByWorkspace.set(workspaceId, forWorkspace + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeDownloads = Math.max(0, activeDownloads - 1);
    const remaining = (activeDownloadsByFile.get(fileId) || 1) - 1;
    if (remaining > 0) activeDownloadsByFile.set(fileId, remaining);
    else activeDownloadsByFile.delete(fileId);
    const workspaceRemaining =
      (activeDownloadsByWorkspace.get(workspaceId) || 1) - 1;
    if (workspaceRemaining > 0)
      activeDownloadsByWorkspace.set(workspaceId, workspaceRemaining);
    else activeDownloadsByWorkspace.delete(workspaceId);
  };
}

function beginSharedFileOperation(res: Response) {
  if (sharedFileMaintenance)
    return res
      .status(503)
      .json({ error: "File storage maintenance is in progress" });
  activeSharedFileOperations += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeSharedFileOperations = Math.max(0, activeSharedFileOperations - 1);
    if (activeSharedFileOperations === 0) {
      for (const resolveWaiter of sharedFileIdleWaiters) resolveWaiter();
      sharedFileIdleWaiters.clear();
    }
  };
}

export async function withSharedFileMaintenance<T>(
  operation: () => Promise<T>,
) {
  if (sharedFileMaintenance)
    throw httpError("File storage maintenance is already in progress", 409);
  sharedFileMaintenance = true;
  try {
    if (activeSharedFileOperations > 0) {
      await new Promise<void>((resolveWait, rejectWait) => {
        const timer = setTimeout(() => {
          sharedFileIdleWaiters.delete(onIdle);
          rejectWait(
            httpError(
              "Active file transfers did not finish. Try restore again.",
              409,
            ),
          );
        }, 30_000);
        timer.unref();
        const onIdle = () => {
          clearTimeout(timer);
          resolveWait();
        };
        sharedFileIdleWaiters.add(onIdle);
      });
    }
    return await operation();
  } finally {
    sharedFileMaintenance = false;
  }
}

export async function assertSharedFileStorageReady() {
  sharedFileLimits();
  fileLinkSecret();
  const directory = sharedFileStorageDirectory();
  if (process.env.FGP_MAINTENANCE_PROBE !== "true")
    await mkdir(directory, { recursive: true, mode: 0o750 });
  await access(directory, constants.R_OK | constants.W_OK);
}

export function sharedFileStorageHealth() {
  if (!latestReconciliation) return null;
  return {
    healthy:
      latestReconciliation.missingPayloads === 0 &&
      latestReconciliation.corruptPayloads === 0,
    ...latestReconciliation,
  };
}

async function payloadMatches(
  path: string,
  expected: { sizeBytes: number; sha256: string },
) {
  const fileStat = await stat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!fileStat?.isFile() || fileStat.size !== expected.sizeBytes) return false;
  const digest = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) digest.update(chunk);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  return digest.digest("hex") === expected.sha256;
}

export async function reconcileSharedFileStorage() {
  await assertSharedFileStorageReady();
  const directory = sharedFileStorageDirectory();
  const quarantineDirectory = resolve(directory, ".orphaned");
  await mkdir(quarantineDirectory, { recursive: true, mode: 0o750 });
  const [entries, quarantinedEntries, files] = await Promise.all([
    readdir(directory, { withFileTypes: true }),
    readdir(quarantineDirectory, { withFileTypes: true }),
    prisma.sharedFile.findMany({
      select: { storageName: true, sizeBytes: true, sha256: true },
    }),
  ]);
  const diskFiles = new Set(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
  );
  const quarantinedFiles = new Set(
    quarantinedEntries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );
  let restoredPayloads = 0;
  let corruptPayloads = 0;
  let quarantinedCorruptPayloads = 0;
  let missingPayloads = 0;
  for (const file of files) {
    const currentPath = resolve(directory, file.storageName);
    let corruptCandidate = false;
    if (
      diskFiles.has(file.storageName) &&
      !(await payloadMatches(currentPath, file))
    ) {
      await rename(
        currentPath,
        resolve(
          quarantineDirectory,
          `${file.storageName}.corrupt-${randomUUID()}`,
        ),
      );
      diskFiles.delete(file.storageName);
      corruptCandidate = true;
      quarantinedCorruptPayloads += 1;
    }
    if (
      !diskFiles.has(file.storageName) &&
      quarantinedFiles.has(file.storageName)
    ) {
      const quarantinedPath = resolve(quarantineDirectory, file.storageName);
      if (await payloadMatches(quarantinedPath, file)) {
        await rename(quarantinedPath, currentPath);
        diskFiles.add(file.storageName);
        quarantinedFiles.delete(file.storageName);
        restoredPayloads += 1;
      } else {
        corruptCandidate = true;
      }
    }
    if (!diskFiles.has(file.storageName)) {
      missingPayloads += 1;
      if (corruptCandidate) corruptPayloads += 1;
    }
  }

  const referenced = new Set(files.map((file) => file.storageName));
  let removedTemporary = 0;
  let quarantinedOrphans = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const temporary = /^[0-9a-f-]{36}\.uploading$/.test(entry.name);
    const unreferenced =
      /^[0-9a-f-]{36}$/.test(entry.name) && !referenced.has(entry.name);
    if (temporary) {
      await rm(resolve(directory, entry.name), { force: true });
      removedTemporary += 1;
      continue;
    }
    if (!unreferenced || quarantinedFiles.has(entry.name)) continue;
    await rename(
      resolve(directory, entry.name),
      resolve(quarantineDirectory, entry.name),
    );
    quarantinedFiles.add(entry.name);
    quarantinedOrphans += 1;
  }
  const outcome = {
    missingPayloads,
    corruptPayloads,
    removedTemporary,
    quarantinedOrphans,
    quarantinedCorruptPayloads,
    restoredPayloads,
  };
  latestReconciliation = outcome;
  return outcome;
}

function setDownloadHeaders(
  res: Response,
  file: { originalName: string; mimeType: string; sizeBytes: number },
  actualSize: number,
) {
  res.set({
    "Content-Type": file.mimeType || "application/octet-stream",
    "Content-Length": String(actualSize),
    "Content-Disposition": attachmentHeader(file.originalName),
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
  });
}

export const publicSharedFileRouter = Router();

publicSharedFileRouter.head("/:publicId", async (req, res, next) => {
  const releaseOperation = beginSharedFileOperation(res);
  if (typeof releaseOperation !== "function") return;
  try {
    const file = await findPublicFile(String(req.params.publicId));
    if (!file) return res.status(404).json({ error: "File not found" });
    const fileStat = await stat(storagePath(file.storageName)).catch(
      (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      },
    );
    if (!fileStat?.isFile())
      return res.status(404).json({ error: "File not found" });
    setDownloadHeaders(res, file, fileStat.size);
    res.status(200).end();
  } catch (error) {
    next(error);
  } finally {
    releaseOperation();
  }
});

publicSharedFileRouter.get("/:publicId", async (req, res, next) => {
  const releaseOperation = beginSharedFileOperation(res);
  if (typeof releaseOperation !== "function") return;
  let releaseDownload: (() => void) | null = null;
  let downloadTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const file = await findPublicFile(String(req.params.publicId));
    if (!file) return res.status(404).json({ error: "File not found" });
    const path = storagePath(file.storageName);
    const fileStat = await stat(path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!fileStat?.isFile())
      return res.status(404).json({ error: "File not found" });
    releaseDownload = acquireDownload(file.id, file.workspaceId);
    if (!releaseDownload) {
      res.set("Retry-After", "5");
      return res
        .status(429)
        .json({ error: "Too many active downloads. Try again shortly." });
    }
    res.once("close", releaseDownload);
    downloadTimeout = setTimeout(
      () => res.destroy(new Error("Shared-file download timed out")),
      configuredInteger(
        "FILE_DOWNLOAD_TIMEOUT_MS",
        DEFAULT_DOWNLOAD_TIMEOUT_MS,
        2 * 60 * 60 * 1000,
      ),
    );
    downloadTimeout.unref();
    setDownloadHeaders(res, file, fileStat.size);
    await pipeline(createReadStream(path), res);
    await prisma.sharedFile
      .updateMany({
        where: { id: file.id },
        data: {
          downloadCount: { increment: 1 },
          lastDownloadedAt: new Date(),
        },
      })
      .catch((error) =>
        console.error("Shared-file download count failed", error),
      );
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : undefined);
      return;
    }
    next(error);
  } finally {
    if (downloadTimeout) clearTimeout(downloadTimeout);
    releaseDownload?.();
    releaseOperation();
  }
});

export const sharedFileRouter = Router();

sharedFileRouter.get("/", async (req, res, next) => {
  const releaseOperation = beginSharedFileOperation(res);
  if (typeof releaseOperation !== "function") return;
  try {
    const auth = (req as AuthRequest).auth;
    const workspaceId = auth.workspaceId;
    const [files, usage] = await Promise.all([
      prisma.sharedFile.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "desc" },
        take: 500,
        include: { uploadedBy: { select: { username: true } } },
      }),
      fileUsage(workspaceId),
    ]);
    const limits = sharedFileLimits();
    res.json({
      files: files.map((file) => publicFile(file, auth)),
      usage: { ...usage, ...limits },
    });
  } catch (error) {
    next(error);
  } finally {
    releaseOperation();
  }
});

sharedFileRouter.post("/", async (req, res, next) => {
  const releaseOperation = beginSharedFileOperation(res);
  if (typeof releaseOperation !== "function") return;
  const auth = (req as AuthRequest).auth;
  try {
    if (!req.is("application/octet-stream")) {
      req.resume();
      throw httpError("Upload files as application/octet-stream", 415);
    }
    const contentEncoding = req.get("content-encoding");
    if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
      req.resume();
      throw httpError("Compressed request bodies are not supported", 415);
    }
    const name = originalFilename(req);
    const mimeType = uploadedMimeType(req);
    const contentLengthText = req.get("content-length");
    if (!contentLengthText) {
      req.resume();
      throw httpError("A Content-Length header is required", 411);
    }
    const contentLength = Number(contentLengthText);
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
      req.resume();
      throw httpError("The uploaded file is empty or has an invalid size", 400);
    }

    const created = await withWorkspaceUploadQueue(
      auth.workspaceId,
      async () => {
        if (req.aborted || res.destroyed)
          throw httpError("The upload was cancelled", 499);
        const limits = sharedFileLimits();
        const usage = await fileUsage(auth.workspaceId);
        const remaining = limits.quotaBytes - usage.usedBytes;
        if (usage.fileCount >= limits.maxFiles) {
          req.resume();
          throw httpError(
            "The workspace file-count limit has been reached",
            409,
          );
        }
        if (contentLength > limits.maxFileBytes) {
          req.resume();
          throw httpError("The file exceeds the upload size limit", 413);
        }
        if (remaining <= 0 || contentLength > remaining) {
          req.resume();
          throw httpError(
            "The workspace file-storage quota would be exceeded",
            413,
          );
        }

        const storageName = randomUUID();
        const root = sharedFileStorageDirectory();
        const temporaryPath = resolve(root, `${storageName}.uploading`);
        const finalPath = storagePath(storageName);
        const maximum = Math.min(limits.maxFileBytes, remaining);
        const limitMessage =
          remaining < limits.maxFileBytes
            ? "The workspace file-storage quota would be exceeded"
            : "The file exceeds the upload size limit";
        const limiter = new UploadLimiter(maximum, limitMessage);
        await mkdir(root, { recursive: true, mode: 0o750 });
        try {
          await pipeline(
            req,
            limiter,
            createWriteStream(temporaryPath, { flags: "wx", mode: 0o640 }),
          );
          if (req.aborted || res.destroyed)
            throw httpError("The upload was cancelled", 499);
          if (limiter.size <= 0)
            throw httpError("The uploaded file is empty", 400);
          await rename(temporaryPath, finalPath);
          try {
            return await prisma.$transaction(async (transaction) => {
              const file = await transaction.sharedFile.create({
                data: {
                  workspaceId: auth.workspaceId,
                  uploadedById: auth.id,
                  storageName,
                  originalName: name,
                  mimeType,
                  sizeBytes: limiter.size,
                  sha256: limiter.digest.digest("hex"),
                },
                include: { uploadedBy: { select: { username: true } } },
              });
              await transaction.auditLog.create({
                data: {
                  workspaceId: auth.workspaceId,
                  actorId: auth.id,
                  action: "SHARED_FILE_UPLOADED",
                  targetType: "SharedFile",
                  targetId: file.id,
                  metadata: JSON.stringify({
                    filename: file.originalName,
                    sizeBytes: file.sizeBytes,
                    mimeType: file.mimeType,
                  }),
                  ipAddress: req.ip,
                },
              });
              return file;
            });
          } catch (error) {
            await rm(finalPath, { force: true });
            throw error;
          }
        } finally {
          await rm(temporaryPath, { force: true });
        }
      },
    );
    res.status(201).json(publicFile(created, auth));
  } catch (error) {
    if (req.aborted || res.destroyed) return;
    next(error);
  } finally {
    releaseOperation();
  }
});

sharedFileRouter.delete("/:id", async (req, res, next) => {
  const releaseOperation = beginSharedFileOperation(res);
  if (typeof releaseOperation !== "function") return;
  try {
    const auth = (req as unknown as AuthRequest).auth;
    const id = String(req.params.id);
    if (!id || id.length > 100)
      return res.status(404).json({ error: "File not found" });
    const file = await prisma.sharedFile.findFirst({
      where: { id, workspaceId: auth.workspaceId },
    });
    if (!file) return res.status(404).json({ error: "File not found" });
    if (!canDeleteFile(file, auth))
      return res.status(403).json({ error: "You cannot delete this file" });
    await prisma.$transaction([
      prisma.sharedFile.delete({ where: { id: file.id } }),
      prisma.auditLog.create({
        data: {
          workspaceId: auth.workspaceId,
          actorId: auth.id,
          action: "SHARED_FILE_DELETED",
          targetType: "SharedFile",
          targetId: file.id,
          metadata: JSON.stringify({
            filename: file.originalName,
            sizeBytes: file.sizeBytes,
          }),
          ipAddress: req.ip,
        },
      }),
    ]);
    await rm(storagePath(file.storageName), { force: true }).catch((error) =>
      console.error("Shared-file disk cleanup failed", error),
    );
    res.status(204).end();
  } catch (error) {
    next(error);
  } finally {
    releaseOperation();
  }
});
