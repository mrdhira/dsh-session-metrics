/**
 * Configuration resolution and native-schema contracts.
 *
 * Table-driven: each case names the situation it pins. Positive cases come first — the
 * shipped defaults, then overrides — followed by the leniency cases, which are all negative
 * inputs that must degrade instead of throwing.
 *
 * The native-schema cases exist because the Host only serves a configuration namespace —
 * the thing the Plugins-sidebar pricing page needs in order to read and write — when
 * `Config` carries the Schemastery brand. The predicate, the graph walk and the volatile
 * placement rule below are copied from `@deepseek-ai/dsh-app-boot`, so a protocol change
 * shows up here rather than as a dead settings page.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Config as NativeConfig, resolveSettings, SHIPPED_PROVIDERS } from '../lib/v1/settings.js';

/**
 * A native Schemastery node, as the Host's own code and these cases walk it.
 *
 * The shim's inferred type only covers `parse`/`validate`; the brand, `meta`, `dict`,
 * `inner` and `list` are the protocol this file exists to pin, so they are declared here.
 */
interface SchemaNode {
  type: string;
  meta: Record<string, any>;
  dict: Record<string, SchemaNode>;
  inner: SchemaNode;
  list: SchemaNode[];
  value?: any;
  '~standard': { validate(value: unknown): { issues?: unknown } };
}

/** `Config` at runtime IS that node; the imported value is only typed as the shim. */
const Config = NativeConfig as unknown as SchemaNode;

/** A config object as the Host may hand it over: any part of it can be absent or wrong. */
type ConfigInput = Record<string, any> | null | undefined;

/** The resolved settings object, as the module returns it. */
type ResolvedSettings = ReturnType<typeof resolveSettings>;

/** What a resolution case pins; the fields it omits stay at the shipped default. */
interface ResolutionWant {
  providers: string[];
  problems: number;
  display?: Record<string, any>;
  budget?: Record<string, any>;
  flatModel?: boolean;
}

/** What a leniency case pins: the surviving providers and the recorded problem. */
interface LeniencyWant {
  providers: string[];
  problem: RegExp;
  currency?: string;
  sessionUsd?: number;
}

interface ResolutionCase {
  name: string;
  input: ConfigInput;
  want: ResolutionWant;
}

interface LeniencyCase {
  name: string;
  input: ConfigInput;
  want: LeniencyWant;
}

const ids = (settings: ResolvedSettings) => settings.providers.map((p) => p.id);

/** Inputs that must resolve cleanly. */
const RESOLUTION_CASES: ResolutionCase[] = [
  {
    name: 'an absent config object resolves to the shipped defaults',
    input: undefined,
    want: { providers: ['deepseek-account', 'deepseek-official', 'netra-runtime'], problems: 0 },
  },
  {
    name: 'null behaves like absent',
    input: null,
    want: { providers: ['deepseek-account', 'deepseek-official', 'netra-runtime'], problems: 0 },
  },
  {
    name: 'an empty object resolves to the shipped defaults',
    input: {},
    want: { providers: ['deepseek-account', 'deepseek-official', 'netra-runtime'], problems: 0 },
  },
  {
    name: 'omitting providers keeps the shipped cards',
    input: { display: { currency: 'CNY', usdToCny: 7.25, primaryProvider: 'netra-runtime', labels: ['cost'] }, budget: { sessionUsd: 5, warnAt: 0.5 } },
    want: {
      providers: ['deepseek-account', 'deepseek-official', 'netra-runtime'],
      problems: 0,
      display: { currency: 'CNY', usdToCny: 7.25, primaryProvider: 'netra-runtime', labels: ['cost'] },
      budget: { sessionUsd: 5, warnAt: 0.5 },
    },
  },
  {
    name: 'a user provider list replaces the shipped one',
    input: {
      providers: [
        { id: 'my-router', label: 'My Router', models: [{ model: 'x/y', rates: { flat: { cacheHit: '0.01', cacheMiss: '0.1', output: '0.25' } } }], billing: { windows: [] } },
      ],
    },
    want: { providers: ['my-router'], problems: 0, flatModel: true },
  },
];

