import type { NextFunction, Request, Response } from "express";
import { prisma } from "./db.js";
import {
  createSecret,
  generateReadableId,
  hashToken,
  isSecureScannerId,
} from "./auth.js";

export type ExtensionContext = {
  id: string;
  instanceId: string;
  workspaceId: string;
  name: string;
};
export type ExtensionRequest = Request & { extension: ExtensionContext };

export async function pairExtension(input: {
  scannerId: string;
  instanceId?: string;
  name?: string;
}) {
  const scannerId = input.scannerId.trim().toUpperCase();
  if (!isSecureScannerId(scannerId))
    throw Object.assign(new Error("Invalid Scanner ID"), { statusCode: 401 });
  const workspace = await prisma.workspace.findUnique({
    where: { scannerId },
    include: {
      users: {
        where: { role: "ADMIN", status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
  });
  if (!workspace || !workspace.users[0])
    throw Object.assign(new Error("Invalid Scanner ID"), { statusCode: 401 });
  const instanceId =
    input.instanceId?.trim().toUpperCase() || `EXT-${generateReadableId(1, 5)}`;
  if (!/^EXT-[A-Z2-9]{5,12}$/.test(instanceId))
    throw Object.assign(new Error("Invalid extension instance ID"), {
      statusCode: 400,
    });
  const token = createSecret();
  const existing = await prisma.extensionInstance.findUnique({
    where: { instanceId },
  });
  if (existing && existing.workspaceId !== workspace.id)
    throw Object.assign(new Error("Extension instance already paired"), {
      statusCode: 409,
    });
  const extension = await prisma.extensionInstance.upsert({
    where: { instanceId },
    create: {
      instanceId,
      workspaceId: workspace.id,
      ownerUserId: workspace.users[0].id,
      tokenHash: hashToken(token),
      name: input.name?.trim().slice(0, 100) || "Chrome Extension",
      lastSeen: new Date(),
    },
    update: {
      tokenHash: hashToken(token),
      revokedAt: null,
      lastSeen: new Date(),
      name: input.name?.trim().slice(0, 100) || existing?.name,
    },
  });
  return {
    token,
    instanceId: extension.instanceId,
    scannerId: workspace.scannerId,
    workspaceName: workspace.name,
  };
}

export async function requireExtension(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const authorization = req.headers.authorization || "";
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    if (!token)
      return res
        .status(401)
        .json({ error: "Extension authorization required" });
    const extension = await prisma.extensionInstance.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { ownerUser: true },
    });
    if (
      !extension ||
      extension.revokedAt ||
      !extension.ownerUser ||
      extension.ownerUser.status !== "ACTIVE"
    )
      return res.status(401).json({ error: "Extension authorization revoked" });
    (req as ExtensionRequest).extension = {
      id: extension.id,
      instanceId: extension.instanceId,
      workspaceId: extension.workspaceId,
      name: extension.name,
    };
    next();
  } catch (error) {
    next(error);
  }
}
