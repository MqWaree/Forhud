import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "./db.js";

const scryptAsync = promisify(scrypt);
export const SESSION_COOKIE = "aether_session";
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const PASSWORD_MIN_LENGTH = 12;
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