/** Negative inputs: each must degrade to a usable configuration and say why. */
const LENIENCY_CASES: LeniencyCase[] = [
  {
    name: 'one malformed provider is skipped and the rest resolve',
    input: {
      providers: [
        { id: 'broken', models: [{ model: 'm', rates: { peak: { cacheHit: 'free', cacheMiss: '0.3', output: '1.2' } } }] },
        { id: 'fine', models: [] },
      ],
    },
    want: { providers: ['fine'], problem: /providers\[0\].*invalid rate "free"/ },
  },
  {
    name: 'one malformed scalar falls back without losing its siblings',
    input: { display: { currency: 'EUR' }, budget: { sessionUsd: 3 } },
    want: { providers: ['deepseek-account', 'deepseek-official', 'netra-runtime'], problem: /^display:/, currency: 'USD', sessionUsd: 3 },
  },
  {
    name: 'a duplicate provider id is ignored, with a recorded problem',
    input: { providers: [{ id: 'dup' }, { id: 'dup' }] },
    want: { providers: ['dup'], problem: /duplicate provider id "dup"/ },
  },
];

test('defaults: the shipped cards and settings resolve with no problems', () => {
  const settings = resolveSettings({});
  assert.deepEqual(ids(settings), ['deepseek-account', 'deepseek-official', 'netra-runtime']);
  assert.deepEqual(settings.problems, []);
  assert.equal(settings.version, 1);
  assert.deepEqual(settings.display.labels, ['peak', 'time', 'cost', 'saved', 'provider'], 'the label set the strip ships with');
  assert.deepEqual(settings.display.details, ['cost', 'savings', 'models', 'window'], 'and the detail sections');
  assert.equal(settings.display.currency, 'USD');
  assert.deepEqual(settings.display.cnyInDetailsFor, [], 'CNY providers are opt-in');
  assert.equal(settings.budget.sessionUsd, null, 'a budget is off unless configured');
  assert.equal(settings.budget.warnAt, 0.75);
});

test('defaults: every resolution case yields the expected providers and problems', () => {
  for (const { name, input, want } of RESOLUTION_CASES) {
    const settings = resolveSettings(input);
    assert.deepEqual(ids(settings), want.providers, name);
    assert.equal(settings.problems.length, want.problems, `${name}: problems ${JSON.stringify(settings.problems)}`);
    // Only the fields the case names: the rest of the resolved object is the shipped default.
    for (const [key, value] of Object.entries(want.display ?? {})) {
      assert.deepEqual((settings.display as Record<string, any>)[key], value, `${name}: display.${key}`);
    }
    for (const [key, value] of Object.entries(want.budget ?? {})) {
      assert.deepEqual((settings.budget as Record<string, any>)[key], value, `${name}: budget.${key}`);
    }
    if (want.flatModel) assert.equal(settings.providers[0].models[0].mode, 'flat', `${name}: mode`);
  }
});

test('rates: a shipped peak provider is peak/off-peak, and a flat provider declares no windows', () => {
  const settings = resolveSettings({});
  const flash = settings.providers[0].models[0];
  assert.equal(flash.mode, 'peak');
  assert.equal(flash.rates.flat, null, 'a peak card has no flat row');
  assert.equal(flash.rates.peak.cacheHit, 6_000_000, 'peak as published');
  assert.equal(flash.rates.offPeak.cacheHit, 3_000_000, 'off-peak as half');
  const netra = settings.providers[2];
  assert.equal(netra.models[0].mode, 'flat');
  assert.equal(netra.models[0].rates.peak, null, 'a flat card has no peak row');
  assert.deepEqual(netra.billing.windows, [], 'and no peak concept');
});

test('leniency: a bad field degrades to a usable configuration and names itself', () => {
  for (const { name, input, want } of LENIENCY_CASES) {
    const settings = resolveSettings(input);
    assert.deepEqual(ids(settings), want.providers, name);
    assert.equal(settings.problems.length, 1, `${name}: exactly one problem`);
    assert.match(settings.problems[0], want.problem, name);
    if (want.currency) assert.equal(settings.display.currency, want.currency, `${name}: falls back`);
    if (want.sessionUsd) assert.equal(settings.budget.sessionUsd, want.sessionUsd, `${name}: sibling survives`);
  }
});

test('the shipped table is never mutated by resolving it', () => {
  const first = resolveSettings({});
  // The resolved card is a fresh copy; `aliases` is the field the shipped peak card carries.
  (first.providers[0].models[0] as { aliases: string[] }).aliases.push('mutated');
  const second = resolveSettings({});
  assert.equal(second.providers[0].models[0].aliases.includes('mutated'), false, 'each call gets a fresh copy');
  assert.equal((SHIPPED_PROVIDERS[0].models[0] as { aliases: string[] }).aliases.includes('mutated'), false, 'and the module table is untouched');
});

// --- the Host's gate on serving a configuration namespace -------------------------------

/** The Host's own predicate, copied from `@deepseek-ai/dsh-app-boot`. */
function isNativeConfigSchema(value: unknown): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  const meta = Reflect.get(value, 'meta');
  return Reflect.get(value, Symbol.for('schemastery')) === true
    && typeof Reflect.get(value, 'type') === 'string'
    && meta !== null && typeof meta === 'object';
}

