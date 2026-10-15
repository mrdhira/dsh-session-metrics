/**
 * Checkpoints, and the projection unit's `stateVersion`.
 *
 * `@deepseek-ai/dsh-session-projection` keys cache reuse on the unit's declared
 * `stateVersion`, as its own shipped text states: a stored row is usable iff its
 * `ver` matches the live unit's version, and then its state is seeded and only the
 * tail (`seq` above the row) is replayed; an unusable row is discarded and its key
 * refolds from `init` over the whole log. That makes `stateVersion` part of the
 * contract, not a decoration. When `discovered` joined the ledger state every
 * stored row on this machine was `ver: 1` with no `discovered` field, so leaving
 * the version at 1 would have kept the whole session prefix — the very spend the
 * list exists to name — invisible for every pre-change session.
 *
 * The restore below models exactly that rule, so these cases fail if the declared
 * version stops matching the shape the fold writes, in either direction: too low
 * and a ver-1 row is trusted and refolded only over its tail; too high and a row
 * this same code wrote is itself discarded.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { apply as registerHost } from '../lib/v1/index.js';
import { toLedgerView } from '../lib/v1/ledger.js';

/** One session event, with the `seq` its log assigns it. */
interface SeqEvent {
  seq: number;
  type: string;
  time?: number;
  data?: Record<string, any>;
}

/** A stored projection row, as the framework checkpoints it. */
interface CheckpointRow {
  ver: number;
  seq: number;
  val: any;
}

/** The registered projection unit, limited to what these cases touch. */
interface Unit {
  key: string;
  stateVersion: number;
  init(): any;
  apply(state: any, event: any): any;
}

/** The host's own registration, captured from a stub context. */
function projectionUnit(): Unit {
  let unit: any = null;
  const ctx = {
    sessionProjections: {
      register(spec: any) {
        unit = spec;
        return () => {};
      },
    },
    // The embedded skill is optional; a composition without a registry skips it.
    inject: () => () => {},
  };
  registerHost(ctx, {});
  assert.ok(unit !== null, 'the host registers one projection');
  return unit as Unit;
}

/**
 * Restore one key the way the framework does.
 *
 * Quoted from the projection package's own contract: a matching `ver` seeds from
 * the row and replays only the tail; a mismatched row pulls the floor to 0 and
 * refolds from `init`.
 * @param unit - the registered projection unit.
 * @param row - the stored row, or null when there is none.
 * @param events - the log (all of it; the floor decides what is replayed).
 * @returns the restored state.
 */
function restore(unit: Unit, row: CheckpointRow | null, events: SeqEvent[]): any {
  const usable = row !== null && row.ver === unit.stateVersion;
  let state = usable ? (row as CheckpointRow).val : unit.init();
  const floor = usable ? (row as CheckpointRow).seq + 1 : 0;
  for (const event of events) if (event.seq >= floor) state = unit.apply(state, event);
  return state;
}

/** Fold the log through `seq`, and wrap the state as that sequence's stored row. */
function checkpoint(unit: Unit, events: SeqEvent[], seq: number): CheckpointRow {
  let state = unit.init();
  for (const event of events) if (event.seq <= seq) state = unit.apply(state, event);
  return { ver: unit.stateVersion, seq, val: state };
}

/** The pair fields these cases assert, read from the wire view. */
function discoveredPairs(state: any) {
  return toLedgerView(state).discovered.map((entry: any) => ({
    provider: entry.provider,
    model: entry.model,
    tokens: entry.tokens,
    reports: entry.reports,
  }));
}

const BASE = Date.parse('2026-10-15T01:00:00Z');

/** Two steps on an uncarded pair (`openrouter` `auto`), so both are discovered. */
const LOG: SeqEvent[] = [
  { seq: 0, type: 'request/header', time: BASE, data: { header: { config: { provider: 'openrouter', model: 'auto' } } } },
  { seq: 1, type: 'step/start', time: BASE, data: { turn: 1, step: 1 } },
  { seq: 2, type: 'assistant/message', time: BASE + 100, data: { usage: { inputTokens: 100 } } },
  { seq: 3, type: 'step/end', time: BASE + 100, data: { turn: 1, step: 1 } },
  { seq: 4, type: 'step/start', time: BASE + 500, data: { turn: 1, step: 2 } },
  { seq: 5, type: 'assistant/message', time: BASE + 600, data: { usage: { inputTokens: 50 } } },
  { seq: 6, type: 'step/end', time: BASE + 600, data: { turn: 1, step: 2 } },
];

/** The row boundary: everything at or below this seq lives in the checkpoint. */
const CHECKPOINT_SEQ = 3;

/** What the whole log yields once both reports are banked. */
const FULL_DISCOVERY = [{ provider: 'openrouter', model: 'auto', tokens: 150, reports: 2 }];

test('checkpoint: a ver-1 state without `discovered` is refolded, not trusted', () => {
  const unit = projectionUnit();
  // What every checkpoint written before discovery shipped looks like: `ver: 1`
  // and no `discovered` field at all (the live rows on this machine).
  const legacyState = checkpoint(unit, LOG, CHECKPOINT_SEQ).val;
  delete legacyState.discovered;
  const row: CheckpointRow = { ver: 1, seq: CHECKPOINT_SEQ, val: legacyState };

  assert.notEqual(unit.stateVersion, row.ver, 'the state shape changed, so a ver-1 row must be unusable');
  assert.deepEqual(
    discoveredPairs(restore(unit, row, LOG)),
    FULL_DISCOVERY,
    'an unusable row refolds from init, so the checkpointed prefix contributes its discovery',
  );
});

test('checkpoint: a row whose ver matches the unit is reused, and only the tail is replayed', () => {
  const unit = projectionUnit();
  const row = checkpoint(unit, LOG, CHECKPOINT_SEQ);
  // Only the tail is offered, as a restored key reads it: seeding is the only way
  // the first step's tokens can survive.
  const tail = LOG.filter((event) => event.seq > row.seq);
  assert.deepEqual(
    discoveredPairs(restore(unit, row, tail)),
    FULL_DISCOVERY,
    'a usable row seeds the fold, so the tail alone still yields the whole session',
  );
});

test('checkpoint: the fold still accepts a directly constructed state with no `discovered`', () => {
  const unit = projectionUnit();
  // The tolerant guard, for a state that never passed through a checkpoint: a
  // missing field is an empty list, never a crash.
  let state = unit.init();
  delete state.discovered;
  for (const event of LOG.slice(0, 3)) state = unit.apply(state, event);
  assert.deepEqual(
    discoveredPairs(state),
    [{ provider: 'openrouter', model: 'auto', tokens: 100, reports: 1 }],
    'a state without the field still records discovery from the events it folds',
  );
});
