/**
 * The ledger fold.
 *
 * The ledger is the only structure this plugin folds from session events, so these cases pin
 * the properties the design depends on: one row per step, priced at that step's own model;
 * retries overwrite rather than double-count; totals stay whole while rows are trimmed; and
 * the wire view is plain JSON the Host's schema accepts.
 *
 * Table-driven, positive cases first: a single step, then accumulation, then the awkward
 * inputs (retries, empty usage, unknown providers, trimming).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { initLedgerState, createLedgerApply, toLedgerView, groupKey, bucketsFrom } from '../lib/v1/ledger.js';
import { sessionMetricsWireSchema } from '../lib/v1/schema.js';
import { resolveSettings } from '../lib/v1/settings.js';
import { findCard } from '../lib/v1/pricing.js';

/** The four billing buckets a usage report normalizes into. */
interface Buckets {
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** A raw usage report as an event carries it: counts may be absent, or the provider's bug. */
interface UsageReport {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** One session event, as the fold consumes it. */
interface SessionEvent {
  type: string;
  time?: number;
  data?: Record<string, any>;
}

/** A ledger row; the fold cases index it by field name, so it stays open. */
type LedgerRow = Record<string, any>;

/** The state fields these cases read. */
interface LedgerState {
  turns: number;
  steps: number;
  totals: Record<string, Buckets>;
  rows: LedgerRow[];
  openIndex?: number | null;
  lastProvider?: string | null;
  lastModel?: string | null;
}

/** The fold, as `createLedgerApply` returns it. */
type LedgerApply = (state: LedgerState, event: SessionEvent) => LedgerState;

/** The state a case pins; only the fields it names are asserted. */
interface FoldWant {
  steps?: number;
  turns?: number;
  rows?: number;
  firstRow?: Record<string, any>;
  lastRowStep?: number;
  firstRowStep?: number;
  models?: string[];
  groupCount?: number;
  groupKeys?: string[];
  groupSuffix?: string;
  ordered?: boolean;
  totals?: Record<string, Buckets>;
}

/** One event sequence and the state it must fold into. */
interface FoldCase {
  name: string;
  events: () => SessionEvent[];
  apply?: LedgerApply;
  want: FoldWant;
}

/** One step's options; every field but the time has a default. */
interface StepOptions {
  turn?: number;
  step?: number;
  time: number;
  provider?: string;
  model?: string;
  usage?: UsageReport;
}

/** [name, usage report, expected buckets] — `null` means "not a billable report". */
type BucketCase = [name: string, usage: UsageReport | null, want: Buckets | null];

const BASE = Date.parse('2026-10-15T01:00:00Z');
const peakKey = groupKey('deepseek-account', 'deepseek-flash', 'peak');
const fold = createLedgerApply({ tierFor: () => 'peak' });

/**
 * A fold backed by the **shipped** cards, so "configured" means what the plugin really
 * ships: `openrouter`'s free models have zero-rate cards and are therefore priced at
 * `$0.00` rather than discovered, while its paid models have none and are discovered.
 */
const shippedSettings = resolveSettings({});
const discoveryFold = createLedgerApply({
  tierFor: () => 'flat',
  hasCard: (provider: any, model: any) => findCard(shippedSettings.providers, provider, model).model !== null,
});

/** Drive a sequence of events through the fold. */
function run(events: SessionEvent[], apply: LedgerApply = fold): LedgerState {
  let state = initLedgerState() as LedgerState;
  for (const event of events) state = apply(state, event);
  return state;
}

/** A complete step on one provider/model. */
function step({ turn = 1, step: index = 1, time, provider = 'deepseek-account', model = 'deepseek-flash', usage }: StepOptions): SessionEvent[] {
  return [
    { type: 'request/header', time, data: { header: { config: { provider, model } } } },
    { type: 'step/start', time, data: { turn, step: index } },
    { type: 'assistant/message', time: time + 500, data: { turn, step: index, usage } },
    { type: 'step/end', time: time + 500, data: { turn, step: index } },
  ];
}

/** Usage reports in, billing buckets out. `null` means "not a billable report". */
const BUCKET_CASES: BucketCase[] = [
  ['every bucket present', { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
    { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 }],
  ['only input, everything else absent', { inputTokens: 10 },
    { uncachedInputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }],
  ['an all-zero report is not a bucket set', {}, null],
  ['no report at all', null, null],
  // A negative count is a provider bug. Clamping it keeps the buckets that are
  // trustworthy instead of discarding the report, so the step is still priced for
  // what it really used.
  ['a negative count clamps to zero and keeps its siblings', { inputTokens: -5, outputTokens: 3 },
    { uncachedInputTokens: 0, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 }],
  ['an all-non-positive report yields nothing', { inputTokens: -5, outputTokens: -1 }, null],
];

/** Event sequences and the state they must fold into. */
const FOLD_CASES: FoldCase[] = [
  {
    name: 'one step records one row and one group',
    events: () => step({ time: BASE, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000 } }),
    want: {
      steps: 1, turns: 0, rows: 1,
      firstRow: { buckets: { uncachedInputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 50 }, tier: 'peak' },
      totals: { [peakKey]: { uncachedInputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 50 } },
    },
  },
  {
    name: 'steps accumulate into one group under the same model',
    events: () => {
      const base = BASE;
      return [
        { type: 'turn/start', time: base, data: { turn: 1 } },
        ...step({ time: base, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000 } }),
        ...step({ step: 2, time: base + 1000, usage: { inputTokens: 200, outputTokens: 60, cacheReadTokens: 2000 } }),
      ];
    },
    want: {
      steps: 2, turns: 1, rows: 2,
      totals: { [peakKey]: { uncachedInputTokens: 300, cacheReadTokens: 3000, cacheWriteTokens: 0, outputTokens: 110 } },
    },
  },
  {
    name: 'a switched model keeps its own group, so it cannot be mispriced',
    events: () => [
      ...step({ time: BASE, model: 'deepseek-flash', usage: { inputTokens: 10, outputTokens: 1 } }),
      ...step({ step: 2, time: BASE + 1000, model: 'deepseek-v4-pro', usage: { inputTokens: 20, outputTokens: 2 } }),
    ],
    want: {
      steps: 2, rows: 2,
      models: ['deepseek-flash', 'deepseek-v4-pro'],
      groupKeys: [groupKey('deepseek-account', 'deepseek-flash', 'peak'), groupKey('deepseek-account', 'deepseek-v4-pro', 'peak')],
    },
  },
  {
    name: 'an in-step retry overwrites instead of double counting',
    events: () => [
      { type: 'request/header', time: BASE, data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } } } },
      { type: 'step/start', time: BASE, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', time: BASE + 100, data: { usage: { inputTokens: 999, outputTokens: 999 } } },
      { type: 'assistant/message', time: BASE + 200, data: { usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 } } },
      { type: 'step/end', time: BASE + 200, data: { turn: 1, step: 1 } },
    ],
    want: {
      steps: 1, rows: 1,
      totals: { [peakKey]: { uncachedInputTokens: 10, cacheReadTokens: 30, cacheWriteTokens: 0, outputTokens: 20 } },
    },
  },
  {
    name: 'a step with no usage records a row but adds no money',
    events: () => [
      { type: 'request/header', time: BASE, data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } } } },
      { type: 'step/start', time: BASE, data: { turn: 1, step: 1 } },
      { type: 'step/end', time: BASE + 100, data: { turn: 1, step: 1 } },
    ],
    want: { steps: 1, rows: 1, firstRow: { buckets: null }, totals: {} },
  },
  {
    name: 'the tier comes from the injected resolver, so a calendar change is visible',
    events: () => step({ time: BASE, usage: { inputTokens: 1, outputTokens: 1 } }),
    apply: createLedgerApply({ tierFor: () => 'off-peak' }),
    want: { steps: 1, rows: 1, firstRow: { tier: 'off-peak' }, groupSuffix: 'off-peak' },
  },
  {
    name: 'an unknown provider still records, so the client can report it unpriced',
    events: () => step({ time: BASE, provider: 'session-title-first-prompt-llm', model: 'x', usage: { inputTokens: 5, outputTokens: 1 } }),
    want: { steps: 1, rows: 1, firstRow: { provider: 'session-title-first-prompt-llm' }, groupCount: 1 },
  },
  {
    name: 'a long session trims rows but never loses money',
    events: () => {
      const events: SessionEvent[] = [];
      for (let index = 1; index <= 260; index += 1) {
        events.push(...step({ step: index, time: BASE + index * 1000, usage: { inputTokens: 1, outputTokens: 1 } }));
      }
      return events;
    },
    want: {
      steps: 260, rows: 200,
      totals: { [peakKey]: { uncachedInputTokens: 260, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 260 } },
      lastRowStep: 260,
    },
  },
  {
    name: 'trimming drops the oldest rows and keeps the rest in order',
    events: () => {
      const events: SessionEvent[] = [];
      for (let index = 1; index <= 205; index += 1) {
        events.push(...step({ step: index, time: BASE + index * 1000, usage: { inputTokens: 1, outputTokens: 1 } }));
      }
      return events;
    },
    want: { steps: 205, rows: 200, ordered: true, firstRowStep: 6 },
  },
];

