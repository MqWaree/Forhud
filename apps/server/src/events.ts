import type { Response } from "express";

type EventAudience = { workspaceId: string; userId: string };
const clients = new Map<Response, EventAudience>();

function writeEvent(client: Response, message: string) {
  if (client.writableEnded || client.destroyed) {
    clients.delete(client);
    return;
  }
  try {
    client.write(message);
  } catch {
    clients.delete(client);
  }
}

export function connect(res: Response, workspaceId: string, userId: string) {
  clients.set(res, { workspaceId, userId });
  const heartbeat = setInterval(() => {
    writeEvent(res, `: heartbeat\n\n`);
  }, 25_000);
  heartbeat.unref?.();
  res.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
  writeEvent(res, `event: ready\ndata: {}\n\n`);
}

export function emit(type: string, data: unknown, workspaceId?: string) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [client, audience] of clients) {
    if (!workspaceId || audience.workspaceId === workspaceId)
      writeEvent(client, msg);
  }
}

export function emitToUsers(
  type: string,
  data: unknown,
  userIds: Iterable<string>,
) {
  const allowed = new Set(userIds);
  if (!allowed.size) return;
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [client, audience] of clients)
    if (allowed.has(audience.userId)) writeEvent(client, msg);
}
