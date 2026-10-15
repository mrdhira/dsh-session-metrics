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
 * State is plain JSON: no BigInt, no Date, no functions. A projection unit's
 * state is checkpointed, and the checkpoint row schema refuses anything
 * `JSON.stringify` cannot carry.
 */

import { bucketTotal } from './pricing.js';

/** Sent as the billing tier for a run whose provider has no calendar. */
const UNKNOWN_TIER = 'flat';

/** Per-step rows kept for the ledger view. */
const ROW_LIMIT = 200;

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
  return { turns: 0, steps: 0, totals: {}, rows: [], openIndex: null, lastProvider: null, lastModel: null };
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
 *   registration drops its cells).
 * @returns the projection `apply` function.
 */
export function createLedgerApply(options: any) {
  const tierFor = options.tierFor ?? (() => UNKNOWN_TIER);

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
        if (row.groupKey !== null && row.buckets !== null) totals = subtractFromTotals(totals, row.groupKey, row.buckets);
        rows = rows.slice();
        rows[openIndex] = { ...row, endTime: at, provider, model, tier: tierAtReport, buckets, groupKey: key };
      }
      totals = addToTotals(totals, key, buckets);
      return { ...state, rows, totals, openIndex };
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
  };
  views.set(state, view);
  return view;
}
