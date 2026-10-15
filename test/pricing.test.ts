/**
 * Cost arithmetic and billing-window rules.
 *
 * Table-driven: every case carries the name of the rule it pins, so a failure reads as a
 * sentence rather than as a line number. Cases run in the order the code does — the happy
 * path first, then rejections and unknown inputs last.
 *
 * Tier cases use fixed instants (Thursday 2026-10-15, Saturday 2026-10-17) so a failure
 * names the rule that broke instead of depending on when the suite runs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRate, costOf, formatUsd, scaleRates, NANO_PER_USD } from '../lib/v1/money.js';
import { resolveSettings } from '../lib/v1/settings.js';
import {
  tierAt, nextBoundary, ratesAt, findCard, priceBuckets, savingsNano,
  bucketTotal, formatInZone, countdown, FLAT, PEAK, OFF_PEAK,
} from '../lib/v1/pricing.js';

/** A provider calendar as the shipped settings table writes it. */
interface Billing {
  timezone?: string;
  weekdays?: number[];
  windows: ReadonlyArray<readonly number[]>;
  holidays?: string[];
  holidayZone?: string;
}

/** The three tiers a calendar can resolve to. */
type Tier = 'peak' | 'off-peak' | 'flat';

/** [name, rate spelling, nanodollars] — or the rejection the spelling must raise. */
type RateCase = [name: string, input: string | number, want: number | RegExp];
/** [name, [rate, tokens], nanodollars] */
type CostCase = [name: string, args: [rate: number, tokens: number], want: number];
/** [name, [nanodollars], rendered] */
type FormatCase = [name: string, args: [nano: number | null], want: string | null];
/** [name, instant, billing, expected tier] */
type TierCase = [name: string, instant: string, billing: Billing, want: Tier];
/** [name, instant, billing, expected tier] */
type BoundaryCase = [name: string, from: string, want: string | null, billing?: Billing];
/** [name, [provider, model], expected model id] */
type CardCase = [name: string, pair: [provider: string, model: string], want: string];
/** [name, [provider, model], which side resolves to null] */
type UnknownCardCase = [name: string, pair: [provider: string, model: string], which: 'provider' | 'model'];
/** [name, [instant, zone], rendered clock] */
type ClockCase = [name: string, args: [instant: string, zone: string], want: string];

const settings = resolveSettings({});
const deepseek = settings.providers.find((p) => p.id === 'deepseek-account');
const netra = settings.providers.find((p) => p.id === 'netra-runtime');
const flash = deepseek.models.find((m: { model: string }) => m.model === 'deepseek-flash');

/** Every accepted rate spelling, then the ones that must be rejected. */
const RATE_CASES: RateCase[] = [
  ['a plain decimal', '0.006', 6_000_000],
  ['a whole number', '1.2', 1_200_000_000],
  ['the smallest representable rate', '0.000000001', 1],
  ['a number rather than a string', 0.3, 300_000_000],
  ['zero', '0', 0],
  ['a rejection: a word', 'free', /invalid rate/],
  ['a rejection: more precision than nanodollars allow', '0.1234567890', /more than 9 decimals/],
  ['a rejection: a negative rate', '-1', /invalid rate/],
];

const COST_CASES: CostCase[] = [
  ['a full million tokens at the rate', [6_000_000, 1_000_000], 6_000_000],
  ['no tokens', [300_000_000, 0], 0],
  ['no rate', [0, 12_345], 0],
  ['a fractional priced batch: 375,040 cached at $0.006/1M', [6_000_000, 375_040], 2_250_240],
];

const FORMAT_CASES: FormatCase[] = [
  ['a sub-cent cost', [1_110_000], '0.0011'],
  ['a fractional dollar', [811_900_000], '0.8119'],
  ['whole dollars', [6_000_000_000], '6.0000'],
  ['zero', [0], '0.0000'],
  ['an absent cost', [null], null],
];

