/**
 * Money arithmetic for the session-metrics plugin.
 *
 * Amounts are integer **nanodollars** held as plain JavaScript numbers, never
 * BigInt: a projection unit's state is checkpointed into a store whose row
 * schema requires a losslessly JSON-serializable value, and `JSON.stringify`
 * refuses a BigInt. 2^53 nanodollars is about 9,000,000 USD, so a session total
 * is always a safe integer.
 *
 * Rates are published per 1M tokens; the same unit is used here so a rate and a
 * cost are directly comparable.
 */

/** Nanodollars per USD. */
export const NANO_PER_USD = 1_000_000_000;

/** Tokens per published rate unit. */
export const TOKENS_PER_RATE_UNIT = 1_000_000;

/**
 * Parse a USD-per-1M-token rate into integer nanodollars per 1M tokens.
 * @param value - decimal USD as a string or number.
 * @returns nanodollars per 1M tokens.
 */
export function parseRate(value: any) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`invalid rate "${String(value)}" (expected USD per 1M tokens)`);
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > 9) throw new Error(`rate "${text}" has more than 9 decimals`);
  return Number(whole) * NANO_PER_USD + Number((fraction || '0').padEnd(9, '0'));
}

/**
 * Multiply a per-1M rate by a token count.
 * @param nanoPerMillion - nanodollars per 1M tokens.
 * @param tokens - token count.
 * @returns the cost in nanodollars.
 */
export function costOf(nanoPerMillion: any, tokens: any) {
  if (!tokens) return 0;
  return Math.round((nanoPerMillion * tokens) / TOKENS_PER_RATE_UNIT);
}

/**
 * Scale every field of a rate row by a multiplier, rounding to whole nanodollars.
 * @param rates - a resolved nanodollar rate row.
 * @param multiplier - fraction to apply.
 * @returns the scaled row.
 */
export function scaleRates(rates: any, multiplier: any) {
  const scale = (value: any) => Math.round(value * multiplier);
  return {
    cacheHit: scale(rates.cacheHit),
    cacheMiss: scale(rates.cacheMiss),
    cacheWrite: scale(rates.cacheWrite),
    output: scale(rates.output),
  };
}

/**
 * Format integer nanodollars as a USD string.
 * @param nano - nanodollars.
 * @param digits - decimal places; the default suits sub-cent session costs.
 * @returns the formatted amount.
 */
export function formatUsd(nano: any, digits = 4) {
  if (nano === null || nano === undefined || !Number.isFinite(nano)) return null;
  const negative = nano < 0;
  const magnitude = Math.abs(nano);
  const whole = Math.floor(magnitude / NANO_PER_USD);
  const fraction = Math.round(magnitude - whole * NANO_PER_USD);
  const padded = String(fraction).padStart(9, '0').slice(0, digits);
  return `${negative ? '-' : ''}${whole}.${padded}`;
}

/**
 * Nanodollars to USD as a number, for callers that need to compute rather than
 * display.
 * @param nano - nanodollars.
 * @returns USD as a float.
 */
export function toUsd(nano: any) {
  return nano / NANO_PER_USD;
}
