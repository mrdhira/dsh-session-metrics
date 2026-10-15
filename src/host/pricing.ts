/**
 * Billing-window and cost arithmetic for the session-metrics plugin.
 *
 * Everything here is pure: given a resolved provider/model, a token bucket and
 * an instant, it answers "what tier applies" and "what did that cost". No state,
 * no I/O, so the same functions serve the Host fold, the client view and the
 * tests.
 *
 * Money stays in integer nanodollars as plain numbers (see `money.js`); tier is
 * decided from the provider's own calendar, expressed in that provider's zone,
 * while display always converts to the viewer's zone.
 */

import { costOf } from './money.js';

/** Tier used by a provider that declares no peak windows. */
export const FLAT = 'flat';

/** The peak tier. */
export const PEAK = 'peak';

/** The off-peak tier. */
export const OFF_PEAK = 'off-peak';

/**
 * Split an instant into calendar fields in one IANA zone.
 * @param date - the instant.
 * @param timeZone - IANA zone name.
 * @returns weekday (ISO), year, month, day, hour, minute.
 */
/**
 * One formatter per zone, reused.
 *
 * `Intl.DateTimeFormat` construction is expensive and allocates ICU state, and
 * `tierAt` runs once per scanned minute — so building one per call turned a
 * boundary search into thousands of formatter allocations.
 */
const formatters = new Map();

/** The cached formatter for one zone. */
function formatterFor(timeZone: any) {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function zonedParts(date: any, timeZone: any) {
  const parts = formatterFor(timeZone).formatToParts(date);
  const lookup: Record<string, string> = {};
  for (const part of parts) if (part.type !== 'literal') lookup[part.type] = part.value;
  const weekdayNames: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    weekday: weekdayNames[lookup.weekday as string] ?? 0,
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: lookup.hour === '24' ? 0 : Number(lookup.hour),
    minute: Number(lookup.minute),
  };
}

/**
 * Format an instant as a `YYYY-MM-DD` calendar date in one zone.
 * @param date - the instant.
 * @param timeZone - IANA zone name.
 * @returns the local date.
 */