/** [name, instant, billing, want] — the windows are 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri. */
const TIER_CASES: TierCase[] = [
  ['inside the first window', '2026-10-15T02:00:00Z', deepseek.billing, PEAK],
  ['inside the gap between windows', '2026-10-15T05:00:00Z', deepseek.billing, OFF_PEAK],
  ['inside the second window', '2026-10-15T07:00:00Z', deepseek.billing, PEAK],
  ['after the last window', '2026-10-15T12:00:00Z', deepseek.billing, OFF_PEAK],
  ['before the first window', '2026-10-15T00:30:00Z', deepseek.billing, OFF_PEAK],
  ['Saturday all day', '2026-10-17T02:00:00Z', deepseek.billing, OFF_PEAK],
  ['Saturday inside what would be a window', '2026-10-17T07:00:00Z', deepseek.billing, OFF_PEAK],
  ['a provider with no windows is flat, never off-peak', '2026-10-15T02:00:00Z', netra.billing, FLAT],
  ['a declared holiday inside a window', '2026-10-15T02:00:00Z', { ...deepseek.billing, holidays: ['2026-10-15'], holidayZone: 'UTC' }, OFF_PEAK],
  ['the day after a holiday', '2026-10-16T02:00:00Z', { ...deepseek.billing, holidays: ['2026-10-15'], holidayZone: 'UTC' }, PEAK],
  // 22:00 UTC Wednesday is 06:00 Thursday in Shanghai: off-peak for a UTC calendar,
  // peak for a Shanghai one. That difference is the whole point of a per-provider zone.
  ['the same instant under a UTC calendar', '2026-10-14T22:00:00Z', deepseek.billing, OFF_PEAK],
  ['and under a Shanghai calendar', '2026-10-14T22:00:00Z', { ...deepseek.billing, timezone: 'Asia/Shanghai' }, PEAK],
];

/**
 * [name, instant, billing, want] for the same provider calendar written in a DST-observing
 * zone: peak 01:00-03:00 local, every day, instead of the shipped 01:00-04:00/06:00-10:00 UTC
 * Mon-Fri calendar.
 *
 * `America/New_York` springs forward on 2026-03-08 (02:00 EST becomes 03:00 EDT, so no 02:00
 * wall clock exists) and falls back on 2026-11-01 (02:00 EDT becomes 01:00 EST, so 01:00-02:00
 * local happens twice). Each 07:00Z pair is the *same UTC instant-of-day* on either side of a
 * transition: the local hour moves, so the tier must move with it. A regression in either half
 * of a transition fails the row that names it.
 */
const newYorkBilling: Billing = {
  ...deepseek.billing,
  timezone: 'America/New_York',
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  windows: [[1, 3]],
};

const DST_TIER_CASES: TierCase[] = [
  ['spring forward: 07:00Z before the change is 02:00 EST, inside the window', '2026-03-07T07:00:00Z', newYorkBilling, PEAK],
  ['spring forward: the same 07:00Z after the change is 03:00 EDT, past the window', '2026-03-08T07:00:00Z', newYorkBilling, OFF_PEAK],
  ['fall back: 07:00Z before the change is 03:00 EDT, past the window', '2026-10-31T07:00:00Z', newYorkBilling, OFF_PEAK],
  ['fall back: the same 07:00Z after the change is 02:00 EST, inside the window', '2026-11-01T07:00:00Z', newYorkBilling, PEAK],
  ['fall back: the first pass through 01:30 local, still on EDT, is inside the window', '2026-11-01T05:30:00Z', newYorkBilling, PEAK],
  ['fall back: the repeated 01:30 local, now on EST, is still inside the window', '2026-11-01T06:30:00Z', newYorkBilling, PEAK],
];

const BOUNDARY_CASES: BoundaryCase[] = [
  ['from the off-peak gap', '2026-10-15T04:46:00Z', '2026-10-15T06:00:00Z'],
  ['from inside a peak window', '2026-10-15T02:00:00Z', '2026-10-15T04:00:00Z'],
  ['where peak ends', '2026-10-15T07:00:00Z', '2026-10-15T10:00:00Z'],
  ["into the next weekday's peak", '2026-10-15T12:00:00Z', '2026-10-16T01:00:00Z'],
  ["to the end of Friday's peak", '2026-10-16T07:00:00Z', '2026-10-16T10:00:00Z'],
  ['across the weekend to Monday', '2026-10-17T02:00:00Z', '2026-10-19T01:00:00Z'],
  ['nothing to find for a flat provider', '2026-10-15T04:46:00Z', null, netra.billing],
];

