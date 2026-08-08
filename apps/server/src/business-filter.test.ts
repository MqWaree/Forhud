import { afterEach, describe, expect, it } from "vitest";
import {
  isExcludedBusinessPlatform,
  isExcludedBusinessSearchResult,
} from "./business-filter.js";

const originalExcluded = process.env.SEARCH_EXCLUDED_DOMAINS;
const originalAllowed = process.env.SEARCH_ALLOWED_DOMAINS;

afterEach(() => {
  if (originalExcluded === undefined)
    delete process.env.SEARCH_EXCLUDED_DOMAINS;
  else process.env.SEARCH_EXCLUDED_DOMAINS = originalExcluded;
  if (originalAllowed === undefined) delete process.env.SEARCH_ALLOWED_DOMAINS;
  else process.env.SEARCH_ALLOWED_DOMAINS = originalAllowed;
});

describe("business discovery filtering", () => {
  it.each([
    "https://discord.gg/example",
    "https://old.reddit.com/r/business",
    "https://store.steampowered.com/app/123",
    "https://www.linkedin.com/company/example",
    "https://shop.example.amazon.com/item",
  ])("excludes platform URL %s", (url) => {
    expect(isExcludedBusinessPlatform(url)).toBe(true);
  });

  it("keeps direct company websites", () => {
    expect(
      isExcludedBusinessPlatform("https://example-agency.fr/contact"),
    ).toBe(false);
  });

  it.each([
    ["https://elitepvpers.com/forum", "Rust Cheats & Hacks - Buy & Sell"],
    ["https://leetcode.com/discuss", "Best Rust Cheats - Discuss"],
    ["https://guidedhacking.com/threads/rust", "How To Make Rust Cheats?"],
    ["https://cheats.rs/", "Rust Language Cheat Sheet"],
    ["https://bo3.gg/games/articles/rust", "The Best Rust Cheats"],
    [
      "https://ionos.com/digitalguide/server/know-how/rust-cheats/",
      "What are some useful Rust cheats and console commands? - IONOS",
    ],
  ])("excludes non-business search result %s", (url, title) => {
    expect(isExcludedBusinessSearchResult({ url, title })).toBe(true);
  });

  it.each([
    ["https://hera.gg/", "Rust Cheats - Undetected Rust Hacks | HERA.GG"],
    ["https://privatecheatz.com/", "Rust Hacks & Cheats - Undetected ESP"],
    ["https://divisioncheats.com/", "Buy Safe Cheats - Division Cheats"],
    ["https://chamscheats.com/", "Rust Hacks - Best Rust Cheats"],
    ["https://ionos.com/", "Cloud infrastructure and hosting"],
  ])("keeps first-party business result %s", (url, title) => {
    expect(isExcludedBusinessSearchResult({ url, title })).toBe(false);
  });

  it("supports custom exclusions and explicit allow overrides", () => {
    process.env.SEARCH_EXCLUDED_DOMAINS = "directory.example, forum.example";
    expect(
      isExcludedBusinessPlatform("https://fr.directory.example/listing"),
    ).toBe(true);
    process.env.SEARCH_ALLOWED_DOMAINS = "reddit.com";
    expect(
      isExcludedBusinessPlatform("https://www.reddit.com/r/business"),
    ).toBe(false);
  });
});
