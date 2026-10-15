/**
 * Configuration schema and resolution for the session-metrics plugin.
 *
 * Two jobs live here:
 *
 *  1. `Config` — the schema Cordis validates before the plugin activates. It is
 *     exported from the entry module on purpose: the Host serves an entry whose
 *     schema it knows, which is what lets the Plugins sidebar render this
 *     plugin's own configuration page. Cordis reads `Config["~standard"]`, and
 *     that member is an **own enumerable property** rather than a prototype
 *     getter, because a loader that copies own enumerable exports would
 *     otherwise drop it (a failure that once left the row permanently failed).
 *
 *  2. `resolveSettings` — turns validated configuration into the single
 *     JSON-safe object the client reads: providers with integer nanodollar
 *     rates, the billing calendar, the display choices and the budget, plus a
 *     `problems` list. Resolution is deliberately lenient: a malformed provider
 *     is skipped with a recorded problem so a typo can never stop the plugin
 *     from activating.
 */

import { z } from './zod.js';
import { parseRate, scaleRates } from './money.js';

/** A USD-per-1M-token rate as written in configuration. */
const rateValue = () => z.union([z.string(), z.number()]);

/**
 * One rate row: three required buckets, plus an optional explicit cache-write rate.
 *
 * A factory, not a shared constant: schema values are mutable (`.optional()`,
 * `.describe()` and friends chain by mutating), so one instance reused under
 * several keys would carry the last-applied description and default everywhere.
 * @returns a fresh rate-row schema.
 */
const rateRow = () => z.object({
  cacheHit: rateValue().describe('USD per 1M cached-input (cache hit) tokens'),
  cacheMiss: rateValue().describe('USD per 1M uncached-input (cache miss) tokens'),
  output: rateValue().describe('USD per 1M output tokens'),
  cacheWrite: rateValue().optional().describe('USD per 1M cache-write tokens; defaults to the cache-miss rate'),
});

/** How a model is billed: one flat rate, or a peak rate with an off-peak variant. */
const rates = z
  .object({
    flat: rateRow().optional().describe('A single rate for every hour; use instead of peak/offPeak'),
    peak: rateRow().optional(),
    offPeak: rateRow().optional().describe('Explicit off-peak row; omit to derive it from peak'),
    multiplier: z.number().positive().optional().describe('Off-peak fraction of the peak rate; default 0.5'),
  })
  .withDefault({});

/** One billable model of a provider. */
const model = z.object({
  model: z.string().describe('Model id exactly as the provider reports it'),
  aliases: z.array(z.string()).withDefault([]).describe('Other ids billed at this row'),
  label: z.string().optional().describe('Display name'),
  contextWindow: z.number().int().positive().optional().describe('Informational only; the stats pills own context display'),
  rates: rates,
});

/** The calendar that decides peak versus off-peak for one provider. */
const billing = z.object({
  timezone: z.string().withDefault('UTC').describe('IANA zone the windows below are written in'),
  weekdays: z.array(z.number().int().min(1).max(7)).withDefault([1, 2, 3, 4, 5]).describe('ISO weekdays charged at the peak rate'),
  windows: z
    .array(z.tuple([z.number().int(), z.number().int()]))
    .withDefault([])
    .describe('Peak hour windows as [start, end); empty means a flat rate'),
  holidays: z.array(z.string()).withDefault([]).describe('YYYY-MM-DD dates charged off-peak'),
  holidayZone: z.string().withDefault('Asia/Shanghai').describe('Zone the holiday dates are written in'),
});

/** One integrated model provider. */
const provider = z.object({
  id: z.string().describe('Provider id exactly as reported in the request header'),
  label: z.string().optional(),
  models: z.array(model).withDefault([]),
  billing: billing.withDefault({}),
});

