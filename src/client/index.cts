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

const React = require('react');
// A tooltip must not be clipped by the panel's scroll container, and a fixed-position box
// is still clipped if any ancestor carries a transform. Portalling it to `document.body`
// escapes both, and the guard keeps a missing module from taking the whole panel down.
const ReactDOM = (function () {
  try {
    return require('react-dom');
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
function costOf(rateNano, tokens) {
  if (!rateNano || !tokens) return 0;
  return Math.round((rateNano * tokens) / PER_MILLION);
}

/** Integer nanodollars to a USD string. */
function usd(nano, digits) {
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
function usd2(nano) {
  if (nano === null || nano === undefined || !isFinite(nano)) return null;
  const cents = Math.round(Math.abs(nano) / 1e7);
  // A session that has cost something must not read as free: below a cent, say so.
  if (cents === 0 && nano > 0) return '< $0.01';
  return (nano < 0 ? '-$' : '$') + (cents / 100).toFixed(2);
}

/** The city part of an IANA zone: `Asia/Tokyo` becomes `Tokyo`. */
function cityOf(zone) {
  const tail = String(zone || 'UTC').split('/').pop() || 'UTC';
  return tail.replace(/_/g, ' ');
}

/**
 * Label keys, with the legacy aliases expanded and de-duplicated.
 *
 * `window` used to mean "the peak flag and the clock in one chip"; it now maps to
 * the separate `peak` and `time` chips so existing profile configs keep rendering.
 */
function labelKeys(labels) {
  const out = [];
  const add = function (key) { if (out.indexOf(key) < 0) out.push(key); };
  (Array.isArray(labels) ? labels : []).forEach(function (key) {
    if (key === 'window') { add('peak'); add('time'); }
    else if (key === 'savings') { add('saved'); }
    else if (key === 'steps') { /* removed from the UI; the ledger stays in the projection */ }
    else add(key);
  });
  return out;
}

/** Every token bucket a session can be billed for. */
function bucketTotal(buckets) {
  if (!buckets) return 0;
  return buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens + buckets.outputTokens;
}

/**
 * The same peak window expressed in another zone, for the schedule sentence.
 *
 * Derived from today's offset between the two zones, which is what a reader wants
 * from a one-line "in your local time" hint.
 */
function windowInZone(nowMs, window, providerZone, viewerZone) {
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
function tokens(value) {
  if (typeof value !== 'number' || !isFinite(value)) return '—';
  if (value >= 1e9) return (value / 1e9).toFixed(2) + 'B';
  if (value >= 1e6) return (value / 1e6).toFixed(2) + 'M';
  if (value >= 1e3) return (value / 1e3).toFixed(1) + 'k';
  return String(Math.round(value));
}

/** One decimal percentage. */
function pct(value) {
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
const zoneFormatters = new Map();

/** The cached formatter for one zone. */
function formatterFor(zone) {
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

/** Calendar fields for an instant in a zone. */
function zoned(date, zone) {
  const parts = formatterFor(zone).formatToParts(date);
  const at: Record<string, any> = {};
  for (const p of parts) if (p.type !== 'literal') at[p.type] = p.value;
  const day = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[at.weekday] || 0;
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
function tierAt(ms, billing) {
  const windows = (billing && billing.windows) || [];
  if (windows.length === 0) return 'flat';
  const zone = billing.timezone || 'UTC';
  const at = zoned(new Date(ms), zone);
  if (((billing.weekdays) || []).indexOf(at.weekday) < 0) return 'off-peak';
  if (((billing.holidays) || []).indexOf(at.date) >= 0) return 'off-peak';
  const inside = windows.some(function (w) {
    return w[0] <= w[1] ? at.hour >= w[0] && at.hour < w[1] : at.hour >= w[0] || at.hour < w[1];
  });
  return inside ? 'peak' : 'off-peak';
}

/** The next instant the tier changes, or null for a flat rate. */
function nextBoundary(ms, billing) {
  const windows = (billing && billing.windows) || [];
  if (windows.length === 0) return null;
  const current = tierAt(ms, billing);
  const hourMs = 3600000;
  const start = Math.floor(ms / hourMs) * hourMs;
  let boundary = null;
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
 * was read in.
 */
interface BadgePayload {
  providers: number;
  models: number;
  tier: string | null;
  zone: string | null;
  title: string;
}

/**
 * The accepted configuration layer out of whatever snapshot shape the service serves.
 *
 * `readSnapshot` accepts either the owner's `{ state, mutate }` form or a settings
 * controller. Only the `value` layer counts: `base` is what an override would inherit,
 * and a badge built from shipped defaults would claim configuration that is not there.
 */
function badgeValue(form: any) {
  const snap = readSnapshot(form);
  if (snap === null || snap === undefined) return null;
  // Read the own property only: the prototype must not answer for the accepted layer.
  return snap.value === undefined ? null : snap.value;
}

/**
 * One provider's billing calendar, with every field `tierAt` reads.
 *
 * `weekdays` and `holidays` are guards inside `tierAt`, so a calendar copied
 * without them reports off-peak for every instant of a peak window — which is
 * what a half-copied calendar did before this carried them.
 * @param provider - a provider from the resolved configuration.
 * @returns the calendar, or null when the provider carries none.
 */
function billingOf(provider: any) {
  const billing = provider && typeof provider === 'object' ? provider.billing : null;
  if (billing === null || typeof billing !== 'object') return null;
  return {
    windows: Array.isArray(billing.windows) ? billing.windows : [],
    // The schema lists the weekdays CHARGED AT PEAK, and `tierAt` reads an instant
    // outside that list as off-peak — so an empty list is "no peak day", not "every
    // day". Carried through exactly as it arrives.
    weekdays: Array.isArray(billing.weekdays) ? billing.weekdays : [],
    holidays: Array.isArray(billing.holidays) ? billing.holidays : [],
    timezone: typeof billing.timezone === 'string' && billing.timezone !== '' ? billing.timezone : 'UTC',
  };
}

/**
 * The badge's content, or null when there is no honest value to show.
 *
 * The whole point of this component is not to exist when it cannot say
 * something true: an empty chip is the failure mode T-001 exists to avoid, so
 * every branch that lacks a real provider list, or a real price state, returns
 * null and the slot renders nothing at all.
 * @param value - the accepted configuration layer.
 * @param nowMs - the instant to read the calendar at.
 * @returns the payload, or null when the badge must stay away.
 */
function badgePayload(value: any, nowMs: number): BadgePayload | null {
  const providers = value && Array.isArray(value.providers) ? value.providers : [];
  if (providers.length === 0) return null;
  let models = 0;
  let calendar = null;
  let zone = 'UTC';
  let windowed = false;
  providers.forEach(function (provider) {
    if (Array.isArray(provider && provider.models)) models += provider.models.length;
    const billing = billingOf(provider);
    if (billing === null || billing.windows.length === 0) return;
    windowed = true;
    // The first provider with a peak window supplies the calendar: that is the state
    // the chip names, and the title says which zone it was read in.
    if (calendar === null) {
      calendar = billing;
      zone = billing.timezone;
    }
  });
  const tier = calendar === null ? null : tierAt(nowMs, calendar);
  const title = (windowed
    ? 'The peak/off-peak state right now, in ' + zone + ', for ' + providers.length +
      ' configured provider(s) with ' + models + ' model(s). Read from this plugin\u2019s own configuration.'
    : 'No configured provider has peak windows, so every hour is charged at one rate. ' +
      providers.length + ' provider(s) and ' + models + ' model(s) are configured.')
    + ' Set rates on the component row under dsh-session-metrics \u203a session-metrics.';
  return { providers: providers.length, models: models, tier: tier, zone: zone, title: title };
}

/**
 * The one child that decides between a real chip and nothing.
 *
 * It takes its `title` from props on purpose: the DOM suite mounts a component
 * with props alone, and a parent that held it in state would also re-render on
 * every revision of the configuration.
 */
class BadgeView extends React.PureComponent<any, any> {
  render() {
    const payload = badgePayload(this.props.value, Date.now());
    if (payload === null) return null;
    const segments = [
      payload.providers + (payload.providers === 1 ? ' provider' : ' providers'),
      payload.models + (payload.models === 1 ? ' model' : ' models'),
    ];
    if (payload.tier !== null) segments.push(payload.tier);
    const children: any[] = [];
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
}

/**
 * The Plugins-page badge beside the plugin title (T-001).
 *
 * The slot hands this component `{ subject }` and standard hooks only — no
 * `getService` — so a badge cannot reach the configuration through props. It is
 * handed a getter captured in the registration closure instead, and the getter
 * is called on **every render** rather than once at registration: the settings
 * service may arrive after this bundle. A service that is missing, null,
 * unreadable or without an entry for this plugin is not an error — it means the
 * badge has nothing true to say, so it renders nothing.
 *
 * Every step is defensive because this component runs *inside* the slot owner's
 * render: a throw here would abdicate the entry, not merely hide the chip.
 * @param props - slot props plus the `getService` getter `apply` supplies.
 * @returns the badge, or null when there is no real value to show.
 */
function PluginBadge(props) {
  const propsGet = props && typeof props.getService === 'function' ? props.getService : null;
  const getService = propsGet === null ? props.serviceGet : propsGet;
  const stableGet = useCallback(function (name) {
    return getService && typeof getService === 'function' ? getService(name) : undefined;
  }, [getService]);
  const service = useMemo(function () {
    if (typeof getService !== 'function') return null;
    const found = stableGet('configForms');
    return found === undefined || found === null ? null : found;
  }, [stableGet, getService]);
  // `ctx.get('configForms')` returns the service itself; `service.get(entry)` returns
  // this plugin's form. Both are checked at every level: `undefined` and `null` are
  // both normal on a restricted context, and a deployment without a settings service
  // simply renders no badge.
  const form = useMemo(function () {
    if (service === null || typeof service.get !== 'function') return null;
    try {
      const found = service.get(SETTINGS_NS);
      return found === undefined || found === null ? null : found;
    } catch (error) {
      return null;
    }
  }, [service]);
  const subscribe = useCallback(function (listener) {
    if (form === null || typeof form.subscribe !== 'function') return function () {};
    try {
      const unsubscribe = form.subscribe(listener);
      return function () {
        if (typeof unsubscribe === 'function') unsubscribe();
      };
    } catch (error) {
      return function () {};
    }
  }, [form]);
  const getSnapshot = useCallback(function () {
    if (form === null) return null;
    try {
      return badgeValue(form);
    } catch (error) {
      return null;
    }
  }, [form]);
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return value === null ? null : h(BadgeView, { value: value });
}

/** `hh:mm` for an instant in a zone. */
function clock(ms, zone) {
  const at = zoned(new Date(ms), zone);
  return String(at.hour).padStart(2, '0') + ':' + String(at.minute).padStart(2, '0');
}

/** A human countdown. */
function countdown(from, to) {
  const minutes = Math.max(0, Math.floor((to - from) / 60000));
  if (minutes < 1) return 'less than a minute';
  const hrs = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hrs === 0) return rest + 'm';
  return rest === 0 ? hrs + 'h' : hrs + 'h ' + rest + 'm';
}

// ----------------------------------------------------------- projections
/** Token bucket totals from either shape the projection may serve. */
function tokenBuckets(value) {
  const source = value && value.totals ? value.totals : (value || {});
  return {
    uncachedInputTokens: source.uncachedInputTokens || 0,
    cacheReadTokens: source.cacheReadTokens || 0,
    cacheWriteTokens: source.cacheWriteTokens || 0,
    outputTokens: source.outputTokens || 0,
  };
}

/** The session's provider/model from the model-selection projection. */
function selection(value) {
  if (!value) return null;
  const used = value.lastUsed || value.next;
  if (!used || !used.provider || !used.model) return null;
  return { provider: used.provider, model: used.model };
}

/**
 * How one projection arrived: `absent` (not in the snapshot at all), `null`
 * (served but empty), or `present`. Distinguishing the three is the difference
 * between "the owner row is not running" and "it is running but has no value".
 * @param value - the projection value.
 * @returns the status word.
 */
function sourceState(value) {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  return 'present';
}

/** The last provider/model the ledger recorded, as a fallback selection. */
function selectionFromLedger(ledger) {
  const rows = ledger && ledger.rows ? ledger.rows : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row && row.provider) return { provider: row.provider, model: row.model };
  }
  const keys = Object.keys((ledger && ledger.totals) || {});
  for (const key of keys) {
    const parts = key.split('\u0000');
    if (parts[0]) return { provider: parts[0], model: parts[1] || null };
  }
  return null;
}

/** The rate row a resolved model charges at one tier. */
function ratesAt(model, tier) {
  if (!model) return null;
  if (model.mode === 'flat') return model.rates.flat;
  return tier === 'peak' ? model.rates.peak : model.rates.offPeak;
}

/** Find a provider and model card for a reported pair. */
function findCard(providers, providerId, modelId) {
  const provider = (providers || []).find(function (p) { return p.id === providerId; }) || null;
  if (!provider) return { provider: null, model: null };
  const model = provider.models.find(function (m) {
    return m.model === modelId || (m.aliases || []).indexOf(modelId) >= 0;
  }) || null;
  return { provider: provider, model: model };
}

/** Price one bucket set against one rate row. */
function priceBuckets(rates, buckets) {
  if (!rates) return null;
  const hit = costOf(rates.cacheHit, buckets.cacheReadTokens);
  const miss = costOf(rates.cacheMiss, buckets.uncachedInputTokens);
  const write = costOf(rates.cacheWrite, buckets.cacheWriteTokens);
  const out = costOf(rates.output, buckets.outputTokens);
  return { cacheHitNano: hit, cacheMissNano: miss, cacheWriteNano: write, outputNano: out, totalNano: hit + miss + write + out };
}

/** What the cache saved on one bucket set. */
function savingsOf(rates, buckets) {
  if (!rates) return 0;
  const diff = rates.cacheMiss - rates.cacheHit;
  return diff > 0 ? costOf(diff, buckets.cacheReadTokens) : 0;
}

/**
 * Price the whole session: accumulate per provider/model/tier group, then
 * fall back to the current selection's card for buckets recorded before a
 * model was known.
 */
function priceSession(settings, ledger, selectionValue, now) {
  const groups = [];
  let total = 0;
  let saved = 0;
  let priced = true;
  let peakNano = 0;
  const byModel = new Map();

  Object.keys(ledger.totals || {}).forEach(function (key) {
    const parts = key.split('\u0000');
    const providerId = parts[0] || null;
    const modelId = parts[1] || null;
    const storedTier = parts[2] || 'flat';
    const buckets = ledger.totals[key];
    const card = findCard(settings.providers, providerId, modelId);
    const tier = storedTier;
    const rates = ratesAt(card.model, tier);
    const price = priceBuckets(rates, buckets);
    const group = {
      key: key, provider: providerId, model: modelId, tier: tier, buckets: buckets,
      rates: rates, price: price, savings: savingsOf(rates, buckets),
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
class MetricsBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    if (typeof console !== 'undefined' && console.error) console.error('session-metrics render failed', error);
  }

  render() {
    if (this.state.error === null) return this.props.children;
    const error = this.state.error;
    const message = error && error.message ? error.message : String(error);
    const stack = error && error.stack ? String(error.stack).split('\n').slice(0, 6).join(' | ') : '';
    return h('div', { className: 'dsm-slot', 'data-safe': 'false' },
      h('div', { className: 'dsm-root' },
        h('span', { className: 'dsm-trigger dsm-diag', title: stack || message },
          h('span', { className: 'dsm-flagDot' }, '\u25b2'),
          h('span', null, 'session-metrics failed'),
          h('span', { className: 'dsm-model', style: { maxWidth: 'none', whiteSpace: 'normal' } }, message),
          h('span', { className: 'dsm-build' }, BUILD))));
  }
}

/** A labelled cell. */
/**
 * A metric label with its explanation.
 *
 * Native `title` tooltips did not surface in the harness window, so the explanation is a
 * child element revealed by CSS on hover or keyboard focus. The same text is the accessible
 * name, so assistive technology gets it too.
 */
function Hint(props: any) {
  // The box cannot live inside the hint: the panel scrolls, and an absolutely positioned
  // child of a scroll container is clipped at its edge — which cropped long text and the
  // right-hand column. It is rendered once, fixed, and clamped to the viewport instead.
  return h('span', {
    className: 'dsm-hint',
    'aria-label': props.title,
    tabIndex: 0,
    onMouseEnter: function (event: any) { props.onShow(event.currentTarget, props.title); },
    onMouseLeave: props.onHide,
    onFocus: function (event: any) { props.onShow(event.currentTarget, props.title); },
    onBlur: props.onHide,
  },
    props.label,
    h('span', { className: 'dsm-q' }, '?'));
}


/** A proportional bar. */
function Bar(props) {
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
function SessionMetricsPanel(props) {
  // Lost props are a fault, not an empty session: without `useProjection` the strip
  // can never price anything, and silence would hide the reason.
  const frameworkPropsMissing = typeof props.useProjection !== 'function';
  const metrics = props.useProjection ? props.useProjection(PROJECTION) : undefined;
  const usageValue = props.useProjection ? props.useProjection('tokenUsage') : undefined;
  const selectionValue = props.useProjection ? props.useProjection('modelSelection') : undefined;

    /** The floating explanation: its text and its clamped viewport position. */
  const tipState = useState(null);
  const tip = tipState[0];
  const setTip = tipState[1];
  const showTip = useCallback(function (node: any, text: string) {
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
  const rootRef = useRef(null);
  const anchorState = useState(null);
  const anchor = anchorState[0];
  const setAnchor = anchorState[1];
  const nowState = useState(Date.now());
  const now = nowState[0];
  const setNow = nowState[1];

  useEffect(function () {
    if (typeof props.refreshProjections === 'function') props.refreshProjections(props.sessionId);
  }, [props.refreshProjections, props.sessionId]);

  const settings = metrics && metrics.settings ? metrics.settings : null;
  const ledger = metrics && metrics.ledger ? metrics.ledger : null;
  // The ledger carries the provider and model of every step, so it is a sufficient
  // source on its own; `modelSelection` is preferred because it is the catalogue the
  // composer's own model picker uses.
  const current = selection(selectionValue) || selectionFromLedger(ledger);
  const buckets = tokenBuckets(usageValue);
  const labels = labelKeys(settings && settings.display ? settings.display.labels : []);
  const details = settings && settings.display && settings.display.details ? settings.display.details : [];
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
    const onKey = function (event) { if (event.key === 'Escape') setOpen(false); };
    const onResize = function () { setOpen(false); };
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
  const hasAnyProjection = metrics !== undefined || usageValue !== undefined || selectionValue !== undefined;
  const missing = [];
  const notes = [];
  if (frameworkPropsMissing) missing.push('the framework props are missing (no useProjection was passed)');
  if (props.sessionId === undefined) notes.push('the session identity prop is missing (projections still resolve)');
  if (metrics === undefined) missing.push('the sessionMetrics projection is absent');
  else if (settings === null) missing.push('the projection carries no settings');
  else if (ledger === null) missing.push('the projection carries no ledger');
  if (current === null) missing.push('no provider or model recorded yet');
  const reasons = missing.concat(notes);

  const priced = useMemo(function () {
    if (!settings || !ledger) return null;
    return priceSession(settings, ledger, current, now);
  }, [settings, ledger, current && current.provider, current && current.model]);

  const card = settings && current ? findCard(settings.providers, current.provider, current.model) : { provider: null, model: null };
  const billing = card.provider ? card.provider.billing : null;
  const tier = billing ? tierAt(now, billing) : null;
  // The countdown is only visible inside the open detail, so the search does not run
  // at all while the strip is collapsed — and while open it is recomputed at most once
  // a minute, since within a minute the answer cannot change.
  const minute = Math.floor(now / 60000);
  const boundary = useMemo(
    function () { return open && billing !== null ? nextBoundary(minute * 60000, billing) : null; },
    [open, billing, minute]);
  const viewerZone = (function () {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
  })();

  const budgetLimit = (settings && settings.budget.sessionUsd) || null;
  const warnAt = settings && settings.budget ? settings.budget.warnAt : 0.75;
  const spentNano = priced ? priced.totalNano : null;
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
                h('div', { className: 'dsm-note' }, 'sessionMetrics: ' + sourceState(metrics) +
                  ' \u00b7 tokenUsage: ' + sourceState(usageValue) +
                  ' \u00b7 modelSelection: ' + sourceState(selectionValue)),
                h('div', { className: 'dsm-foot' }, h('span', null, 'build ' + BUILD),
                  h('span', null, 'a projection absent from the snapshot usually means its owner row is not running in the Host'))))
          : null));
  }

  const showCny = settings.display.cnyInDetailsFor.indexOf(current.provider) >= 0 || settings.display.currency === 'CNY';
  const costNano = priced ? priced.totalNano : null;
  const savedNano = priced ? priced.savedNano : null;

  // ---------------------------------------------------------------- strip chips
  const chips = [];
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
  if (labels.indexOf('provider') >= 0 && current.provider !== settings.display.primaryProvider) {
    chips.push(h('span', {
      key: 'provider', className: 'dsm-model',
      title: 'Provider this session is using (from modelSelection).',
    }, current.provider));
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
  }, chips.reduce(function (list: any[], chip: any, index: number) {
    // A dot between every pair: the chips read as separate facts on one line rather than
    // one run-on label.
    if (index > 0) list.push(h('span', { key: 'sep' + index, className: 'dsm-sep' }, '\u00b7'));
    list.push(chip);
    return list;
  }, []));

  // ------------------------------------------------------------------- detail
  let panel = null;
  if (open) {
    const top = anchor ? Math.max(12, anchor.top - 12) : 140;
    const left = anchor ? Math.min(Math.max(12, anchor.left), Math.max(12, window.innerWidth - 580)) : 24;
    const sections = [];

    const groups = priced ? priced.groups : [];
    const sumNano = function (pick) {
      return groups.reduce(function (total, group) { return total + (group.price ? pick(group.price) : 0); }, 0);
    };
    const sumTokens = function (pick) {
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
                + (showCny ? ' \u00b7 \u00a5' + ((spentNano / NANO) * settings.display.usdToCny).toFixed(2) : '')))
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
      const cacheShare = priced.totalNano > 0 ? cachedNano / priced.totalNano : null;
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
            const byKey = new Map<string, any>();
            groups.forEach(function (group: any) {
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
            return Array.from(byKey.values()).sort(function (a: any, b: any) { return b.nano - a.nano; });
          })();
          const shown = modelRows.slice(0, 8);
          sections.push(h('div', { key: 'models' },
            h('div', { className: 'dsm-section' }, 'Model provider'),
            h('table', { className: 'dsm-table' },
              h('thead', null, h('tr', null,
                h('th', null, 'provider'), h('th', null, 'model'), h('th', null, 'peak hours'))),
              h('tbody', null, shown.map(function (row: any, index: number) {
                const rowCard = findCard(settings.providers, row.provider, row.model);
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
                  h('td', null, modelName),
                  h('td', null, state));
              }))),
            modelRows.length > shown.length
              ? h('div', { className: 'dsm-note' }, 'plus ' + (modelRows.length - shown.length) + ' more provider/model combinations')
              : null,
            priced && !priced.priced
              ? h('div', { className: 'dsm-note dsm-warn' }, 'At least one of these has no rate card, so its cost is not counted.')
              : null));
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
              + (settings.problems.length > 0 ? ' \u00b7 config problems: ' + settings.problems.join('; ') : ''),
          }, 'Session Metrics'),
          h('span', { className: 'dsm-tag dsm-model', title: current.provider + ' \u00b7 ' + current.model },
            current.provider + ' \u00b7 ' + current.model)),
        sections));
  }

  return h('div', {
    className: 'dsm-slot',
    'data-safe': props.sessionId === undefined ? 'false' : 'true',
    ref: rootRef,
  }, h('div', { className: 'dsm-root' }, trigger, panel));
}


