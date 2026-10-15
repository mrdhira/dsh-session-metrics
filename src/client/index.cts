/**
 * Client half of the session-metrics bundle (TypeScript source).
 *
 * A DSH client module is a plain script registering a lazy factory whose `id` equals the
 * package name; the factory returns a Cordis plugin. `build.mjs` wraps this module in that
 * handshake, so the file itself is an ordinary CommonJS module: React arrives through
 * `require`, and the factory's return value is `module.exports`.
 *
 * No JSX: the element tree is built with `React.createElement`, which keeps the bundle free
 * of a `react/jsx-runtime` import the browser module table may not expose.
 *
 * It deliberately shows only what the shipped stats pills cannot: money, cache savings, the
 * peak/off-peak window, the provider and the budget. Session token totals, cache-hit rate,
 * context, turns, steps and tok/s belong to those pills.
 */

// React arrives through `require` because the bundle is a CommonJS factory. The cast is
// the seam: `require` is typed as returning `unknown` (that is honest — the loader could
// hand back anything), `typeof import('react')` is a type-only reference to the package
// this repo already depends on at runtime, so the framework's own API is stated rather
// than the bundle's copy of it being hand-declared. React is bundled by nobody (it is
// external), so the types and the value are the same module.
const React = require('react') as typeof import('react');
// A tooltip must not be clipped by the panel's scroll container, and a fixed-position box
// is still clipped if any ancestor carries a transform. Portalling it to `document.body`
// escapes both, and the guard keeps a missing module from taking the whole panel down —
// which is also why the result is `null`, not a throw, at this boundary.
const ReactDOM = (function (): typeof import('react-dom') | null {
  try {
    return require('react-dom') as typeof import('react-dom');
  } catch (error) {
    return null;
  }
})();
const h = React.createElement;
const { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } = React;

const PLUGIN_ID = 'dsh-session-metrics';
/** Rendered in the detail footer so a shipped generation is verifiable from a screenshot. */
const BUILD = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dsh-session-metrics/dev';
const NS = 'sessionMetrics';
const PROJECTION = 'sessionMetrics';
const BUDGET_KEY = PLUGIN_ID + '.budget.';

// ------------------------------------------------------------------- shapes
// The domain shapes this half reads. Two families live here and they are not the
// same thing: the **resolved** shapes the Host projects (integer-nanodollar rates,
// `mode: 'flat' | 'peak'`) and the **stored/editor** shapes the settings schema
// accepts (USD decimal strings, `rates.flat` or `rates.peak`). The editor is the
// only place they meet, which is why `normalizeProviders` exists at all.

/** The four billing buckets, as a ledger total or the `tokenUsage` projection carries them. */
interface Buckets {
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

/** An hour window `[start, end)` in the billing zone; start > end wraps midnight. */
type HourWindow = [number, number];

/** A resolved rate row: integer nanodollars per 1M tokens, each bucket. */
interface ResolvedRateRow {
  cacheHit: number;
  cacheMiss: number;
  cacheWrite: number;
  output: number;
}

/** A rate row in editor/schema form: USD decimal strings; `cacheWrite` may be absent. */
interface EditorRateRow {
  cacheHit?: string;
  cacheMiss?: string;
  cacheWrite?: string;
  output?: string;
}

/**
 * The billing calendar: one shape for both the resolved and the stored form.
 *
 * `windows` are `[start, end)` hours, `weekdays` are ISO 1-7, `holidays` are
 * `YYYY-MM-DD` dates written in `holidayZone` — which the Host compares in that
 * zone, so `tierAt` below must too.
 */
interface Billing {
  timezone: string;
  weekdays: number[];
  windows: HourWindow[];
  holidays: string[];
  holidayZone: string;
}

/**
 * A model card that may arrive resolved or stored.
 *
 * `mode` only exists on the resolved shape; the editor's stored shape is detected
 * by `rates.flat` / `rates.peak` instead. `rates.*` are `ResolvedRateRow` when the
 * Host resolved them and `EditorRateRow` when they came back out of the schema —
 * the two are distinguished by the `normalizeProviders` boundary, and this type
 * deliberately keeps both visible rather than collapsing them into one lie.
 */
interface ModelCard {
  model: string;
  aliases: string[];
  label?: string;
  mode?: 'flat' | 'peak';
  contextWindow?: number;
  rates: {
    flat?: ResolvedRateRow | EditorRateRow | null;
    peak?: ResolvedRateRow | EditorRateRow | null;
    offPeak?: ResolvedRateRow | EditorRateRow | null;
    multiplier?: number;
  };
}

/** One provider card, as the settings projection carries it. */
interface ProviderCard {
  id: string;
  label?: string;
  billing: Billing;
  models: ModelCard[];
}

/** Presentation choices from the settings projection. */
interface DisplaySettings {
  currency: 'USD' | 'CNY';
  cnyInDetailsFor: string[];
  usdToCny: number;
  labels: string[];
  details: string[];
  primaryProvider: string | null;
}

/** The resolved budget, after the Host's defaults. */
interface BudgetSettings {
  sessionUsd: number | null;
  warnAt: number;
}

/**
 * The `sessionMetrics` projection value: what the Host folds for this session.
 *
 * Shape read from the Host's own projection (`src/host/index.ts`):
 * `{ version: 1, settings, ledger: toLedgerView(state) }` — the resolved settings and
 * the per-step ledger, side by side. `ledger` is absent (not null) on a projection from
 * a host that has not folded a step yet, which is why every read of it is guarded.
 */
interface SessionMetricsValue {
  version: number;
  settings: SessionSettingsValue;
  ledger?: LedgerValue | null;
}

/** The resolved settings half of the projection. */
interface SessionSettingsValue {
  version: number;
  display: DisplaySettings;
  budget: BudgetSettings;
  pricingAsOf: string | null;
  providers: ProviderCard[];
  problems: string[];
}

/** One provider/model/tier price group, as the strip computes it. */
interface PriceGroup {
  key: string;
  provider: string | null;
  model: string | null;
  tier: string;
  buckets: Buckets;
  /** The rate row priced, or null when the pair has no card for this tier. */
  rates: ResolvedRateRow | EditorRateRow | null;
  price: PriceResult | null;
  savings: number;
}

/** The four priced buckets plus their total, in integer nanodollars. */
interface PriceResult {
  cacheHitNano: number;
  cacheMissNano: number;
  cacheWriteNano: number;
  outputNano: number;
  totalNano: number;
}

/** One ledger row, as `toLedgerView` projects it. */
interface LedgerRow {
  turn: number;
  step: number;
  startTime: number;
  endTime: number | null;
  provider: string | null;
  model: string | null;
  tier: string;
  buckets: Buckets;
}

/** A provider/model pair the ledger observed with no rate card. */
interface DiscoveredPair {
  provider: string | null;
  model: string | null;
  tokens: number;
  reports: number;
  firstSeen: number | null;
  lastSeen: number | null;
}

/**
 * The `ledger` projection.
 *
 * An older checkpoint carries no `discovered` field at all, so it is optional —
 * reading it as present is exactly the class of assumption that crashed the live
 * strip, and the reader treats absence as an empty list.
 */
interface LedgerValue {
  turns: number;
  steps: number;
  totals: Record<string, Buckets>;
  rows: LedgerRow[];
  discovered?: DiscoveredPair[];
}

/** The `modelSelection` projection, limited to the two fields the strip reads. */
interface ModelSelectionValue {
  lastUsed?: { provider?: string; model?: string } | null;
  next?: { provider?: string; model?: string } | null;
}

/** A provider/model pair, once both halves are known. */
interface Pair {
  provider: string;
  model: string | null;
}

/** The accepted configuration layer as the pricing page reads it (all fields optional: partial layers are normal). */
interface ConfigLayer {
  display?: Partial<DisplaySettings>;
  budget?: Partial<BudgetSettings>;
  providers?: unknown;
  pricingAsOf?: string | null;
  [key: string]: unknown;
}

// ------------------------------------------------------------- editor shapes
// What `normalizeProviders` produces: the stored/schema form, USD decimal strings, no
// nanodollars and no `mode`. The editor renders and writes this shape, and the Host
// parses it back. Keeping it distinct from `ProviderCard` is the point — the same code
// reads both, and treating one as the other is what showed "6000000" as dollars.

/** One model row as the editor holds it. */
interface EditorModel {
  model: string;
  aliases: string[];
  label?: string;
  contextWindow?: number;
  rates: {
    flat?: EditorRateRow;
    peak?: EditorRateRow;
    offPeak?: EditorRateRow;
    multiplier?: number;
  };
}

/** One provider row as the editor holds it. */
interface EditorProvider {
  id: string;
  label?: string;
  billing: Billing;
  models: EditorModel[];
}

/** A draft edit in progress: the rows, fenced by the revision they started from. */
interface EditorDraft {
  revision: unknown;
  providers: EditorProvider[];
}

/**
 * The snapshot the pricing page reads: `value` (accepted), `base` (inherited), revision
 * and writability. `readSnapshot` hands back exactly this shape, narrowed once from the
 * service's `unknown` face.
 */
interface ConfigSnapshot {
  value?: unknown;
  base?: unknown;
  revision?: unknown;
  writability?: string;
  writable?: boolean;
}

// ------------------------------------------------------------- boundary reads
/**
 * Narrow an `unknown` boundary value to a bag of fields, or `null`.
 *
 * Every value that crosses into this half — a projection, a config layer, a snapshot
 * from the settings service, a `formatToParts` entry — arrives as `unknown`, and the
 * job at the boundary is to turn "I hope this is an object" into a check the compiler
 * tracks. The null prototype is not decoration: it keeps a `value` or `providers`
 * inherited from `Object.prototype` from ever being read as if it were supplied.
 * @param value - whatever arrived.
 * @returns the value as a plain record, or `null` when it is not an object.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object') return null;
  return Object.assign(Object.create(null) as Record<string, unknown>, value as Record<string, unknown>);
}

/** A number, or a fallback. Used for every numeric field of a wire value. */
function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && isFinite(value) ? value : fallback;
}

/** A string, or null. */
function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A string list, dropping anything that is not a string. */
function asTextList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** `[start, end)` hour windows, dropping anything that is not a two-number pair. */
function asWindows(value: unknown): HourWindow[] {
  if (!Array.isArray(value)) return [];
  return value.filter(function (entry): entry is HourWindow {
    return Array.isArray(entry) && typeof entry[0] === 'number' && typeof entry[1] === 'number';
  });
}

/**
 * One rate row from either shape the Host serves.
 *
 * Resolved rows are numbers, stored rows are USD strings; both are copied through
 * unchanged so the same object can hold either. An absent row stays absent — that is
 * the shape whose `peak` is undefined on a flat model, and inventing a value for it
 * would be the bug rather than the fix.
 */
function asRateRow(value: unknown): ResolvedRateRow | EditorRateRow | null {
  const row = asRecord(value);
  if (row === null) return null;
  const out: Record<string, number | string> = {};
  for (const key of ['cacheHit', 'cacheMiss', 'cacheWrite', 'output'] as const) {
    const field = row[key];
    if (typeof field === 'number' || typeof field === 'string') out[key] = field;
  }
  return out as ResolvedRateRow | EditorRateRow;
}

/** One model card from the settings projection. */
function asModelCard(value: unknown): ModelCard | null {
  const model = asRecord(value);
  if (model === null || typeof model.model !== 'string') return null;
  const rates = asRecord(model.rates) ?? {};
  const card: ModelCard = { model: model.model, aliases: asTextList(model.aliases), rates: {} };
  for (const tier of ['flat', 'peak', 'offPeak'] as const) {
    const row = asRateRow(rates[tier]);
    if (row !== null) card.rates[tier] = row;
  }
  if (typeof rates.multiplier === 'number') card.rates.multiplier = rates.multiplier;
  if (typeof model.label === 'string') card.label = model.label;
  if (model.mode === 'flat' || model.mode === 'peak') card.mode = model.mode;
  if (typeof model.contextWindow === 'number') card.contextWindow = model.contextWindow;
  return card;
}

/** The billing calendar from the settings projection, with the schema's own defaults. */
function asBilling(value: unknown): Billing {
  const billing = asRecord(value) ?? {};
  return {
    timezone: asText(billing.timezone) ?? 'UTC',
    weekdays: Array.isArray(billing.weekdays)
      ? billing.weekdays.filter((day): day is number => typeof day === 'number')
      : [1, 2, 3, 4, 5],
    windows: asWindows(billing.windows),
    holidays: asTextList(billing.holidays),
    holidayZone: asText(billing.holidayZone) ?? 'Asia/Shanghai',
  };
}

/** One provider card from the settings projection. */
function asProviderCard(value: unknown): ProviderCard | null {
  const provider = asRecord(value);
  if (provider === null || typeof provider.id !== 'string') return null;
  const models = Array.isArray(provider.models) ? provider.models : [];
  const card: ProviderCard = {
    id: provider.id,
    billing: asBilling(provider.billing),
    models: models.map(asModelCard).filter((model): model is ModelCard => model !== null),
  };
  if (typeof provider.label === 'string') card.label = provider.label;
  return card;
}

/** The `sessionMetrics` projection, read field by field. */
function asSessionMetrics(value: unknown): SessionMetricsValue | null {
  const metrics = asRecord(value);
  if (metrics === null) return null;
  const settings = asSettings(metrics.settings);
  if (settings === null) return null;
  return {
    version: asNumber(metrics.version, 1),
    settings: settings,
    ledger: asLedger(metrics.ledger),
  };
}

/** The resolved settings half of the projection. */
function asSettings(value: unknown): SessionSettingsValue | null {
  const settings = asRecord(value);
  if (settings === null) return null;
  const display = asRecord(settings.display) ?? {};
  const budget = asRecord(settings.budget) ?? {};
  const providers = Array.isArray(settings.providers) ? settings.providers : [];
  return {
    version: asNumber(settings.version, 1),
    display: {
      currency: display.currency === 'CNY' ? 'CNY' : 'USD',
      cnyInDetailsFor: asTextList(display.cnyInDetailsFor),
      usdToCny: asNumber(display.usdToCny, 1),
      labels: asTextList(display.labels),
      details: asTextList(display.details),
      primaryProvider: asText(display.primaryProvider),
    },
    budget: {
      sessionUsd: typeof budget.sessionUsd === 'number' ? budget.sessionUsd : null,
      warnAt: asNumber(budget.warnAt, 0.75),
    },
    pricingAsOf: asText(settings.pricingAsOf),
    providers: providers.map(asProviderCard).filter((provider): provider is ProviderCard => provider !== null),
    problems: asTextList(settings.problems),
  };
}