const CARD_CASES: CardCase[] = [
  ['an exact model id resolves', ['deepseek-account', 'deepseek-flash'], 'deepseek-flash'],
  ['an alias resolves to its card', ['deepseek-account', 'deepseek-v4.1-flash'], 'deepseek-flash'],
  ['a slashed id resolves against its own provider', ['netra-runtime', 'deepseek/deepseek-v4.1-flash'], 'deepseek/deepseek-v4.1-flash'],
];

const UNKNOWN_CARD_CASES: UnknownCardCase[] = [
  ['an unknown provider', ['some-router', 'x'], 'provider'],
  ['an unknown model under a known provider', ['deepseek-account', 'nope'], 'model'],
];

const CLOCK_CASES: ClockCase[] = [
  ['a zone east of UTC', ['2026-10-15T04:46:00Z', 'Asia/Tokyo'], '13:46'],
  ['UTC itself', ['2026-10-15T04:46:00Z', 'UTC'], '04:46'],
];

test('money: every accepted rate spelling parses, and malformed ones are rejected', () => {
  for (const [name, input, want] of RATE_CASES) {
    if (want instanceof RegExp) assert.throws(() => parseRate(input), want, name);
    else assert.equal(parseRate(input), want, name);
  }
  assert.equal(NANO_PER_USD, 1_000_000_000, 'money is integer nanodollars');
});

test('money: cost is the rate applied per million tokens', () => {
  for (const [name, [rate, tokens], want] of COST_CASES) {
    assert.equal(costOf(rate, tokens), want, name);
  }
});

test('money: formatting keeps sub-cent costs legible, and an absent cost stays absent', () => {
  for (const [name, [nano], want] of FORMAT_CASES) {
    assert.equal(formatUsd(nano), want, name);
  }
});

test('money: scaling one rate row rounds to whole nanodollars', () => {
  const peak = { cacheHit: 6_000_000, cacheMiss: 300_000_000, cacheWrite: 300_000_000, output: 1_200_000_000 };
  assert.deepEqual(scaleRates(peak, 0.5), {
    cacheHit: 3_000_000, cacheMiss: 150_000_000, cacheWrite: 150_000_000, output: 600_000_000,
  }, 'half rates stay integral');
  assert.deepEqual(scaleRates(peak, 1), peak, 'a multiplier of one changes nothing');
});

test('tier: the provider calendar decides, in the provider zone', () => {
  for (const [name, instant, billing, want] of TIER_CASES) {
    assert.equal(tierAt(new Date(instant), billing), want, name);
  }
});

test('tier: a DST transition moves the wall clock, not the provider window', () => {
  for (const [name, instant, billing, want] of DST_TIER_CASES) {
    assert.equal(tierAt(new Date(instant), billing), want, name);
  }
});

test('tier: a flat provider has one rate row and no windows', () => {
  assert.equal(ratesAt(netra.models[0], FLAT), netra.models[0].rates.flat, 'the flat row is the row');
  assert.deepEqual(netra.billing.windows, [], 'and there are no windows to schedule');
});

test('next change: the returned minute is the one the tier actually changes', () => {
  for (const [name, from, want, billing = deepseek.billing] of BOUNDARY_CASES) {
    const got = nextBoundary(Date.parse(from), billing);
    assert.equal(got, want === null ? null : Date.parse(want), name);
    if (got === null) continue;
    assert.notEqual(
      tierAt(new Date(got - 60_000), billing),
      tierAt(new Date(got), billing),
      `${name}: ${new Date(got).toISOString()} must be a real boundary`,
    );
  }
});