/** One pair the discovery list records, as the wire view reports it. */
interface DiscoveredWant {
  provider: string | null;
  model: string | null;
  tokens: number;
  reports: number;
}

/** One event sequence and the unpriced pairs it must record. */
interface DiscoveryCase {
  name: string;
  events: () => SessionEvent[];
  want: DiscoveredWant[];
  /** The totals groups the case also pins, when the pair it left must have none. */
  groups?: string[];
}

/**
 * Discovery cases, in code-flow order: pairs with no card are recorded; pairs with a
 * card — including a zero-rate free one — are not; and the list obeys the same
 * replace-not-add accounting as `totals` while staying bounded.
 */
const DISCOVERY_CASES: DiscoveryCase[] = [
  {
    name: 'a pair with no card is recorded once, deduped, with its tokens summed',
    events: () => [
      ...step({ time: BASE, provider: 'openrouter', model: 'auto', usage: { inputTokens: 100, outputTokens: 10 } }),
      ...step({ step: 2, time: BASE + 1000, provider: 'openrouter', model: 'auto', usage: { inputTokens: 50, cacheReadTokens: 25 } }),
    ],
    want: [{ provider: 'openrouter', model: 'auto', tokens: 185, reports: 2 }],
  },
  {
    name: 'the biggest unpriced spend is listed first',
    events: () => [
      ...step({ time: BASE, provider: 'openrouter', model: 'auto', usage: { inputTokens: 10, outputTokens: 1 } }),
      ...step({ step: 2, time: BASE + 1000, provider: 'openrouter', model: 'anthropic/claude-opus-4.7', usage: { inputTokens: 10_000, outputTokens: 1_000 } }),
    ],
    want: [
      { provider: 'openrouter', model: 'anthropic/claude-opus-4.7', tokens: 11_000, reports: 1 },
      { provider: 'openrouter', model: 'auto', tokens: 11, reports: 1 },
    ],
  },
  {
    name: 'a configured pair is not discovered',
    events: () => step({ time: BASE, usage: { inputTokens: 100, outputTokens: 10 } }),
    want: [],
  },
  {
    name: 'a free model with a zero-rate card is priced, not discovered',
    events: () => step({ time: BASE, provider: 'openrouter', model: 'nvidia/nemotron-3.5-lightning:free', usage: { inputTokens: 100, outputTokens: 10 } }),
    want: [],
  },
  {
    name: 'an unknown model under a configured provider is discovered',
    events: () => step({ time: BASE, provider: 'deepseek-account', model: 'nope', usage: { inputTokens: 100, outputTokens: 10 } }),
    want: [{ provider: 'deepseek-account', model: 'nope', tokens: 110, reports: 1 }],
  },
  {
    name: 'a step that reports no usage discovers nothing',
    events: () => [
      { type: 'request/header', time: BASE, data: { header: { config: { provider: 'openrouter', model: 'auto' } } } },
      { type: 'step/start', time: BASE, data: { turn: 1, step: 1 } },
      { type: 'step/end', time: BASE + 100, data: { turn: 1, step: 1 } },
    ],
    want: [],
  },
  {
    // The same retry the FOLD_CASES pin for `totals`, through the discovery list: the
    // later report replaces the earlier one, so the pair carries 60 tokens from one
    // report — never 2,058 from two.
    name: 'an in-step retry replaces its report instead of summing it',
    events: () => [
      { type: 'request/header', time: BASE, data: { header: { config: { provider: 'openrouter', model: 'auto' } } } },
      { type: 'step/start', time: BASE, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', time: BASE + 100, data: { usage: { inputTokens: 999, outputTokens: 999 } } },
      { type: 'assistant/message', time: BASE + 200, data: { usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 } } },
      { type: 'step/end', time: BASE + 200, data: { turn: 1, step: 1 } },
    ],
    want: [{ provider: 'openrouter', model: 'auto', tokens: 60, reports: 1 }],
    groups: [groupKey('openrouter', 'auto', 'flat')],
  },
  {
    // The abandoned pair is left with no totals group, so it must be left with no
    // discovery row either: the panel would otherwise name a pair this session did
    // not spend on.
    name: 'a retry that switches to a carded pair leaves nothing behind for the pair it left',
    events: () => [
      { type: 'request/header', time: BASE, data: { header: { config: { provider: 'openrouter', model: 'auto' } } } },
      { type: 'step/start', time: BASE, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', time: BASE + 100, data: { usage: { inputTokens: 100 } } },
      { type: 'request/header', time: BASE + 150, data: { header: { config: { provider: 'openrouter', model: 'nvidia/nemotron-3.5-lightning:free' } } } },
      { type: 'assistant/message', time: BASE + 200, data: { usage: { inputTokens: 10 } } },
      { type: 'step/end', time: BASE + 200, data: { turn: 1, step: 1 } },
    ],
    want: [],
    groups: [groupKey('openrouter', 'nvidia/nemotron-3.5-lightning:free', 'flat')],
  },
  {
    name: 'a retry that switches between two uncarded pairs keeps only the one it landed on',
    events: () => [
      { type: 'request/header', time: BASE, data: { header: { config: { provider: 'openrouter', model: 'auto' } } } },
      { type: 'step/start', time: BASE, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', time: BASE + 100, data: { usage: { inputTokens: 100 } } },
      { type: 'request/header', time: BASE + 150, data: { header: { config: { provider: 'openrouter', model: 'anthropic/claude-opus-4.7' } } } },
      { type: 'assistant/message', time: BASE + 200, data: { usage: { inputTokens: 10 } } },
      { type: 'step/end', time: BASE + 200, data: { turn: 1, step: 1 } },
    ],
    want: [{ provider: 'openrouter', model: 'anthropic/claude-opus-4.7', tokens: 10, reports: 1 }],
    groups: [groupKey('openrouter', 'anthropic/claude-opus-4.7', 'flat')],
  },
  {
    name: 'the list is bounded: more unpriced pairs than the limit keeps the first ones',
    events: () => {
      const events: SessionEvent[] = [];
      for (let index = 0; index < 40; index += 1) {
        // Zero-padded so the expected order is explicit: the view sorts by spend and
        // then by the pair key, which for equal spend is a string order.
        events.push(...step({ step: index + 1, time: BASE + index * 1000, provider: 'some-router', model: `model-${String(index).padStart(2, '0')}`, usage: { inputTokens: 1, outputTokens: 1 } }));
      }
      return events;
    },
    want: Array.from({ length: 32 }, (_, index) => ({ provider: 'some-router', model: `model-${String(index).padStart(2, '0')}`, tokens: 2, reports: 1 })),
  },
  {
    // The bound caps *new* pairs, not updates: the first pair is already on the list
    // once the cap is reached, so a later report must still land on it.
    name: 'past the bound, a pair already on the list keeps updating and the list stays full',
    events: () => {
      const events: SessionEvent[] = [];
      for (let index = 0; index < 40; index += 1) {
        events.push(...step({ step: index + 1, time: BASE + index * 1000, provider: 'some-router', model: `model-${String(index).padStart(2, '0')}`, usage: { inputTokens: 1, outputTokens: 1 } }));
      }
      events.push(...step({ step: 41, time: BASE + 40_000, provider: 'some-router', model: 'model-00', usage: { inputTokens: 1, outputTokens: 1 } }));
      return events;
    },
    want: [
      { provider: 'some-router', model: 'model-00', tokens: 4, reports: 2 },
      ...Array.from({ length: 31 }, (_, index) => ({ provider: 'some-router', model: `model-${String(index + 1).padStart(2, '0')}`, tokens: 2, reports: 1 })),
    ],
  },
];

test('buckets: a usage report normalizes into the four billing buckets', () => {
  for (const [name, usage, want] of BUCKET_CASES) {
    assert.deepEqual(bucketsFrom(usage), want, name);
  }
});

test('fold: every event sequence folds into the expected rows and totals', () => {
  for (const { name, events, apply = fold, want } of FOLD_CASES) {
    const state = run(events(), apply);
    if (want.steps !== undefined) assert.equal(state.steps, want.steps, `${name}: steps`);
    if (want.turns !== undefined) assert.equal(state.turns, want.turns, `${name}: turns`);
    if (want.rows !== undefined) assert.equal(state.rows.length, want.rows, `${name}: rows`);
    if (want.firstRow) {
      for (const [key, value] of Object.entries(want.firstRow)) {
        assert.deepEqual(state.rows[0][key], value, `${name}: first row ${key}`);
      }
    }
    if (want.lastRowStep !== undefined) assert.equal(state.rows[state.rows.length - 1].step, want.lastRowStep, `${name}: newest row survives`);
    if (want.firstRowStep !== undefined) assert.equal(state.rows[0].step, want.firstRowStep, `${name}: oldest rows dropped`);
    if (want.models) assert.deepEqual(state.rows.map((row) => row.model), want.models, `${name}: models in order`);
    if (want.groupCount !== undefined) assert.equal(Object.keys(state.totals).length, want.groupCount, `${name}: groups`);
    if (want.groupKeys) {
      for (const key of want.groupKeys) assert.ok(Object.keys(state.totals).includes(key), `${name}: group ${key}`);
    }
    if (want.groupSuffix) {
      assert.ok(Object.keys(state.totals)[0].endsWith(want.groupSuffix), `${name}: group carries the tier`);
    }
    if (want.ordered) {
      const steps = state.rows.map((row) => row.step);
      assert.deepEqual(steps, steps.slice().sort((a, b) => a - b), `${name}: trimming must not reorder`);
    }
    if (want.totals) assert.deepEqual(state.totals, want.totals, `${name}: totals`);
  }
});

test('discovery: unpriced pairs are recorded once, deduped, bounded and priced nowhere', () => {
  for (const { name, events, want, groups } of DISCOVERY_CASES) {
    const state = run(events(), discoveryFold);
    const view = toLedgerView(state);
    const got = view.discovered.map((entry: any) => ({
      provider: entry.provider, model: entry.model, tokens: entry.tokens, reports: entry.reports,
    }));
    assert.deepEqual(got, want, name);
    if (groups !== undefined) {
      assert.deepEqual(Object.keys(state.totals).sort(), groups.slice().sort(), `${name}: totals groups`);
    }
  }
  // A discovered pair still has its tokens banked: the client can say what was seen even
  // though it refuses to price it.
  const state = run(step({ time: BASE, provider: 'openrouter', model: 'auto', usage: { inputTokens: 7, outputTokens: 3 } }), discoveryFold);
  assert.deepEqual(Object.keys(state.totals), [groupKey('openrouter', 'auto', 'flat')], 'the tokens still land in totals');
  assert.equal(toLedgerView(state).discovered[0].tokens, 10, 'and the discovery row counts them');
});

test('wire: the projected view is JSON-safe and schema-valid', () => {
  const state = run([
    ...step({ time: BASE, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000 } }),
    ...step({ step: 2, time: BASE + 1000, usage: { inputTokens: 200, outputTokens: 60 } }),
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state, 'state must survive a JSON round trip unchanged');
  const view = {
    version: 1,
    settings: {
      version: 1,
      display: { currency: 'USD', cnyInDetailsFor: [], usdToCny: 7.1, labels: ['cost'], details: ['cost'], primaryProvider: null },
      budget: { sessionUsd: null, warnAt: 0.75 },
      pricingAsOf: null,
      providers: [],
      problems: [],
    },
    ledger: toLedgerView(state),
  };
  assert.doesNotThrow(() => sessionMetricsWireSchema.parse(JSON.parse(JSON.stringify(view))));
});

test('wire: a view with an unexpected field or a bad row is rejected', () => {
  const valid = {
    version: 1,
    settings: {
      version: 1,
      display: { currency: 'USD', cnyInDetailsFor: [], usdToCny: 7.1, labels: [], details: [], primaryProvider: null },
      budget: { sessionUsd: null, warnAt: 0.75 },
      pricingAsOf: null,
      providers: [],
      problems: [],
    },
    ledger: {
      turns: 0, steps: 0, totals: {}, rows: [], discovered: [],
    },
  };
  assert.doesNotThrow(() => sessionMetricsWireSchema.parse(valid), 'the control view is valid');
  assert.throws(() => sessionMetricsWireSchema.parse({ ...valid, surprise: true }), /is not a known field/);
  assert.throws(() => sessionMetricsWireSchema.parse({ ...valid, ledger: { ...valid.ledger, rows: [{ turn: 'x' }] } }), /must be a number/);
  // `discovered` is part of the contract, so a malformed row must be refused rather than
  // reaching the client and rendering an invented pair.
  assert.throws(
    () => sessionMetricsWireSchema.parse({ ...valid, ledger: { ...valid.ledger, discovered: [{ provider: 'x', model: 'y', tokens: 'lots' }] } }),
    /must be a number/,
  );
  // Every declared field is required, not merely typed where present: a row that
  // omits `reports` must be refused rather than reach the client as a partial.
  assert.throws(
    () => sessionMetricsWireSchema.parse({ ...valid, ledger: { ...valid.ledger, discovered: [{ provider: 'openrouter', model: 'auto', tokens: 10, firstSeen: null, lastSeen: null }] } }),
    /is required/,
  );
  assert.doesNotThrow(
    () => sessionMetricsWireSchema.parse({
      ...valid,
      ledger: { ...valid.ledger, discovered: [{ provider: 'openrouter', model: 'auto', tokens: 10, reports: 1, firstSeen: null, lastSeen: null }] },
    }),
    'a well-formed discovery row is valid',
  );
});
