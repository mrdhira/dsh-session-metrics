/**
 * The per-step ledger: the one thing this plugin folds from session events.
 *
 * Session *totals* deliberately do not come from here — they come from the
 * `tokenUsage` projection, which is the authoritative fold for token counts. A
 * session's cost, however, needs granularity that projection does not offer: it
 * exposes only totals and the last step, while a rate can change mid-session and
 * a session can switch models. So this fold records one row per step, each
 * carrying the model that served it and its billing tier, and accumulates the
 * same buckets under a `provider · model · tier` key.
 *
 * Consequences of that split, both intentional:
 *   - money is never stored — rows carry buckets and tier, and the client prices
 *     them, so editing a rate changes the displayed cost with no re-fold;
 *   - a session that switches models is priced per row rather than pretending one
 *     rate applied throughout;
 *   - `rows` is bounded for the wire, while `totals` is not, so a long session
 *     never loses money to a display limit.
 *
 * It also keeps a second, smaller list: `discovered`, the provider/model pairs
 * this session actually used that have **no rate card**. A pair with no card is
 * priced as `unpriced`, and without this list that fact is invisible on every
 * screen that shows only configuration — the Pricing page cannot see sessions,
 * and a session-scoped detail view cannot see other sessions. Recording it here
 * is what lets the client say "this is what was seen, and it is unpriced"
 * instead of silently omitting it; it is deduped by pair, bounded, and obeys the
 * same replace-not-add accounting as `totals` (a retry that moves to another pair
 * must leave nothing behind for the pair it left).
 *
 * State is plain JSON: no BigInt, no Date, no functions. A projection unit's
 * state is checkpointed, and the checkpoint row schema refuses anything
 * `JSON.stringify` cannot carry.
 */

import { bucketTotal } from './pricing.js';

/** Sent as the billing tier for a run whose provider has no calendar. */
const UNKNOWN_TIER = 'flat';

/** Per-step rows kept for the ledger view. */
const ROW_LIMIT = 200;

/** Distinct unpriced provider/model pairs kept. */
const DISCOVERY_LIMIT = 32;

/**
 * Key one accumulated bucket group.
 * @param provider - provider id, or null.
 * @param model - model id, or null.
 * @param tier - billing tier.
 * @returns a stable key string.
 */
export function groupKey(provider: any, model: any, tier: any) {
  return `${provider ?? ''}\u0000${model ?? ''}\u0000${tier}`;
}

/**
 * An empty bucket set.
 * @returns zeroed buckets.
 */
function zeroBuckets() {
  return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
}

/**
 * Read a provider usage report into billing buckets.
 * @param usage - the raw `assistant/message` usage record.
 * @returns normalized buckets, or null when the provider reported nothing usable.
 */
export function bucketsFrom(usage: any) {
  if (usage === null || typeof usage !== 'object') return null;
  const pick = (value: any) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
  const buckets = {
    uncachedInputTokens: pick(usage.inputTokens),
    cacheReadTokens: pick(usage.cacheReadTokens),
    cacheWriteTokens: pick(usage.cacheWriteTokens),
    outputTokens: pick(usage.outputTokens),
  };
  if (bucketTotal(buckets) === 0) return null;
  return buckets;
}

/**
 * Fresh ledger state.
 * @returns empty state.
 */
export function initLedgerState() {
  return { turns: 0, steps: 0, totals: {}, rows: [], openIndex: null, lastProvider: null, lastModel: null, discovered: {} };
}

/**
 * Key one observed-but-unpriced pair.
 * @param provider - provider id, or null.
 * @param model - model id, or null.
 * @returns a stable key string.
 */
function pairKey(provider: any, model: any) {
  return `${provider ?? ''}\u0000${model ?? ''}`;
}

/**
 * Add one report to a discovered pair, or retract a replaced one, deduped by pair.
 *
 * Tokens are summed as evidence of how much went unpriced; no money is derived
 * here, because a pair with no card has no rate to apply. `sign` is `+1` when a
 * report is banked and `-1` when the report it replaced is taken back, so the
 * list mirrors the same replace-not-add accounting as `totals`: an in-step retry
 * that switches pairs leaves no discovery row for the pair it abandoned. The list
 * is bounded — a session that cycles through more unpriced pairs than the limit
 * keeps the first ones seen, so the earliest evidence is what survives — while an
 * entry already on the list keeps updating past the bound.
 * @param discovered - the discovery map (not mutated).
 * @param provider - provider id from the request header.
 * @param model - model id from the request header.
 * @param at - the instant of the report; ignored when retracting.
 * @param buckets - the buckets that were attributed to the pair.
 * @param sign - `+1` to bank one report, `-1` to retract one.
 * @returns the new discovery map.
 */
