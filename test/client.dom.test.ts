/**
 * Client bundle tests under jsdom.
 *
 * The bundle is a plain-JS `window.__ModuleLoader__.load({...})` script, so the
 * test evaluates the real file through a stub loader rather than importing it —
 * the same path the browser takes. Two things are checked that the host tests
 * cannot see: that the strip renders the money/tier/provider facts, and that it
 * renders **none** of the figures the shipped stats pills already own.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSettings } from '../lib/v1/settings.js';
import { loadBundle, mount, type MountedView } from './harness.ts';
import { priceBuckets, ratesAt, findCard } from '../lib/v1/pricing.js';
import { formatUsd } from '../lib/v1/money.js';

/** The four billing buckets the strip prices. */
interface Buckets {
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** One ledger row, as the projection carries it. */
interface LedgerRow {
  turn: number;
  step: number;
  startTime: number;
  endTime: number;
  provider: string;
  model: string;
  tier: string;
  buckets: Buckets;
}

/** The ledger projection the strip reads. */
interface LedgerFixture {
  turns: number;
  steps: number;
  totals: Record<string, Buckets>;
  rows: LedgerRow[];
  /** Pairs the ledger observed with no rate card; absent on a pre-discovery checkpoint. */
  discovered?: DiscoveredFixture[];
}

/** One observed-but-unpriced pair, as the wire carries it. */
interface DiscoveredFixture {
  provider: string;
  model: string;
  tokens: number;
  steps: number;
  firstSeen: number;
  lastSeen: number;
}

/** The resolved settings object, as the module returns it. */
type SettingsFixture = ReturnType<typeof resolveSettings>;

/** The model-selection projection, when the session has one. */
interface SelectionFixture {
  lastUsed: { provider: string; model: string };
}

/** Everything a case can hand the strip. */
interface RenderArgs {
  ledger?: LedgerFixture | null;
  settings?: SettingsFixture;
  selection?: SelectionFixture | null;
  usage?: Buckets | null;
  projectionMissing?: boolean;
  sessionId?: string;
}

/** Mount the strip with fixed projection values. */
function render(args: RenderArgs): MountedView & { clickTrigger: () => Promise<void> } {
  const { ledger, settings, selection, usage, projectionMissing = false } = args;
  // `hasOwnProperty` rather than a default parameter: a test that passes
  // `sessionId: undefined` on purpose must reach the component as undefined, or the
  // default silently substitutes a real session and the test asserts the wrong thing.
  const sessionId = Object.prototype.hasOwnProperty.call(args, 'sessionId') ? args.sessionId : 'session-test';
  const loaded = loadBundle();
  const registration = loaded.slot('conversation.input.dock');
  const useProjection = (key: string) => {
    if (key === 'sessionMetrics') return projectionMissing ? undefined : { version: 1, settings, ledger };
    if (key === 'tokenUsage') return usage;
    if (key === 'modelSelection') return selection;
    return undefined;
  };
  const view = mount(loaded, registration, { sessionId, useProjection });
  return {
    ...view,
    clickTrigger: () => view.click('.dsm-trigger'),
  };
}

const settings = resolveSettings({ display: { primaryProvider: 'deepseek-account' } });

/** One $1.0944 peak step on the shipped DeepSeek card. */
const ledger: LedgerFixture = {
  turns: 1,
  steps: 1,
  totals: {
    'deepseek-account\u0000deepseek-flash\u0000peak': {
      uncachedInputTokens: 377,
      cacheReadTokens: 375_040,
      cacheWriteTokens: 0,
      outputTokens: 910,
    },
  },
  rows: [{
    turn: 1, step: 1, startTime: Date.now() - 1000, endTime: Date.now(),
    provider: 'deepseek-account', model: 'deepseek-flash', tier: 'peak',
    buckets: { uncachedInputTokens: 377, cacheReadTokens: 375_040, cacheWriteTokens: 0, outputTokens: 910 },
  }],
};

const selection: SelectionFixture = { lastUsed: { provider: 'deepseek-account', model: 'deepseek-flash' } };
const usage: Buckets = { uncachedInputTokens: 377, cacheReadTokens: 375_040, cacheWriteTokens: 0, outputTokens: 910 };

/** The free model `agent-default-model` configures, with one step's real buckets. */
const FREE_MODEL = 'nvidia/nemotron-3.5-lightning:free';
const freeBuckets: Buckets = { uncachedInputTokens: 146_120, cacheReadTokens: 1_102_496, cacheWriteTokens: 0, outputTokens: 5_534 };
const freeSelection: SelectionFixture = { lastUsed: { provider: 'openrouter', model: FREE_MODEL } };
const freeLedger: LedgerFixture = {
  turns: 1,
  steps: 1,
  totals: { ['openrouter\u0000' + FREE_MODEL + '\u0000flat']: freeBuckets },
  rows: [{
    turn: 1, step: 1, startTime: Date.now() - 1000, endTime: Date.now(),
    provider: 'openrouter', model: FREE_MODEL, tier: 'flat', buckets: freeBuckets,
  }],
};

/** One pair the ledger observed with no rate card: OpenRouter's paid router. */
const discoveredPair: DiscoveredFixture = {
  provider: 'openrouter', model: 'auto', tokens: 310_956, steps: 2,
  firstSeen: 1792026000100, lastSeen: 1792026001100,
};

/** A session that used the paid router: real tokens, no card, so unpriced. */
const unpricedBuckets: Buckets = { uncachedInputTokens: 22_526, cacheReadTokens: 282_624, cacheWriteTokens: 0, outputTokens: 5_804 };
const unpricedLedger: LedgerFixture = {
  turns: 1,
  steps: 1,
  totals: { 'openrouter\u0000auto\u0000flat': unpricedBuckets },
  rows: [{
    turn: 1, step: 1, startTime: Date.now() - 1000, endTime: Date.now(),
    provider: 'openrouter', model: 'auto', tier: 'flat', buckets: unpricedBuckets,
  }],
  discovered: [discoveredPair],
};

/** A session that used one priced card and one unpriced pair. */
const mixedLedger: LedgerFixture = {
  turns: 1,
  steps: 2,
  totals: Object.assign({}, ledger.totals, unpricedLedger.totals),
  rows: ledger.rows.concat(unpricedLedger.rows),
  discovered: [discoveredPair],
};

/**
 * A resolved settings fixture whose one card has **only** a flat rate row.
 *
 * Deliberately *not* built by `resolveSettings`: the Host's own resolver always emits
 * `rates.peak` (null when the mode is flat), so it cannot express the shape that crashed
 * the live page — a stored card read as resolved, where `rates.peak` is `undefined`
 * rather than null and `.cacheHit` off it throws. The client must survive a card that is
 * missing a tier's row entirely, so the fixture reproduces that shape literally.
 * @param rates - the rate rows the card carries, in nanodollars per 1M.
 * @returns a settings object shaped like the `sessionMetrics` projection's `settings`.
 */
function flatOnly(rates: { flat?: Record<string, number>; peak?: Record<string, number> }): SettingsFixture {
  return {
    version: 1,
    display: {
      currency: 'USD', cnyInDetailsFor: [], usdToCny: 7.1,
      labels: ['peak', 'time', 'cost', 'saved', 'provider'],
      details: ['cost', 'savings', 'models', 'window'],
      primaryProvider: null,
    },
    budget: { sessionUsd: null, warnAt: 0.75 },
    pricingAsOf: null,
    problems: [],
    providers: [{
      id: 'flat-only',
      label: 'Flat Only',
      billing: { timezone: 'UTC', weekdays: [1, 2, 3, 4, 5], windows: [], holidays: [], holidayZone: 'Asia/Shanghai' },
      models: [{ model: 'flat-only-1', aliases: [], mode: 'flat', rates: rates }],
    }],
  };
}

test('registration: the strip passes only the options its slot declares', () => {
  // `conversation.input.dock` declares `id`, `order`, `label` and nothing else. An
  // `inject` here is unsupported, and where a slot does support it the return value
  // becomes the component's props — which silently replaced `useProjection` and
  // `sessionId` and left the strip with nothing to read.
  const loaded = loadBundle();
  const spec = loaded.slot('conversation.input.dock').spec;
  assert.equal(spec.inject, undefined, 'no inject option on this slot');
  assert.equal(spec.id, 'dsh-session-metrics');
  assert.equal(spec.order, 17, 'the order doubles as the loaded-generation marker');
  assert.equal(String(Object.keys(spec).sort()), 'id,name,order');
});

test('labels: the strip shows peak state, the clock, cost, savings and provider without a click', () => {
  const view = render({ ledger, settings, selection, usage });
  try {
    const text = view.text();
    // The expectation comes from the host module rather than from mental arithmetic:
    // 910 output tokens at $1.20/1M plus the cached and uncached prompt is a third of a
    // cent, so this fixture also pins the sub-cent display.
    const card = findCard(settings.providers, 'deepseek-account', 'deepseek-flash');
    const expected = priceBuckets(ratesAt(card.model, 'peak'), ledger.rows[0].buckets)!.totalNano;
    assert.equal(formatUsd(expected, 4), '0.0034', 'the fixture prices to a third of a cent');
    assert.match(text, /< \$0\.01/, `a session that cost something must not read as free: ${text}`);
    assert.match(text, /Cost/);
    assert.match(text, /Saved/);
    assert.match(text, /\$0\.11/, 'cache savings at two decimals');
    assert.match(text, /(ON|OFF) PEAK HOURS/, 'the tier is legible without clicking');
    assert.match(text, /\d\d:\d\d/, 'a 24-hour clock');
    const zone = (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC').split('/').pop();
    assert.equal(text.includes(zone!), true, `the clock names the viewer zone: ${text}`);
    const trigger = view.container.querySelector('.dsm-trigger');
    assert.ok(trigger !== null);
    assert.equal(trigger.textContent!.includes('deepseek-flash'), false, 'no model chip in the strip');
    assert.equal(trigger.textContent!.includes('session-metrics/v'), false, 'no build tag in the strip');
  } finally {
    view.unmount();
  }
});

test('labels: a dot separates every pair of chips', () => {
  const view = render({ ledger, settings, selection, usage });
  try {
    const separators = view.container.querySelectorAll('.dsm-sep');
    const chips = view.container.querySelectorAll('.dsm-trigger > .dsm-item, .dsm-trigger > .dsm-model');
    assert.equal(chips.length >= 3, true, `expected several chips, found ${chips.length}`);
    assert.equal(separators.length, chips.length - 1, 'one divider between each pair, and none at the ends');
    for (const node of separators) assert.equal(node.textContent, '\u00b7', 'the divider is a middot');
  } finally {
    view.unmount();
  }
});

test('labels: peak is an up triangle and off-peak a down triangle, in the app colours', () => {
  const view = render({ ledger, settings, selection, usage });
  try {
    const peak = view.container.querySelector('.dsm-peak');
    const off = view.container.querySelector('.dsm-off');
    assert.equal(peak === null && off === null, false, 'the tier chip is present at any hour');
    if (peak !== null) {
      assert.equal(peak.textContent!.includes('\u25b2'), true, 'peak points up');
      assert.equal(peak.textContent!.includes('ON'), true, 'peak reads ON');
    }
    if (off !== null) {
      assert.equal(off.textContent!.includes('\u25bc'), true, 'off-peak points down');
      assert.equal(off.textContent!.includes('OFF'), true, 'off-peak reads OFF');
    }
    const css = [...view.container.ownerDocument!.querySelectorAll('style[data-plugin-css]')]
      .map((node) => node.textContent).join('');
    assert.match(css, /\.dsm-peak\{color:var\(--dsw-alias-state-error-primary/, 'peak uses the error colour');
    assert.match(css, /\.dsm-off\{color:var\(--dsw-alias-state-success-primary/, 'off-peak uses the success colour');
  } finally {
    view.unmount();
  }
});

test('labels: the provider chip shows unless the config names it as primary', () => {
  const shown = render({ ledger, settings: resolveSettings({}), selection, usage });
  try {
    assert.match(shown.text(), /deepseek-account/, 'the provider chip');
  } finally {
    shown.unmount();
  }
  const hidden = render({ ledger, settings, selection, usage });
  try {
    assert.equal(hidden.container.querySelector('.dsm-trigger')!.textContent!.includes('deepseek-account'), false,
      'primaryProvider suppresses the chip');
  } finally {
    hidden.unmount();
  }
});

test('labels: a legacy window/savings config still renders the peak flag, the clock and savings', () => {
  const legacy = resolveSettings({ display: { labels: ['cost', 'savings', 'window'] } });
  const view = render({ ledger, settings: legacy, selection, usage });
  try {
    const text = view.text();
    assert.match(text, /Cost/);
    assert.match(text, /Saved/);
    assert.match(text, /(ON|OFF) PEAK HOURS/, 'window expands to the peak flag plus the clock');
    assert.match(text, /\d\d:\d\d/, 'and the clock');
  } finally {
    view.unmount();
  }
});

test('free: a session on the shipped zero-rate card reads $0.00, never unpriced', async () => {
  // The distinction the whole free-model requirement rests on: a zero-rate card is a real
  // cost of zero, while a missing card is "unpriced". Rendering it as `unpriced` would say
  // the plugin does not know the price; rendering it as anything else would invent money.
  const view = render({ ledger: freeLedger, settings, selection: freeSelection, usage: freeBuckets });
  try {
    const text = view.text();
    assert.match(text, /Cost\$0\.00/, `a free session costs exactly $0.00: ${text}`);
    assert.equal(text.includes('unpriced'), false, 'and it is not reported as unpriced');
    await view.clickTrigger();
    assert.match(view.text(), /Cost breakdown/);
    assert.match(view.text(), /Total \$0\.00/, 'the breakdown agrees with the strip');
    assert.equal(view.text().includes('Seen, unpriced'), false, 'a priced free model is not discovered');
  } finally {
    view.unmount();
  }
});

test('details: four sections, no step table, and the pill figures stay out of it', async () => {
  const view = render({ ledger, settings, selection, usage });
  try {
    await view.clickTrigger();
    const text = view.text();
    for (const heading of ['Cost breakdown', 'Saving breakdown', 'Model provider', 'Timezone']) {
      assert.match(text, new RegExp(heading), `missing section: ${heading}`);
    }
    assert.match(text, /Input/);
    assert.match(text, /Output/);
    assert.match(text, /Cached/);
    assert.equal(text.includes('Cost by step'), false, 'the per-step table is gone');
    assert.equal(text.includes('Cache savings'), false, 'renamed to Saving breakdown');
    assert.equal(text.includes('Rate window'), false, 'renamed to Timezone');
    assert.equal(text.includes('Sources'), false, 'the sources section is gone');
    assert.equal(text.includes('Rates as of'), false, 'rates-as-of was dropped');
    assert.equal(text.includes('Seen, unpriced'), false, 'a ledger with no discovery renders no discovery section');
    // build id and provenance moved onto the heading, reachable on hover
    const heading = view.container.querySelector('.dsm-title span');
    const headingTitle = heading === null ? '' : heading.getAttribute('title') || '';
    assert.match(headingTitle, /build dsh-session-metrics\//, `the heading identifies the loaded generation: ${headingTitle}`);
    assert.match(headingTitle, /tokenUsage/, 'and still names the projection the tokens come from');
    for (const forbidden of ['tok/s', 'AVG TTFT', 'Context Used', 'System Prompt', 'Tool Definitions', '% Context']) {
      assert.equal(text.includes(forbidden), false, `"${forbidden}" is a stats-pill figure: ${text}`);
    }
  } finally {
    view.unmount();
  }
});

test('details: a metric explanation floats above the panel, clamped to the viewport', async () => {
  const view = render({ ledger, settings, selection, usage });
  try {
    await view.clickTrigger();
    const hints = [...view.container.querySelectorAll('.dsm-hint')];
    assert.ok(hints.length >= 3, `expected the Saved/Blended/share hints, found ${hints.length}`);
    for (const hint of hints) {
      assert.equal((hint.getAttribute('aria-label') || '').length > 20, true, 'named for assistive technology');
    }
    // The box is portalled, so it lives in the document rather than in the slot subtree.
    const findBox = () => view.container.ownerDocument!.querySelector('.dsm-tipBox');
    assert.equal(findBox() === null, true, 'nothing floats until hovered');

    await view.hover(hints[0]);
    const box = findBox();
    assert.ok(box !== null, 'hovering reveals the explanation');
    assert.equal(box.getAttribute('role'), 'tooltip');
    // Portalled to the body: no scroll container or transformed ancestor can clip it.
    assert.equal(box.parentElement === view.container.ownerDocument!.body, true,
      `the explanation must escape the panel: ${box.parentElement && box.parentElement.className}`);
    assert.equal(box.textContent!.length > 20, true, `thin explanation: ${box.textContent}`);
    const style = box.getAttribute('style') || '';
    assert.match(style, /left: \d+px/, 'positioned in viewport coordinates');
    // Clamped, so a right-hand column cannot push the box off screen or under the panel edge.
    assert.match(style, /left: (1[2-9]|[2-9]\d|\d{3,})px/, `clamped from the left edge: ${style}`);
    const css = [...view.container.ownerDocument!.querySelectorAll('style[data-plugin-css]')]
      .map((node) => node.textContent).join('');
    assert.match(css, /\.dsm-tipBox\{position:fixed/, 'fixed, so the scrolling panel cannot clip it');
    assert.match(css, /max-width:min\(320px,calc\(100vw - 24px\)\)/, 'hugging its text, clamped to the window');
    assert.match(css, /pointer-events:none/, 'and it never steals the pointer');

    await view.unhover(hints[0]);
    assert.equal(findBox() === null, true, 'and it goes away');

    // The reported bug: a label near the right edge pushed the box past the window and it
    // was cropped. A clamped left coordinate keeps the whole box on screen.
    const win = view.container.ownerDocument!.defaultView!;
    const farRight = hints[0];
    farRight.getBoundingClientRect = () => ({ left: win.innerWidth - 20, right: win.innerWidth, top: 300, bottom: 316, width: 20, height: 16 }) as DOMRect;
    await view.hover(farRight);
    const clamped = findBox();
    assert.ok(clamped !== null, 'the explanation opens for a right-edge label');
    const left = Number(((clamped.getAttribute('style') || '').match(/left: (\d+)px/) || [])[1]);
    assert.equal(left + 320 <= win.innerWidth, true, `the box must fit: left ${left} in ${win.innerWidth}`);
    assert.equal(clamped.className.includes('dsm-tipAbove'), true, 'and it opens upward when there is room');
    await view.unhover(farRight);
    assert.equal(findBox() === null, true, 'and clears again');
  } finally {
    view.unmount();
  }
});

test('details: the model provider table names the peak-hour state per row', async () => {
  const view = render({ ledger, settings, selection, usage });
  try {
    await view.clickTrigger();
    const rows = [...view.container.querySelectorAll('.dsm-table tbody tr')];
    assert.ok(rows.length >= 1, 'a row per provider/model group');
    assert.equal(rows.length, 1, 'a model that ran both tiers is ONE row, not two');
    const cells = [...rows[0].querySelectorAll('td')].map((node) => node.textContent);
    assert.equal(cells.length, 3, 'provider, model, peak hours');
    assert.equal(cells[0], 'deepseek-account');
    assert.equal(cells[1], 'DeepSeek V4.1 Flash', `the card's own label, not the internal key: ${cells[1]}`);
    assert.equal(['On', 'Off', 'None'].includes(cells[2] as string), true, `peak hours cell: ${cells[2]}`);
  } finally {
    view.unmount();
  }
});

test('details: the timezone section reports both clocks, one local sentence, no countdown note', async () => {
  const view = render({ ledger, settings, selection, usage });
  try {
    await view.clickTrigger();
    const text = view.text();
    assert.match(text, /Local time/, 'the reader\u2019s clock');
    assert.match(text, /Provider time/, 'the billing clock');
    assert.match(text, /UTC/);
    // Only the reader's zone: the provider's clock was noise once the windows are translated.
    assert.match(text, /Peak hours run on weekdays 10:00\u201313:00 and 15:00\u201319:00 Asia\/Tokyo/, `schedule sentence: ${text}`);
    assert.equal(/01:00\u201304:00/.test(text), false, 'the provider-zone window list is gone');
    assert.match(text, /Ongoing|Next in|None/, 'a short peak state');
    assert.equal(/starts in .* \u2014 at /.test(text), false, 'and no redundant countdown note');
  } finally {
    view.unmount();
  }
});

test('discovery: the detail names every observed unpriced pair, with tokens and no cost', async () => {
  const view = render({ ledger: unpricedLedger, settings, selection: { lastUsed: { provider: 'openrouter', model: 'auto' } }, usage: unpricedBuckets });
  try {
    assert.match(view.text(), /Costunpriced/, 'the strip refuses to price the pair');
    await view.clickTrigger();
    const text = view.text();
    assert.match(text, /Seen, unpriced/, 'the section says what it is');
    assert.match(text, /openrouter \u00b7 auto/, 'and names the pair that was seen');
    assert.match(text, /unpriced/, 'and labels it unpriced');
    const item = [...view.container.querySelectorAll('.dsm-list li')]
      .find((node) => (node.textContent || '').includes('openrouter \u00b7 auto'));
    assert.ok(item !== undefined, 'the pair is listed');
    assert.equal((item!.textContent || '').includes('$'), false, 'a discovered pair is never given a cost');
    assert.match(item!.textContent!, /tokens/, 'the observed tokens are shown instead');
    assert.match(text, /no rate card matches/i, 'and the cost section says why there is no total');
  } finally {
    view.unmount();
  }
});

test('discovery: an unpriced model row says unpriced while a priced row is untouched', async () => {
  const view = render({ ledger: mixedLedger, settings, selection, usage });
  try {
    await view.clickTrigger();
    const rows = [...view.container.querySelectorAll('.dsm-table tbody tr')];
    assert.equal(rows.length, 2, 'one row per provider/model');
    const cells = rows.map((row) => [...row.querySelectorAll('td')].map((node) => node.textContent));
    assert.deepEqual(cells.map((row) => row.length), [3, 3], 'the table keeps its three columns');
    const priced = cells.find((row) => row[0] === 'deepseek-account');
    const unpriced = cells.find((row) => row[0] === 'openrouter');
    assert.ok(priced !== undefined && unpriced !== undefined, `both rows render: ${JSON.stringify(cells)}`);
    assert.equal(priced![1], 'DeepSeek V4.1 Flash', 'a priced row shows its card label and nothing else');
    assert.equal(priced![1].includes('unpriced'), false, 'and never says unpriced');
    assert.equal(unpriced![1].includes('unpriced'), true, `an unpriced row says so visibly: ${unpriced![1]}`);
  } finally {
    view.unmount();
  }
});

test('placement: sticky like the composer, with no shipped stylesheet override', () => {
  const view = render({ ledger, settings, selection, usage });
  try {
    const css = view.styles();
    assert.match(css, /\.dsm-slot\{position:sticky;bottom:0/, 'the strip pins itself the way the composer seat does');
    assert.doesNotMatch(css, /\.dsm-slot\{[^}]*position:fixed/, 'viewport pinning scrolls wrong and stays banned');
    assert.equal(css.includes('.InputBar_dock'), false, 'the shipped composer dock row must not be restyled');
    // Typography must follow the app's own font-size setting (ui-theme.fontSize) rather
    // than pinning pixels, or the widget cannot scale with it.
    assert.match(css, /font-size:calc\(var\(--dsh-content-font-size,14px\)/, 'sized from the app variable');
    assert.equal(/font-size:\d+px/.test(css), false, 'no hardcoded pixel sizes');
    assert.equal(view.container.querySelector('.dsm-slot')!.getAttribute('data-safe'), 'true');
  } finally {
    view.unmount();
  }
});

test('robustness: the model is derived from the ledger when modelSelection is absent', async () => {
  // The ledger records the provider and model of every step, so the strip must not
  // depend on a second projection to have anything to show.
  const view = render({ ledger, settings, selection: null, usage });
  try {
    const text = view.text();
    assert.match(text, /Cost< \$0\.01|Cost\$/, `expected the strip to price the session from the ledger: ${text}`);
    // The model chip is gone from the strip, so the proof that the ledger resolved the
    // model is that the step priced against that model's own card: $0.11 of cache savings.
    assert.match(text, /Saved\$0\.11/, `expected the ledger's model to price the step: ${text}`);
    await view.clickTrigger();
    const rows = [...view.container.querySelectorAll('.dsm-table tbody tr')];
    assert.equal(rows.length, 1, 'one ledger group');
    assert.equal(rows[0].querySelectorAll('td')[1].textContent, 'DeepSeek V4.1 Flash', 'the ledger supplied the model, resolved to its card');
  } finally {
    view.unmount();
  }
});

test('robustness: a missing projection explains itself instead of vanishing', () => {
  const view = render({ ledger: null, settings, selection, usage });
  try {
    const chip = view.container.querySelector('.dsm-trigger');
    assert.ok(chip !== null, 'a silent panel is undiagnosable; the strip must say what it waits for');
    assert.equal(view.container.querySelector('.dsm-slot')!.getAttribute('data-safe'), 'false');
    assert.match(view.text(), /waiting/);
    assert.match(chip.getAttribute('title')!, /the projection carries no ledger/, 'the reason names the absent half');
  } finally {
    view.unmount();
  }
});

test('robustness: the diagnostic names the absent sources when opened', async () => {
  const view = render({ selection: null, usage: null, projectionMissing: true });
  try {
    await view.clickTrigger();
    const text = view.text();
    assert.match(text, /Why the strip is waiting/);
    assert.match(text, /sessionMetrics: absent/);
    // `null` means the projection is served but empty, which is different from
    // absent — the diagnostic must not flatten the two.
    assert.match(text, /tokenUsage: null/);
    assert.match(text, /modelSelection: null/);
  } finally {
    view.unmount();
  }
});

test('robustness: a missing session prop is reported, not treated as an empty session', () => {
  // The projections are session-scoped by the framework, so a strip that renders
  // nothing because a prop was absent is a fault, not a legitimate empty state.
  const view = render({ ledger, settings, selection, usage, sessionId: undefined });
  try {
    const chip = view.container.querySelector('.dsm-trigger');
    assert.ok(chip !== null, 'the strip must still render when data is present');
    assert.equal(view.container.querySelector('.dsm-diag') === null, true, 'not rendered as a diagnostic when it has data');
    assert.match(view.text(), /Cost/, 'the strip renders normally from the projections');
  } finally {
    view.unmount();
  }
});

test('robustness: no session and no data still renders a diagnostic, never nothing', () => {
  // A silent entry is undiagnosable: the slot reports it inactive and the user sees an
  // empty space with no clue which input is missing.
  const view = render({ projectionMissing: true, sessionId: undefined });
  try {
    const chip = view.container.querySelector('.dsm-trigger');
    assert.ok(chip !== null, 'the strip must render even with nothing to price');
    assert.ok(view.container.querySelector('.dsm-diag') !== null, 'and it renders as a diagnostic');
    assert.match(view.text(), /waiting/);
  } finally {
    view.unmount();
  }
});

test('robustness: a card with a flat row only, read at a peak tier, is unpriced rather than a crash', () => {
  // Live crash: `rates.peak` is undefined on a flat model, and the rate fields then read
  // `.cacheHit` off undefined. The ledger's stored tier is what selects the row, so a
  // flat card that recorded a peak tier is the exact shape that threw.
  const settings = flatOnly({ flat: { cacheHit: 10_000_000, cacheMiss: 100_000_000, cacheWrite: 100_000_000, output: 250_000_000 } });
  const view = render({ ledger, settings, selection, usage });
  try {
    const text = view.text();
    assert.equal(text.includes('session-metrics failed'), false, `must not crash: ${text.slice(0, 140)}`);
    assert.match(text, /unpriced/, 'a tier the card does not carry is unpriced, never invented');
    assert.equal(text.includes('NaN'), false, 'and nothing is rendered as NaN');
  } finally {
    view.unmount();
  }
});

test('robustness: a flat card is priced for real when the ledger records the flat tier', () => {
  // The positive half of the row above: the guard must not make every flat card unpriced.
  const settings = flatOnly({ flat: { cacheHit: 10_000_000, cacheMiss: 100_000_000, cacheWrite: 100_000_000, output: 250_000_000 } });
  const oneCent = { uncachedInputTokens: 60_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 16_000 };
  const flatLedger: LedgerFixture = {
    turns: 1, steps: 1,
    totals: { 'flat-only\u0000flat-only-1\u0000flat': oneCent },
    rows: [{
      turn: 1, step: 1, startTime: Date.now() - 1000, endTime: Date.now(),
      provider: 'flat-only', model: 'flat-only-1', tier: 'flat', buckets: oneCent,
    }],
  };
  const view = render({ ledger: flatLedger, settings, selection: { lastUsed: { provider: 'flat-only', model: 'flat-only-1' } }, usage: oneCent });
  try {
    const text = view.text();
    assert.equal(text.includes('session-metrics failed'), false, `must not crash: ${text.slice(0, 140)}`);
    assert.equal(text.includes('unpriced'), false, 'a card with a flat row is priced');
    assert.match(text, /Cost/, 'the cost chip is present');
  } finally {
    view.unmount();
  }
});

test('robustness: a projection whose settings half is missing or empty is diagnosed, never silent', () => {
  const cases: Array<[string, unknown]> = [
    ['no settings key at all', { version: 1, ledger }],
    ['settings null', { version: 1, settings: null, ledger }],
    ['settings undefined', { version: 1, settings: undefined, ledger }],
    ['settings is not an object', { version: 1, settings: 'nope', ledger }],
  ];
  for (const [label, projection] of cases) {
    const loaded = loadBundle();
    const registration = loaded.slot('conversation.input.dock');
    const view = mount(loaded, registration, {
      sessionId: 'session-test',
      useProjection: (key: string) => (key === 'sessionMetrics' ? projection : undefined),
    });
    try {
      const chip = view.container.querySelector('.dsm-trigger');
      assert.ok(chip !== null, `${label}: the strip must render a diagnostic, not nothing`);
      assert.match(view.text(), /waiting/, `${label}: the diagnostic says what it waits for`);
      assert.match(chip.getAttribute('title')!, /no settings/, `${label}: and names the missing half`);
    } finally {
      view.unmount();
    }
  }
});

test('robustness: settings and a ledger with no provider or model is a diagnostic, not a null read', () => {
  // The projection is present and well-formed, but nothing has recorded a provider or a
  // model yet — no `modelSelection` and an empty ledger. `current` is null, and the strip
  // must say so: before this path was guarded it read `current.provider` off null and
  // threw (`metrics: the strip renders nothing when the provider is unknown`).
  const emptyLedger: LedgerFixture = { turns: 0, steps: 0, totals: {}, rows: [] };
  const view = render({ ledger: emptyLedger, settings, selection: null, usage });
  try {
    assert.equal(view.text().includes('session-metrics failed'), false, `must not crash: ${view.text().slice(0, 140)}`);
    assert.match(view.text(), /waiting/, 'the strip renders its diagnostic');
    assert.match(view.text(), /no provider or model recorded yet/, 'and names the missing half');
  } finally {
    view.unmount();
  }
});