/**
 * The ledger projection.
 *
 * `discovered` is optional on purpose: a checkpoint written before that field existed
 * carries none, and reading it as present is exactly the assumption that produced a
 * live crash. Absent becomes an empty list here, once.
 */
function asLedger(value: unknown): LedgerValue | null {
  const ledger = asRecord(value);
  if (ledger === null) return null;
  const totalsRecord = asRecord(ledger.totals) ?? {};
  const totals: Record<string, Buckets> = {};
  for (const key of Object.keys(totalsRecord)) totals[key] = asBuckets(totalsRecord[key]);
  const rows = Array.isArray(ledger.rows) ? ledger.rows : [];
  const discovered = Array.isArray(ledger.discovered) ? ledger.discovered : [];
  return {
    turns: asNumber(ledger.turns, 0),
    steps: asNumber(ledger.steps, 0),
    totals: totals,
    rows: rows.map(asLedgerRow).filter((row): row is LedgerRow => row !== null),
    discovered: discovered.map(asDiscoveredPair).filter((pair): pair is DiscoveredPair => pair !== null),
  };
}

/** One token-bucket set, as a ledger total carries it. */
function asBuckets(value: unknown): Buckets {
  const buckets = asRecord(value) ?? {};
  return {
    uncachedInputTokens: asNumber(buckets.uncachedInputTokens, 0),
    cacheReadTokens: asNumber(buckets.cacheReadTokens, 0),
    cacheWriteTokens: asNumber(buckets.cacheWriteTokens, 0),
    outputTokens: asNumber(buckets.outputTokens, 0),
  };
}

/** One ledger row. */
function asLedgerRow(value: unknown): LedgerRow | null {
  const row = asRecord(value);
  if (row === null) return null;
  return {
    turn: asNumber(row.turn, 0),
    step: asNumber(row.step, 0),
    startTime: asNumber(row.startTime, 0),
    endTime: typeof row.endTime === 'number' ? row.endTime : null,
    provider: asText(row.provider),
    model: asText(row.model),
    tier: asText(row.tier) ?? 'flat',
    buckets: asBuckets(row.buckets),
  };
}

/** One observed-but-unpriced pair. */
function asDiscoveredPair(value: unknown): DiscoveredPair | null {
  const pair = asRecord(value);
  if (pair === null) return null;
  return {
    provider: asText(pair.provider),
    model: asText(pair.model),
    tokens: asNumber(pair.tokens, 0),
    reports: asNumber(pair.reports, 0),
    firstSeen: typeof pair.firstSeen === 'number' ? pair.firstSeen : null,
    lastSeen: typeof pair.lastSeen === 'number' ? pair.lastSeen : null,
  };
}

/**
 * The writer face of a form, or null when it carries no `mutate`.
 *
 * The guard is on the method actually called, in one place: `save` used to repeat
 * `typeof form.mutate !== 'function'` after the form had already been narrowed, which
 * is impossible to keep honest once `form` is `unknown`.
 * @param form - the form as the page holds it.
 * @returns the typed writer, or null.
 */
function asWriter(form: unknown): DshConfigForm | null {
  const candidate = asRecord(form);
  if (candidate === null || typeof candidate.mutate !== 'function') return null;
  return candidate as DshConfigForm;
}

/** The rows of a draft, or an empty list when there is no draft. */
function rowsOf(draft: EditorDraft | null): EditorProvider[] {
  return draft === null ? [] : draft.providers;
}

/**
 * A provider list from either a resolved settings layer or an already-normalized one.
 *
 * `base` is the inherited layer, which the Host serves in the schema's own shape but
 * which a test (or a future version) may hand over already normalized; both are read
 * through `normalizeProviders` so the caller sees the editor shape either way.
 * @param providers - the raw list from a config layer, if there is one.
 * @returns the rows.
 */
function asProviderList(providers: unknown): EditorProvider[] {
  // The inherited layer is the Host's **resolved** tree (integer nanodollar rates,
  // `mode`), not the editor's USD-string form, so it is copied field by field before the
  // one normalizer runs. Reading it as `EditorProvider[]` would be the exact mistake that
  // showed "6000000" as dollars.
  if (!Array.isArray(providers)) return [];
  const entries: unknown[] = providers;
  const cards: ProviderCard[] = [];
  for (const entry of entries) {
    const card = asProviderCard(entry);
    if (card !== null) cards.push(card);
  }
  return normalizeProviders(cards);
}

/**
 * One configuration layer from the settings snapshot.
 *
 * The layer is partial by design: the Host exposes only the fields it serves, so
 * `display`, `budget` and `providers` may each be absent, and each takes the schema's
 * own default. Normalizing here is what lets the rest of the pricing page assume a
 * shape instead of guarding every read — and it is the boundary a partial layer must
 * cross, which is how the live `JSON.parse(JSON.stringify(undefined))` crash reached
 * the number formatting before.
 * @param value - the `value` or `base` layer from the snapshot.
 * @returns the layer the page renders from.
 */
function asConfigLayer(value: unknown): ConfigLayer {
  const layer = asRecord(value) ?? {};
  const display = asRecord(layer.display) ?? {};
  const budget = asRecord(layer.budget) ?? {};
  const labels = asTextList(display.labels);
  const details = asTextList(display.details);
  return {
    display: {
      currency: display.currency === 'CNY' ? 'CNY' : 'USD',
      cnyInDetailsFor: asTextList(display.cnyInDetailsFor),
      usdToCny: asNumber(display.usdToCny, 7.1),
      labels: labels.length > 0 ? labels : ['peak', 'time', 'cost', 'saved', 'provider'],
      details: details.length > 0 ? details : ['cost', 'savings', 'models', 'window'],
      primaryProvider: asText(display.primaryProvider),
    },
    budget: {
      sessionUsd: typeof budget.sessionUsd === 'number' ? budget.sessionUsd : null,
      warnAt: asNumber(budget.warnAt, 0.75),
    },
    providers: Array.isArray(layer.providers) ? layer.providers : [],
    pricingAsOf: asText(layer.pricingAsOf),
  };
}

// ---------------------------------------------------------------- styles
const STYLES = [
  '.dsm-slot{position:sticky;bottom:0;z-index:7;width:100%;display:flex;justify-content:center;background:linear-gradient(180deg,transparent 0px,var(--dsw-alias-bg-base) 12px)}',
  '.dsm-root{position:relative;min-width:0;font-size:calc(var(--dsh-content-font-size,14px) - 3px);line-height:16px;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.dsm-trigger{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-primary);color:inherit;font:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:8px;padding:2px 6px}',
  '.dsm-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
  '.dsm-item{display:inline-flex;align-items:baseline;gap:4px;white-space:nowrap}',
  '.dsm-item b{font-weight:600;color:var(--dsw-alias-label-secondary)}',
  '.dsm-mono{font-variant-numeric:tabular-nums;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}',
  '.dsm-peak,.dsm-off{font-weight:700;letter-spacing:.02em}',
  '.dsm-peak{color:var(--dsw-alias-state-error-primary,#c53030)}',
  '.dsm-off{color:var(--dsw-alias-state-success-primary,#2f855a)}',
  '.dsm-flagDot{font-size:0.82em;line-height:12px}',
  '.dsm-zone{font-weight:500;opacity:.75;margin-left:2px;white-space:nowrap}',
  '.dsm-cols{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 12px;margin:6px 0}',
  '.dsm-col{display:flex;flex-direction:column;gap:1px;min-width:0}',
  '.dsm-col span{font-size:.91em;color:var(--dsw-alias-label-quaternary);white-space:nowrap}',
  '.dsm-col b{font-size:1.09em;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
  '.dsm-col i{font-style:normal;font-size:.91em;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
  '.dsm-hint{position:relative;border-bottom:1px dotted var(--dsw-alias-label-quaternary);cursor:help}',
  '.dsm-tipBox{position:fixed;z-index:80;width:max-content;max-width:min(320px,calc(100vw - 24px));white-space:normal;text-transform:none;letter-spacing:0;font-weight:400;font-size:0.91em;line-height:1.35;text-align:left;color:var(--dsw-alias-label-secondary);background:var(--dsw-specific-menu,var(--dsw-alias-bg-primary,#fff));border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:6px 8px;box-shadow:0 8px 20px rgba(0,0,0,.18);pointer-events:none}',
  '.dsm-tipAbove{transform:translateY(-100%)}',
  '.dsm-sep{opacity:.5}',
  '.dsm-path{font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);background:var(--dsw-alias-fill-tsp-secondary);border-radius:4px;padding:1px 5px;color:var(--dsw-alias-label-primary);font-weight:600}',
  '.dsm-q{font-size:.85em;color:var(--dsw-alias-label-quaternary);margin-left:3px;cursor:help}',
  '.dsm-foot{margin-top:10px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l2);font-size:.85em;color:var(--dsw-alias-label-quaternary);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}',
  '.dsm-barInput{background:var(--dsw-alias-state-warning-primary,#b7791f)}',
  '.dsm-warn{color:var(--dsw-alias-state-warning-primary,#b7791f)}',
  '.dsm-over{color:var(--dsw-alias-state-error-primary,#c53030)}',
  '.dsm-model{color:var(--dsw-alias-label-quaternary);max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsm-build{font-size:0.82em;opacity:.5;margin-left:4px}',
  '.dsm-scrim{position:fixed;inset:0;z-index:60}',
  '.dsm-panel{position:fixed;z-index:61;box-sizing:border-box;width:min(560px,calc(100vw - 32px));max-height:min(70vh,640px);overflow:auto;border-radius:var(--dsw-radius-lg);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-menu,var(--dsw-alias-bg-primary,#fff));box-shadow:0 12px 32px rgba(0,0,0,.18);padding:12px}',
  '.dsm-title{font-size:1.09em;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}',
  '.dsm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px 12px;margin:8px 0}',
  '.dsm-cell{display:flex;flex-direction:column;gap:1px;min-width:0}',
  '.dsm-cell span{font-size:0.91em;color:var(--dsw-alias-label-quaternary)}',
  '.dsm-cell b{font-size:1.09em;font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
  '.dsm-section{margin-top:10px;font-size:0.91em;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-quaternary)}',
  '.dsm-table{width:100%;border-collapse:collapse;font-size:1em;margin-top:4px}',
  '.dsm-table th{text-align:right;font-weight:500;color:var(--dsw-alias-label-quaternary);padding:2px 4px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
  '.dsm-table th:first-child,.dsm-table td:first-child{text-align:left}',
  '.dsm-table td{padding:2px 4px;text-align:right;color:var(--dsw-alias-label-secondary)}',
  '.dsm-table tr[data-peak="true"] td:first-child{border-left:2px solid var(--dsw-alias-state-warning-primary,#b7791f);padding-left:6px}',
  '.dsm-note{margin-top:8px;font-size:0.91em;color:var(--dsw-alias-label-quaternary)}',
  '.dsm-bar{height:5px;border-radius:999px;background:var(--dsw-alias-fill-tsp-secondary);overflow:hidden;display:flex;margin-top:3px}',
  '.dsm-bar i{display:block;height:100%}',
  '.dsm-hit{background:var(--dsw-alias-state-success-primary,#2f855a)}',
  '.dsm-miss{background:var(--dsw-alias-state-warning-primary,#b7791f)}',
  '.dsm-write{background:var(--dsw-alias-label-quaternary)}',
  '.dsm-output{background:var(--dsw-alias-state-business-primary,#3182ce)}',
  '.dsm-toggle{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:0.91em;cursor:pointer;padding:1px 8px}',
  '.dsm-toggle[data-on="true"]{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-fill-tsp-secondary)}',
  '.dsm-page{font-size:calc(var(--dsh-content-font-size,14px) - 2px);color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:8px}',
  '.dsm-card{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:8px;display:flex;flex-direction:column;gap:6px}',
  '.dsm-cardHead,.dsm-modelHead,.dsm-actions,.dsm-billingRow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
  '.dsm-cardHead{font-weight:600}',
  '.dsm-modelRow{border-top:1px dashed var(--dsw-alias-border-l2);padding-top:6px;display:flex;flex-direction:column;gap:4px}',
  '.dsm-input{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-primary);color:var(--dsw-alias-label-primary);font:inherit;font-size:1em;padding:2px 6px;min-width:70px}',
  '.dsm-inputId{font-weight:600;min-width:170px}',
  '.dsm-inputModel{min-width:260px;font-weight:600}',
  '.dsm-rates{display:flex;gap:6px;flex-wrap:wrap}',
  '.dsm-rate{display:flex;flex-direction:column;gap:1px;font-size:0.91em;color:var(--dsw-alias-label-quaternary)}',
  '.dsm-usdLabel{font-size:0.91em;color:var(--dsw-alias-label-quaternary)}',
  '.dsm-tag{font-size:0.91em;color:var(--dsw-alias-label-quaternary);font-weight:400}',
  '.dsm-badge{display:inline-flex;align-items:center;gap:4px;font-size:0.91em;line-height:16px;white-space:nowrap;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 8px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-fill-tsp-secondary)}',
  '.dsm-primary{border-color:var(--dsw-alias-border-l3);font-weight:600;color:var(--dsw-alias-label-primary)}',
  '.dsm-toggle:disabled{opacity:.45;cursor:default}',
  '.dsm-diag{border-style:dashed;opacity:.85}',
  '.dsm-summary{font-size:1.09em;color:var(--dsw-alias-label-tertiary)}',
  '.dsm-list{margin:4px 0 0;padding-left:16px;font-size:1em;color:var(--dsw-alias-label-secondary)}',
  '.dsm-pre{margin:0;padding:8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-fill-tsp-secondary);font-size:0.91em;line-height:14px;overflow:auto;max-height:220px}',
  // Declared last on purpose: it must win over `.dsm-tag`/`.dsm-warn` at equal specificity.
  '.dsm-unpriced{color:var(--dsw-alias-state-warning-primary,#b7791f);font-weight:600}',
].join('');

