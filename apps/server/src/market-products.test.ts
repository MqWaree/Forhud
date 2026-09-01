import { describe, expect, it } from "vitest";
import { marketProduct, marketProductKey } from "./market-products.js";

describe("market product scopes", () => {
  it("keeps Rust NFA data on its stable legacy scope", () => {
    expect(marketProduct("ignored", "RUST_NFA")).toEqual({
      key: "rust-nfa-accounts",
      name: "Rust NFA accounts",
      type: "RUST_NFA",
    });
  });

  it("creates stable, type-isolated keys for custom products", () => {
    expect(marketProductKey("Fortnite Accounts", "GAME_ACCOUNTS")).toBe(
      "game-accounts-fortnite-accounts",
    );
    expect(marketProductKey("Fortnite Accounts", "OTHER_ITEMS")).toBe(
      "other-items-fortnite-accounts",
    );
  });
});
