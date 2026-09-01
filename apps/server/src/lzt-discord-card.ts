import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

export type LztDiscordCardListing = {
  itemId: string;
  title: string;
  priceEurMinor: number;
  priceUsdMinor?: number;
  inventoryCs2EurMinor?: number;
  inventoryRustEurMinor?: number;
  inventoryTotalEurMinor?: number;
  gamesCount?: number;
  rustHours?: number;
  alertLabel: string;
};

const WIDTH = 760;
const HEIGHT = 360;
let fontStylePromise: Promise<string> | undefined;

function safeText(value: unknown) {
  return Array.from(String(value ?? ""))
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function xml(value: unknown) {
  return safeText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function money(minor: number | undefined, currency: "EUR" | "USD") {
  if (minor === undefined || !Number.isFinite(minor)) return "Unknown";
  return `${currency === "USD" ? "$" : "€"}${(minor / 100).toFixed(2)}`;
}

function metric(value: number | undefined, maximumFractionDigits = 0) {
  return value === undefined || !Number.isFinite(value)
    ? "Unknown"
    : value.toLocaleString("en-US", { maximumFractionDigits });
}

function metricCard(
  x: number,
  y: number,
  label: string,
  value: string,
  accent: string,
) {
  const width = 224;
  const center = x + width / 2;
  return [
    "<g>",
    `<rect x="${x}" y="${y}" width="${width}" height="68" rx="11" fill="#141620" stroke="#2d3040"/>`,
    `<rect x="${x}" y="${y}" width="${width}" height="2" rx="1" fill="${accent}"/>`,
    `<text class="small" x="${center}" y="${y + 25}" fill="#898da1" font-size="10" letter-spacing="1.2" text-anchor="middle">${xml(label.toUpperCase())}</text>`,
    `<text class="display" x="${center}" y="${y + 51}" fill="#f4f3f9" font-size="17" text-anchor="middle">${xml(value)}</text>`,
    "</g>",
  ].join("");
}

async function fontStyle() {
  fontStylePromise ??= (async () => {
    try {
      const file = resolve(
        process.cwd(),
        "apps/server/assets/fonts/smallest_pixel-7.ttf",
      );
      const font = (await readFile(file)).toString("base64");
      return `<style>@font-face{font-family:SmallestPixel;src:url(data:font/ttf;base64,${font}) format('truetype');font-style:normal;font-weight:400}text{font-family:SmallestPixel,'Segoe UI',sans-serif;text-rendering:geometricPrecision}.display,.small{font-family:SmallestPixel,'Segoe UI',sans-serif;font-weight:400}</style>`;
    } catch {
      return "<style>text{font-family:'DejaVu Sans','Segoe UI',sans-serif}</style>";
    }
  })();
  return fontStylePromise;
}

export async function renderLztDiscordCard(
  listing: LztDiscordCardListing,
): Promise<Buffer> {
  const title = safeText(
    listing.title || `LZT listing ${listing.itemId}`,
  ).slice(0, 78);
  const price =
    listing.priceUsdMinor === undefined
      ? money(listing.priceEurMinor, "EUR")
      : `${money(listing.priceUsdMinor, "USD")} / ${money(listing.priceEurMinor, "EUR")}`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    "<defs>",
    await fontStyle(),
    "<linearGradient id=" +
      '"header" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#1d4ed8"/><stop offset=".5" stop-color="#2563eb"/><stop offset="1" stop-color="#312e81"/></linearGradient>',
    '<pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="#222432" stroke-width="1" opacity=".2"/></pattern>',
    '<filter id="shadow" x="-15%" y="-20%" width="130%" height="160%"><feDropShadow dx="0" dy="9" stdDeviation="10" flood-color="#000" flood-opacity=".65"/></filter>',
    '<clipPath id="clip"><rect x="12" y="10" width="736" height="340" rx="19"/></clipPath>',
    "</defs>",
    '<rect width="760" height="360" fill="#080910"/>',
    '<rect width="760" height="360" fill="url(#grid)"/>',
    '<g filter="url(#shadow)"><rect x="12" y="10" width="736" height="340" rx="19" fill="#0f1118" stroke="#303342"/></g>',
    '<g clip-path="url(#clip)"><rect x="12" y="10" width="736" height="62" fill="url(#header)"/></g>',
    '<text class="display" x="380" y="39" fill="#fff" font-size="24" text-anchor="middle">FGP</text>',
    '<text class="small" x="380" y="57" fill="#dbeafe" font-size="9" letter-spacing="2.6" text-anchor="middle">LZT RUST ACCOUNT RADAR</text>',
    '<rect x="270" y="82" width="220" height="24" rx="12" fill="#111c35" stroke="#3b82f6"/>',
    `<text class="small" x="380" y="98" fill="#dbeafe" font-size="10" letter-spacing=".8" text-anchor="middle">${xml(listing.alertLabel)}</text>`,
    `<text class="display" x="380" y="128" fill="#f5f4f9" font-size="15" text-anchor="middle">${xml(title)}</text>`,
    metricCard(28, 145, "Price", price, "#38bdf8"),
    metricCard(268, 145, "Games", metric(listing.gamesCount), "#60a5fa"),
    metricCard(508, 145, "Rust hours", metric(listing.rustHours, 2), "#818cf8"),
    metricCard(
      28,
      225,
      "Rust inventory · EUR",
      money(listing.inventoryRustEurMinor, "EUR"),
      "#22d3ee",
    ),
    metricCard(
      268,
      225,
      "CS2 inventory · EUR",
      money(listing.inventoryCs2EurMinor, "EUR"),
      "#6366f1",
    ),
    metricCard(
      508,
      225,
      "Total inventory · EUR",
      money(listing.inventoryTotalEurMinor, "EUR"),
      "#a78bfa",
    ),
    `<text class="small" x="380" y="319" fill="#8a8ea2" font-size="10" letter-spacing="1" text-anchor="middle">LISTING ${xml(listing.itemId)}</text>`,
    '<text class="small" x="380" y="336" fill="#54586b" font-size="8" letter-spacing="1.4" text-anchor="middle">LIVE LZT DATA</text>',
    "</svg>",
  ].join("");

  return sharp(Buffer.from(svg, "utf8"))
    .png({ compressionLevel: 9 })
    .toBuffer();
}