if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + NS + '"]') === null) {
  const style = document.createElement('style');
  style.dataset.plugin = PLUGIN_ID;
  style.dataset.pluginCss = NS;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

// ------------------------------------------------------------ formatting
const NANO = 1e9;
const PER_MILLION = 1e6;

/** Integer nanodollars from a token count and a per-1M nanodollar rate. */
function costOf(rateNano: number | null | undefined, tokens: number | null | undefined): number {
  if (!rateNano || !tokens) return 0;
  return Math.round((rateNano * tokens) / PER_MILLION);
}

/** Integer nanodollars to a USD string; null when there is no figure to show. */
function usd(nano: number | null | undefined, digits?: number): string | null {
  if (nano === null || nano === undefined || !isFinite(nano)) return null;
  const places = digits === undefined ? 4 : digits;
  const whole = Math.floor(Math.abs(nano) / NANO);
  const frac = String(Math.round(Math.abs(nano) - whole * NANO)).padStart(9, '0').slice(0, places);
  return (nano < 0 ? '-' : '') + whole + '.' + frac;
}


/**
 * Money as the strip shows it: rounded half-up to cents.
 *
 * `usd` truncates, which is right for internal figures but wrong for a label a
 * person compares against a bill.
 */
function usd2(nano: number | null | undefined): string | null {
  if (nano === null || nano === undefined || !isFinite(nano)) return null;
  const cents = Math.round(Math.abs(nano) / 1e7);
  // A session that has cost something must not read as free: below a cent, say so.
  if (cents === 0 && nano > 0) return '< $0.01';
  return (nano < 0 ? '-$' : '$') + (cents / 100).toFixed(2);
}

/** The city part of an IANA zone: `Asia/Tokyo` becomes `Tokyo`. */
function cityOf(zone: string | null | undefined): string {
  const tail = String(zone || 'UTC').split('/').pop() || 'UTC';
  return tail.replace(/_/g, ' ');
}

/**
 * Label keys, with the legacy aliases expanded and de-duplicated.
 *
 * `window` used to mean "the peak flag and the clock in one chip"; it now maps to
 * the separate `peak` and `time` chips so existing profile configs keep rendering.
 */
function labelKeys(labels: unknown): string[] {
  const out: string[] = [];
  const add = function (key: string): void { if (out.indexOf(key) < 0) out.push(key); };
  (Array.isArray(labels) ? labels : []).forEach(function (key) {
    if (key === 'window') { add('peak'); add('time'); }
    else if (key === 'savings') { add('saved'); }
    else if (key === 'steps') { /* removed from the UI; the ledger stays in the projection */ }
    else add(key);
  });
  return out;
}

/** Every token bucket a session can be billed for. */
function bucketTotal(buckets: Buckets): number {
  return buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens + buckets.outputTokens;
}

/**
 * The same peak window expressed in another zone, for the schedule sentence.
 *
 * Derived from today's offset between the two zones, which is what a reader wants
 * from a one-line "in your local time" hint.
 */
function windowInZone(nowMs: number, window: HourWindow, providerZone: string, viewerZone: string): string {
  const at = zoned(new Date(nowMs), providerZone);
  const midnight = nowMs - ((at.hour * 60 + at.minute) * 60000) - (nowMs % 60000);
  const start = midnight + window[0] * 3600000;
  const end = midnight + window[1] * 3600000;
  const finish = window[1] > window[0] ? end : end + 86400000;
  return clock(start, viewerZone) + '\u2013' + clock(finish, viewerZone);
}

/** Tooltip copy for the figures that need a sentence of explanation. */
const TIPS = {
  input: 'Prompt tokens billed at the input rate. A cache write, when one happens, is billed here too.',
  output: 'Completion tokens billed at the output rate.',
  cached: 'Prompt tokens served from cache and billed at the cheaper cached rate.',
  saved: 'Cached tokens \u00d7 (input rate \u2212 cached rate): what those tokens would have cost at the full input rate, minus what they actually cost.',
  blended: 'Total cost \u00f7 total tokens \u2014 the average actually paid per 1M tokens, across cached, uncached and output together.',
  share: 'Share of this session\u2019s cost that went to reading cached input.',
  budget: 'A budget is a display aid: it never blocks the agent.',
};

/** Compact token counts, used only where the pills do not already show them. */
function tokens(value: unknown): string {
  if (typeof value !== 'number' || !isFinite(value)) return '—';
  if (value >= 1e9) return (value / 1e9).toFixed(2) + 'B';
  if (value >= 1e6) return (value / 1e6).toFixed(2) + 'M';
  if (value >= 1e3) return (value / 1e3).toFixed(1) + 'k';
  return String(Math.round(value));
}

/** One decimal percentage. */
function pct(value: unknown): string {
  if (typeof value !== 'number' || !isFinite(value)) return '—';
  return (value * 100).toFixed(1) + '%';
}

// ------------------------------------------------------- tier + calendar
/**
 * One formatter per zone, reused.
 *
 * This runs inside the tier search, which probes up to dozens of instants per
 * render. Building a formatter per probe allocated thousands of ICU objects a
 * second while the detail panel ticked — enough to run a test process out of
 * memory.
 */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** The cached formatter for one zone. */
function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, weekday: 'short', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    zoneFormatters.set(zone, formatter);
  }
  return formatter;
}

/** The calendar fields `zoned` reads off one formatted instant. */
interface ZonedFields {
  weekday: number;
  hour: number;
  minute: number;
  day: number;
  month: number;
  date: string;
}

/** ISO weekday numbers, keyed by the `weekday: 'short'` token `en-US` emits. */
const WEEKDAY_NUMBERS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Calendar fields for an instant in a zone. */
function zoned(date: Date, zone: string): ZonedFields {
  const parts = formatterFor(zone).formatToParts(date);
  // `formatToParts` returns a discriminated union whose `value` lives only on the
  // non-literal members; collecting into a plain map keeps that narrowing in one place.
  const at: Record<string, string> = {};
  for (const part of parts) if (part.type !== 'literal') at[part.type] = part.value;
  // A missing token is not a silent zero: `Intl` always emits these for this pattern, so
  // a fallback would only ever hide a broken formatter. The lookup is typed as possibly
  // absent rather than asserted present.
  const day = WEEKDAY_NUMBERS[at.weekday ?? ''] ?? 0;
  return {
    weekday: day,
    hour: at.hour === '24' ? 0 : Number(at.hour),
    minute: Number(at.minute),
    day: Number(at.day),
    month: Number(at.month),
    date: at.year + '-' + at.month + '-' + at.day,
  };
}

/** The billing tier for one instant under one provider's calendar. */
function tierAt(ms: number, billing: Billing): 'flat' | 'peak' | 'off-peak' {
  const windows = billing.windows;
  if (windows.length === 0) return 'flat';
  const zone = billing.timezone || 'UTC';
  const at = zoned(new Date(ms), zone);
  if (billing.weekdays.indexOf(at.weekday) < 0) return 'off-peak';
  // Holiday dates are written in `holidayZone`, which is not necessarily the
  // billing zone. The Host's own `tierAt` resolves them there, so a chip that
  // read them in the provider zone could show peak on a day the Host charged
  // off-peak.
  const holidays = billing.holidays;
  if (holidays.length > 0
    && holidays.indexOf(zoned(new Date(ms), billing.holidayZone || zone).date) >= 0) return 'off-peak';
  const inside = windows.some(function (w) {
    return w[0] <= w[1] ? at.hour >= w[0] && at.hour < w[1] : at.hour >= w[0] || at.hour < w[1];
  });
  return inside ? 'peak' : 'off-peak';
}

/** The next instant the tier changes, or null for a flat rate (or no calendar at all). */
function nextBoundary(ms: number, billing: Billing | null): number | null {
  if (billing === null) return null;
  const windows = billing.windows;
  if (windows.length === 0) return null;
  const current = tierAt(ms, billing);
  const hourMs = 3600000;
  const start = Math.floor(ms / hourMs) * hourMs;
  let boundary: number | null = null;
  for (let step = 1; step <= 24 * 4; step += 1) {
    const candidate = start + step * hourMs;
    if (tierAt(candidate, billing) !== current) { boundary = candidate; break; }
  }
  if (boundary === null) return null;
  for (let step = 1; step <= 60; step += 1) {
    const candidate = boundary - hourMs + step * 60000;
    if (candidate > ms && tierAt(candidate, billing) !== current) return candidate;
  }
  return boundary;
}

// ------------------------------------------------ plugin detail badge (T-001)
/**
 * What the detail badge shows, once a real value is behind it.
 *
 * `tier` is null when no configured provider has a peak window: a flat provider
 * has no off-peak rate, and naming "flat" beside a peak/off-peak chip would
 * claim a state that provider never enters. `zone` names the calendar the tier
 * was read in, `tierProvider` names whose calendar it is, and `boundary` is the
 * instant that tier next changes (null when it never does), so a mounted chip can
 * re-read it instead of going stale.
 */
interface BadgePayload {
  providers: number;
  models: number;
  tier: string | null;
  zone: string | null;
  tierProvider: string | null;
  boundary: number | null;
  title: string;
}

/**
 * The accepted configuration layer out of whatever snapshot shape the service serves.
 *
 * `readSnapshot` accepts either the owner's `{ state, mutate }` form or a settings
 * controller. Only the `value` layer counts: `base` is what an override would inherit,
 * and a badge built from shipped defaults would claim configuration that is not there.
 * The accepted layer is an **own** property of the snapshot — a prototype answer is not
 * the layer the form accepted.
 * @param form - the form or controller the badge read.
 * @returns the accepted value layer, or null when there is none.
 */
function badgeValue(form: unknown): unknown {
  const snap = readSnapshot(form);
  if (snap === null) return null;
  if (!Object.prototype.hasOwnProperty.call(snap, 'value')) return null;
  const value = snap.value;
  return value === undefined || value === null ? null : value;
}

/**
 * The badge's content, or null when there is no honest value to show.
 *
 * The whole point of this component is not to exist when it cannot say
 * something true: an empty chip is the failure mode T-001 exists to avoid, so
 * every branch that lacks a real provider list, or a real price state, returns
 * null and the slot renders nothing at all.
 *
 * The calendar comes from `normalizeProviders` — the same normalizer the editor
 * uses — so a partial layer takes exactly the defaults the Host schema declares
 * (weekdays Mon–Fri, `holidayZone` Asia/Shanghai) and the badge can never
 * disagree with the strip about the tier.
 * @param value - the accepted configuration layer.
 * @param nowMs - the instant to read the calendar at.
 * @returns the payload, or null when the badge must stay away.
 */
function badgePayload(value: unknown, nowMs: number): BadgePayload | null {
  const layer = asRecord(value);
  const providers: unknown[] = layer !== null && Array.isArray(layer.providers) ? layer.providers : [];
  if (providers.length === 0) return null;
  let models = 0;
  let calendar: Billing | null = null;
  let zone = 'UTC';
  let tierProvider: string | null = null;
  providers.forEach(function (entry) {
    const provider = asRecord(entry);
    if (provider !== null && Array.isArray(provider.models)) models += provider.models.length;
    const billing = normalizeProviders([entry])[0].billing;
    if (billing.windows.length === 0) return;
    // The first provider with a peak window supplies the calendar: that is the state
    // the chip names, and the title names that provider rather than attributing its
    // calendar to all of them.
    if (calendar === null) {
      calendar = billing;
      zone = billing.timezone;
      tierProvider = provider !== null && typeof provider.id === 'string' && provider.id !== ''
        ? provider.id
        : 'the first provider with peak windows';
    }
  });
  const tier = calendar === null ? null : tierAt(nowMs, calendar);
  const boundary = calendar === null ? null : nextBoundary(nowMs, calendar);
  const scope = providers.length + ' provider(s) and ' + models + ' model(s) are configured.';
  const title = (calendar !== null
    ? 'The peak/off-peak state right now, read from the calendar of "' + tierProvider +
      '" in ' + zone + '. ' + scope
    : 'No configured provider has peak windows, so every hour is charged at one rate. ' + scope)
    + ' Set rates on the component row under ' + PLUGIN_ID + ' \u203a ' + SETTINGS_NS + '.';
  return {
    providers: providers.length,
    models: models,
    tier: tier,
    zone: zone,
    tierProvider: tierProvider,
    boundary: boundary,
    title: title,
  };
}

/**
 * The one child that decides between a real chip and nothing.
 *
 * It re-reads `Date.now()` in state rather than once per render, and schedules one
 * timer for `payload.boundary`: a chip whose single claim is "right now" must not
 * keep claiming the tier it saw when the page first rendered. A flat calendar has
 * no boundary, so it costs no timer at all.
 */
function BadgeView(props: { value: unknown }): React.ReactNode {
  const nowState = useState(function () { return Date.now(); });
  const nowMs = nowState[0];
  const setNowMs = nowState[1];
  const payload = badgePayload(props.value, nowMs);
  const boundary = payload === null ? null : payload.boundary;
  useEffect(function () {
    if (boundary === null) return undefined;
    const wait = Math.max(1000, boundary - Date.now());
    const timer = window.setTimeout(function () { setNowMs(Date.now()); }, wait);
    return function () { window.clearTimeout(timer); };
  }, [nowMs, props.value, boundary]);
  if (payload === null) return null;
  const segments = [
    payload.providers + (payload.providers === 1 ? ' provider' : ' providers'),
    payload.models + (payload.models === 1 ? ' model' : ' models'),
  ];
  if (payload.tier !== null) segments.push(payload.tier);
  // `string | object` deliberately: the separator is a bare text child while a tier is
  // a styled element, which is what React's own children type accepts.
  const children: Array<string | ReturnType<typeof h>> = [];
  segments.forEach(function (part, index) {
    if (index > 0) children.push('\u00b7');
    if (part === 'peak' || part === 'off-peak') {
      children.push(h('span', { key: 'tier', className: part === 'peak' ? 'dsm-peak' : 'dsm-off' }, part));
    } else {
      children.push(part);
    }
  });
  return h('span', { className: 'dsm-badge', title: payload.title }, children);
}

/**
 * The Plugins-page badge beside the plugin title (T-001).
 *
 * The slot hands this component `{ subject }` and standard hooks only — no
 * `getService` — so a badge cannot reach the configuration through props. It is
 * handed a getter captured in the registration closure instead, and the getter
 * is resolved when the service identity changes, then re-read on every render
 * through `getSnapshot`: the settings service may arrive after this bundle. A
 * service that is missing, null or unreadable is not an error — it means the
 * badge has nothing true to say, so it renders nothing.
 *
 * Only the *absence* of data is turned into null here. A **throw** is deliberately
 * left alone: `MetricsBoundary` wraps this component and renders a readable
 * failure chip, so swallowing an error would only delete the message (see
 * dsh-plugin-delivery.md, "Make the empty case visible").
 * @param props - slot props plus the `getService` getter `apply` supplies.
 * @returns the badge, or null when there is no real value to show.
 */