export function zonedDate(date: any, timeZone: any) {
  const { year, month, day } = zonedParts(date, timeZone);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The billing tier for one instant under one provider's calendar.
 * @param date - the instant.
 * @param billing - the provider's resolved calendar.
 * @returns `flat`, `peak` or `off-peak`.
 */
export function tierAt(date: any, billing: any) {
  const windows = billing?.windows ?? [];
  if (windows.length === 0) return FLAT;
  const zone = billing.timezone ?? 'UTC';
  const parts = zonedParts(date, zone);
  if (!(billing.weekdays ?? []).includes(parts.weekday)) return OFF_PEAK;
  if ((billing.holidays ?? []).includes(zonedDate(date, billing.holidayZone ?? zone))) return OFF_PEAK;
  const hour = parts.hour;
  const inWindow = windows.some(([from, to]: [number, number]) => (from <= to ? hour >= from && hour < to : hour >= from || hour < to));
  return inWindow ? PEAK : OFF_PEAK;
}

/**
 * The next instant at which this provider's tier changes.
 * @param fromMs - epoch milliseconds to search from.
 * @param billing - the provider's resolved calendar.
 * @returns epoch milliseconds of the boundary, or null when the rate is flat.
 */
export function nextBoundary(fromMs: any, billing: any) {
  const windows = billing?.windows ?? [];
  if (windows.length === 0) return null;
  const current = tierAt(new Date(fromMs), billing);
  // Hour first, then the minutes inside the hour that changes tier: at most 24
  // hour probes plus 60 minute probes, instead of 4,320 minute probes.
  const hourMs = 3_600_000;
  const start = Math.floor(fromMs / hourMs) * hourMs;
  let boundary = null;
  for (let step = 1; step <= 24 * 4; step += 1) {
    const candidate = start + step * hourMs;
    if (tierAt(new Date(candidate), billing) !== current) {
      boundary = candidate;
      break;
    }
  }
  if (boundary === null) return null;
  for (let step = 1; step <= 60; step += 1) {
    const candidate = boundary - hourMs + step * 60_000;
    if (candidate > fromMs && tierAt(new Date(candidate), billing) !== current) return candidate;
  }
  return boundary;
}

/**
 * The rate row a model charges at one tier.
 * @param model - a resolved model.
 * @param tier - the tier from `tierAt`.
 * @returns the rate row, or null when the model has no card for that tier.
 */
export function ratesAt(model: any, tier: any) {
  if (model === null || model === undefined) return null;
  if (model.mode === 'flat') return model.rates.flat;
  if (tier === PEAK) return model.rates.peak;
  return model.rates.offPeak;
}

/**
 * Find the configured provider and model for a session's reported pair.
 * @param providers - resolved providers.
 * @param providerId - the provider id from the request header.
 * @param modelId - the model id from the request header.
 * @returns `{ provider, model }` with either entry possibly null.
 */
export function findCard(providers: any, providerId: any, modelId: any) {
  const provider = (providers ?? []).find((entry: any) => entry.id === providerId) ?? null;
  if (provider === null) return { provider: null, model: null };
  const model = provider.models.find((entry: any) => entry.model === modelId || entry.aliases.includes(modelId)) ?? null;
  return { provider, model };
}

/**
 * Price one token bucket set against one rate row.
 * @param rates - a nanodollar rate row, or null when unpriced.
 * @param buckets - `uncachedInputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`.
 * @returns the per-bucket and total cost in nanodollars, or null when unpriced.
 */
export function priceBuckets(rates: any, buckets: any) {
  if (rates === null || rates === undefined) return null;
  const cacheHit = costOf(rates.cacheHit, buckets.cacheReadTokens ?? 0);
  const cacheMiss = costOf(rates.cacheMiss, buckets.uncachedInputTokens ?? 0);
  const cacheWrite = costOf(rates.cacheWrite, buckets.cacheWriteTokens ?? 0);
  const output = costOf(rates.output, buckets.outputTokens ?? 0);
  return {
    cacheHitNano: cacheHit,
    cacheMissNano: cacheMiss,
    cacheWriteNano: cacheWrite,
    outputNano: output,
    totalNano: cacheHit + cacheMiss + cacheWrite + output,
  };
}

/**
 * What the cache saved: the extra a miss rate would have charged for the tokens
 * that were read from cache.
 * @param rates - a nanodollar rate row, or null.
 * @param buckets - the token bucket set.
 * @returns nanodollars saved, or null when unpriced or the hit rate is not lower.
 */
export function savingsNano(rates: any, buckets: any) {
  if (rates === null || rates === undefined) return null;
  const difference = rates.cacheMiss - rates.cacheHit;
  if (difference <= 0) return 0;
  return costOf(difference, buckets.cacheReadTokens ?? 0);
}

/**
 * Total tokens across the four billing buckets.
 * @param buckets - the token bucket set.
 * @returns the token count.
 */
export function bucketTotal(buckets: any) {
  return (buckets.uncachedInputTokens ?? 0)
    + (buckets.cacheReadTokens ?? 0)
    + (buckets.cacheWriteTokens ?? 0)
    + (buckets.outputTokens ?? 0);
}

/**
 * An instant rendered in a zone, for the chips and the countdown sentence.
 * @param ms - epoch milliseconds.
 * @param zone - IANA zone name.
 * @param withDate - include the calendar date.
 * @returns the formatted local time.
 */
export function formatInZone(ms: any, zone: any, withDate = false) {
  const parts = zonedParts(new Date(ms), zone);
  const hhmm = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  if (!withDate) return hhmm;
  return `${String(parts.day).padStart(2, '0')} ${String(parts.month).padStart(2, '0')} ${hhmm}`;
}

/**
 * A human countdown between two instants.
 * @param fromMs - the earlier instant.
 * @param toMs - the later instant.
 * @returns `1h 14m`, `14m`, or `less than a minute`.
 */
export function countdown(fromMs: any, toMs: any) {
  // Floor, not round: a countdown should never claim more time has passed than
  // has, so 30 seconds reads as "less than a minute" rather than "1m".
  const minutes = Math.max(0, Math.floor((toMs - fromMs) / 60_000));
  if (minutes < 1) return 'less than a minute';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}
