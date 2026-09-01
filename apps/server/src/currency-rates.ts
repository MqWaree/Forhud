import { z } from "zod";

export const supportedDisplayCurrencies = ["DKK", "EUR", "USD", "RUB"] as const;
export type DisplayCurrency = (typeof supportedDisplayCurrencies)[number];
export const supportedSourceCurrencies = [
  ...supportedDisplayCurrencies,
  "GBP",
  "CAD",
  "AUD",
  "UAH",
  "PLN",
  "SEK",
  "NOK",
  "JPY",
  "CNY",
  "USDT",
] as const;

export type CurrencyRateSnapshot = {
  base: "USD";
  rates: Record<string, number>;
  updatedAt: string;
  fetchedAt: string;
  stale: boolean;
  source: "ExchangeRate-API" | "Cached reference rates";
};

const responseSchema = z.object({
  result: z.literal("success"),
  base_code: z.literal("USD"),
  time_last_update_unix: z.number().int().positive(),
  rates: z.record(z.number().positive()),
});

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 6_000;
const FALLBACK_RETRY_MS = 5 * 60 * 1000;
const fallbackRates: Record<string, number> = {
  DKK: 6.470217,
  EUR: 0.867027,
  USD: 1,
  RUB: 82.744352,
  GBP: 0.75,
  CAD: 1.37,
  AUD: 1.53,
  UAH: 41.5,
  PLN: 3.7,
  SEK: 9.5,
  NOK: 10,
  JPY: 147,
  CNY: 7.15,
  USDT: 1,
};
let cachedRates: CurrencyRateSnapshot | undefined;
let cacheExpiresAt = 0;
let pendingRates: Promise<CurrencyRateSnapshot> | undefined;

export function parseCurrencyRates(payload: unknown, fetchedAt = new Date()): CurrencyRateSnapshot {
  const parsed = responseSchema.parse(payload);
  const rates = Object.fromEntries(
    supportedSourceCurrencies.map((currency) => {
      const rate = currency === "USD" || currency === "USDT" ? 1 : parsed.rates[currency];
      if (!rate || !Number.isFinite(rate))
        throw new Error(`Exchange-rate response is missing ${currency}`);
      return [currency, rate];
    }),
  ) as Record<string, number>;
  return {
    base: "USD",
    rates,
    updatedAt: new Date(parsed.time_last_update_unix * 1000).toISOString(),
    fetchedAt: fetchedAt.toISOString(),
    stale: false,
    source: "ExchangeRate-API",
  };
}

export function convertMinorUnits(
  amountMinor: number,
  sourceCurrency: string,
  targetCurrency: DisplayCurrency,
  rates: Record<string, number>,
) {
  const source = sourceCurrency.trim().toUpperCase();
  if (!supportedSourceCurrencies.includes(source as (typeof supportedSourceCurrencies)[number]))
    return undefined;
  const sourceRate = rates[source];
  const targetRate = rates[targetCurrency];
  if (!sourceRate || !targetRate) return undefined;
  return Math.round((amountMinor / sourceRate) * targetRate);
}

async function refreshCurrencyRates(): Promise<CurrencyRateSnapshot> {
  const now = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch("https://open.er-api.com/v6/latest/USD", {
      headers: { Accept: "application/json", "User-Agent": "FGP/1.4 currency conversion" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Exchange-rate provider returned HTTP ${response.status}`);
    const next = parseCurrencyRates(await response.json(), new Date(now));
    cachedRates = next;
    cacheExpiresAt = now + CACHE_TTL_MS;
    return next;
  } catch {
    if (cachedRates) return { ...cachedRates, stale: true };
    const fallback: CurrencyRateSnapshot = {
      base: "USD",
      rates: fallbackRates,
      updatedAt: "2026-08-13T00:02:31.000Z",
      fetchedAt: new Date(now).toISOString(),
      stale: true,
      source: "Cached reference rates",
    };
    cachedRates = fallback;
    cacheExpiresAt = now + FALLBACK_RETRY_MS;
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

export async function getCurrencyRates(): Promise<CurrencyRateSnapshot> {
  const now = Date.now();
  if (cachedRates && now < cacheExpiresAt) return cachedRates;
  if (!pendingRates) {
    pendingRates = refreshCurrencyRates().finally(() => {
      pendingRates = undefined;
    });
  }
  return pendingRates;
}
