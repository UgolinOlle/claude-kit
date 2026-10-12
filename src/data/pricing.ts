/**
 * API list prices in USD per million tokens, used by `claude-kit usage` for *estimates*.
 * Subscription plans aren't billed per token; the figures then show relative cost.
 * Cache writes cost 1.25x input (5-minute TTL) or 2x (1-hour); reads vary per model.
 * Source: Anthropic pricing as of 2026-10. Rot is expected; `claude-kit upgrade` refreshes it.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
}

export const CACHE_WRITE_5M = 1.25;
export const CACHE_WRITE_1H = 2;

/** Longest matching prefix wins, so "claude-opus-5-5" beats "claude-opus-5". */
const PRICES: Record<string, ModelPrice> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-mythos-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cacheRead: 0.08 },
};

const KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);

/** Strips provider prefixes ("anthropic.", "us.anthropic.") and suffixes ("[1m]", "@date"). */
export function normalizeModel(model: string): string {
  return model
    .toLowerCase()
    .replace(/^(?:[a-z]{2}\.)?anthropic\./, "")
    .replace(/\[.*\]$/, "")
    .replace(/[@-]\d{8}(?:-v\d+(?::\d+)?)?$/, "");
}

export function priceFor(model: string): ModelPrice | undefined {
  const id = normalizeModel(model);
  const key = KEYS.find((k) => id === k || id.startsWith(k + "-"));
  return key ? PRICES[key] : undefined;
}

/** Short display name: "claude-opus-5-5" → "opus-5-5". */
export const shortModel = (model: string) =>
  normalizeModel(model).replace(/^claude-/, "");
