/**
 * Wire schema for the `sessionMetrics` projection value.
 *
 * The registry validates every view this unit emits, so a mismatch here would
 * throw on the first tracked step and blank the panel — the schema and the fold
 * must be changed together, and an integration test drives a real step through
 * both to prove they agree.
 */

import { z } from './zod.js';

/** A rate row in integer nanodollars per 1M tokens. */
const nanoRates = z.union([
  z.null(),
  z.object({
    cacheHit: z.number(),
    cacheMiss: z.number(),
    cacheWrite: z.number(),
    output: z.number(),
  }),
]);

/** One resolved model. */
const resolvedModel = z.object({
  model: z.string(),
  aliases: z.array(z.string()),
  label: z.union([z.string(), z.null()]),
  contextWindow: z.union([z.number(), z.null()]),
  mode: z.string(),
  rates: z.object({ flat: nanoRates, peak: nanoRates, offPeak: nanoRates }),
});

/** One resolved provider. */
const resolvedProvider = z.object({
  id: z.string(),
  label: z.string(),
  billing: z.object({
    timezone: z.string(),
    weekdays: z.array(z.number()),
    windows: z.array(z.tuple([z.number(), z.number()])),
    holidays: z.array(z.string()),
    holidayZone: z.string(),
  }),
  models: z.array(resolvedModel),
});

/** One ledger row. */
const ledgerRow = z.object({
  turn: z.union([z.number(), z.null()]),
  step: z.union([z.number(), z.null()]),
  startTime: z.number(),
  endTime: z.union([z.number(), z.null()]),
  provider: z.union([z.string(), z.null()]),
  model: z.union([z.string(), z.null()]),
  tier: z.string(),
  buckets: z.union([
    z.null(),
    z.object({
      uncachedInputTokens: z.number(),
      cacheReadTokens: z.number(),
      cacheWriteTokens: z.number(),
      outputTokens: z.number(),
    }),
  ]),
});

/** A bucket set. */
const buckets = z.object({
  uncachedInputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  outputTokens: z.number(),
});

/**
 * One observed provider/model pair with no rate card.
 *
 * `tokens` is the sum of the buckets attributed to the pair; it is evidence of
 * how much went unpriced, never a cost — a pair without a card has no rate.
 */
const discoveredPair = z.object({
  provider: z.union([z.string(), z.null()]),
  model: z.union([z.string(), z.null()]),
  tokens: z.number(),
  steps: z.number(),
  firstSeen: z.union([z.number(), z.null()]),
  lastSeen: z.union([z.number(), z.null()]),
});

/** The full client-visible value. */
export const sessionMetricsWireSchema = z.object({
  version: z.number(),
  settings: z.object({
    version: z.number(),
    display: z.object({
      currency: z.string(),
      cnyInDetailsFor: z.array(z.string()),
      usdToCny: z.number(),
      labels: z.array(z.string()),
      details: z.array(z.string()),
      primaryProvider: z.union([z.string(), z.null()]),
    }),
    budget: z.object({ sessionUsd: z.union([z.number(), z.null()]), warnAt: z.number() }),
    pricingAsOf: z.union([z.string(), z.null()]),
    providers: z.array(resolvedProvider),
    problems: z.array(z.string()),
  }),
  ledger: z.object({
    turns: z.number(),
    steps: z.number(),
    totals: z.record(buckets),
    rows: z.array(ledgerRow),
    discovered: z.array(discoveredPair),
  }),
});
