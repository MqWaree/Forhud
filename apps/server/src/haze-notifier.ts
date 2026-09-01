import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "discord.js-selfbot-v13";
import { convertMinorUnits, getCurrencyRates } from "./currency-rates.js";
import { prisma } from "./db.js";
import { renderLztDiscordCard } from "./lzt-discord-card.js";

const DEFAULT_POLL_MS = 1_000;
const MAX_ATTEMPTS = 5;
const STALE_CLAIM_MS = 120_000;

export type HazeNotifierEnvironment = {
  HAZE_LZT_NOTIFICATIONS_ENABLED?: string;
  DISCORD_USER_TOKEN?: string;
  HAZE_LZT_CHANNEL_ID?: string;
  LZT_ALERT_CHANNEL_ID?: string;
  HAZE_LZT_POLL_MS?: string;
};

export function hazeNotifierConfiguration(
  environment: HazeNotifierEnvironment = process.env,
) {
  const enabled = environment.HAZE_LZT_NOTIFICATIONS_ENABLED === "true";
  const token = environment.DISCORD_USER_TOKEN?.trim() || "";
  const channelId =
    environment.HAZE_LZT_CHANNEL_ID?.trim() ||
    environment.LZT_ALERT_CHANNEL_ID?.trim() ||
    "";
  const rawPollMs = Number(environment.HAZE_LZT_POLL_MS || DEFAULT_POLL_MS);
  return {
    enabled,
    configured: enabled && token.length > 0 && /^\d{5,30}$/.test(channelId),
    token,
    channelId,
    pollMs: Number.isFinite(rawPollMs)
      ? Math.max(500, Math.min(30_000, Math.round(rawPollMs)))
      : DEFAULT_POLL_MS,
  };
}

export function normalizeHazeManualMessage(value: unknown) {
  return Array.from(String(value ?? ""))
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 8 || (code >= 11 && code <= 31) || code === 127
        ? " "
        : character;
    })
    .join("")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 2_000);
}

export async function queueHazeManualMessage(content: unknown) {
  const normalized = normalizeHazeManualMessage(content);
  if (!normalized) throw new Error("Enter a message for Haze to send");
  return prisma.hazeManualMessage.create({
    data: { content: normalized },
    select: { id: true, status: true, createdAt: true },
  });
}

function safeText(value: unknown, max = 180) {
  return Array.from(String(value ?? ""))
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function buildHazeAlertContent(listing: {
  itemId: string;
  title: string;
  publicUrl: string;
  priceEurMinor: number;
  priceUsdMinor: number | null;
  rustHours?: number | null;
  inventoryRustEurMinor?: number | null;
}) {
  const price = [
    listing.priceUsdMinor == null
      ? undefined
      : `$${(listing.priceUsdMinor / 100).toFixed(2)}`,
    `€${(listing.priceEurMinor / 100).toFixed(2)}`,
  ]
    .filter(Boolean)
    .join(" / ");
  const hours =
    listing.rustHours == null || !Number.isFinite(listing.rustHours)
      ? undefined
      : Number(listing.rustHours.toFixed(2)).toLocaleString("en-US");
  const inventory =
    listing.inventoryRustEurMinor == null ||
    !Number.isFinite(listing.inventoryRustEurMinor)
      ? undefined
      : `€${(listing.inventoryRustEurMinor / 100).toFixed(2)}`;
  const dlcMatch = safeText(listing.title).match(
    /(?:\b(\d+)\s*(?:rust\s*)?(?:dlcs?|dlc\s+packs?)\b|\b(?:dlcs?|dlc\s+packs?)\s*[:x-]?\s*(\d+)\b)/i,
  );
  const dlcCount = dlcMatch?.[1] || dlcMatch?.[2];
  const inventoryDetails = [
    inventory ? `${inventory} inventory` : undefined,
    dlcCount ? `${dlcCount} DLC pack${dlcCount === "1" ? "" : "s"}` : undefined,
  ].filter(Boolean);

  return [
    `**${safeText(listing.title || "Rust account")}**`,
    `${price}  •  \`LZT ${safeText(listing.itemId, 80)}\``,
    hours ? `💑 **Rust playtime:** ${hours} hours` : undefined,
    inventoryDetails.length
      ? `🙏 **Rust inventory:** ${inventoryDetails.join(" • ")}`
      : undefined,
    `🔗 **[View listing](${listing.publicUrl})**`,
  ]
    .filter(Boolean)
    .join("\n");
}

export type HazeDeliveryStage =
  | "CURRENCY_RATES"
  | "FETCH_CHANNEL"
  | "RENDER_CARD"
  | "SEND_MESSAGE"
  | "SEND_TEXT_FALLBACK"
  | "SAVE_SENT_STATUS";

function errorField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" || typeof value === "number"
    ? safeText(value, 220)
    : undefined;
}

