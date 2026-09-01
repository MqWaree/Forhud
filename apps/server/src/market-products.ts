export const marketProductTypes = ["RUST_NFA", "GAME_ACCOUNTS", "OTHER_ITEMS"] as const;
export type MarketProductType = (typeof marketProductTypes)[number];

export type MarketProduct = {
  key: string;
  name: string;
  type: MarketProductType;
};

export function marketProductKey(name: string, type: MarketProductType) {
  if (type === "RUST_NFA") return "rust-nfa-accounts";
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
  return `${type.toLowerCase().replace(/_/g, "-")}-${slug || "product"}`;
}

export function marketProduct(name: string, type: MarketProductType): MarketProduct {
  const cleanName = name.trim().replace(/\s+/g, " ").slice(0, 120);
  const normalizedName = type === "RUST_NFA" ? "Rust NFA accounts" : cleanName;
  return {
    key: marketProductKey(normalizedName, type),
    name: normalizedName,
    type,
  };
}