/** The Host's volatility placement rule, copied from the same source. */
function validateVolatilePlacement(node: any, path: string, blocked = false, seen = new Map<any, Set<boolean>>()): void {
  const states = seen.get(node) ?? new Set();
  if (states.has(blocked)) return;
  states.add(blocked);
  seen.set(node, states);
  if (node.meta && node.meta.volatile && blocked) {
    throw new Error(`${path}: volatile fields require a fixed object path without an enclosing volatile field`);
  }
  const nested = blocked || !!(node.meta && node.meta.volatile);
  for (const [key, child] of Object.entries(node.dict ?? {})) validateVolatilePlacement(child, `${path}/${key}`, nested, seen);
  if (node.inner && node.type !== 'lazy') validateVolatilePlacement(node.inner, `${path}/inner`, true, seen);
  for (const [index, child] of (node.list ?? []).entries()) validateVolatilePlacement(child, `${path}/${index}`, true, seen);
}

test('native: Config passes the Host brand check and accepts an absent config', () => {
  assert.equal(isNativeConfigSchema(Config), true);
  assert.equal(Config.type, 'object');
  assert.equal(typeof Config.meta, 'object');
  assert.equal(Object.getOwnPropertySymbols(Config).includes(Symbol.for('schemastery')), true);
  assert.equal(Config['~standard'].validate(undefined).issues, undefined, 'an absent config is valid');
});

test('native: the whole graph walks under the projector rules', () => {
  const types = new Set(['any', 'never', 'const', 'boolean', 'string', 'number', 'object', 'array', 'dict', 'tuple', 'union', 'transform']);
  const needsChild: Record<string, string | undefined> = { object: 'dict', array: 'inner', dict: 'inner', tuple: 'list', union: 'list', transform: 'inner' };
  const problems: string[] = [];
  let visited = 0;
  const visit = (node: any, path: string): void => {
    visited += 1;
    const type = Reflect.get(node, 'type');
    if (!types.has(type)) problems.push(`${path}: native type "${type}" is not projectable`);
    const meta = Reflect.get(node, 'meta');
    if (meta === null || typeof meta !== 'object') problems.push(`${path}: meta must be an object`);
    const need = needsChild[type];
    if (need !== undefined && Reflect.get(node, need) === undefined) problems.push(`${path}: ${type} is missing ${need}`);
    if (type === 'object') for (const [key, child] of Object.entries(node.dict)) visit(child, `${path}/${key}`);
    else if (type === 'array' || type === 'dict') visit(node.inner, `${path}[]`);
    else if (type === 'tuple' || type === 'union') node.list.forEach((child: any, index: number) => visit(child, `${path}/${index}`));
  };
  visit(Config, 'config');
  assert.deepEqual(problems, []);
  assert.ok(visited > 50, `expected the whole config graph to be walked, visited ${visited}`);
});

test('native: the editable fields are volatile and legally placed', () => {
  // `dsh-settings` exposes ONLY volatile fields, so a schema without any is read-only in
  // the UI — which is how this plugin's Pricing page first appeared as a bare YAML block.
  assert.doesNotThrow(() => validateVolatilePlacement(Config, 'config'), 'our volatile placement must be legal');
  for (const field of ['display', 'budget', 'providers', 'pricingAsOf']) {
    assert.equal(Config.dict[field].meta.volatile, true, `${field} is editable`);
  }
  const providersInner = Config.dict.providers.inner;
  assert.equal(providersInner.meta.volatile, undefined, 'nested fields stay non-volatile: a rate row lives inside an array');
});

test('native: chaining after construction is reflected in the projected meta', () => {
  assert.deepEqual(Config.dict.providers.meta.default, SHIPPED_PROVIDERS, 'the shipped table is the projected default');
  assert.equal(Config.dict.providers.inner.dict.models.type, 'array');
  const currency = Config.dict.display.dict.currency;
  assert.equal(currency.type, 'union');
  assert.deepEqual(currency.list.map((node: any) => node.value), ['USD', 'CNY']);
  assert.equal(Config.dict.budget.dict.sessionUsd.meta.required, false, 'an optional field projects as not required');
});

test('native: a structurally invalid schema is rejected by the same predicate', () => {
  assert.equal(isNativeConfigSchema(null), false);
  assert.equal(isNativeConfigSchema({ type: 'object' }), false, 'no brand');
  assert.equal(isNativeConfigSchema({ [Symbol.for('schemastery')]: true, type: 'object' }), false, 'no meta');
  assert.equal(isNativeConfigSchema({ [Symbol.for('schemastery')]: true, meta: {} }), false, 'no type');
});