function errorObjectSummary(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const parts = [
    errorField(record, "name"),
    errorField(record, "message"),
    errorField(record, "code")
      ? "code=" + errorField(record, "code")
      : undefined,
    errorField(record, "status")
      ? "status=" + errorField(record, "status")
      : errorField(record, "statusCode")
        ? "status=" + errorField(record, "statusCode")
        : undefined,
  ].filter((part): part is string => Boolean(part));
  const rawError = record.rawError;
  if (rawError && typeof rawError === "object") {
    const raw = rawError as Record<string, unknown>;
    const rawMessage = errorField(raw, "message");
    const rawCode = errorField(raw, "code");
    if (rawMessage) parts.push("Discord: " + rawMessage);
    if (rawCode) parts.push("Discord code=" + rawCode);
  }
  return parts.length ? Array.from(new Set(parts)).join(" · ") : undefined;
}

export function hazeDeliveryErrorMessage(
  stage: HazeDeliveryStage,
  error: unknown,
) {
  const detail =
    error instanceof Error
      ? [error.name, safeText(error.message, 300)].filter(Boolean).join(": ") +
        (errorObjectSummary(error) ? " · " + errorObjectSummary(error) : "")
      : typeof error === "string" || typeof error === "number"
        ? safeText(error, 300)
        : errorObjectSummary(error) || "Unknown thrown value";
  return safeText(stage + ": " + detail, 500);
}

function retryDelay(attempt: number) {
  return Math.min(300_000, 5_000 * 2 ** Math.max(0, attempt - 1));
}

async function releaseStaleClaims(now = new Date()) {
  await prisma.lztHazeAlert.updateMany({
    where: {
      status: "SENDING",
      claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) },
    },
    data: {
      status: "PENDING",
      claimedAt: null,
      nextAttemptAt: now,
      lastError: "Recovered after an interrupted Haze delivery",
    },
  });
  await prisma.hazeManualMessage.updateMany({
    where: {
      status: "SENDING",
      claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) },
    },
    data: {
      status: "PENDING",
      claimedAt: null,
      nextAttemptAt: now,
      lastError: "Recovered after an interrupted Haze delivery",
    },
  });
}

