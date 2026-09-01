import { describe, expect, it } from "vitest";
import {
  buildHazeAlertContent,
  hazeDeliveryErrorMessage,
  hazeNotifierConfiguration,
  normalizeHazeManualMessage,
} from "./haze-notifier.js";

describe("FGP Haze notifier", () => {
  it("requires an explicit enable flag, user token, and channel", () => {
    expect(hazeNotifierConfiguration({})).toMatchObject({
      enabled: false,
      configured: false,
    });
    expect(
      hazeNotifierConfiguration({
        HAZE_LZT_NOTIFICATIONS_ENABLED: "true",
        DISCORD_USER_TOKEN: "secret",
        HAZE_LZT_CHANNEL_ID: "1522737467307069570",
      }),
    ).toMatchObject({ enabled: true, configured: true, pollMs: 1000 });
  });

  it("normalizes direct messages without removing intentional line breaks", () => {
    expect(
      normalizeHazeManualMessage(
        "  Haze alert  \r\n  Line two\n\n\nLine three  ",
      ),
    ).toBe("Haze alert\nLine two\n\nLine three");
    expect(normalizeHazeManualMessage("x".repeat(2_050))).toHaveLength(2_000);
  });

  it("records the exact delivery stage for Error and Discord-shaped failures", () => {
    expect(
      hazeDeliveryErrorMessage("RENDER_CARD", new Error("font unavailable")),
    ).toContain("RENDER_CARD: Error: font unavailable");
    expect(
      hazeDeliveryErrorMessage("SEND_MESSAGE", {
        message: "Request failed",
        code: 50_013,
        rawError: { message: "Missing Permissions", code: 50_013 },
        token: "must-not-leak",
      }),
    ).toBe(
      "SEND_MESSAGE: Request failed · code=50013 · Discord: Missing Permissions · Discord code=50013",
    );
  });

  it("builds the compact Rust alert with verified listing details", () => {
    const content = buildHazeAlertContent({
      itemId: "251989841",
      title: "RUST 238 hours 25 items 32 Kills 43 Deaths · 2 DLC",
      publicUrl: "https://lzt.market/251989841/",
      priceEurMinor: 828,
      priceUsdMinor: 957,
      rustHours: 238,
      inventoryRustEurMinor: 1245,
    });

    expect(content.split("\n")).toEqual([
      "**RUST 238 hours 25 items 32 Kills 43 Deaths · 2 DLC**",
      "$9.57 / €8.28  •  `LZT 251989841`",
      "💑 **Rust playtime:** 238 hours",
      "🙏 **Rust inventory:** €12.45 inventory • 2 DLC packs",
      "🔗 **[View listing](https://lzt.market/251989841/)**",
    ]);
  });
});