function PluginBadge(props: DshSlotProps & { serviceGet?: (name: string) => unknown }): React.ReactNode {
  const propsGet = typeof props.getService === 'function' ? props.getService : null;
  const getService = propsGet === null ? props.serviceGet : propsGet;
  const stableGet = useCallback(function (name: string): unknown {
    return getService && typeof getService === 'function' ? getService(name) : undefined;
  }, [getService]);
  const service = useMemo(function (): DshConfigFormsService | null {
    if (typeof getService !== 'function') return null;
    const found = stableGet('configForms');
    return found !== undefined && found !== null && typeof found === 'object'
      ? found as DshConfigFormsService
      : null;
  }, [stableGet, getService]);
  // `ctx.get('configForms')` returns the service itself; `service.get(namespace)` returns
  // this plugin's form. `undefined` and `null` are both normal on a restricted context,
  // and a deployment without a settings service simply renders no badge. A *throw* is not
  // caught: the boundary wraps this component and shows it.
  const form = useMemo(function (): DshConfigForm | null {
    if (service === null || typeof service.get !== 'function') return null;
    const found = service.get(SETTINGS_NS);
    return found === undefined || found === null ? null : found;
  }, [service]);
  // A form without `subscribe` is absence, not failure: the owner-supplied shape
  // carries none, and the value still arrives through `getSnapshot`.
  const subscribe = useCallback(function (listener: () => void): () => void {
    if (form === null || typeof form.subscribe !== 'function') return function () {};
    const unsubscribe = form.subscribe(listener);
    return function () {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [form]);
  // The accepted layer is returned **by reference**. A copy here would make
  // `useSyncExternalStore` see a new snapshot on every read and re-render forever
  // (React: "Maximum update depth exceeded"), which is exactly what a defensive
  // `asRecord` copy did before this comment existed. Narrowing happens in `BadgeView`.
  const getSnapshot = useCallback(function (): unknown {
    return form === null ? null : badgeValue(form);
  }, [form]);
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return value === null ? null : h(BadgeView, { value: value });
}

/** `hh:mm` for an instant in a zone. */
function clock(ms: number, zone: string): string {
  const at = zoned(new Date(ms), zone);
  return String(at.hour).padStart(2, '0') + ':' + String(at.minute).padStart(2, '0');
}

/** A human countdown. */
function countdown(from: number, to: number): string {
  const minutes = Math.max(0, Math.floor((to - from) / 60000));
  if (minutes < 1) return 'less than a minute';
  const hrs = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hrs === 0) return rest + 'm';
  return rest === 0 ? hrs + 'h' : hrs + 'h ' + rest + 'm';
}

// ----------------------------------------------------------- projections
/** Token bucket totals from either shape the projection may serve. */
function tokenBuckets(value: unknown): Buckets {
  const source = asRecord(value);
  const totals = source !== null && asRecord(source.totals) !== null ? asRecord(source.totals) : source;
  return {
    uncachedInputTokens: countOf(totals?.uncachedInputTokens),
    cacheReadTokens: countOf(totals?.cacheReadTokens),
    cacheWriteTokens: countOf(totals?.cacheWriteTokens),
    outputTokens: countOf(totals?.outputTokens),
  };
}

/**
 * A token count, or zero.
 *
 * The `unknown` boundary is why this exists: a count is a number or it is absent, and
 * an absent count is zero tokens. A non-numeric value is zero too — the same thing
 * `previous || 0` did before it was typed, without needing a cast to say it.
 * @param value - whatever the projection carried.
 * @returns the count as a number.
 */
function countOf(value: unknown): number {
  return typeof value === 'number' && isFinite(value) ? value : 0;
}

/** The session's provider/model from the model-selection projection. */
function selection(value: unknown): Pair | null {
  const source = asRecord(value);
  if (source === null) return null;
  const used = asRecord(source.lastUsed) ?? asRecord(source.next);
  if (used === null || !used.provider || !used.model) return null;
  return { provider: String(used.provider), model: String(used.model) };
}

/**
 * How one projection arrived: `absent` (not in the snapshot at all), `null`
 * (served but empty), or `present`. Distinguishing the three is the difference
 * between "the owner row is not running" and "it is running but has no value".
 * @param value - the projection value.
 * @returns the status word.
 */
function sourceState(value: unknown): 'absent' | 'null' | 'present' {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  return 'present';
}

/** The last provider/model the ledger recorded, as a fallback selection. */
function selectionFromLedger(ledger: LedgerValue | null): Pair | null {
  const rows = ledger !== null ? ledger.rows : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.provider) return { provider: row.provider, model: row.model };
  }
  const keys = ledger !== null ? Object.keys(ledger.totals) : [];
  for (const key of keys) {
    const parts = key.split('\u0000');
    const provider = parts[0];
    if (provider) return { provider: provider, model: parts[1] || null };
  }
  return null;
}

/**
 * The rate row a resolved model charges at one tier.
 *
 * `undefined` is a real answer, not a failure: a card can carry a `flat` row and no
 * `peak` one, which is exactly the shape that threw `rates.peak.cacheReadTokens` live.
 */
function ratesAt(model: ModelCard | null, tier: string): ResolvedRateRow | EditorRateRow | null | undefined {
  if (model === null) return null;
  if (model.mode === 'flat') return model.rates.flat;
  return tier === 'peak' ? model.rates.peak : model.rates.offPeak;
}

/** One found card: the provider and model, or both null when the pair has no card. */
interface CardMatch {
  provider: ProviderCard | null;
  model: ModelCard | null;
}

/** Find a provider and model card for a reported pair. */
function findCard(providers: ProviderCard[], providerId: string | null, modelId: string | null): CardMatch {
  const provider = providers.find(function (p) { return p.id === providerId; }) ?? null;
  if (provider === null) return { provider: null, model: null };
  const model = provider.models.find(function (m) {
    return m.model === modelId || m.aliases.indexOf(modelId ?? '') >= 0;
  }) ?? null;
  return { provider: provider, model: model };
}

/** Price one bucket set against one rate row; null when there is no rate row. */
function priceBuckets(
  rates: ResolvedRateRow | EditorRateRow | null | undefined,
  buckets: Buckets,
): PriceResult | null {
  if (rates === null || rates === undefined) return null;
  // The rate a resolved card carries is a number; the editor's string form never reaches
  // here (only resolved settings are priced), so a missing field is zero nanodollars.
  const hit = costOf(countOf(rates.cacheHit), buckets.cacheReadTokens);
  const miss = costOf(countOf(rates.cacheMiss), buckets.uncachedInputTokens);
  const write = costOf(countOf(rates.cacheWrite), buckets.cacheWriteTokens);
  const out = costOf(countOf(rates.output), buckets.outputTokens);
  return { cacheHitNano: hit, cacheMissNano: miss, cacheWriteNano: write, outputNano: out, totalNano: hit + miss + write + out };
}

/** What the cache saved on one bucket set. */
function savingsOf(rates: ResolvedRateRow | EditorRateRow | null | undefined, buckets: Buckets): number {
  if (rates === null || rates === undefined) return 0;
  const diff = countOf(rates.cacheMiss) - countOf(rates.cacheHit);
  return diff > 0 ? costOf(diff, buckets.cacheReadTokens) : 0;
}

/** What `priceSession` returns: the groups plus the session-wide figures. */
interface SessionPrice {
  groups: PriceGroup[];
  totalNano: number | null;
  savedNano: number | null;
  peakNano: number;
  peakShare: number | null;
  priced: boolean;
  byModel: Array<{ model: string | null; nano: number; tokens: number }>;
}

/**
 * Price the whole session: accumulate per provider/model/tier group, then
 * fall back to the current selection's card for buckets recorded before a
 * model was known.
 */
function priceSession(settings: SessionSettingsValue, ledger: LedgerValue): SessionPrice {
  const groups: PriceGroup[] = [];
  let total = 0;
  let saved = 0;
  let priced = true;
  let peakNano = 0;
  const byModel = new Map<string, { model: string | null; nano: number; tokens: number }>();

  Object.keys(ledger.totals).forEach(function (key) {
    const parts = key.split('\u0000');
    const providerId = parts[0] || null;
    const modelId = parts[1] || null;
    const storedTier = parts[2] || 'flat';
    const buckets = ledger.totals[key];
    const card = findCard(settings.providers, providerId, modelId);
    const tier = storedTier;
    const rates = ratesAt(card.model, tier);
    const price = priceBuckets(rates, buckets);
    const group: PriceGroup = {
      key: key, provider: providerId, model: modelId, tier: tier, buckets: buckets,
      rates: rates ?? null, price: price, savings: savingsOf(rates, buckets),
    };
    groups.push(group);
    if (price === null) { priced = false; return; }
    total += price.totalNano;
    saved += group.savings;
    if (tier === 'peak') peakNano += price.totalNano;
    const modelKey = (modelId || 'unknown');
    const entry = byModel.get(modelKey) || { model: modelId, nano: 0, tokens: 0 };
    entry.nano += price.totalNano;
    entry.tokens += buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens + buckets.outputTokens;
    byModel.set(modelKey, entry);
  });

  return {
    groups: groups,
    totalNano: priced ? total : null,
    savedNano: priced ? saved : null,
    peakNano: peakNano,
    peakShare: priced && total > 0 ? peakNano / total : null,
    priced: priced,
    byModel: Array.from(byModel.values()),
  };
}

// ------------------------------------------------------------ ui pieces
/**
 * Render-failure boundary.
 *
 * A slot entry that throws is *abdicated* by the framework: it is dropped from the
 * slot's entry list (so the inspector reports it inactive) while staying on the
 * registration ledger, and the user sees an empty space with no clue. Catching the
 * failure here keeps the entry alive and puts the message where it can be read.
 */
