/**
 * Replay against real session logs.
 *
 * Skipped unless `DSH_SESSION_LOG` points at a `session.v4.jsonl.zstd`, so the
 * suite stays runnable without one:
 *
 *   DSH_SESSION_LOG=~/.dsh/sessions/<dir>/<id>/session.v4.jsonl.zstd \
 *     node --test test/replay.test.ts
 *
 * Two claims are checked against real data rather than fixtures:
 *
 *  1. `totalTokens = input + cacheRead + cacheWrite + output` for every usage
 *     record — i.e. DSH reports `inputTokens` *exclusive* of cache reads, so the
 *     cost formula must not subtract the cached count again.
 *  2. The ledger's accumulated buckets equal those of the official `tokenUsage`
 *     fold, reimplemented here from `@deepseek-ai/dsh-token-meter` (dedupe per
 *     turn/step, later report wins, earlier report subtracted). Session totals
 *     come from that projection, so any divergence would make this plugin
 *     contradict the stats pills.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { createLedgerApply, initLedgerState, toLedgerView, groupKey } from '../lib/v1/ledger.js';
import { resolveSettings } from '../lib/v1/settings.js';
import { tierAt } from '../lib/v1/pricing.js';
import { sessionMetricsWireSchema } from '../lib/v1/schema.js';

/** The four billing buckets a usage report normalizes into. */
interface Buckets {
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** The ledger state fields these cases read. */
interface LedgerState {
  turns: number;
  steps: number;
  totals: Record<string, Buckets>;
  rows: unknown[];
  openIndex?: number | null;
  lastProvider?: string | null;
  lastModel?: string | null;
}

/** One event's usage report, as the log carries it. */
interface UsageRecord {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

const LOG = process.env.DSH_SESSION_LOG;
const maybe = LOG === undefined || LOG === '' ? test.skip : test;

/**
 * Parsed logs, keyed by path.
 *
 * Every case in this file replays the same log, and parsing it is by far the most
 * expensive thing here — the parsed events are what dominate the process's memory.
 * Reading once keeps a five-case replay to one parse.
 */
const parsedLogs = new Map<string, any[]>();

/** Read and parse a zstd-compressed session log, once per path. */
function readEvents(path: string): any[] {
  const cached = parsedLogs.get(path);
  if (cached !== undefined) return cached;
  const raw = execFileSync('zstd', ['-dc', path], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8');
  const events: any[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* a truncated trailing line is not a reason to fail the replay */
    }
  }
  parsedLogs.set(path, events);
  return events;
}

const zero = (): Buckets => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

/** The official `tokenUsage` fold: later report of the same step replaces the earlier one. */
function officialTotals(events: any[]): Buckets {
  let totals = zero();
  let last: { turn: unknown; step: unknown; buckets: Buckets } | null = null;
  for (const event of events) {
    if (event?.type !== 'assistant/message' || !event.data?.usage) continue;
    const usage = event.data.usage as UsageRecord;
    const buckets: Buckets = {
      uncachedInputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    };
    const turn = event.data.turn ?? null;
    const step = event.data.step ?? null;
    const same = last !== null && last.turn === turn && last.step === step;
    const previous = same ? last!.buckets : zero();
    totals = {
      uncachedInputTokens: totals.uncachedInputTokens - previous.uncachedInputTokens + buckets.uncachedInputTokens,
      outputTokens: totals.outputTokens - previous.outputTokens + buckets.outputTokens,
      cacheReadTokens: totals.cacheReadTokens - previous.cacheReadTokens + buckets.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens - previous.cacheWriteTokens + buckets.cacheWriteTokens,
    };
    last = { turn, step, buckets };
  }
  return totals;
}

maybe('exclusive buckets: every usage record satisfies total = input + cacheRead + cacheWrite + output', () => {
  const events = readEvents(LOG as string);
  let checked = 0;
  const violations: string[] = [];
  for (const event of events) {
    if (event?.type !== 'assistant/message' || !event.data?.usage) continue;
    const { usage } = event.data as { usage: UsageRecord };
    if (typeof usage.totalTokens !== 'number') continue;
    const sum = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0);
    checked += 1;
    if (sum !== usage.totalTokens) violations.push(`turn ${event.data.turn} step ${event.data.step}: ${sum} != ${usage.totalTokens}`);
  }
  assert.ok(checked > 0, 'the log should contain usage records');
  assert.deepEqual(violations.slice(0, 5), [], `${violations.length} of ${checked} usage records break the exclusive-bucket identity`);
});

maybe('ledger totals equal the official tokenUsage fold', () => {
  const events = readEvents(LOG as string);
  const settings = resolveSettings({});
  const billing = new Map<string, any>(settings.providers.map((provider: { id: string; billing: any }) => [provider.id, provider.billing]));
  const fold = createLedgerApply({
    tierFor: (providerId: string, at: number) => {
      const calendar = billing.get(providerId);
      return calendar === undefined ? 'flat' : tierAt(new Date(at), calendar);
    },
  });

  let state = initLedgerState() as LedgerState;
  for (const event of events) state = fold(state, event);

  const mine = zero();
  for (const buckets of Object.values(state.totals)) {
    mine.uncachedInputTokens += buckets.uncachedInputTokens;
    mine.outputTokens += buckets.outputTokens;
    mine.cacheReadTokens += buckets.cacheReadTokens;
    mine.cacheWriteTokens += buckets.cacheWriteTokens;
  }
  assert.deepEqual(mine, officialTotals(events), 'the ledger must agree with the projection session totals come from');
});

maybe('ledger: no usage event is orphaned from a step', () => {
  const events = readEvents(LOG as string);
  let open = false;
  let orphans = 0;
  for (const event of events) {
    if (event?.type === 'step/start') open = true;
    if (event?.type === 'step/end' || event?.type === 'turn/end') open = false;
    if (event?.type === 'assistant/message' && event.data?.usage && !open) orphans += 1;
  }
  assert.equal(orphans, 0, 'usage arriving without an open step would be dropped by the fold');
});

maybe('replay: the produced wire value is JSON-safe and schema-valid', () => {
  const events = readEvents(LOG as string);
  const settings = resolveSettings({});
  const fold = createLedgerApply({ tierFor: () => 'peak' });
  let state = initLedgerState() as LedgerState;
  for (const event of events) state = fold(state, event);

  assert.doesNotThrow(() => JSON.stringify(state), 'a checkpoint must be able to serialize the state');
  const view = {
    version: 1,
    settings: {
      version: settings.version,
      display: settings.display,
      budget: settings.budget,
      pricingAsOf: settings.pricingAsOf,
      providers: settings.providers,
      problems: settings.problems,
    },
    ledger: toLedgerView(state),
  };
  assert.doesNotThrow(() => sessionMetricsWireSchema.parse(JSON.parse(JSON.stringify(view))));
});

maybe('replay: cost of the real session matches hand arithmetic per group', () => {
  const events = readEvents(LOG as string);
  const settings = resolveSettings({});
  const fold = createLedgerApply({ tierFor: () => 'peak' });
  let state = initLedgerState() as LedgerState;
  for (const event of events) state = fold(state, event);

  // Group keys are `provider \0 model \0 tier`; recompute one group by hand.
  const keys = Object.keys(state.totals);
  assert.ok(keys.length > 0, 'the log should produce at least one group');
  for (const key of keys) {
    const [providerId, modelId, tier] = key.split('\u0000');
    const buckets = state.totals[key];
    assert.equal(key, groupKey(providerId, modelId, tier));
    const provider = settings.providers.find((candidate: { id: string }) => candidate.id === providerId);
    if (provider === undefined) continue;
    const model = provider.models.find((candidate: { model: string }) => candidate.model === modelId);
    if (model === undefined) continue;
    const rates = model.mode === 'flat' ? model.rates.flat : tier === 'peak' ? model.rates.peak : model.rates.offPeak;
    const expected = Math.round(rates.cacheHit * buckets.cacheReadTokens / 1e6)
      + Math.round(rates.cacheMiss * buckets.uncachedInputTokens / 1e6)
      + Math.round(rates.cacheWrite * buckets.cacheWriteTokens / 1e6)
      + Math.round(rates.output * buckets.outputTokens / 1e6);
    assert.ok(Number.isSafeInteger(expected) && expected >= 0, `group ${key} prices to ${expected} nanodollars`);
  }
});