test('next change: a warm search constructs no formatter at all', () => {
  // The defect this guards: a formatter built inside `tierAt`, which the search calls for
  // every scanned minute — thousands of ICU allocations per call, on every render. Counting
  // constructions is deterministic where a timing assertion would not be.
  const Real = Intl.DateTimeFormat;
  let constructions = 0;
  // The spy replaces a global constructor, so its own signature is deliberately loose.
  const instrumented = function (...args: unknown[]): Intl.DateTimeFormat {
    constructions += 1;
    return new (Real as unknown as new (...rest: unknown[]) => Intl.DateTimeFormat)(...args);
  };
  globalThis.Intl.DateTimeFormat = instrumented as unknown as typeof Intl.DateTimeFormat;
  try {
    const from = Date.parse('2026-10-15T04:46:00Z');
    nextBoundary(from, deepseek.billing);
    const warm = constructions;
    for (let index = 0; index < 50; index += 1) nextBoundary(from + index * 60_000, deepseek.billing);
    assert.equal(constructions - warm, 0, 'a warm search must construct no formatter');
    assert.ok(warm <= 4, `the first search builds at most one formatter per zone, built ${warm}`);
  } finally {
    globalThis.Intl.DateTimeFormat = Real;
  }
});

test('rates: a tier row is selected by tier, with off-peak derived as half of peak', () => {
  assert.deepEqual(ratesAt(flash, PEAK), flash.rates.peak, 'peak is the declared row');
  assert.deepEqual(ratesAt(flash, OFF_PEAK), {
    cacheHit: flash.rates.peak.cacheHit / 2,
    cacheMiss: flash.rates.peak.cacheMiss / 2,
    cacheWrite: flash.rates.peak.cacheWrite / 2,
    output: flash.rates.peak.output / 2,
  }, 'off-peak is derived, not guessed');
});

test('cards: an exact id or an alias resolves to its card', () => {
  for (const [name, [provider, model], want] of CARD_CASES) {
    const card = findCard(settings.providers, provider, model);
    assert.equal(card.model === null ? null : card.model.model, want, name);
  }
});

test('cards: an unknown pair resolves to nothing rather than guessing a rate', () => {
  for (const [name, [provider, model], which] of UNKNOWN_CARD_CASES) {
    const card = findCard(settings.providers, provider, model);
    assert.equal(card[which], null, name);
  }
  assert.equal(ratesAt(null, PEAK), null, 'an unknown model has no rate row');
  assert.equal(priceBuckets(null, { cacheReadTokens: 1 }), null, 'and prices to nothing');
  assert.equal(savingsNano(null, { cacheReadTokens: 1 }), null, 'and saves nothing');
});

test('price: the four buckets are priced separately and summed', () => {
  const buckets = { uncachedInputTokens: 377, cacheReadTokens: 375_040, cacheWriteTokens: 0, outputTokens: 910 };
  const price = priceBuckets(ratesAt(netra.models[0], FLAT), buckets)!;
  assert.equal(price.cacheMissNano, costOf(100_000_000, 377), 'input at the miss rate');
  assert.equal(price.cacheHitNano, costOf(10_000_000, 375_040), 'cached at the hit rate');
  assert.equal(price.outputNano, costOf(250_000_000, 910), 'output at the output rate');
  assert.equal(price.cacheWriteNano, 0, 'nothing written');
  assert.equal(price.totalNano, price.cacheHitNano + price.cacheMissNano + price.cacheWriteNano + price.outputNano,
    'the total is their sum, with no hidden term');
  assert.equal(bucketTotal(buckets), 376_327, 'and the token total counts every bucket');
});

test('savings: the gap between the miss and the hit rate, on the cached tokens only', () => {
  const buckets = { uncachedInputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 0 };
  // $0.30 miss vs $0.006 hit = $0.294 saved per 1M cached tokens.
  assert.equal(savingsNano(ratesAt(flash, PEAK), buckets), 294_000_000);
  const nothingCached = { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  assert.equal(savingsNano(ratesAt(flash, PEAK), nothingCached), 0, 'nothing cached saves nothing');
});

test('clock: times and countdowns render in the requested zone', () => {
  for (const [name, [instant, zone], want] of CLOCK_CASES) {
    assert.equal(formatInZone(Date.parse(instant), zone), want, name);
  }
  const instant = Date.parse('2026-10-15T04:46:00Z');
  assert.equal(countdown(instant, Date.parse('2026-10-15T06:00:00Z')), '1h 14m', 'hours and minutes');
  assert.equal(countdown(instant, instant + 60_000), '1m', 'a whole minute');
  assert.equal(countdown(instant, instant + 30_000), 'less than a minute', 'and never "0m"');
});