class MetricsBoundary extends React.Component<{ children?: React.ReactNode }, { error: unknown }> {
  constructor(props: { children?: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }

  componentDidCatch(error: unknown): void {
    if (typeof console !== 'undefined' && console.error) console.error('session-metrics render failed', error);
  }

  render(): React.ReactNode {
    if (this.state.error === null) return this.props.children;
    const error = asRecord(this.state.error);
    const message = typeof error?.message === 'string' ? error.message : String(this.state.error);
    const stack = typeof error?.stack === 'string' ? error.stack.split('\n').slice(0, 6).join(' | ') : '';
    return h('div', { className: 'dsm-slot', 'data-safe': 'false' },
      h('div', { className: 'dsm-root' },
        h('span', { className: 'dsm-trigger dsm-diag', title: stack || message },
          h('span', { className: 'dsm-flagDot' }, '\u25b2'),
          h('span', null, 'session-metrics failed'),
          h('span', { className: 'dsm-model', style: { maxWidth: 'none', whiteSpace: 'normal' } }, message),
          h('span', { className: 'dsm-build' }, BUILD))));
  }
}

/** Props for the one explanation affordance: where to anchor the box, and its text. */
interface HintProps {
  label: string;
  title: string;
  onShow(node: Element, text: string): void;
  onHide(): void;
}

/** A metric label with its explanation.
 *
 * Native `title` tooltips did not surface in the harness window, so the explanation is a
 * child element revealed by CSS on hover or keyboard focus. The same text is the accessible
 * name, so assistive technology gets it too.
 */
function Hint(props: HintProps): React.ReactNode {
  // The box cannot live inside the hint: the panel scrolls, and an absolutely positioned
  // child of a scroll container is clipped at its edge — which cropped long text and the
  // right-hand column. It is rendered once, fixed, and clamped to the viewport instead.
  return h('span', {
    className: 'dsm-hint',
    'aria-label': props.title,
    tabIndex: 0,
    onMouseEnter: function (event: React.MouseEvent<HTMLElement>) { props.onShow(event.currentTarget, props.title); },
    onMouseLeave: props.onHide,
    onFocus: function (event: React.FocusEvent<HTMLElement>) { props.onShow(event.currentTarget, props.title); },
    onBlur: props.onHide,
  },
    props.label,
    h('span', { className: 'dsm-q' }, '?'));
}


/** One segment of a proportional bar. */
interface BarSegment {
  key: string;
  value: number;
  className: string;
}

/** A proportional bar. */
function Bar(props: { title: string; segments: BarSegment[] }): React.ReactNode {
  let total = 0;
  props.segments.forEach(function (s) { if (s.value > 0) total += s.value; });
  if (total <= 0) return null;
  return h('div', { className: 'dsm-bar', title: props.title },
    props.segments.map(function (s, i) {
      const amount = s.value > 0 ? s.value : 0;
      return h('i', { key: s.key || i, className: s.className, style: { width: (amount / total) * 100 + '%' } });
    }));
}

/** Read a per-session budget override from browser storage. */

/** Persist a per-session budget override. */

// ---------------------------------------------------------------- panel
/** The strip and its detail popover. */
function SessionMetricsPanel(props: DshSlotProps & { refreshProjections?: (sessionId?: string) => void }): React.ReactNode {
  // Lost props are a fault, not an empty session: without `useProjection` the strip
  // can never price anything, and silence would hide the reason.
  const frameworkPropsMissing = typeof props.useProjection !== 'function';

    /** The floating explanation: its text and its clamped viewport position. */
  const tipState = useState<{ text: string; left: number; top: number; above: boolean } | null>(null);
  const tip = tipState[0];
  const setTip = tipState[1];
  const showTip = useCallback(function (node: Element, text: string) {
    if (!node || typeof node.getBoundingClientRect !== 'function' || typeof window === 'undefined') return;
    const rect = node.getBoundingClientRect();
    const margin = 12;
    const width = Math.min(320, window.innerWidth - margin * 2);
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
    const above = rect.top > 96;
    setTip({ text: text, left: left, top: above ? rect.top - 8 : rect.bottom + 6, above: above });
  }, []);
  const hideTip = useCallback(function () { setTip(null); }, []);

  const openState = useState(false);
  const open = openState[0];
  const setOpen = openState[1];
  const rootRef = useRef<HTMLDivElement | null>(null);
  const anchorState = useState<{ left: number; top: number; bottom: number } | null>(null);
  const anchor = anchorState[0];
  const setAnchor = anchorState[1];
  const nowState = useState(Date.now());
  const now = nowState[0];
  const setNow = nowState[1];

  useEffect(function () {
    if (typeof props.refreshProjections === 'function') props.refreshProjections(props.sessionId);
  }, [props.refreshProjections, props.sessionId]);

  // The projection is a cross-half wire value, so it arrives as `unknown` and is narrowed
  // here rather than trusted: `metrics.budget.sessionUsd` on a wrong-shaped projection is the
  // same class of read that crashed the live strip on `rates.peak`.
  const rawMetrics: unknown = props.useProjection ? props.useProjection(PROJECTION) : undefined;
  const metrics = asSessionMetrics(rawMetrics);
  const usageValue: unknown = props.useProjection ? props.useProjection('tokenUsage') : undefined;
  const selectionValue: unknown = props.useProjection ? props.useProjection('modelSelection') : undefined;

  const settings: SessionSettingsValue | null = metrics === null ? null : metrics.settings;
  const ledger: LedgerValue | null = metrics === null || metrics.ledger === undefined ? null : metrics.ledger;
  // The ledger carries the provider and model of every step, so it is a sufficient
  // source on its own; `modelSelection` is preferred because it is the catalogue the
  // composer's own model picker uses.
  const current = selection(selectionValue) ?? selectionFromLedger(ledger);
  const buckets = tokenBuckets(usageValue);
  const labels = labelKeys(settings === null ? [] : settings.display.labels);
  const details = settings === null ? [] : settings.display.details;
  const wantsClock = labels.indexOf('time') >= 0 || labels.indexOf('peak') >= 0;

  // The collapsed strip shows a real clock now, so it ticks — aligned to the minute
  // boundary, and only while a clock or peak chip is on screen. A config that shows
  // neither costs nothing, and a visible clock costs one render a minute.
  useEffect(function () {
    if (!wantsClock) return undefined;
    const wait = 60000 - (Date.now() % 60000) + 50;
    const timer = window.setTimeout(function () { setNow(Date.now()); }, wait);
    return function () { window.clearTimeout(timer); };
  }, [wantsClock, now]);

  // Inside the detail the countdown has minutes and seconds, so that view ticks faster.
  useEffect(function () {
    if (!open) return undefined;
    const timer = window.setTimeout(function () { setNow(Date.now()); }, 1000);
    return function () { window.clearTimeout(timer); };
  }, [open, now]);

  useEffect(function () {
    if (!open) return undefined;
    const onKey = function (event: KeyboardEvent): void { if (event.key === 'Escape') setOpen(false); };
    const onResize = function (): void { setOpen(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return function () {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  // A panel that renders nothing when a source is missing is undiagnosable, so the
  // strip says which input it is waiting for instead of disappearing.
  //
  // The session identity is a note rather than a fault: the projections are already
  // session-scoped by the framework, and gating on a prop the owner may not pass is
  // what once made this strip invisible.
  const missing: string[] = [];
  const notes: string[] = [];
  if (frameworkPropsMissing) missing.push('the framework props are missing (no useProjection was passed)');
  if (props.sessionId === undefined) notes.push('the session identity prop is missing (projections still resolve)');
  if (rawMetrics === undefined) missing.push('the sessionMetrics projection is absent');
  else if (settings === null) missing.push('the projection carries no settings');
  else if (ledger === null) missing.push('the projection carries no ledger');
  if (current === null) missing.push('no provider or model recorded yet');
  const reasons = missing.concat(notes);

  const priced: SessionPrice | null = useMemo(function () {
    if (settings === null || ledger === null) return null;
    return priceSession(settings, ledger);
  }, [settings, ledger, current?.provider, current?.model]);

  const card: CardMatch = settings !== null && current !== null
    ? findCard(settings.providers, current.provider, current.model)
    : { provider: null, model: null };
  const billing = card.provider !== null ? card.provider.billing : null;
  const tier = billing !== null ? tierAt(now, billing) : null;
  // The countdown is only visible inside the open detail, so the search does not run
  // at all while the strip is collapsed — and while open it is recomputed at most once
  // a minute, since within a minute the answer cannot change.
  const minute = Math.floor(now / 60000);
  const boundary = useMemo(
    function () { return open && billing !== null ? nextBoundary(minute * 60000, billing) : null; },
    [open, billing, minute]);
  const viewerZone = (function (): string {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
  })();

  const budgetLimit = settings === null ? null : settings.budget.sessionUsd;
  const warnAt = settings === null ? 0.75 : settings.budget.warnAt;
  const spentNano = priced !== null ? priced.totalNano : null;
  const budgetFraction = budgetLimit && spentNano !== null ? (spentNano / NANO) / budgetLimit : null;

  if (missing.length > 0) {
    const notice = h('div', { className: 'dsm-flagDot' }, '\u25cc'),
      label = h('span', null, 'session-metrics: waiting'),
      why = h('span', { className: 'dsm-model', title: reasons.join('; ') }, reasons[0]);
    return h('div', { className: 'dsm-slot', 'data-safe': 'false', ref: rootRef },
      h('div', { className: 'dsm-root' },
        h('button', {
          type: 'button', className: 'dsm-trigger dsm-diag', title: reasons.join('; '),
          onClick: function () { setOpen(!open); },
        }, notice, label, why),
        open
          ? h(React.Fragment, null,
              h('div', { className: 'dsm-scrim', onClick: function () { setOpen(false); } }),
              h('div', { className: 'dsm-panel', role: 'dialog', 'aria-label': 'Session metrics diagnostics', style: { left: '24px', bottom: '24px' } },
                h('div', { className: 'dsm-title' }, h('span', null, 'Why the strip is waiting')),
                h('div', { className: 'dsm-section' }, 'Waiting on'),
                h('ul', { className: 'dsm-list' }, reasons.map(function (reason, index) { return h('li', { key: index }, reason); })),
                h('div', { className: 'dsm-section' }, 'Sources read'),
                h('div', { className: 'dsm-note' }, 'sessionMetrics: ' + sourceState(rawMetrics) +
                  ' \u00b7 tokenUsage: ' + sourceState(usageValue) +
                  ' \u00b7 modelSelection: ' + sourceState(selectionValue)),
                h('div', { className: 'dsm-foot' }, h('span', null, 'build ' + BUILD),
                  h('span', null, 'a projection absent from the snapshot usually means its owner row is not running in the Host'))))
          : null));
  }

  // `missing` was empty, which means settings, ledger and provider/model are all present —
  // but that fact lives in an array, so the compiler cannot carry it into the callbacks
  // below. These guards restate it in a form `tsc` tracks: delete one and the reads below
  // fail the typecheck (TS18047) *and* the strip renders nothing at runtime, instead of
  // throwing on `current.provider` the way the live crashes did.
  const resolvedSettings = settings;
  const books = ledger;
  const pair = current;
  if (resolvedSettings === null || books === null || pair === null) return null;

  const showCny = resolvedSettings.display.cnyInDetailsFor.indexOf(pair.provider) >= 0 || resolvedSettings.display.currency === 'CNY';
  const costNano = priced ? priced.totalNano : null;
  const savedNano = priced ? priced.savedNano : null;

  // ---------------------------------------------------------------- strip chips
  const chips: React.ReactNode[] = [];
  if (labels.indexOf('peak') >= 0 && (tier === 'peak' || tier === 'off-peak')) {
    const peak = tier === 'peak';
    chips.push(h('span', {
      key: 'peak', className: 'dsm-item ' + (peak ? 'dsm-peak' : 'dsm-off'),
      title: peak
        ? 'Peak hours are on now: this session is billed at the peak rate.'
        : 'Off-peak now: this session is billed at the reduced off-peak rate.',
    },
      h('span', { className: 'dsm-flagDot' }, peak ? '\u25b2' : '\u25bc'),
      // The space belongs in the text, not only in the flex gap, or the chip reads
      // "ONPEAK HOURS" to a screen reader and to a copy-paste.
      h('b', null, peak ? 'ON' : 'OFF', h('span', { className: 'dsm-zone' }, ' PEAK HOURS'))));
  }
  if (labels.indexOf('time') >= 0) {
    chips.push(h('span', {
      key: 'time', className: 'dsm-item',
      title: 'Your local time (' + viewerZone + '), 24-hour. Updates every minute.',
    },
      h('b', { className: 'dsm-mono' }, clock(now, viewerZone)),
      h('span', { className: 'dsm-zone' }, cityOf(viewerZone))));
  }
  if (labels.indexOf('cost') >= 0) {
    chips.push(h('span', {
      key: 'cost', className: 'dsm-item' + (costNano === null ? ' dsm-warn' : ''),
      title: costNano === null
        ? 'No rate card matches this session\u2019s provider and model.'
        : 'Total cost of this session at the configured rates. Exact: $' + usd(costNano, 6),
    },
      h('span', null, 'Cost'),
      h('b', { className: 'dsm-mono' }, costNano === null ? 'unpriced' : usd2(costNano))));
  }
  if (labels.indexOf('saved') >= 0 && savedNano !== null && savedNano > 0) {
    chips.push(h('span', { key: 'saved', className: 'dsm-item', title: TIPS.saved },
      h('span', null, 'Saved'),
      h('b', { className: 'dsm-mono' }, usd2(savedNano))));
  }
  if (labels.indexOf('provider') >= 0 && pair.provider !== resolvedSettings.display.primaryProvider) {
    chips.push(h('span', {
      key: 'provider', className: 'dsm-model',
      title: 'Provider this session is using (from modelSelection).',
    }, pair.provider));
  }
  if (labels.indexOf('budget') >= 0 && budgetLimit) {
    const className = budgetFraction === null ? '' : budgetFraction >= 1 ? ' dsm-over' : budgetFraction >= warnAt ? ' dsm-warn' : '';
    chips.push(h('span', {
      key: 'budget', className: 'dsm-item' + className,
      title: 'Spend against the configured session budget. ' + TIPS.budget,
    },
      h('span', null, 'Budget'),
      h('b', { className: 'dsm-mono' }, (costNano === null ? '$\u2014' : usd2(costNano)) + ' / $' + budgetLimit.toFixed(2))));
  }

  const trigger = h('button', {
    type: 'button',
    className: 'dsm-trigger',
    'aria-expanded': open ? 'true' : 'false',
    title: 'Session metrics \u2014 click for the cost, saving, model and peak-hour breakdown',
    onClick: function () {
      if (open) { setOpen(false); return; }
      const node = rootRef.current;
      if (node && node.getBoundingClientRect) setAnchor(node.getBoundingClientRect());
      setNow(Date.now());
      setOpen(true);
    },
  }, chips.reduce(function (list: React.ReactNode[], chip: React.ReactNode, index: number) {
    // A dot between every pair: the chips read as separate facts on one line rather than
    // one run-on label.
    if (index > 0) list.push(h('span', { key: 'sep' + index, className: 'dsm-sep' }, '\u00b7'));
    list.push(chip);
    return list;
  }, []));

  // ------------------------------------------------------------------- detail
  let panel: React.ReactNode = null;
  if (open) {
    const top = anchor ? Math.max(12, anchor.top - 12) : 140;
    const left = anchor ? Math.min(Math.max(12, anchor.left), Math.max(12, window.innerWidth - 580)) : 24;
    const sections: React.ReactNode[] = [];

    const groups = priced ? priced.groups : [];
    // Pairs the ledger actually observed with no rate card. An older checkpoint
    // carries no `discovered` field at all, so it is read as an empty list.
    const discovered = Array.isArray(books.discovered) ? books.discovered : [];
    const sumNano = function (pick: (price: PriceResult) => number): number {
      return groups.reduce(function (total, group) { return total + (group.price ? pick(group.price) : 0); }, 0);
    };
    const sumTokens = function (pick: (buckets: Buckets) => number): number {
      return groups.reduce(function (total, group) { return total + (group.buckets ? pick(group.buckets) : 0); }, 0);
    };
    const inputNano = sumNano(function (p) { return p.cacheMissNano + p.cacheWriteNano; });
    const outputNano = sumNano(function (p) { return p.outputNano; });
    const cachedNano = sumNano(function (p) { return p.cacheHitNano; });
    const inputTokens = sumTokens(function (b) { return b.uncachedInputTokens + b.cacheWriteTokens; });
    const outputTokens = sumTokens(function (b) { return b.outputTokens; });
    const cachedTokens = sumTokens(function (b) { return b.cacheReadTokens; });
    const writeTokens = sumTokens(function (b) { return b.cacheWriteTokens; });
    const sessionTokens = inputTokens + outputTokens + cachedTokens;

    if (details.indexOf('cost') >= 0) {
      sections.push(h('div', { key: 'cost' },
        h('div', { className: 'dsm-section' }, 'Cost breakdown'),
        priced && priced.totalNano !== null
          ? h(React.Fragment, null,
              h('div', { className: 'dsm-cols' },
                h('div', { className: 'dsm-col' },
                  h(Hint, { onShow: showTip, onHide: hideTip, label: 'Input', title: TIPS.input }),
                  h('b', null, usd2(inputNano)),
                  h('i', null, tokens(inputTokens) + ' tok' + (writeTokens > 0 ? ' (incl. ' + tokens(writeTokens) + ' cache write)' : ''))),
                h('div', { className: 'dsm-col' },
                  h(Hint, { onShow: showTip, onHide: hideTip, label: 'Output', title: TIPS.output }),
                  h('b', null, usd2(outputNano)),
                  h('i', null, tokens(outputTokens) + ' tok')),
                h('div', { className: 'dsm-col' },
                  h(Hint, { onShow: showTip, onHide: hideTip, label: 'Cached', title: TIPS.cached }),
                  h('b', null, usd2(cachedNano)),
                  h('i', null, tokens(cachedTokens) + ' tok'))),
              Bar({
                title: 'cost split',
                segments: [
                  { key: 'input', value: inputNano, className: 'dsm-barInput' },
                  { key: 'output', value: outputNano, className: 'dsm-output' },
                  { key: 'cached', value: cachedNano, className: 'dsm-hit' },
                ],
              }),
              h('div', { className: 'dsm-note' },
                'Total ' + usd2(priced.totalNano) + ' \u00b7 ' + tokens(sessionTokens) + ' tokens'
                + (budgetLimit ? ' \u00b7 budget ' + usd2(budgetLimit * NANO) + ' (' + pct(budgetFraction) + ')' : '')
                + (showCny && spentNano !== null ? ' \u00b7 \u00a5' + ((spentNano / NANO) * resolvedSettings.display.usdToCny).toFixed(2) : '')))
          : h('div', { className: 'dsm-note dsm-warn' }, 'No rate card matches this session\u2019s provider and model, so no cost is shown. Add one in the plugin\u2019s Pricing section, or in cordis.patch.yml.')));
    }

    if (details.indexOf('savings') >= 0 && priced && priced.savedNano !== null) {
      const blended = (function () {
        let tok = 0;
        let nano = 0;
        groups.forEach(function (group) {
          if (!group.price) return;
          tok += bucketTotal(group.buckets);
          nano += group.price.totalNano;
        });
        return tok > 0 ? (nano / NANO) / (tok / 1e6) : null;
      })();
      const cacheShare = (priced.totalNano ?? 0) > 0 ? cachedNano / (priced.totalNano ?? 0) : null;
      sections.push(h('div', { key: 'savings' },
        h('div', { className: 'dsm-section' }, 'Saving breakdown'),
        h('div', { className: 'dsm-cols' },
          h('div', { className: 'dsm-col' },
            h(Hint, { onShow: showTip, onHide: hideTip, label: 'Saved', title: TIPS.saved }),
            h('b', null, usd2(priced.savedNano)),
            h('i', null, 'vs full input rate')),
          h('div', { className: 'dsm-col' },
            h(Hint, { onShow: showTip, onHide: hideTip, label: 'Blended rate', title: TIPS.blended }),
            h('b', null, blended === null ? '\u2014' : '$' + blended.toFixed(4)),
            h('i', null, 'per 1M tokens')),
          h('div', { className: 'dsm-col' },
            h(Hint, { onShow: showTip, onHide: hideTip, label: 'From cache reads', title: TIPS.share }),
            h('b', null, cacheShare === null ? '\u2014' : pct(cacheShare)),
            h('i', null, 'of total cost')))));
    }

    if (details.indexOf('models') >= 0 && groups.length > 0) {
          // The ledger splits groups by tier, which made one model appear twice with "On"
          // and "Off". A row is a provider+model, so the tiers are summed and the
          // peak-hours column reports the state that provider is in right now.
          const modelRows = (function () {
            const byKey = new Map<string, { provider: string | null; model: string | null; nano: number; tokens: number; priced: boolean }>();
            groups.forEach(function (group) {
              const key = (group.provider || '') + '\u0000' + (group.model || '');
              const entry = byKey.get(key) || { provider: group.provider, model: group.model, nano: 0, tokens: 0, priced: true };
              if (group.price) {
                entry.nano += group.price.totalNano;
                entry.tokens += bucketTotal(group.buckets);
              } else {
                entry.priced = false;
              }
              byKey.set(key, entry);
            });
            return Array.from(byKey.values()).sort(function (a, b) { return b.nano - a.nano; });
          })();
          const shown = modelRows.slice(0, 8);
          sections.push(h('div', { key: 'models' },
            h('div', { className: 'dsm-section' }, 'Model provider'),
            h('table', { className: 'dsm-table' },
              h('thead', null, h('tr', null,
                h('th', null, 'provider'), h('th', null, 'model'), h('th', null, 'peak hours'))),
              h('tbody', null, shown.map(function (row, index) {
                const rowCard = findCard(resolvedSettings.providers, row.provider, row.model);
                const rowBilling = rowCard.provider ? rowCard.provider.billing : null;
                const hasWindows = rowBilling !== null && rowBilling.windows.length > 0;
                // The card's own label is what the composer shows ("DeepSeek V4.1 Flash"),
                // so that belongs here rather than the internal model key.
                const modelName = rowCard.model && rowCard.model.label ? rowCard.model.label : (row.model || 'unknown');
                const state = hasWindows ? (tier === 'peak' ? 'On' : 'Off') : 'None';
                return h('tr', {
                  key: index,
                  title: 'None: this provider bills a flat rate. On: peak right now. Off: off-peak right now.'
                    + (row.priced ? '\nCost ' + usd2(row.nano) + ' \u00b7 ' + tokens(row.tokens) + ' tokens' : '\nunpriced'),
                },
                  h('td', null, row.provider || 'unknown'),
                  // The word, not only a tooltip: an unpriced row states it where a
                  // reader sees it, and it never borrows a number it does not have.
                  h('td', null, modelName, row.priced ? null : h('span', { className: 'dsm-unpriced' }, ' \u00b7 unpriced')),
                  h('td', null, state));
              }))),
            modelRows.length > shown.length
              ? h('div', { className: 'dsm-note' }, 'plus ' + (modelRows.length - shown.length) + ' more provider/model combinations')
              : null,
            priced && !priced.priced
              ? h('div', { className: 'dsm-note dsm-warn' }, 'At least one of these has no rate card, so its cost is not counted.')
              : null));
        }

        if (details.indexOf('models') >= 0 && discovered.length > 0) {
          // Auto-discovery: a provider or model integrated after this plugin shipped has
          // no card, and nothing on a configuration-only screen would ever mention it. The
          // ledger recorded the pairs as they were used, so the session itself names them
          // — with the tokens seen and the word `unpriced`, never an invented cost.
          const listed = discovered.slice(0, 8);
          sections.push(h('div', { key: 'discovered' },
            h('div', { className: 'dsm-section' }, 'Seen, unpriced'),
            h('ul', { className: 'dsm-list' }, listed.map(function (entry, index) {
              const provider = entry && entry.provider ? entry.provider : 'unknown provider';
              const model = entry && entry.model ? entry.model : 'unknown model';
              const seen = entry && typeof entry.tokens === 'number' ? tokens(entry.tokens) + ' tokens' : 'no tokens';
              return h('li', { key: index },
                h('b', null, provider + ' \u00b7 ' + model),
                ' \u2014 ' + seen + ', no rate card: ',
                h('b', { className: 'dsm-unpriced' }, 'unpriced'));
            })),
            discovered.length > listed.length
              ? h('div', { className: 'dsm-note' }, 'plus ' + (discovered.length - listed.length) + ' more unpriced pairs')
              : null,
            h('div', { className: 'dsm-note' }, 'No cost is counted for these. Add a rate card on this plugin\u2019s component row under '
              + PLUGIN_ID + ' \u203a ' + SETTINGS_NS + ' to price them; a provider\u2019s free models cost $0.00 and need a zero-rate card.')));
        }

        if (details.indexOf('window') >= 0 && billing) {
      const hasWindows = billing.windows.length > 0;
      const peakState = !hasWindows
        ? 'None'
        : tier === 'peak'
          ? 'Ongoing'
          : boundary === null ? 'Off-peak' : 'Next in ' + countdown(now, boundary);
      const days = billing.weekdays || [];
      const dayText = days.length === 7
        ? 'every day'
        : (days.length === 5 && [1, 2, 3, 4, 5].every(function (day) { return days.indexOf(day) >= 0; }))
          ? 'on weekdays'
          : 'on ' + days.map(function (day) { return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][day - 1]; }).join(', ');
      const localWindows = billing.windows.map(function (window) {
        return windowInZone(now, window, billing.timezone, viewerZone);
      }).join(' and ');
      sections.push(h('div', { key: 'window' },
        h('div', { className: 'dsm-section' }, 'Timezone'),
        h('div', { className: 'dsm-cols' },
          h('div', { className: 'dsm-col' },
            h('span', null, 'Local time'),
            h('b', { className: 'dsm-mono' }, clock(now, viewerZone)),
            h('i', null, viewerZone)),
          h('div', { className: 'dsm-col' },
            h('span', null, 'Provider time'),
            h('b', { className: 'dsm-mono' }, clock(now, billing.timezone)),
            h('i', null, billing.timezone)),
          h('div', { className: 'dsm-col' },
            h('span', null, 'Peak hours'),
            h('b', null, peakState),
            h('i', null, hasWindows ? 'rates switch at these windows' : 'flat rate'))),
        h('div', { className: 'dsm-note' }, hasWindows
          // One sentence, in the reader's own zone: the provider's windows are already
          // translated, so repeating the provider's clock here only adds noise.
          ? 'Peak hours run ' + dayText + ' ' + localWindows + ' ' + viewerZone + '.'
          : 'This provider bills a flat rate: there are no peak hours.')));
    }

    panel = h(React.Fragment, null,
      h('div', { className: 'dsm-scrim', onClick: function () { setOpen(false); } }),
      h('div', {
        className: 'dsm-panel', role: 'dialog', 'aria-label': 'Session metrics',
        style: { left: left + 'px', bottom: Math.max(12, window.innerHeight - top) + 'px' },
        onScroll: hideTip,
      },
        tip !== null
          ? (ReactDOM !== null && ReactDOM !== undefined && typeof ReactDOM.createPortal === 'function'
              ? ReactDOM.createPortal(h('div', {
                  className: 'dsm-tipBox' + (tip.above ? ' dsm-tipAbove' : ''),
                  role: 'tooltip',
                  style: { left: tip.left + 'px', top: tip.top + 'px' },
                }, tip.text), document.body)
              : h('div', {
                  className: 'dsm-tipBox' + (tip.above ? ' dsm-tipAbove' : ''),
                  role: 'tooltip',
                  style: { left: tip.left + 'px', top: tip.top + 'px' },
                }, tip.text))
          : null,
        h('div', { className: 'dsm-title' },
          // The build id and the provenance stay reachable here rather than in a footer row.
          h('span', {
            title: 'build ' + BUILD
              + ' \u00b7 tokens from tokenUsage, provider and model from modelSelection, rate cards and tiers from sessionMetrics'
              + (resolvedSettings.problems.length > 0 ? ' \u00b7 config problems: ' + resolvedSettings.problems.join('; ') : ''),
          }, 'Session Metrics'),
          h('span', { className: 'dsm-tag dsm-model', title: pair.provider + ' \u00b7 ' + pair.model },
            pair.provider + ' \u00b7 ' + pair.model)),
        sections));
  }

  return h('div', {
    className: 'dsm-slot',
    'data-safe': props.sessionId === undefined ? 'false' : 'true',
    ref: rootRef,
  }, h('div', { className: 'dsm-root' }, trigger, panel));
}


// ------------------------------------------------- pricing page (Plugins)
/**
 * The settings *namespace* the row serves — the id the bundle's patch declares.
 *
 * `configForms` is keyed by **namespace**, not by the Loader entry id: asking it for
 * `include:session-metrics` returns a controller whose value layer is unavailable, which is
 * indistinguishable from "nothing is configured". The plugin-manager's own row page gates on
 * `view.ns === openRow.rowId`, and the row is `session-metrics`.
 *
 * This literal is the client's one copy. The Loader entry id and the `plugins.row.config`
 * key are derived from it below, and `test/namespace.ts` reads the row id out of
 * `cordis.patch.yml` so a rename cannot leave the client, the patch and the host disagreeing
 * silently.
 */
const SETTINGS_NS = 'session-metrics';

/** The Loader's entry id for this plugin's row — what the Host's Config inspector takes. */
const CONFIG_ENTRY = 'include:' + SETTINGS_NS;

/** The `plugins.row.config` key: `<bundle>#<rowId>`, as the ledger expects. */
const ROW_CONFIG_KEY = PLUGIN_ID + '#' + SETTINGS_NS;

/** Parse "1-4,6-10" into peak windows. */
function parseWindows(text: string): HourWindow[] {
  const windows: HourWindow[] = [];
  for (const part of String(text || '').split(',')) {
    const match = part.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (match === null) continue;
    windows.push([Number(match[1]), Number(match[2])]);
  }
  return windows;
}

/** Render peak windows for editing. */
function formatWindows(windows: HourWindow[]): string {
  return windows.map(function (w) { return w[0] + '-' + w[1]; }).join(',');
}

/** Integer nanodollars per 1M as the USD string the schema accepts. */
function usdFromNano(nano: number): string {
  const text = (nano / 1e9).toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
  return text === '' ? '0' : text;
}

/**
 * Convert a resolved (nanodollar) provider tree into the USD string form the
 * editor shows and writes back.
 *
 * This conversion is not cosmetic. The Host resolves rates to nanodollars for
 * the client to compute with, while the schema accepts USD per 1M tokens; a
 * page that displayed or saved the nanodollar form would show "6000000" and
 * then save it as six million dollars per million tokens.
 * @param providers - resolved providers.
 * @returns providers whose rate rows hold USD decimal strings.
 */
/** One rate value as a USD string: resolved layers carry nanodollar numbers. */
function usdValue(value: unknown): string {
  if (typeof value === 'number') return usdFromNano(value);
  if (typeof value === 'string') return value;
  return '0';
}

/** A complete rate row, so no field is ever missing from the editor. */
function usdRow(row: ResolvedRateRow | EditorRateRow | null | undefined): EditorRateRow {
  const source = row || {};
  return {
    cacheHit: usdValue(source.cacheHit),
    cacheMiss: usdValue(source.cacheMiss),
    cacheWrite: usdValue(source.cacheWrite),
    output: usdValue(source.output),
  };
}

/**
 * Normalize a provider list into the shape the **schema** accepts.
 *
 * The config layer arrives in one of two shapes: the resolved one (`mode` plus
 * nanodollar rate numbers) or the stored one (`rates.flat` / `rates.peak` with USD
 * strings and no `mode`). Assuming the resolved shape crashed the live page —
 * `rates.peak` is undefined for a flat model, and the rate fields then read
 * `.cacheHit` off undefined.
 *
 * Absent rate rows are OMITTED rather than nulled: the schema's rate rows are optional
 * objects, and a null would be rejected on save.
 * @param providers - either shape.
 * @returns providers the editor can render and the Host will accept.
 */
function normalizeProviders(providers: unknown): EditorProvider[] {
  if (!Array.isArray(providers)) return [];
  return providers.map(function (entry): EditorProvider {
    const source = asRecord(entry) ?? {};
    const models = Array.isArray(source.models) ? source.models : [];
    const modelCards = models.map(function (model): EditorModel {
      const card = asRecord(model) ?? {};
      const rates = asRecord(card.rates) ?? {};
      const out: EditorModel['rates'] = {};
      // Absent rate rows stay absent; a flat model has no `peak`, which is exactly the
      // shape whose `.cacheHit` read crashed the live page.
      for (const key of ['flat', 'peak', 'offPeak'] as const) {
        const row = rates[key];
        if (row !== undefined && row !== null) out[key] = usdRow(asRateRow(row) ?? {});
      }
      if (out.flat === undefined && out.peak === undefined) out.flat = usdRow(null);
      out.multiplier = typeof rates.multiplier === 'number' ? rates.multiplier : 0.5;
      const result: EditorModel = {
        model: typeof card.model === 'string' ? card.model : '',
        aliases: asTextList(card.aliases),
        rates: out,
      };
      if (typeof card.label === 'string') result.label = card.label;
      if (typeof card.contextWindow === 'number') result.contextWindow = card.contextWindow;
      return result;
    });
    const billing = asRecord(source.billing) ?? {};
    const normalized: EditorProvider = {
      id: typeof source.id === 'string' ? source.id : '',
      models: modelCards,
      billing: {
        timezone: typeof billing.timezone === 'string' ? billing.timezone : 'UTC',
        weekdays: Array.isArray(billing.weekdays)
          ? billing.weekdays.filter((day): day is number => typeof day === 'number')
          : [1, 2, 3, 4, 5],
        windows: asWindows(billing.windows),
        holidays: asTextList(billing.holidays),
        holidayZone: typeof billing.holidayZone === 'string' ? billing.holidayZone : 'Asia/Shanghai',
      },
    };
    if (typeof source.label === 'string') normalized.label = source.label;
    return normalized;
  });
}

/**
 * The equivalent `cordis.patch.yml` block.
 *
 * Takes providers in the editor's USD form and prints the values verbatim:
 * converting here as well would divide by a billion twice and emit rates like
 * `6e-12`.
 * @param providers - providers whose rate rows hold USD decimal strings.
 * @returns the YAML block.
 */
function toYaml(providers: EditorProvider[]): string {
  const lines = ['config:', '  providers:'];
  providers.forEach(function (provider) {
    lines.push('    - id: ' + provider.id);
    lines.push('      billing: { timezone: ' + provider.billing.timezone + ', windows: [' +
      provider.billing.windows.map(function (w) { return '[' + w[0] + ',' + w[1] + ']'; }).join(', ') + '] }');
    lines.push('      models:');
    provider.models.forEach(function (model) {
      const flat = model.rates.flat !== undefined;
      const rates = flat ? model.rates.flat : model.rates.peak;
      if (rates === null || rates === undefined) return;
      lines.push('        - model: ' + model.model);
      lines.push('          rates: { ' + (flat ? 'flat' : 'peak') + ': { cacheHit: ' + String(rates.cacheHit) +
        ', cacheMiss: ' + String(rates.cacheMiss) + ', output: ' + String(rates.output) + ' } }');
    });
  });
  return lines.join('\n') + '\n';
}

/**
 * The snapshot behind either form shape: the owner's `{ state, mutate }` face or a
 * settings controller with `getSnapshot()`.
 * @param form - either shape.
 * @returns the snapshot, or null when there is none yet.
 */
function readSnapshot(form: unknown): ConfigSnapshot | null {
  const candidate = asRecord(form);
  if (candidate === null) return null;
  const state = candidate.state;
  if (state !== undefined && state !== null) {
    const snap = asRecord(state);
    if (snap !== null) return snap as ConfigSnapshot;
  }
  const getSnapshot = candidate.getSnapshot;
  if (typeof getSnapshot === 'function') {
    const snap = asRecord(getSnapshot.call(form));
    if (snap !== null) return snap as ConfigSnapshot;
  }
  return null;
}

/** Props for one editable rate row. */
interface RateFieldsProps {
  row: EditorRateRow | null | undefined;
  onChange(field: string, value: string): void;
}

/** One editable rate row. */
function RateFields(props: RateFieldsProps): React.ReactNode {
  // `props.row` was undefined for a flat model read as a peak one, and indexing it
  // threw `Cannot read properties of undefined (reading 'cacheHit')` live.
  const row: EditorRateRow = props.row ?? {};
  const fields: Array<[keyof EditorRateRow, string]> = [
    ['cacheHit', 'cache hit'], ['cacheMiss', 'cache miss'], ['cacheWrite', 'cache write'], ['output', 'output'],
  ];
  return h('div', { className: 'dsm-rates' }, fields.map(function (pair) {
    const value = row[pair[0]];
    return h('label', { key: pair[0], className: 'dsm-rate' },
      h('span', null, pair[1]),
      h('input', {
        type: 'text', inputMode: 'decimal', className: 'dsm-input',
        value: value === undefined ? '' : String(value),
        onChange: function (event: React.ChangeEvent<HTMLInputElement>) { props.onChange(pair[0], event.target.value); },
      }));
  }));
}

/**
 * The Plugins-sidebar page: every provider the plugin integrates, with its
 * models and rates, editable in place.
 *
 * Reads the Host's schema-resolved configuration through `configForms`, whose
 * `value` already carries the shipped rate cards as defaults — so the page
 * shows the effective table without duplicating it. Writes go through the same
 * form, guarded by the revision read when editing began; a conflict keeps the
 * draft. A deployment that serves no namespace for this entry falls back to a
 * read-only summary plus the equivalent YAML.
 */
function PricingPage(props: DshSlotProps): React.ReactNode {
  // The slot owner hands the page its own form and says which half to render:
  // `summary` is the one-liner on the row, `page` is the editor. Preferring the
  // supplied form matters — reading it from the service instead works only when
  // the entry's namespace resolves by id, which is a different path.
  const view = props.view === 'summary' ? 'summary' : 'page';
  // The slot owner hands this page `{ state, mutate }` — a resolved snapshot plus one
  // atomic write — not the settings controller. Requiring `getSnapshot()` here
  // rejected the real form, which is why the page stayed read-only.
  const supplied = props.form === undefined || props.form === null ? null : props.form;
  // Resolved on every render rather than captured when the plugin applied: the
  // settings service may arrive after this bundle, and a page stuck on a stale
  // `undefined` would stay read-only for the life of the page.
  const service: DshConfigFormsService | null = props.getService
    ? (asRecord(props.getService('configForms')) as DshConfigFormsService | null)
    : props.configForms ?? null;
  const fromService = service !== null && typeof service.get === 'function' ? service.get(SETTINGS_NS) : null;
  const form: unknown = supplied !== null ? supplied : fromService ?? null;
  const snapState = useState<ConfigSnapshot | null>(null);
  const snapshot = snapState[0];
  const setSnapshot = snapState[1];
  const draftState = useState<EditorDraft | null>(null);
  const draft = draftState[0];
  const setDraft = draftState[1];
  const noticeState = useState<string | null>(null);
  const notice = noticeState[0];
  // What the last successful write contained. The owner-supplied form has no
  // subscription, so the snapshot on this render can predate the write; without this
  // the page appeared to roll back even though the Host had persisted the change.
  const savedState = useState<EditorProvider[] | null>(null);
  const savedProviders = savedState[0];
  const setSavedProviders = savedState[1];
  const setNotice = noticeState[1];

  useEffect(function () {
    if (form === null) {
      setSnapshot(null);
      return undefined;
    }
    setSnapshot(readSnapshot(form));
    // The owner-supplied shape carries no subscription: the page re-renders from its
    // own store when the served namespace changes.
    const candidate = asRecord(form);
    if (candidate === null || typeof candidate.subscribe !== 'function') return undefined;
    const unsubscribe = candidate.subscribe(function () { setSnapshot(readSnapshot(form)); });
    return typeof unsubscribe === 'function' ? unsubscribe : undefined;
  }, [form]);

  // `value` is the accepted configuration; `base` is what an override would inherit
  // (the shipped cards plus the profile patch). Falling back to `base` keeps the
  // editor usable when a Host has not published an accepted value yet, instead of
  // showing a read-only page for no reason.
  const accepted: unknown = snapshot !== null && snapshot.value !== undefined && snapshot.value !== null ? snapshot.value : null;
  const inherited: unknown = snapshot !== null && snapshot.base !== undefined && snapshot.base !== null ? snapshot.base : null;
  const raw = accepted !== null ? accepted : inherited;
  const showingInherited = accepted === null && inherited !== null;
  // A config layer can arrive partial: the Host exposes only the fields it serves, so
  // `display`, `budget` and `providers` may each be missing. Normalize once here and
  // the rest of the page can assume the shape.
  const resolved: ConfigLayer | null = raw === null || raw === undefined ? null : asConfigLayer(raw);
  const base: ConfigLayer | null = snapshot !== null && snapshot.base !== null && snapshot.base !== undefined ? asConfigLayer(snapshot.base) : null;
  const revision = snapshot === null ? null : snapshot.revision;
  const clean = draft === null || draft.revision !== revision;

  // The Host resolves rates to nanodollars for computing; the editor must show
  // USD. Converting only while dirty would leave the first paint showing
  // "6000000" as if it were dollars, so the clean view converts too. This is a
  // hook, so it sits before any early return.
  // The Host confirmed a revision: its values supersede what we remembered writing.
  useEffect(function () {
    setSavedProviders(null);
  }, [revision]);

  const displayProviders: EditorProvider[] = useMemo(function () {
    if (resolved === null) return [];
    if (!clean) return rowsOf(draft);
    if (savedProviders !== null) return savedProviders;
    return normalizeProviders(resolved.providers);
  }, [resolved, clean, draft, savedProviders]);

  if (resolved === null) {
    // Read-only is a legitimate state, not an error. Two distinct cases:
    //   - the inline plugin-page copy never gets a form (the owner resolves one for a
    //     ROW page), so it points at the row instead of showing an empty block;
    //   - a row page can be read-only before the Host serves the namespace, where the
    //     rates still come from cordis.patch.yml.
    // `resolved` is null on this branch by construction, so there are no providers to
    // show; reading `resolved.providers` here was the site of a dead `never` narrowing.
    const yamlProviders: EditorProvider[] = [];
    const diagnostics = (function () {
      // Re-read the service here: the diagnostics must report on the layer the page
      // actually read, and `asRecord` narrows the `unknown` getter result once.
      const described: DshConfigFormsService | null = props.getService
        ? asRecord(props.getService('configForms')) as DshConfigFormsService | null
        : null;
      let served = 'unavailable';
      if (described !== null && typeof described.describe === 'function') {
        try {
          const mirror = asRecord(described.describe());
          const getSnapshot = mirror?.getSnapshot;
          const snap = mirror !== null && typeof getSnapshot === 'function'
            ? asRecord(getSnapshot.call(mirror))
            : mirror;
          const view = asRecord(snap?.view) ?? snap;
          const namespaces = view !== null && Array.isArray(view.namespaces)
            ? view.namespaces.map(function (e) { const entry = asRecord(e); return entry !== null && typeof entry.ns === 'string' ? entry.ns : String(e); })
            : null;
          served = namespaces === null ? 'unknown' : namespaces.join(', ') || 'none';
        } catch (error) {
          served = 'unreadable';
        }
      }
      return 'entry ' + CONFIG_ENTRY + ' \u00b7 namespace ' + SETTINGS_NS + ' \u00b7 form ' + (form === null ? 'not supplied' : 'supplied') +
        ' \u00b7 accepted (value) ' + (accepted === null ? 'absent' : 'present') +
        ' \u00b7 inherited (base) ' + (inherited === null ? 'absent' : 'present') +
        ' \u00b7 served namespaces: ' + served;
    })();

    return h('div', { className: 'dsm-page' },
      h('div', { className: 'dsm-title' },
        h('span', { title: diagnostics }, 'Pricing'),
        h('span', { className: 'dsm-tag' }, props.surface === 'bundle' ? 'edited on the row page' : 'read-only')),
      h('div', { className: 'dsm-note' },
        props.surface === 'bundle'
          ? h(React.Fragment, null,
              'These rates price every session on this machine. Edit them on the component row below: open ',
              h('b', { className: 'dsm-path' }, 'dsh-session-metrics \u203a'),
              ' and use its Pricing section \u2014 providers, models, per-1M rates, peak windows and budget.')
          : 'These rates come from the profile configuration and are read-only on this page until the Host serves a settings form for the plugin. Until then, set them in cordis.patch.yml'
            + (yamlProviders.length === 0 ? ' \u2014 the shipped defaults apply when nothing is configured.' : ', shown below.')),
      // An empty block would suggest configuration exists when it does not.
      yamlProviders.length > 0 ? h('pre', { className: 'dsm-pre' }, toYaml(yamlProviders)) : null);
  }

  /**
   * The form as a writer, or null when it carries no `mutate`.
   *
   * Guarded on the method actually called: a form exposing `mutate` but not `set` would
   * otherwise swallow the click and save nothing. The narrowing lives here once, so
   * `save` reads a typed writer instead of re-checking `unknown`.
   */
  const writer = asWriter(form);

  /** The rows as they currently stand, dirty or clean. */
  const currentRows = function (): EditorProvider[] {
    return clean ? normalizeProviders(resolved?.providers) : rowsOf(draft);
  };

  /** Start a draft from the values currently on screen. */
  const begin = function (): void {
    if (!clean) return;
    setDraft({ revision: revision, providers: normalizeProviders(resolved?.providers) });
  };

  /** Apply one edit to the draft, cloning so React sees a new value. */
  const update = function (mutate: (next: EditorProvider[]) => void): void {
    const next = JSON.parse(JSON.stringify(currentRows())) as EditorProvider[];
    mutate(next);
    setDraft({ revision: draft !== null && draft.revision === revision ? draft.revision : revision, providers: next });
  };

  /** Write the draft, fenced by the revision read when editing began. */
  const save = function (): void {
    const candidate = asRecord(form);
    if (writer === null || candidate === null || typeof candidate.mutate !== 'function') return;
    const providersToWrite = currentRows();
    const ops = [{ op: 'set', path: ['providers'], value: providersToWrite }];
    Promise.resolve(candidate.mutate(ops, revision)).then(function (accepted) {
      if (accepted === false) {
        setNotice('The Host refused the change, so nothing was saved. Your edits are still here \u2014 copy the block below if you prefer to set them in cordis.patch.yml.');
      } else {
        // Keep showing what we wrote: the owner-supplied form has no subscription, so
        // the snapshot on the next render can predate this write.
        setSavedProviders(providersToWrite);
        setDraft(null);
        setNotice('Saved. These rates are in use from the next step on.');
      }
    }).catch(function (error: unknown) {
      const reason = asRecord(error);
      setNotice('Saving failed: ' + (typeof reason?.message === 'string' ? reason.message : String(error)) + '. Your edits are kept.');
    });
  };

  const providers = displayProviders;

  if (view === 'summary') {
    const modelCount = providers.reduce(function (total, provider) { return total + provider.models.length; }, 0);
    const parts = [providers.length + ' providers', modelCount + ' models'];
    const sessionUsd = resolved === null ? null : resolved.budget?.sessionUsd;
    if (sessionUsd) parts.push('budget $' + sessionUsd.toFixed(2));
    if (snapshot !== null && snapshot.writability === 'read-only') parts.push('read-only');
    return h('span', { className: 'dsm-summary' }, parts.join(' \u00b7 '));
  }

  const providerCards = providers.map(function (provider, providerIndex) {
    const baseProviders = asProviderList(base?.providers);
    const baseProvider = baseProviders.filter(function (p) { return p.id === provider.id; })[0] ?? null;
    return h('div', { className: 'dsm-card', key: provider.id + providerIndex },
      h('div', { className: 'dsm-cardHead' },
        h('input', {
          className: 'dsm-input dsm-inputId', value: provider.id,
          onChange: function (event) { begin(); update(function (next) { next[providerIndex].id = event.target.value; }); },
        }),
        provider.label ? h('span', { className: 'dsm-tag' }, provider.label) : null,
        h('button', {
          type: 'button', className: 'dsm-toggle',
          disabled: baseProvider === null,
          title: baseProvider === null ? 'No shipped card for this provider' : 'Restore the shipped rates for this provider',
          onClick: function () {
            if (baseProvider === null) return;
            const shipped = normalizeProviders([baseProvider])[0];
            update(function (next) { next[providerIndex] = shipped; });
          },
        }, 'reset to shipped'),
        h('button', {
          type: 'button', className: 'dsm-toggle',
          onClick: function () { update(function (next) { next.splice(providerIndex, 1); }); },
        }, 'remove')),
      h('div', { className: 'dsm-billingRow' },
        h('label', { className: 'dsm-rate' }, h('span', null, 'billing zone'),
          h('input', {
            className: 'dsm-input', value: provider.billing.timezone,
            onChange: function (event) { begin(); update(function (next) { next[providerIndex].billing.timezone = event.target.value; }); },
          })),
        h('label', { className: 'dsm-rate' }, h('span', null, 'peak windows'),
          h('input', {
            className: 'dsm-input', value: formatWindows(provider.billing.windows), placeholder: '1-4,6-10 (empty = flat)',
            onChange: function (event) { begin(); update(function (next) { next[providerIndex].billing.windows = parseWindows(event.target.value); }); },
          })),
        h('label', { className: 'dsm-rate' }, h('span', null, 'weekdays'),
          h('input', {
            className: 'dsm-input', value: provider.billing.weekdays.join(','),
            onChange: function (event) {
              begin();
              update(function (next) {
                next[providerIndex].billing.weekdays = event.target.value.split(',').map(function (part) { return Number(part.trim()); })
                  .filter(function (day) { return day >= 1 && day <= 7; });
              });
            },
          }))),
      provider.models.map(function (model, modelIndex) {
        const isFlat = model.rates.flat !== undefined;
        const row = isFlat ? model.rates.flat : model.rates.peak;
        const swap = function (mode: 'flat' | 'peak'): void {
          begin();
          update(function (next) {
            const target = next[providerIndex].models[modelIndex];
            const source = mode === 'flat' ? target.rates.peak : target.rates.flat;
            const zero = { cacheHit: '0', cacheMiss: '0', cacheWrite: '0', output: '0' };
            if (mode === 'flat') { target.rates.flat = source || zero; delete target.rates.peak; delete target.rates.offPeak; }
            else { target.rates.peak = source || zero; delete target.rates.flat; }
          });
        };
        const writeRow = function (mode: 'flat' | 'peak' | 'offPeak', field: keyof EditorRateRow, value: string): void {
          begin();
          update(function (next) {
            const target = next[providerIndex].models[modelIndex];
            if (target.rates[mode] === undefined) target.rates[mode] = { cacheHit: '0', cacheMiss: '0', cacheWrite: '0', output: '0' };
            target.rates[mode][field] = value;
          });
        };
        return h('div', { className: 'dsm-modelRow', key: model.model + modelIndex },
          h('div', { className: 'dsm-modelHead' },
            h('input', {
              className: 'dsm-input dsm-inputModel', value: model.model, title: model.model,
              onChange: function (event) { begin(); update(function (next) { next[providerIndex].models[modelIndex].model = event.target.value; }); },
            }),
            h('button', { type: 'button', className: 'dsm-toggle', 'data-on': String(isFlat),
              onClick: function () { swap('flat'); } }, 'flat'),
            h('button', { type: 'button', className: 'dsm-toggle', 'data-on': String(!isFlat),
              onClick: function () { swap('peak'); } }, 'peak / off-peak'),
            h('button', { type: 'button', className: 'dsm-toggle',
              onClick: function () { update(function (next) { next[providerIndex].models.splice(modelIndex, 1); }); } }, 'remove')),
          h('div', { className: 'dsm-usdLabel' }, isFlat ? 'USD per 1M tokens' : 'USD per 1M tokens (peak)'),
          h(RateFields, {
            row: row,
            onChange: function (field, value) { writeRow(isFlat ? 'flat' : 'peak', field as keyof EditorRateRow, value); },
          }),
          !isFlat
            ? (model.rates.offPeak !== undefined
                ? h('div', null,
                    h('div', { className: 'dsm-usdLabel' }, 'USD per 1M tokens (off-peak)'),
                    h(RateFields, {
                      row: model.rates.offPeak,
                      onChange: function (field, value) { writeRow('offPeak', field as keyof EditorRateRow, value); },
                    }))
                : h('label', { className: 'dsm-rate' }, h('span', null, 'off-peak multiplier'),
                    h('input', {
                      className: 'dsm-input', inputMode: 'decimal',
                      value: String(model.rates.multiplier === undefined ? 0.5 : model.rates.multiplier),
                      onChange: function (event) {
                        const parsed = Number(event.target.value);
                        begin();
                        update(function (next) {
                          next[providerIndex].models[modelIndex].rates.multiplier = isFinite(parsed) && parsed > 0 ? parsed : 0.5;
                        });
                      },
                    })))
            : null);
      }),
      h('button', {
        type: 'button', className: 'dsm-toggle',
        onClick: function () {
          begin();
          update(function (next) {
            next[providerIndex].models.push({
              model: 'new-model', aliases: [],
              rates: { flat: { cacheHit: '0', cacheMiss: '0', cacheWrite: '0', output: '0' }, multiplier: 0.5 },
            });
          });
        },
      }, '+ model'));
  });

  const writable = snapshot === null || snapshot === undefined
    ? true
    : snapshot.writability !== 'read-only' && snapshot.writable !== false;
  return h('div', { className: 'dsm-page' },
    h('div', { className: 'dsm-title' },
      h('span', null, 'Pricing'),
      h('span', { className: 'dsm-tag' }, providers.length + ' providers')),
    h('div', { className: 'dsm-note' },
      'Rates used to price this session, per provider and per model \u2014 these are the ones on this machine right now. A session whose provider or model has no card is reported as ',
      h('b', null, 'unpriced'), ' rather than guessed; the session\u2019s own detail lists the pairs it saw under ',
      h('b', null, 'Seen, unpriced'), ', and adding their card here prices them. A provider\u2019s free models need a zero-rate card to read $0.00.'),
    showingInherited
      ? h('div', { className: 'dsm-note' }, 'These are the inherited rates; saving writes your own over them.')
      : null,
    providers.length === 0
      ? h('div', { className: 'dsm-note dsm-warn' },
          'No rate cards are configured for this entry yet. The Host exposes only the fields it serves, so this can also mean the settings namespace is not registered '
          + '(see docs/authoring.md: editable fields must declare .volatile()). Use + provider to add one, or set them in cordis.patch.yml.')
      : null,
    h('div', { className: 'dsm-actions' },
      h('button', { type: 'button', className: 'dsm-toggle dsm-primary', disabled: !writable || clean, onClick: save }, 'save rates'),
      h('button', { type: 'button', className: 'dsm-toggle', disabled: clean,
        onClick: function () { setDraft(null); setNotice(null); } }, 'discard'),
      clean ? h('span', { className: 'dsm-note' }, 'no changes') : h('span', { className: 'dsm-note dsm-warn' }, 'unsaved changes')),
    notice === null ? null : h('div', { className: 'dsm-note dsm-warn' }, notice),
    h('div', { className: 'dsm-note' }, 'Stored in this profile\u2019s Cordis patch. Revision ' + String(revision) + '.'),
    providerCards,
    h('button', {
      type: 'button', className: 'dsm-toggle',
      onClick: function () {
        begin();
        update(function (next) {
          next.push({
            id: 'new-provider', models: [],
            billing: { timezone: 'UTC', weekdays: [1, 2, 3, 4, 5], windows: [], holidays: [], holidayZone: 'Asia/Shanghai' },
          });
        });
      },
    }, '+ provider'),
    h('div', { className: 'dsm-section' }, 'Equivalent cordis.patch.yml'),
    h('pre', { className: 'dsm-pre' }, toYaml(providers)));
}

/**
 * Whether this plugin has anything to say for the page's subject (T-001).
 *
 * `plugins.detail.badge` is a **list** slot and its owner renders *every* entry
 * on all three detail pages (ItemDetail, RowDetail, BundleDetail) with no filter,
 * so each entry must decide for itself. The owner's contract is explicit: "an
 * entry renders null for a subject it has nothing for". We contribute no plugin
 * item, so only our own bundle or row page qualifies; anything unrecognised —
 * including a missing `subject` — is a page we do not own.
 *
 * Every read is guarded because this runs inside the owner's render, where a
 * throw would be the owner's failure, not a chip we can show.
 * @param subject - the page's subject, as the owner passes it.
 * @returns true only for this plugin's own bundle or row page.
 */
function isOurSubject(subject: unknown): boolean {
  const page = asRecord(subject);
  if (page === null) return false;
  const kind = page.kind;
  if (kind !== 'bundle' && kind !== 'row') return false;
  const pkg = asRecord(page.pkg);
  return pkg !== null && pkg.name === PLUGIN_ID;
}

/**
 * Register the detail badge beside the plugin title (T-001).
 *
 * One helper so the same contribution can be attached through either door: the
 * optional `configForms` injection when the context offers one, or the root
 * context otherwise. The registration carries ONLY the options this slot
 * declares — `id`, `order`, `label`; an `inject` option on the slot registration
 * would replace the owner's own props (`subject` and the standard hooks) and
 * leave the component with nothing to read.
 * @param slots - the `slots` service that owns the registration.
 * @param serviceGet - name → service, the badge's read of this plugin's configuration.
 * @returns the deferred registration the slot service returns.
 */
function registerBadge(slots: DshSlotsService, serviceGet: (name: string) => unknown): DshDisposable {
  return slots.inject('plugins.detail.badge', function () {
    return slots.register({
      name: 'plugins.detail.badge',
      id: PLUGIN_ID,
      order: 20,
      label: 'Session metrics: providers, models and the current peak state',
    }, function (props: DshSlotProps) {
      // The gate sits outside the boundary on purpose: on another plugin's page
      // we must render nothing at all, not a failure chip of our own.
      if (!isOurSubject(props.subject)) return null;
      return h(MetricsBoundary, null, h(PluginBadge, Object.assign({}, props, { serviceGet: serviceGet })));
    });
  });
}

const inject = ['slots'];

/**
 * Client plugin body: register the strip in the composer's full-width seat
 * and make sure this session's projection baseline is loaded, so the value is
 * present even in a session that has been idle since the page opened.
 * @param ctx - client root context.
 */
function apply(ctx: DshClientContext): void {
  // Read opportunistically rather than as a declared dependency: a deployment
  // without the settings service still gets the strip, and the pricing page
  // degrades to its read-only form.
  const getService = function (name: string): unknown {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
    } catch (error) {
      return undefined;
    }
  };

  // Inline on the bundle's own page, between its description and its rows: the
  // discoverable half. `plugins.row.config` below feeds the row's own page.
  ctx.slots.inject('plugins.bundle.config', function () {
    return ctx.slots.register({
      name: 'plugins.bundle.config',
      key: PLUGIN_ID,
    }, function (props: DshSlotProps) {
      return h(MetricsBoundary, null, h(PricingPage, Object.assign({}, props, { getService: getService, surface: 'bundle' })));
    });
  });

  ctx.slots.inject('plugins.row.config', function () {
    return ctx.slots.register({
      name: 'plugins.row.config',
      key: ROW_CONFIG_KEY,
      id: PLUGIN_ID,
      order: 12,
    }, function (props: DshSlotProps) {
      return h(MetricsBoundary, null, h(PricingPage, Object.assign({}, props, { getService: getService, surface: 'row' })));
    });
  });

  // The badge beside the plugin title on the Plugins page (T-001). The slot's owner
  // props are `{ subject }` and standard hooks — no `getService`, no configuration —
  // so the service getter is captured in the closure and passed as a prop, and it
  // resolves at render time so a settings service that arrives later is still picked up.
  //
  // `configForms` is an *optional* service: a deployment without the settings UI
  // provides none. `ctx.inject(['configForms'], …)` is the documented idiom for that —
  // the callback runs only while the service is provided, so such a deployment shows no
  // badge at all — and inside the callback `child.configForms` is a legal property read,
  // because the injection is what declares it. On the root context a service is only
  // readable as a property when it is declared, which is exactly why the badge is
  // attached through this door instead.
  // The read and the narrowing happen inside one try/catch: on a restricted client
  // context an undeclared property read THROWS (`cannot get property "…" without
  // declaring it`), and the DOM harness reproduces that exactly. Reading `ctx.inject`
  // once, here, both keeps the throw contained and gives the compiler a local it can
  // narrow — `typeof ctx.inject === 'function'` cannot narrow an optional *method* at a
  // later call site, and moving the read out of the guard is how this bundle first
  // crashed the harness with that exact throw.
  const inject = (function (): DshClientContext['inject'] {
    try {
      return typeof ctx.inject === 'function' ? ctx.inject : undefined;
    } catch (error) {
      return undefined;
    }
  })();

  if (typeof inject === 'function') {
    inject.call(ctx, ['configForms'], function (child): void {
      // Prefer the injected declaration; keep `ctx.get('configForms')` as the
      // secondary source, because a service can be replaced while the badge is
      // mounted and both reads are honest when guarded.
      registerBadge(child.slots, function (name: string): unknown {
        if (name === 'configForms') {
          try {
            const injected = child.configForms;
            if (injected !== undefined && injected !== null) return injected;
          } catch (error) {
            /* the service went away since activation: fall through to the root lookup */
          }
        }
        return getService(name);
      });
    });
  } else {
    // No optional injection on this context: register through the root context, the
    // path the DOM harness and any deployment without the API take.
    registerBadge(ctx.slots, getService);
  }

  // The registration carries ONLY the options this slot declares — `id`, `order`,
  // `label`. Passing an `inject` here is not supported for `conversation.input.dock`,
  // and for slots that do support it the return value *is* the component's props, so
  // an unsupported one silently replaces `useProjection` and `sessionId` and leaves
  // the strip with nothing to read.
  // `ctx.get(name)` with an undefined check, never `ctx.name`: on the client's
  // restricted context an undeclared service read as a property THROWS
  // ("cannot get property ..."), which crashed this entry on its first render and
  // had the slot abdicate it — registered but invisible, with no error on screen.
  const serviceOf = function (name: string): unknown {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
    } catch (error) {
      return undefined;
    }
  };

  const refreshBaseline = function (sessionId?: string): void {
    if (sessionId === undefined) return;
    const sessions = asRecord(serviceOf('sessions'));
    const refresh = sessions?.refreshProjections;
    if (typeof refresh !== 'function') return;
    Promise.resolve(refresh.call(sessions, sessionId)).catch(function () {
      /* the normal session frame still carries the baseline */
    });
  };

  ctx.slots.inject('conversation.input.dock', function () {
    return ctx.slots.register({
      name: 'conversation.input.dock',
      id: PLUGIN_ID,
      order: 17,
    }, function (props: DshSlotProps) {
      return h(MetricsBoundary, null, h(SessionMetricsPanel, Object.assign({}, props, { refreshProjections: refreshBaseline })));
    });
  });
}

module.exports = { inject: inject, apply: apply, name: PLUGIN_ID };