function foldDiscovered(discovered: any, provider: any, model: any, at: any, buckets: any, sign: number) {
  const key = pairKey(provider, model);
  const current = discovered[key];
  if (current === undefined) {
    // Retracting a pair that was never recorded (it had a card) is a no-op; a new
    // pair past the bound is dropped rather than displacing the earliest evidence.
    if (sign < 0 || Object.keys(discovered).length >= DISCOVERY_LIMIT) return discovered;
  }
  const entry = current ?? { provider: provider ?? null, model: model ?? null, tokens: 0, reports: 0, firstSeen: at ?? null, lastSeen: at ?? null };
  const reports = entry.reports + sign;
  const next = { ...discovered };
  if (reports <= 0) {
    // The last report for the pair was retracted, so the pair does not exist — the
    // same rule that drops an emptied group from `totals`.
    delete next[key];
    return next;
  }
  next[key] = {
    provider: entry.provider,
    model: entry.model,
    tokens: entry.tokens + sign * bucketTotal(buckets),
    reports,
    firstSeen: entry.firstSeen,
    lastSeen: sign > 0 ? (at ?? null) : entry.lastSeen,
  };
  return next;
}

/**
 * Add one bucket set into the accumulated groups.
 * @param totals - the totals map (not mutated).
 * @param key - group key.
 * @param buckets - the bucket set to add.
 * @returns the new totals map.
 */
function addToTotals(totals: any, key: any, buckets: any) {
  const current = totals[key] ?? zeroBuckets();
  return {
    ...totals,
    [key]: {
      uncachedInputTokens: current.uncachedInputTokens + buckets.uncachedInputTokens,
      cacheReadTokens: current.cacheReadTokens + buckets.cacheReadTokens,
      cacheWriteTokens: current.cacheWriteTokens + buckets.cacheWriteTokens,
      outputTokens: current.outputTokens + buckets.outputTokens,
    },
  };
}

/**
 * Remove one bucket set from an accumulated group, dropping the group when it
 * empties. Used when a step reports usage twice: the later report replaces the
 * earlier one instead of adding to it, which is how the official `tokenUsage`
 * fold behaves.
 * @param totals - the totals map (not mutated).
 * @param key - group key.
 * @param buckets - the bucket set to remove.
 * @returns the new totals map.
 */
function subtractFromTotals(totals: any, key: any, buckets: any) {
  const current = totals[key];
  if (current === undefined) return totals;
  const next = {
    uncachedInputTokens: current.uncachedInputTokens - buckets.uncachedInputTokens,
    cacheReadTokens: current.cacheReadTokens - buckets.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens - buckets.cacheWriteTokens,
    outputTokens: current.outputTokens - buckets.outputTokens,
  };
  const copy = { ...totals };
  if (bucketTotal(next) === 0 && next.cacheReadTokens === 0 && next.uncachedInputTokens === 0) delete copy[key];
  else copy[key] = next;
  return copy;
}

/**
 * Build the fold.
 * @param options - `tierFor(providerId, dateMs)` resolves the billing tier; it is
 *   the only settings-dependent input, so a calendar edit changes state only
 *   through a re-fold (which a plugin reload performs, since disposing the
 *   registration drops its cells). `hasCard(providerId, modelId)` answers
 *   whether the resolved settings carry a rate card for the pair; when it is
 *   absent the fold assumes every pair is configured, so the ledger stays pure
 *   and existing callers keep their behaviour.
 * @returns the projection `apply` function.
 */