/** Presentation choices. */
const display = z.object({
  currency: z.enum(['USD', 'CNY']).withDefault('USD'),
  cnyInDetailsFor: z
    .array(z.string())
    .withDefault([])
    .describe('Providers that also show a CNY figure, in details only'),
  usdToCny: z.number().positive().withDefault(7.1),
  labels: z
    .array(z.string())
    .withDefault(['peak', 'time', 'cost', 'saved', 'provider'])
    .describe('Which chips the strip shows, in order: peak, time, cost, saved, provider, budget (window and savings are legacy aliases for peak+time and saved)'),
  details: z
    .array(z.string())
    .withDefault(['cost', 'savings', 'models', 'window'])
    .describe('Which sections the detail view shows, in order: cost, savings, models, window'),
  primaryProvider: z.string().optional().describe('Provider chip is hidden when the session matches this'),
});

/** Optional per-session spend ceiling. */
const budget = z.object({
  sessionUsd: z.number().positive().optional().describe('Omit or set null to disable'),
  warnAt: z.number().positive().max(1).withDefault(0.75),
});

/**
 * Shipped rate cards. Netra uses its **live** catalog rates, which its own
 * billing ledger reproduced to the cent; the published docs table is roughly
 * 4.47x higher and is deliberately not used.
 */