async function claimNextManualMessage(now = new Date()) {
  const candidate = await prisma.hazeManualMessage.findFirst({
    where: {
      status: "PENDING",
      attempts: { lt: MAX_ATTEMPTS },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return undefined;
  const claimed = await prisma.hazeManualMessage.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    data: {
      status: "SENDING",
      attempts: { increment: 1 },
      claimedAt: now,
      lastError: null,
    },
  });
  if (!claimed.count) return undefined;
  return prisma.hazeManualMessage.findUnique({ where: { id: candidate.id } });
}

async function claimNextAlert(now = new Date()) {
  const candidate = await prisma.lztHazeAlert.findFirst({
    where: {
      status: "PENDING",
      attempts: { lt: MAX_ATTEMPTS },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return undefined;
  const claimed = await prisma.lztHazeAlert.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    data: {
      status: "SENDING",
      attempts: { increment: 1 },
      claimedAt: now,
      lastError: null,
    },
  });
  if (!claimed.count) return undefined;
  return prisma.lztHazeAlert.findUnique({
    where: { id: candidate.id },
    include: { listing: true },
  });
}

export async function runHazeNotifier() {
  const config = hazeNotifierConfiguration();
  if (!config.enabled) {
    console.log("FGP Haze notifier is disabled.");
    return;
  }
  if (!config.configured)
    throw new Error(
      "FGP Haze notifier is enabled but its user token or channel ID is missing",
    );

  const client = new Client();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    client.destroy();
    await prisma.$disconnect();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());

  client.once("ready", async () => {
    console.log("FGP Haze notifier connected.");
    await releaseStaleClaims();
    while (!stopping) {
      const manualMessage = await claimNextManualMessage();
      if (manualMessage) {
        let manualStage: HazeDeliveryStage = "FETCH_CHANNEL";
        try {
          const channel = await client.channels.fetch(config.channelId);
          if (
            !channel ||
            typeof (channel as { send?: unknown }).send !== "function"
          )
            throw new Error("Configured Haze alert channel is unavailable");
          const sender = channel as unknown as {
            send(options: unknown): Promise<{ id?: string }>;
          };
          manualStage = "SEND_MESSAGE";
          const message = await sender.send({
            content: manualMessage.content,
            allowedMentions: { parse: [] },
          });
          manualStage = "SAVE_SENT_STATUS";
          await prisma.hazeManualMessage.update({
            where: { id: manualMessage.id },
            data: {
              status: "SENT",
              sentAt: new Date(),
              claimedAt: null,
              nextAttemptAt: null,
              discordMessageId: message.id || null,
              lastError: null,
            },
          });
        } catch (error) {
          const message = hazeDeliveryErrorMessage(manualStage, error);
          const terminal = manualMessage.attempts >= MAX_ATTEMPTS;
          console.error(
            `FGP Haze manual message ${manualMessage.id} attempt ${manualMessage.attempts}/${MAX_ATTEMPTS} failed: ${message}`,
          );
          await prisma.hazeManualMessage.update({
            where: { id: manualMessage.id },
            data: {
              status: terminal ? "FAILED" : "PENDING",
              claimedAt: null,
              nextAttemptAt: terminal
                ? null
                : new Date(Date.now() + retryDelay(manualMessage.attempts)),
              lastError: safeText(message, 500),
            },
          });
          await sleep(Math.min(config.pollMs, 2_000));
        }
        continue;
      }
      const alert = await claimNextAlert();
      if (!alert) {
        await sleep(config.pollMs);
        continue;
      }
      let stage: HazeDeliveryStage = "CURRENCY_RATES";
      try {
        const rates = await getCurrencyRates();
        const inventoryEur = (amountMinor: number | null) =>
          amountMinor == null
            ? undefined
            : convertMinorUnits(amountMinor, "RUB", "EUR", rates.rates);
        stage = "FETCH_CHANNEL";
        const channel = await client.channels.fetch(config.channelId);
        if (
          !channel ||
          typeof (channel as { send?: unknown }).send !== "function"
        )
          throw new Error("Configured Haze alert channel is unavailable");
        stage = "RENDER_CARD";
        const image = await renderLztDiscordCard({
          itemId: alert.listing.lztItemId,
          title: alert.listing.title,
          priceEurMinor: alert.listing.priceEurMinor,
          priceUsdMinor: alert.listing.priceUsdMinor ?? undefined,
          inventoryCs2EurMinor: inventoryEur(
            alert.listing.inventoryCs2EurMinor,
          ),
          inventoryRustEurMinor: inventoryEur(
            alert.listing.inventoryRustEurMinor,
          ),
          inventoryTotalEurMinor: inventoryEur(
            alert.listing.inventoryTotalEurMinor,
          ),
          gamesCount: alert.listing.gamesCount ?? undefined,
          rustHours: alert.listing.rustHours ?? undefined,
          alertLabel: alert.alertLabel,
        });
        const sender = channel as unknown as {
          send(options: unknown): Promise<{ id?: string }>;
        };
        const content = buildHazeAlertContent({
          itemId: alert.listing.lztItemId,
          title: alert.listing.title,
          publicUrl: alert.listing.publicUrl,
          priceEurMinor: alert.listing.priceEurMinor,
          priceUsdMinor: alert.listing.priceUsdMinor,
          rustHours: alert.listing.rustHours,
          inventoryRustEurMinor: inventoryEur(
            alert.listing.inventoryRustEurMinor,
          ),
        });
        stage = "SEND_MESSAGE";
        let message: { id?: string };
        try {
          message = await sender.send({
            content,
            files: [
              {
                attachment: image,
                name: `fgp-lzt-${safeText(alert.listing.lztItemId, 80)}.png`,
              },
            ],
            allowedMentions: { parse: [] },
          });
        } catch (attachmentError) {
          const attachmentMessage = hazeDeliveryErrorMessage(
            "SEND_MESSAGE",
            attachmentError,
          );
          console.warn(
            `FGP Haze card attachment failed for ${alert.id}; trying text-only: ${attachmentMessage}`,
          );
          stage = "SEND_TEXT_FALLBACK";
          try {
            message = await sender.send({
              content,
              allowedMentions: { parse: [] },
            });
          } catch (fallbackError) {
            throw new Error(
              attachmentMessage +
                " · " +
                hazeDeliveryErrorMessage("SEND_TEXT_FALLBACK", fallbackError),
            );
          }
        }
        stage = "SAVE_SENT_STATUS";
        await prisma.lztHazeAlert.update({
          where: { id: alert.id },
          data: {
            status: "SENT",
            sentAt: new Date(),
            claimedAt: null,
            nextAttemptAt: null,
            discordMessageId: message.id || null,
            lastError: null,
          },
        });
      } catch (error) {
        const message = hazeDeliveryErrorMessage(stage, error);
        console.error(
          `FGP Haze alert ${alert.id} attempt ${alert.attempts}/${MAX_ATTEMPTS} failed: ${message}`,
        );
        const terminal = alert.attempts >= MAX_ATTEMPTS;
        await prisma.lztHazeAlert.update({
          where: { id: alert.id },
          data: {
            status: terminal ? "FAILED" : "PENDING",
            claimedAt: null,
            nextAttemptAt: terminal
              ? null
              : new Date(Date.now() + retryDelay(alert.attempts)),
            lastError: safeText(message, 500),
          },
        });
        await sleep(Math.min(config.pollMs, 2_000));
      }
    }
  });

  await client.login(config.token);
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntryPoint)
  void runHazeNotifier().catch(async (error) => {
    console.error(
      "FGP Haze notifier failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    await prisma.$disconnect().catch(() => undefined);
    process.exitCode = 1;
  });
