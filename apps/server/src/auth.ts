import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "./db.js";

const scryptAsync = promisify(scrypt);
export const SESSION_COOKIE = "aether_session";
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const roles = ["ADMIN", "MANAGER", "RESEARCHER"] as const;
export type Role = (typeof roles)[number];
export type AuthContext = {
  id: string;
  workspaceId: string;
  username: string;
  role: Role;
  status: string;
  requirePasswordChange: boolean;
  workspace: { id: string; name: string; scannerId: string };
};
export interface AuthRequest extends Request {
  auth: AuthContext;
  sessionId: string;
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function secretMatches(provided: string, expected: string) {
  const providedHash = Buffer.from(hashToken(provided), "hex");
  const expectedHash = Buffer.from(hashToken(expected), "hex");
  return timingSafeEqual(providedHash, expectedHash);
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [algorithm, saltText, hashText] = stored.split("$");
  if (algorithm !== "scrypt" || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, "base64url");
  const actual = (await scryptAsync(
    password,
    Buffer.from(saltText, "base64url"),
    expected.length,
  )) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const COMMON_PASSWORD_PATTERN =
  /^(?:password|passw0rd|admin|administrator|welcome|letmein|qwerty|abc|test|user|login|changeme|default)[\s._-]*\d{0,8}[!@#$%^&*]*$/i;

export function passwordStrengthIssue(password: string) {
  const normalized = password.normalize("NFKC");
  if (COMMON_PASSWORD_PATTERN.test(normalized))
    return "Choose a less predictable password";
  if (/^(.)\1+$/u.test(normalized))
    return "Choose a less predictable password";
  if (
    /(?:012345|123456|234567|345678|456789|567890|abcdef|qwerty)/i.test(
      normalized.replace(/[^a-z0-9]/gi, ""),
    )
  )
    return "Choose a less predictable password";

  let poolSize = 0;
  if (/[a-z]/.test(normalized)) poolSize += 26;
  if (/[A-Z]/.test(normalized)) poolSize += 26;
  if (/\d/.test(normalized)) poolSize += 10;
  if (/[^\p{L}\p{N}\s]/u.test(normalized)) poolSize += 33;
  if (/\s/.test(normalized)) poolSize += 1;
  if ([...normalized].some((character) => character.codePointAt(0)! > 127))
    poolSize += 100;

  const uniqueCharacters = new Set(normalized).size;
  const diversityFactor =
    uniqueCharacters <= 2 ? 0.2 : uniqueCharacters <= 4 ? 0.55 : 1;
  const estimatedEntropy =
    normalized.length * Math.log2(Math.max(poolSize, 1)) * diversityFactor;
  if (estimatedEntropy < 50) return "Choose a less predictable password";
  return undefined;
}

export function createSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function generateReadableId(groups = 2, size = 4) {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from({ length: groups }, () =>
    Array.from(
      { length: size },
      () => alphabet[randomBytes(1)[0]! % alphabet.length],
    ).join(""),
  ).join("-");
}

export function generateScannerId() {
  // Four 4-character groups from a 32-character alphabet provide 80 bits of
  // entropy while remaining practical to type into the Chrome extension.
  return generateReadableId(4, 4);
}

export const SCANNER_ID_PATTERN = /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/;
const KNOWN_INSECURE_SCANNER_IDS = new Set(["A7K9-X2P4"]);

export function isSecureScannerId(value: string) {
  const normalized = value.trim().toUpperCase();
  return (
    SCANNER_ID_PATTERN.test(normalized) &&
    !KNOWN_INSECURE_SCANNER_IDS.has(normalized)
  );
}

function cookieValue(req: Request, name: string) {
  const header = req.headers.cookie || "";
  for (const pair of header.split(";")) {
    const at = pair.indexOf("=");
    if (at > 0 && pair.slice(0, at).trim() === name)
      return decodeURIComponent(pair.slice(at + 1).trim());
  }
  return undefined;
}

export function publicUser(user: AuthContext) {
  return {
    id: user.id,
    workspaceId: user.workspaceId,
    username: user.username,
    role: user.role,
    status: user.status,
    requirePasswordChange: user.requirePasswordChange,
    workspace: user.workspace,
  };
}

export async function createSession(
  userId: string,
  _remember: boolean,
  res: Response,
) {
  const token = createSecret();
  // Closing the browser should not require another login. Explicit logout,
  // password resets, account disabling, and this rolling 30-day expiry still
  // revoke the session normally.
  const maxAge = SESSION_MAX_AGE_MS;
  await prisma.authSession.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(Date.now() + maxAge),
    },
  });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const token = cookieValue(req, SESSION_COOKIE);
    if (!token)
      return res.status(401).json({ error: "Authentication required" });
    const session = await prisma.authSession.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: { include: { workspace: true } } },
    });
    if (
      !session ||
      session.expiresAt <= new Date() ||
      session.user.status !== "ACTIVE"
    ) {
      if (session)
        await prisma.authSession.delete({ where: { id: session.id } });
      clearSessionCookie(res);
      return res.status(401).json({ error: "Session expired" });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      const expected = process.env.PUBLIC_APP_ORIGIN || "http://localhost:5173";
      const allowedOrigins = new Set([
        expected,
        ...(process.env.NODE_ENV === "production"
          ? []
          : ["http://localhost:5173", "http://127.0.0.1:5173"]),
      ]);
      if (origin && !allowedOrigins.has(origin))
        return res.status(403).json({ error: "Request origin rejected" });
    }
    const auth = {
      id: session.user.id,
      workspaceId: session.user.workspaceId,
      username: session.user.username,
      role: session.user.role as Role,
      status: session.user.status,
      requirePasswordChange: session.user.requirePasswordChange,
      workspace: session.user.workspace,
    };
    (req as AuthRequest).auth = auth;
    (req as AuthRequest).sessionId = session.id;
    const now = Date.now();
    const shouldRenew =
      session.expiresAt.getTime() - now < SESSION_MAX_AGE_MS / 2;
    if (shouldRenew) {
      const expiresAt = new Date(now + SESSION_MAX_AGE_MS);
      void prisma.authSession.update({
        where: { id: session.id },
        data: { lastSeen: new Date(now), expiresAt },
      });
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: SESSION_MAX_AGE_MS,
      });
    } else if (now - session.lastSeen.getTime() > 5 * 60 * 1000)
      void prisma.authSession.update({
        where: { id: session.id },
        data: { lastSeen: new Date(now) },
      });
    next();
  } catch (error) {
    next(error);
  }
}

export function requireRole(...allowed: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = (req as AuthRequest).auth;
    if (!auth || !allowed.includes(auth.role))
      return res.status(403).json({ error: "Insufficient permissions" });
    next();
  };
}

export async function audit(
  req: Request,
  action: string,
  targetType: string,
  targetId?: string,
  metadata: Record<string, unknown> = {},
) {
  const auth = (req as Partial<AuthRequest>).auth;
  await prisma.auditLog.create({
    data: {
      workspaceId: auth?.workspaceId,
      actorId: auth?.id,
      action,
      targetType,
      targetId,
      metadata: JSON.stringify(metadata),
      ipAddress: req.ip,
    },
  });
}