// ------------------------------------------------- pricing page (Plugins)
/** The Loader's entry id for this plugin's row — what the Host's Config inspector takes. */
const CONFIG_ENTRY = 'include:session-metrics';

/**
 * The settings *namespace* the row serves — the id the bundle's patch declares.
 *
 * `configForms` is keyed by **namespace**, not by the Loader entry id: asking it for
 * `include:session-metrics` returns a controller whose value layer is unavailable, which is
 * indistinguishable from "nothing is configured". The plugin-manager's own row page gates on
 * `view.ns === openRow.rowId`, and the row is `session-metrics`.
 */
const SETTINGS_NS = 'session-metrics';

/** The `plugins.row.config` key: `<bundle>#<rowId>`, as the ledger expects. */
const ROW_CONFIG_KEY = 'dsh-session-metrics#session-metrics';

/** Parse "1-4,6-10" into peak windows. */
function parseWindows(text) {
  const windows = [];
  for (const part of String(text || '').split(',')) {
    const match = part.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (match === null) continue;
    windows.push([Number(match[1]), Number(match[2])]);
  }
  return windows;
}

/** Render peak windows for editing. */
function formatWindows(windows) {
  return (windows || []).map(function (w) { return w[0] + '-' + w[1]; }).join(',');
}

/** Integer nanodollars per 1M as the USD string the schema accepts. */
function usdFromNano(nano) {
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
function usdValue(value) {
  if (typeof value === 'number') return usdFromNano(value);
  if (typeof value === 'string') return value;
  return '0';
}

/** A complete rate row, so no field is ever missing from the editor. */
function usdRow(row) {
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
function normalizeProviders(providers) {
  if (!Array.isArray(providers)) return [];
  return providers.map(function (provider) {
    const source = provider || {};
    const models = Array.isArray(source.models) ? source.models : [];
    const normalized: Record<string, any> = {
      id: typeof source.id === 'string' ? source.id : '',
      models: models.map(function (model) {
        const entry = model || {};
        const rates = entry.rates || {};
        const out: Record<string, any> = {};
        for (const key of ['flat', 'peak', 'offPeak']) {
          if (rates[key] !== undefined && rates[key] !== null) out[key] = usdRow(rates[key]);
        }
        if (out.flat === undefined && out.peak === undefined) out.flat = usdRow(null);
        out.multiplier = typeof rates.multiplier === 'number' ? rates.multiplier : 0.5;
        const result: Record<string, any> = {
          model: typeof entry.model === 'string' ? entry.model : '',
          aliases: Array.isArray(entry.aliases) ? entry.aliases.slice() : [],
          rates: out,
        };
        if (typeof entry.label === 'string') result.label = entry.label;
        if (typeof entry.contextWindow === 'number') result.contextWindow = entry.contextWindow;
        return result;
      }),
    };
    if (typeof source.label === 'string') normalized.label = source.label;
    const billing = source.billing || {};
    normalized.billing = {
      timezone: typeof billing.timezone === 'string' ? billing.timezone : 'UTC',
      weekdays: Array.isArray(billing.weekdays) ? billing.weekdays.slice() : [1, 2, 3, 4, 5],
      windows: Array.isArray(billing.windows) ? billing.windows.map(function (w) { return [w[0], w[1]]; }) : [],
      holidays: Array.isArray(billing.holidays) ? billing.holidays.slice() : [],
      holidayZone: typeof billing.holidayZone === 'string' ? billing.holidayZone : 'Asia/Shanghai',
    };
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
function toYaml(providers) {
  const lines = ['config:', '  providers:'];
  (providers || []).forEach(function (provider) {
    lines.push('    - id: ' + provider.id);
    lines.push('      billing: { timezone: ' + provider.billing.timezone + ', windows: [' +
      provider.billing.windows.map(function (w) { return '[' + w[0] + ',' + w[1] + ']'; }).join(', ') + '] }');
    lines.push('      models:');
    (provider.models || []).forEach(function (model) {
      const flat = model.rates.flat !== undefined;
      const rates = flat ? model.rates.flat : model.rates.peak;
      if (rates === null || rates === undefined) return;
      lines.push('        - model: ' + model.model);
      lines.push('          rates: { ' + (flat ? 'flat' : 'peak') + ': { cacheHit: ' + rates.cacheHit +
        ', cacheMiss: ' + rates.cacheMiss + ', output: ' + rates.output + ' } }');
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
function readSnapshot(form) {
  if (form === null || form === undefined) return null;
  if (form.state !== undefined && form.state !== null) return form.state;
  if (typeof form.getSnapshot === 'function') return form.getSnapshot();
  return null;
}

/** One editable rate row. */
function RateFields(props) {
  // `props.row` was undefined for a flat model read as a peak one, and indexing it
  // threw `Cannot read properties of undefined (reading 'cacheHit')` live.
  const row = props.row || {};
  const fields = [['cacheHit', 'cache hit'], ['cacheMiss', 'cache miss'], ['cacheWrite', 'cache write'], ['output', 'output']];
  return h('div', { className: 'dsm-rates' }, fields.map(function (pair) {
    return h('label', { key: pair[0], className: 'dsm-rate' },
      h('span', null, pair[1]),
      h('input', {
        type: 'text', inputMode: 'decimal', className: 'dsm-input',
        value: row[pair[0]] === undefined ? '' : String(row[pair[0]]),
        onChange: function (event) { props.onChange(pair[0], event.target.value); },
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
function PricingPage(props) {
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
  const service = props.getService ? props.getService('configForms') : props.configForms;
  const form = supplied !== null
    ? supplied
    : (service && typeof service.get === 'function' ? service.get(SETTINGS_NS) : null);
  const snapState = useState(null);
  const snapshot = snapState[0];
  const setSnapshot = snapState[1];
  const draftState = useState(null);
  const draft = draftState[0];
  const setDraft = draftState[1];
  const noticeState = useState(null);
  const notice = noticeState[0];
  // What the last successful write contained. The owner-supplied form has no
  // subscription, so the snapshot on this render can predate the write; without this
  // the page appeared to roll back even though the Host had persisted the change.
  const savedState = useState(null);
  const savedProviders = savedState[0];
  const setSavedProviders = savedState[1];
  const setNotice = noticeState[1];

  useEffect(function () {
    if (form === null) {
      setSnapshot(null);
      return undefined;
    }
    setSnapshot(readSnapshot(form) ?? null);
    // The owner-supplied shape carries no subscription: the page re-renders from its
    // own store when the served namespace changes.
    if (typeof form.subscribe !== 'function') return undefined;
    return form.subscribe(function () { setSnapshot(readSnapshot(form)); });
  }, [form]);

  // `value` is the accepted configuration; `base` is what an override would inherit
  // (the shipped cards plus the profile patch). Falling back to `base` keeps the
  // editor usable when a Host has not published an accepted value yet, instead of
  // showing a read-only page for no reason.
  const accepted = snapshot !== null && snapshot !== undefined && snapshot.value !== undefined && snapshot.value !== null ? snapshot.value : null;
  const inherited = snapshot !== null && snapshot !== undefined && snapshot.base !== undefined && snapshot.base !== null ? snapshot.base : null;
  const raw = accepted !== null ? accepted : inherited;
  const showingInherited = accepted === null && inherited !== null;
  // A config layer can arrive partial: the Host exposes only the fields it serves, so
  // `display`, `budget` and `providers` may each be missing. Normalize once here and
  // the rest of the page can assume the shape.
  const resolved = raw === null || raw === undefined ? null : {
    display: Object.assign({
      currency: 'USD',
      cnyInDetailsFor: [],
      usdToCny: 7.1,
      labels: ['peak', 'time', 'cost', 'saved', 'provider'],
      details: ['cost', 'savings', 'models', 'window'],
      primaryProvider: null,
    }, raw.display || {}),
    budget: Object.assign({ sessionUsd: null, warnAt: 0.75 }, raw.budget || {}),
    providers: Array.isArray(raw.providers) ? raw.providers : [],
    pricingAsOf: raw.pricingAsOf === undefined ? null : raw.pricingAsOf,
  };
  const base = snapshot && snapshot.base ? snapshot.base : null;
  const revision = snapshot ? snapshot.revision : null;
  const clean = draft === null || draft.revision !== revision;

  // The Host resolves rates to nanodollars for computing; the editor must show
  // USD. Converting only while dirty would leave the first paint showing
  // "6000000" as if it were dollars, so the clean view converts too. This is a
  // hook, so it sits before any early return.
  // The Host confirmed a revision: its values supersede what we remembered writing.
  useEffect(function () {
    setSavedProviders(null);
  }, [revision]);

  const displayProviders = useMemo(function () {
    if (resolved === null) return [];
    if (!clean) return draft.providers;
    if (savedProviders !== null) return savedProviders;
    return normalizeProviders(resolved.providers);
  }, [resolved, clean, draft, savedProviders]);

  if (resolved === null) {
    // Read-only is a legitimate state, not an error. Two distinct cases:
    //   - the inline plugin-page copy never gets a form (the owner resolves one for a
    //     ROW page), so it points at the row instead of showing an empty block;
    //   - a row page can be read-only before the Host serves the namespace, where the
    //     rates still come from cordis.patch.yml.
    const yamlProviders = resolved !== null && Array.isArray(resolved.providers) ? resolved.providers : [];
    const diagnostics = (function () {
      const service = props.getService ? props.getService('configForms') : undefined;
      let served = 'unavailable';
      if (service !== undefined && service !== null && typeof service.describe === 'function') {
        try {
          const mirror = service.describe();
          const snap = mirror && typeof mirror.getSnapshot === 'function' ? mirror.getSnapshot() : mirror;
          const view = snap && snap.view ? snap.view : snap;
          const namespaces = view && Array.isArray(view.namespaces) ? view.namespaces.map(function (e) { return e && e.ns ? e.ns : String(e); }) : null;
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

  /** Start a draft from the values currently on screen. */
  const begin = function () {
    if (!clean) return;
    setDraft({ revision: revision, providers: normalizeProviders(resolved.providers) });
  };

  /** Apply one edit to the draft, cloning so React sees a new value. */
  const update = function (mutate) {
    const next = JSON.parse(JSON.stringify(clean ? normalizeProviders(resolved.providers) : draft.providers));
    mutate(next);
    setDraft({ revision: draft !== null && draft.revision === revision ? draft.revision : revision, providers: next });
  };

  /** Write the draft, fenced by the revision read when editing began. */
  const save = function () {
    // Guard on the method actually called: a form exposing `mutate` but not `set` would
    // otherwise swallow the click and save nothing.
    if (form === null || typeof form.mutate !== 'function') return;
    const providersToWrite = clean ? normalizeProviders(resolved.providers) : draft.providers;
    const ops = [{ op: 'set', path: ['providers'], value: providersToWrite }];
    Promise.resolve(form.mutate(ops, revision)).then(function (accepted) {
      if (accepted === false) {
        setNotice('The Host refused the change, so nothing was saved. Your edits are still here \u2014 copy the block below if you prefer to set them in cordis.patch.yml.');
      } else {
        // Keep showing what we wrote: the owner-supplied form has no subscription, so
        // the snapshot on the next render can predate this write.
        setSavedProviders(providersToWrite);
        setDraft(null);
        setNotice('Saved. These rates are in use from the next step on.');
      }
    }).catch(function (error) {
      setNotice('Saving failed: ' + (error && error.message ? error.message : String(error)) + '. Your edits are kept.');
    });
  };

  const providers = displayProviders;

  if (view === 'summary') {
    const modelCount = providers.reduce(function (total, provider) { return total + (provider.models || []).length; }, 0);
    const parts = [providers.length + ' providers', modelCount + ' models'];
    if (resolved.budget && resolved.budget.sessionUsd) parts.push('budget $' + resolved.budget.sessionUsd.toFixed(2));
    if (snapshot !== null && snapshot.writability === 'read-only') parts.push('read-only');
    return h('span', { className: 'dsm-summary' }, parts.join(' \u00b7 '));
  }

  const providerCards = providers.map(function (provider, providerIndex) {
    const baseProvider = base && base.providers ? base.providers.filter(function (p) { return p.id === provider.id; })[0] : null;
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
            update(function (next) { next[providerIndex] = normalizeProviders([baseProvider])[0]; });
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
        const swap = function (mode) {
          begin();
          update(function (next) {
            const target = next[providerIndex].models[modelIndex];
            const source = mode === 'flat' ? target.rates.peak : target.rates.flat;
            const zero = { cacheHit: '0', cacheMiss: '0', cacheWrite: '0', output: '0' };
            if (mode === 'flat') { target.rates.flat = source || zero; delete target.rates.peak; delete target.rates.offPeak; }
            else { target.rates.peak = source || zero; delete target.rates.flat; }
          });
        };
        const writeRow = function (mode, field, value) {
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
            onChange: function (field, value) { writeRow(isFlat ? 'flat' : 'peak', field, value); },
          }),
          !isFlat
            ? (model.rates.offPeak !== undefined
                ? h('div', null,
                    h('div', { className: 'dsm-usdLabel' }, 'USD per 1M tokens (off-peak)'),
                    h(RateFields, {
                      row: model.rates.offPeak,
                      onChange: function (field, value) { writeRow('offPeak', field, value); },
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
      h('b', null, 'unpriced'), ' rather than guessed.'),
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
function registerBadge(slots: any, serviceGet: (name: string) => any) {
  return slots.inject('plugins.detail.badge', function () {
    return slots.register({
      name: 'plugins.detail.badge',
      id: PLUGIN_ID,
      order: 20,
      label: 'Session metrics: providers, models and the current peak state',
    }, function (props: any) {
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
function apply(ctx) {
  // Read opportunistically rather than as a declared dependency: a deployment
  // without the settings service still gets the strip, and the pricing page
  // degrades to its read-only form.
  const getService = function (name) {
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
    }, function (props) {
      return h(MetricsBoundary, null, h(PricingPage, Object.assign({}, props, { getService: getService, surface: 'bundle' })));
    });
  });

  ctx.slots.inject('plugins.row.config', function () {
    return ctx.slots.register({
      name: 'plugins.row.config',
      key: ROW_CONFIG_KEY,
      id: PLUGIN_ID,
      order: 12,
    }, function (props) {
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
  const canInject = (function () {
    // Read through try/catch: on a restricted client context an undeclared property
    // read THROWS (`cannot get property "…" without inject`), and the DOM harness
    // reproduces that. A throw here means "no optional injection on this context",
    // not a broken badge.
    try {
      return typeof ctx.inject === 'function';
    } catch (error) {
      return false;
    }
  })();

  if (canInject) {
    ctx.inject(['configForms'], function (child) {
      // Prefer the injected declaration; keep `ctx.get('configForms')` as the
      // secondary source, because a service can be replaced while the badge is
      // mounted and both reads are honest when guarded.
      registerBadge(child.slots, function (name) {
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
  const serviceOf = function (name) {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
    } catch (error) {
      return undefined;
    }
  };

  const refreshBaseline = function (sessionId) {
    if (sessionId === undefined) return;
    const sessions = serviceOf('sessions');
    if (sessions === undefined || typeof sessions.refreshProjections !== 'function') return;
    Promise.resolve(sessions.refreshProjections(sessionId)).catch(function () {
      /* the normal session frame still carries the baseline */
    });
  };

  ctx.slots.inject('conversation.input.dock', function () {
    return ctx.slots.register({
      name: 'conversation.input.dock',
      id: PLUGIN_ID,
      order: 17,
    }, function (props) {
      return h(MetricsBoundary, null, h(SessionMetricsPanel, Object.assign({}, props, { refreshProjections: refreshBaseline })));
    });
  });
}

module.exports = { inject: inject, apply: apply, name: PLUGIN_ID };
