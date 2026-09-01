import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { renderLztDiscordCard } from "./lzt-discord-card.js";

describe("FGP Haze LZT card", () => {
  it("renders the compact production PNG", async () => {
    const card = await renderLztDiscordCard({
      itemId: "253099893",
      title: "Rust NFA account",
      priceEurMinor: 219,
      priceUsdMinor: 250,
      inventoryRustEurMinor: 400,
      inventoryCs2EurMinor: 225,
      inventoryTotalEurMinor: 625,
      gamesCount: 4,
      rustHours: 2450,
      alertLabel: "2000+ HRS / UNDER $6",
    });
    const metadata = await sharp(card).metadata();
    expect(metadata).toMatchObject({ format: "png", width: 760, height: 360 });
    expect(card.length).toBeGreaterThan(10_000);
  });
});