export function createLedgerApply(options: any) {
  const tierFor = options.tierFor ?? (() => UNKNOWN_TIER);
  const hasCard = options.hasCard ?? (() => true);

  const patchRow = (state: any, patch: any) => {
    if (state.openIndex === null) return state;
    const current = state.rows[state.openIndex];
    if (current === undefined) return state;
    const rows = state.rows.slice();
    rows[state.openIndex] = { ...current, ...patch };
    return { ...state, rows };
  };

  const closeRow = (state: any, patch: any) => {
    if (state.openIndex === null) return state;
    const current = state.rows[state.openIndex];
    if (current === undefined) return state;
    const rows = state.rows.slice();
    rows[state.openIndex] = { ...current, ...patch };
    // Closing accumulates nothing: usage is banked the moment it is reported, so
    // a step whose `step/end` never arrives (an interrupted run) still counts.
    return { ...state, rows, openIndex: null };
  };

  /** Append a row, trimming the oldest once the wire bound is reached. */
  const appendRow = (rows: any, row: any) => {
    const kept = rows.length >= ROW_LIMIT ? rows.slice(rows.length - ROW_LIMIT + 1) : rows.slice();
    kept.push(row);
    return kept;
  };

  return function apply(state: any, event: any) {
    const type = event?.type;

    if (type === 'request/header') {
      const config = event.data?.header?.config ?? {};
      const provider = typeof config.provider === 'string' ? config.provider : null;
      const model = typeof config.model === 'string' ? config.model : null;
      if (state.lastProvider === provider && state.lastModel === model) return state;
      return { ...state, lastProvider: provider, lastModel: model };
    }

    if (type === 'turn/start') return { ...state, turns: state.turns + 1 };

    if (type === 'step/start') {
      const startTime = typeof event.time === 'number' ? event.time : Date.now();
      const row = {
        turn: event.data?.turn ?? null,
        step: event.data?.step ?? null,
        startTime,
        endTime: null,
        provider: state.lastProvider,
        model: state.lastModel,
        tier: state.lastProvider === null ? UNKNOWN_TIER : tierFor(state.lastProvider, startTime),
        buckets: null,
        groupKey: null,
      };
      const rows = appendRow(state.rows, row);
      return { ...state, rows, openIndex: rows.length - 1, steps: state.steps + 1 };
    }

    if (type === 'assistant/message') {
      const at = typeof event.time === 'number' ? event.time : null;
      const buckets = bucketsFrom(event.data?.usage);
      if (buckets === null) return patchRow(state, { endTime: at });

      // Attribution happens here, not at `step/start`: a run may report usage
      // before its own request header has been seen, and the provider known at
      // the end of the step is the one that actually served it.
      const provider = state.lastProvider;
      const model = state.lastModel;
      const row = state.openIndex === null ? null : state.rows[state.openIndex];
      const tierAtReport = provider === null ? UNKNOWN_TIER : tierFor(provider, at ?? row?.startTime ?? Date.now());
      const key = groupKey(provider, model, tierAtReport);

      let totals = state.totals;
      // The `?? {}` keeps a pre-`discovered` checkpoint foldable: the field simply
      // was not there, and a missing field is an empty list, never a crash.
      let discovered = state.discovered ?? {};
      let rows = state.rows;
      let openIndex = state.openIndex;
      if (row === null || row === undefined) {
        // Usage with no open step: bank it under a synthetic row instead of
        // dropping tokens the session really spent.
        const synthetic = {
          turn: event.data?.turn ?? null,
          step: event.data?.step ?? null,
          startTime: at ?? Date.now(),
          endTime: at,
          provider,
          model,
          tier: tierAtReport,
          buckets,
          groupKey: key,
        };
        rows = appendRow(rows, synthetic);
        openIndex = rows.length - 1;
      } else {
        if (row.groupKey !== null && row.buckets !== null) {
          totals = subtractFromTotals(totals, row.groupKey, row.buckets);
          // `discovered` mirrors `totals`: the report being replaced is retracted
          // before the new one is banked, or an in-step retry would leave a pair
          // listed with tokens no group carries.
          if (!hasCard(row.provider, row.model)) {
            discovered = foldDiscovered(discovered, row.provider, row.model, null, row.buckets, -1);
          }
        }
        rows = rows.slice();
        rows[openIndex] = { ...row, endTime: at, provider, model, tier: tierAtReport, buckets, groupKey: key };
      }
      totals = addToTotals(totals, key, buckets);
      // Discovery is recorded where usage is attributed, not at `step/start`: a
      // header alone is a request that may never have been billed, while a
      // reported bucket set is money that was really spent (and, with no card,
      // really cannot be priced).
      if (!hasCard(provider, model)) discovered = foldDiscovered(discovered, provider, model, at, buckets, 1);
      return { ...state, rows, totals, openIndex, discovered };
    }

    if (type === 'step/end' || type === 'turn/end') {
      const endTime = typeof event.time === 'number' ? event.time : null;
      return closeRow(state, { endTime });
    }

    return state;
  };
}

/** Memoized views, so a re-render does not rebuild the row objects. */
const views = new WeakMap();

/**
 * The observed-but-unpriced pairs, as an array ordered by tokens spent.
 *
 * Ordered rather than insertion-ordered so the biggest unpriced spend is the one
 * a reader sees first; ties break on the pair so the order is deterministic. A
 * state checkpointed before this field existed has none, so it is optional here.
 * @param state - the ledger state.
 * @returns the discovery rows.
 */
function discoveredView(state: any) {
  const entries = Object.values(state.discovered ?? {}) as any[];
  return entries
    .map((entry) => ({
      provider: entry.provider ?? null,
      model: entry.model ?? null,
      tokens: entry.tokens,
      reports: entry.reports,
      firstSeen: entry.firstSeen ?? null,
      lastSeen: entry.lastSeen ?? null,
    }))
    .sort((a, b) => b.tokens - a.tokens || pairKey(a.provider, a.model).localeCompare(pairKey(b.provider, b.model)));
}

/**
 * Project the ledger into the client-visible value.
 *
 * `groupKey` is deliberately dropped: it is state bookkeeping for add-replacing,
 * not a client concern, and the wire schema is strict so leaking it would throw.
 * @param state - the ledger state.
 * @returns the wire value; bucket maps and totals are reused by reference.
 */
export function toLedgerView(state: any) {
  const cached = views.get(state);
  if (cached !== undefined) return cached;
  const view = {
    turns: state.turns,
    steps: state.steps,
    totals: state.totals,
    rows: state.rows.map((row: any) => ({
      turn: row.turn,
      step: row.step,
      startTime: row.startTime,
      endTime: row.endTime,
      provider: row.provider,
      model: row.model,
      tier: row.tier,
      buckets: row.buckets,
    })),
    discovered: discoveredView(state),
  };
  views.set(state, view);
  return view;
}
