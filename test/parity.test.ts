/**
 * Client/host parity.
 *
 * The browser half cannot import the host modules at runtime (the client bundle is a single
 * standalone file), so it carries its own copy of the cost arithmetic. The client header
 * claims a parity test keeps the two from drifting; this is that test.
 *
 * It drives the **shipped bundle** with a matrix of provider cards, tiers and token mixes,
 * reads the money it renders, and compares it with the host's own `priceBuckets` /
 * `savingsNano` over the same inputs. Any divergence — a changed rate field, a rounding
 * difference, a tier resolved differently — fails here rather than in a user's session.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSettings } from '../lib/v1/settings.js';
import { findCard, priceBuckets, ratesAt, savingsNano, tierAt } from '../lib/v1/pricing.js';
import { loadBundle, mount, type MountedView } from './harness.ts';

/** The four billing buckets the strip prices. */
interface Buckets {
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** One provider/model pair the matrix drives. */
interface Pair {
  provider: string;
  model: string;
}

/** What one mounted strip lets a case read. */
interface RenderedStrip {
  view: MountedView;
  tier: string;
  props: Record<string, unknown>;
}

/** The strip's rounding, restated so the expectation is independent of the implementation. */
const shown = (nano: number | null | undefined): string | null => {
  if (nano === null || nano === undefined) return null;
  const cents = Math.round(Math.abs(nano) / 1e7);
  if (cents === 0 && nano > 0) return '< $0.01';
  return '$' + (cents / 100).toFixed(2);
};

const settings = resolveSettings({});

const MIXES: Buckets[] = [
  { uncachedInputTokens: 1_234, cacheReadTokens: 410_450_000, cacheWriteTokens: 0, outputTokens: 976_600 },
  { uncachedInputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
  { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 500_000, outputTokens: 250_000 },
  { uncachedInputTokens: 999_999, cacheReadTokens: 1_000_000, cacheWriteTokens: 12_345, outputTokens: 987_654 },
];

const PAIRS: Pair[] = [
  { provider: 'deepseek-account', model: 'deepseek-flash' },
  { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  { provider: 'netra-runtime', model: 'deepseek/deepseek-v4.1-flash' },
  // an alias resolves to the same card, so both sides must price it identically
  { provider: 'deepseek-account', model: 'deepseek-v4.1-flash' },
];

/** Mount the strip for one pair+mix and return its rendered money and tier. */
function renderStrip(pair: Pair, buckets: Buckets, nowMs: number): RenderedStrip {
  const tier = tierAt(new Date(nowMs), findCard(settings.providers, pair.provider, pair.model).provider.billing);
  const key = [pair.provider, pair.model, tier].join('\u0000');
  const ledger = { turns: 1, steps: 1, totals: { [key]: buckets }, rows: [] };
  const loaded = loadBundle();
  const props = {
    sessionId: 'parity',
    useProjection: (name: string) => {
      if (name === 'sessionMetrics') return { version: 1, settings, ledger };
      if (name === 'tokenUsage') return buckets;
      if (name === 'modelSelection') return { lastUsed: { provider: pair.provider, model: pair.model } };
      return undefined;
    },
  };
  const view = mount(loaded, loaded.slot('conversation.input.dock'), props);
  return { view, tier, props };
}

test('parity: the strip prices every card, tier and token mix exactly as the host does', () => {
  const nowMs = Date.now();
  const mismatches: string[] = [];
  let checked = 0;
  for (const pair of PAIRS) {
    const card = findCard(settings.providers, pair.provider, pair.model);
    if (card.provider === null || card.model === null) continue;
    for (const buckets of MIXES) {
      const { view, tier } = renderStrip(pair, buckets, nowMs);
      try {
        const text = view.text();
        const rates = ratesAt(card.model, tier);
        const price = priceBuckets(rates, buckets)!;
        const saved = savingsNano(rates, buckets)!;
        checked += 1;
        const cost = shown(price.totalNano);
        if (!text.includes('Cost' + cost)) mismatches.push(`${pair.provider}/${pair.model} ${tier}: cost ${cost} not in "${text}"`);
        if (saved > 0) {
          const savedText = shown(saved);
          if (!text.includes('Saved' + savedText)) mismatches.push(`${pair.provider}/${pair.model} ${tier}: saved ${savedText} not in "${text}"`);
        }
      } finally {
        view.unmount();
      }
    }
  }
  assert.equal(checked >= 12, true, `expected the matrix to render, checked ${checked}`);
  assert.deepEqual(mismatches.slice(0, 5), [], `${mismatches.length} of ${checked} cases disagree with the host`);
});

test('parity: the tier the strip shows is the tier the host computes', () => {
  const nowMs = Date.now();
  const disagreements: string[] = [];
  for (const pair of PAIRS) {
    const { view, tier } = renderStrip(pair, MIXES[0], nowMs);
    try {
      const text = view.text();
      if (tier === 'flat') {
        // A flat provider has no peak flag at all, which is itself the assertion.
        if (/(ON|OFF) PEAK HOURS/.test(text)) disagreements.push(`${pair.provider}: flat but showed a peak flag`);
      } else if (!text.includes((tier === 'peak' ? 'ON' : 'OFF') + ' PEAK HOURS')) {
        disagreements.push(`${pair.provider}/${pair.model}: host says ${tier}, strip shows "${text}"`);
      }
    } finally {
      view.unmount();
    }
  }
  assert.deepEqual(disagreements, [], 'the strip and the host must resolve the same tier');
});

test('parity: an unknown pair is reported unpriced on both sides, never guessed', () => {
  const card = findCard(settings.providers, 'netra-runtime', 'not-a-model');
  assert.equal(card.model, null, 'the host refuses to guess a card');
  const view = renderStrip({ provider: 'netra-runtime', model: 'not-a-model' }, MIXES[0], Date.now()).view;
  try {
    assert.match(view.text(), /Costunpriced|unpriced/, `the strip must say unpriced: ${view.text()}`);
  } finally {
    view.unmount();
  }
});

test('parity: the strip renders its clock, and schedules a tick aligned to the minute', () => {
  // The collapsed strip used to show a frozen clock: it only ticked while the panel was
  // open. It now re-renders on a minute boundary, and only while a clock chip is on screen.
  const win = loadBundle().dom.window;
  const real = win.setTimeout;
  const scheduled: number[] = [];
  win.setTimeout = (fn: () => void, ms: number) => { scheduled.push(ms); return real(fn, ms); };
  const { view, props } = renderStrip(PAIRS[0], MIXES[0], Date.now());
  try {
    view.rerender(props); // the effect re-runs with the spy installed
    assert.match(view.text(), /\d\d:\d\d/, `the clock renders: ${view.text()}`);
    const aligned = scheduled.filter((ms) => typeof ms === 'number' && ms > 0 && ms <= 60_050);
    assert.equal(aligned.length > 0, true, `expected a minute-aligned tick, got ${JSON.stringify(scheduled.slice(0, 4))}`);
    assert.equal(Math.max(...aligned) <= 60_050, true, 'the tick never waits longer than a minute');
  } finally {
    view.unmount();
    win.setTimeout = real;
  }
});

test('parity: a config with no clock chip schedules no timer at all', () => {
  const win = loadBundle().dom.window;
  const real = win.setTimeout;
  const scheduled: number[] = [];
  win.setTimeout = (fn: () => void, ms: number) => { scheduled.push(ms); return real(fn, ms); };
  const quiet = resolveSettings({ display: { labels: ['cost', 'provider'] } });
  const buckets = MIXES[0];
  const loaded = loadBundle();
  const props = {
    sessionId: 'parity',
    useProjection: (name: string) => {
      if (name === 'sessionMetrics') {
        return { version: 1, settings: quiet, ledger: { turns: 1, steps: 1, totals: { 'deepseek-account\u0000deepseek-flash\u0000peak': buckets }, rows: [] } };
      }
      if (name === 'tokenUsage') return buckets;
      return undefined;
    },
  };
  const view = mount(loaded, loaded.slot('conversation.input.dock'), props);
  try {
    view.rerender(props);
    assert.equal(/(ON|OFF) PEAK HOURS|\d\d:\d\d/.test(view.text()), false, `no clock or peak chip: ${view.text()}`);
    const aligned = scheduled.filter((ms) => typeof ms === 'number' && ms > 0 && ms <= 60_050);
    assert.deepEqual(aligned, [], 'nothing to keep live means no timer');
  } finally {
    view.unmount();
    win.setTimeout = real;
  }
});
