import { describe, expect, it } from "vitest";
import {
  csvEscape,
  detectDiscordUrls,
  discordDestinationKind,
  extractDomain,
  extractHttpUrls,
  importLinksSchema,
  leadPatchSchema,
  normalizeDiscordUrl,
  normalizeUrl,
  splitRows,
  splitWebsiteDiscordRows,
} from "./index";
describe("CSV safety", () => {
  it("neutralizes spreadsheet formulas while preserving normal values", () => {
    expect(csvEscape('=HYPERLINK("https://evil.test")')).toBe(
      `"'=HYPERLINK(""https://evil.test"")"`,
    );
    expect(csvEscape("  +cmd|' /C calc'!A0")).toBe("'  +cmd|' /C calc'!A0");
    expect(csvEscape("example.com")).toBe("example.com");
  });
});
describe("URL utilities", () => {
  it("normalizes tracking and slash variants", () =>
    expect(normalizeUrl("HTTPS://Example.COM/path/?utm_source=x#top")).toBe(
      "https://example.com/path",
    ));
  it("extracts a normalized domain", () =>
    expect(extractDomain("https://www.Example.com/a")).toBe("example.com"));
  it("normalizes and deduplicates Discord invites", () =>
    expect(
      detectDiscordUrls(
        '<a href="https://discord.gg/Example/">x</a> discord.com/invite/Example',
      ),
    ).toEqual(["https://discord.gg/Example"]));
  it("rejects unrelated Discord text", () =>
    expect(normalizeDiscordUrl("https://example.com")).toBeNull());
  it("preserves underscore and dash characters in invite codes", () =>
    expect(normalizeDiscordUrl("https://discord.gg/Test_code-2")).toBe(
      "https://discord.gg/Test_code-2",
    ));
  it("distinguishes Discord invites from channel destinations", () => {
    expect(discordDestinationKind("https://discord.gg/Test_code-2")).toBe(
      "invite",
    );
    expect(
      discordDestinationKind(
        "https://discord.com/channels/1309265965082480711/1315932014616248351",
      ),
    ).toBe("channel");
    expect(discordDestinationKind("https://example.com")).toBeNull();
  });
});
describe("manual URL extraction", () => {
  it("extracts HTTP links, trims punctuation, and removes normalized duplicates", () =>
    expect(
      extractHttpUrls(
        "See https://Example.com/a),\nhttps://example.com/a#section and http://two.test/path.",
      ),
    ).toEqual(["https://Example.com/a", "http://two.test/path"]));
  it("accepts bare domains from pasted text and normalizes their scheme", () => {
    expect(
      extractHttpUrls("domain-one.test, https://domain-two.test/path"),
    ).toEqual(["https://domain-two.test/path", "https://domain-one.test"]);
    expect(
      importLinksSchema.parse({ label: "CSV", urls: ["example.com/contact"] })
        .urls,
    ).toEqual(["https://example.com/contact"]);
  });
});
describe("splitRows", () => {
  it("splits only the first occurrence and reports malformed rows", () =>
    expect(splitRows("a:b:c\nnope\nx:y", ":")).toEqual({
      rows: [
        { left: "a", right: "b:c", original: "a:b:c" },
        { left: "x", right: "y", original: "x:y" },
      ],
      malformed: ["nope"],
      total: 3,
    }));
});
describe("splitWebsiteDiscordRows", () => {
  it("separates website and Discord URLs without splitting protocol slashes", () => {
    const result = splitWebsiteDiscordRows(
      "https://wrongcheats.ru/ /https://discord.com/invite/vQEaCzZ2dr",
    );
    expect(result.rows).toEqual([
      {
        left: "https://wrongcheats.ru/",
        right: "https://discord.gg/vQEaCzZ2dr",
        original:
          "https://wrongcheats.ru/ /https://discord.com/invite/vQEaCzZ2dr",
      },
    ]);
    expect(result.malformed).toEqual([]);
  });
  it("extracts Markdown destinations split across adjacent lines", () => {
    const result = splitWebsiteDiscordRows(
      "[https://wrongcheats.ru/](https://wrongcheats.ru/) /\n[Discord](https://discord.gg/example)",
    );
    expect(result.rows[0]).toMatchObject({
      left: "https://wrongcheats.ru/",
      right: "https://discord.gg/example",
    });
  });
  it("counts duplicate pairs and reports malformed input", () => {
    const row = "https://site.test / https://discord.gg/example";
    const result = splitWebsiteDiscordRows(`${row}\n${row}\nnot a pair`);
    expect(result.rows).toHaveLength(1);
    expect(result.duplicates).toBe(1);
    expect(result.malformed).toEqual(["not a pair"]);
  });
});
describe("lead updates and duplicates", () => {
  it("accepts valid lead status updates and rejects unknown values", () => {
    expect(leadPatchSchema.parse({ status: "Researching" })).toEqual({
      status: "Researching",
    });
    expect(() => leadPatchSchema.parse({ status: "Pending" })).toThrow();
  });
  it("normalizes URL variants to the same duplicate key", () =>
    expect(normalizeUrl("https://example.com/?utm_source=a")).toBe(
      normalizeUrl("https://example.com/"),
    ));
});