export const SHIPPED_PROVIDERS = [
  {
    id: 'deepseek-account',
    label: 'DeepSeek (account)',
    models: [
      {
        model: 'deepseek-flash',
        aliases: ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4.1-flash'],
        label: 'DeepSeek V4.1 Flash',
        rates: { peak: { cacheHit: '0.006', cacheMiss: '0.3', output: '1.2' }, multiplier: 0.5 },
      },
      {
        model: 'deepseek-v4-pro',
        aliases: ['deepseek-v4-pro-0813'],
        label: 'DeepSeek V4 Pro',
        rates: { peak: { cacheHit: '0.044', cacheMiss: '1.32', output: '3.96' }, multiplier: 0.5 },
      },
    ],
    billing: { timezone: 'UTC', weekdays: [1, 2, 3, 4, 5], windows: [[1, 4], [6, 10]] },
  },
  {
    id: 'deepseek-official',
    label: 'DeepSeek (API key)',
    models: [
      {
        model: 'deepseek-flash',
        aliases: ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4.1-flash'],
        label: 'DeepSeek V4.1 Flash',
        rates: { peak: { cacheHit: '0.006', cacheMiss: '0.3', output: '1.2' }, multiplier: 0.5 },
      },
      {
        model: 'deepseek-v4-pro',
        aliases: ['deepseek-v4-pro-0813'],
        label: 'DeepSeek V4 Pro',
        rates: { peak: { cacheHit: '0.044', cacheMiss: '1.32', output: '3.96' }, multiplier: 0.5 },
      },
    ],
    billing: { timezone: 'UTC', weekdays: [1, 2, 3, 4, 5], windows: [[1, 4], [6, 10]] },
  },
  {
    id: 'netra-runtime',
    label: 'Netra Runtime',
    models: [
      { model: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash (Netra)', rates: { flat: { cacheHit: '0.01', cacheMiss: '0.1', output: '0.25' } } },
      { model: 'deepseek/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash 0731 (Netra)', rates: { flat: { cacheHit: '0.01', cacheMiss: '0.1', output: '0.25' } } },
    ],
    billing: { timezone: 'UTC', windows: [] },
  },
];

/**
 * The plugin's Config schema, exported so the Host serves and validates this
 * row's configuration.
 *
 * The root carries `.withDefault({})` for a reason found by test rather than
 * reasoning: Cordis validates the row's config *before* the plugin activates, and
 * a row written without a `config:` key passes `undefined`, which a bare object
 * schema rejects as `<root> is required` — leaving the entry permanently failed.
 */
export const Config = z
  .object({
    // Volatile = user-editable in the harness Settings forms. Only fixed-path fields
    // may carry it, which is why the rate rows themselves cannot: a rate lives inside
    // `providers[].models[]`, and the projector rejects volatile under an array.
    display: display.withDefault({}).volatile(),
    budget: budget.withDefault({}).volatile(),
    providers: z.array(provider).withDefault(SHIPPED_PROVIDERS).volatile(),
    pricingFile: z.string().optional().describe('Absolute path to an external rate source; documentation only for now'),
    pricingAsOf: z.string().optional().volatile().describe('Date the copied rates were published'),
  })
  .withDefault({});

/**
 * Resolve one rate row into integer nanodollar fields.
 * @param row - a validated rate row.
 * @returns nanodollar rates per 1M tokens.
 */
function nanoRow(row: any) {
  const cacheMiss = parseRate(row.cacheMiss);
  return {
    cacheHit: parseRate(row.cacheHit),
    cacheMiss,
    cacheWrite: row.cacheWrite === undefined ? cacheMiss : parseRate(row.cacheWrite),
    output: parseRate(row.output),
  };
}

/**
 * Resolve one model's rates into the shape the client computes with.
 * @param input - a validated model row.
 * @returns the resolved model.
 */
function resolveModel(input: any) {
  const flat = input.rates.flat;
  const peakRow = input.rates.peak;
  const multiplier = input.rates.multiplier ?? 0.5;
  const peak = flat === undefined && peakRow !== undefined ? nanoRow(peakRow) : null;
  const offPeak = peak === null
    ? null
    : input.rates.offPeak === undefined
      ? scaleRates(peak, multiplier)
      : nanoRow(input.rates.offPeak);
  return {
    model: input.model,
    aliases: input.aliases,
    label: input.label ?? null,
    contextWindow: input.contextWindow ?? null,
    mode: flat === undefined ? 'peak' : 'flat',
    rates: { flat: flat === undefined ? null : nanoRow(flat), peak, offPeak },
  };
}

/**
 * Resolve one provider, skipping a malformed one with a recorded problem.
 * @param input - the raw provider entry, already schema-validated.
 * @returns the resolved provider.
 */
function resolveProvider(input: any) {
  return {
    id: input.id,
    label: input.label ?? input.id,
    billing: {
      timezone: input.billing.timezone,
      weekdays: input.billing.weekdays,
      windows: input.billing.windows,
      holidays: input.billing.holidays,
      holidayZone: input.billing.holidayZone,
    },
    models: input.models.map(resolveModel),
  };
}

/**
 * Turn raw configuration into the single JSON-safe settings object the client
 * reads. Never throws: a bad provider or a bad scalar is reported in `problems`
 * and everything else still resolves, so a typo cannot stop activation.
 * @param raw - the row's configuration, as written by the user.
 * @returns resolved settings plus any problems found.
 */
export function resolveSettings(raw: any) {
  const problems = [];
  const source = raw === null || typeof raw !== 'object' ? {} : raw;

  let displayValue;
  try {
    displayValue = display.parse(source.display ?? {});
  } catch (error) {
    problems.push(`display: ${error instanceof Error ? error.message : String(error)}`);
    displayValue = display.parse({});
  }

  let budgetValue;
  try {
    budgetValue = budget.parse(source.budget ?? {});
  } catch (error) {
    problems.push(`budget: ${error instanceof Error ? error.message : String(error)}`);
    budgetValue = budget.parse({});
  }

  const providerEntries = Array.isArray(source.providers) && source.providers.length > 0
    ? source.providers
    : SHIPPED_PROVIDERS;
  const providers: any[] = [];
  const seen = new Set();
  providerEntries.forEach((entry: any, index: any) => {
    try {
      const resolved = resolveProvider(provider.parse(entry));
      if (seen.has(resolved.id)) {
        problems.push(`providers[${index}]: duplicate provider id "${resolved.id}" ignored`);
        return;
      }
      seen.add(resolved.id);
      providers.push(resolved);
    } catch (error) {
      problems.push(`providers[${index}]: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  return {
    version: 1,
    display: {
      currency: displayValue.currency,
      cnyInDetailsFor: displayValue.cnyInDetailsFor,
      usdToCny: displayValue.usdToCny,
      labels: displayValue.labels,
      details: displayValue.details,
      primaryProvider: displayValue.primaryProvider ?? null,
    },
    budget: {
      sessionUsd: budgetValue.sessionUsd ?? null,
      warnAt: budgetValue.warnAt,
    },
    pricingAsOf: source.pricingAsOf ?? null,
    providers,
    problems,
  };
}
