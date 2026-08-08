import type { Response } from "express";

const clients = new Map<Response, string>();

export function connect(res: Response, workspaceId: string) {
  clients.set(res, workspaceId);
  res.on("close", () => clients.delete(res));
  res.write(`event: ready\ndata: {}\n\n`);
}

export function emit(type: string, data: unknown, workspaceId?: string) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [client, clientWorkspaceId] of clients) {
    if (!workspaceId || clientWorkspaceId === workspaceId) client.write(msg);
  }
}
