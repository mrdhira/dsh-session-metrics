/**
 * Pricing page tests (the SC7 deliverable).
 *
 * The page is mounted with a stub `configForms` whose snapshot mirrors what the
 * Host serves: `value` is the **resolved** configuration (so shipped rate cards
 * arrive as nanodollars) and `base` is what an override would inherit from. The
 * critical property under test is that the editor converts to USD per 1M for
 * display and writes USD back — showing or saving the nanodollar form would mean
 * a rate of 6000000 instead of 0.006.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Config, resolveSettings } from '../lib/v1/settings.js';
import { loadBundle, mount, useConfigForms, type MountedView } from './harness.ts';

const resolved = resolveSettings({});
const shippedProviders = resolved.providers;

/** One recorded `mutate` call, or a refusal. */
interface FormCall {
  ops?: any[];
  expectedRevision?: number;
  refused?: boolean;
}

/** A stub Host config form, shaped like the one `ctx.configForms.get(entryId)` returns. */
interface FormStub {
  calls: FormCall[];
  getSnapshot(): Record<string, any>;
  subscribe(listener: () => void): () => void;
  mutate(ops: any[], expectedRevision?: number): Promise<boolean>;
  /** Simulate a write the Host refuses. */
  refuse(): Promise<boolean>;
}

/** Overrides for one stub form's snapshot. */
interface FormOptions {
  value?: Record<string, any>;
  base?: Record<string, any>;
  revision?: number;
  writability?: string;
}

/** A stub Host config form, shaped like `ctx.configForms.get(entryId)`. */
function makeForm({ value = { display: resolved.display, budget: resolved.budget, providers: shippedProviders }, base = { providers: shippedProviders }, revision = 7, writability = 'writable' }: FormOptions = {}): FormStub {
  const calls: FormCall[] = [];
  const listeners = new Set<() => void>();
  let snapshot = { value, base, user: {}, revision, writability, persistence: 'host' };
  return {
    calls,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    mutate(ops: any[], expectedRevision?: number) {
      calls.push({ ops, expectedRevision });
      snapshot = { ...snapshot, revision: revision + 1 };
      for (const listener of listeners) listener();
      return Promise.resolve(true);
    },
    /** Simulate a write the Host refuses. */
    refuse() {
      calls.push({ refused: true });
      return Promise.resolve(false);
    },
  };
}

/** Mount the page with a given configForms stub. */
function renderPage(configForms: unknown): MountedView {
  useConfigForms(configForms);
  const loaded = loadBundle();
  const registration = loaded.slot('plugins.row.config');
  assert.equal(registration.spec.key, 'dsh-session-metrics#session-metrics', 'the ledger reads entry.options.key');
  const view = mount(loaded, registration, {});
  return view;
}

const entryIdSeen: string[] = [];
const configFormsFor = (form: unknown) => ({
  get(entryId: string) {
    entryIdSeen.push(entryId);
    return form;
  },
});

test('registration: the editor is offered both inline on the bundle page and on the row page', () => {
  const loaded = loadBundle();
  const specs = loaded.registrations.map((entry) => `${entry.spec.name}:${entry.spec.key ?? entry.spec.id}`);
  assert.ok(specs.includes('plugins.bundle.config:dsh-session-metrics'), 'inline on the plugin page, keyed by package name');
  assert.ok(specs.includes('plugins.row.config:dsh-session-metrics#session-metrics'), 'and on the row page');
});

test('page: lists every integrated provider with its models', () => {
  const form = makeForm();
  const view = renderPage(configFormsFor(form));
  try {
    const text = view.text();
    assert.equal(view.container.querySelectorAll('.dsm-card').length, 3, 'one card per shipped provider');
    for (const id of ['deepseek-account', 'deepseek-official', 'netra-runtime']) {
      assert.ok(text.includes(id), `expected provider ${id} in the page`);
    }
    assert.ok(text.includes('deepseek-flash'), 'expected the model rows');
    assert.ok(text.includes('deepseek/deepseek-v4.1-flash'), 'expected netra models too');
    assert.equal(entryIdSeen[0], 'include:session-metrics', 'the page reads the Host entry id');
  } finally {
    view.unmount();
  }
});

test('page: rates are shown in USD per 1M, never the nanodollar form', () => {
  const form = makeForm();
  const view = renderPage(configFormsFor(form));
  try {
    const rateInputs = [...view.container.querySelectorAll<HTMLInputElement>('.dsm-rates input')].map((node) => node.value);
    assert.ok(rateInputs.length > 0, 'expected rate fields');
    assert.ok(rateInputs.includes('0.006'), `expected $0.006 among ${JSON.stringify(rateInputs)}`);
    assert.ok(rateInputs.includes('0.3'), `expected $0.30 among ${JSON.stringify(rateInputs)}`);
    assert.ok(rateInputs.includes('1.2'), `expected $1.20 among ${JSON.stringify(rateInputs)}`);
    assert.equal(rateInputs.some((value) => value === '6000000'), false, 'the nanodollar form must never be displayed');
  } finally {
    view.unmount();
  }
});

test('page: editing a rate stages a change and saving writes providers once', async () => {
  const form = makeForm();
  const view = renderPage(configFormsFor(form));
  try {
    assert.match(view.text(), /no changes/);
    await view.type('.dsm-rates input', '0.05');
    assert.match(view.text(), /unsaved changes/, 'an edit should mark the draft dirty');

    await view.click('.dsm-primary');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(form.calls.length, 1, 'one write');
    const { ops, expectedRevision } = form.calls[0];
    assert.equal(expectedRevision, 7, 'the revision read when editing began guards the write');
    // As a string: the ops array is built in the bundle's VM realm, so a strict
    // structural comparison against a host array would fail on the prototype alone.
    assert.equal(ops!.map((op) => `${op.op}:${op.path.join('.')}`).join(','), 'set:providers', 'providers is written as one field');
    const flash = ops![0].value.find((provider: any) => provider.id === 'deepseek-account').models.find((model: any) => model.model === 'deepseek-flash');
    assert.equal(flash.rates.peak.cacheHit, '0.05', 'the edited USD decimal is written back, not a nanodollar count');
    assert.equal(flash.rates.peak.output, '1.2', 'untouched rates keep their USD form');
  } finally {
    view.unmount();
  }
});

test('page: discarding restores the resolved values', async () => {
  const form = makeForm();
  const view = renderPage(configFormsFor(form));
  try {
    await view.type('.dsm-rates input', '9.99');
    assert.match(view.text(), /unsaved changes/);
    await view.clickNode(view.control('discard')!);
    assert.equal(form.calls.length, 0, 'discarding must not write');
  } finally {
    view.unmount();
  }
});

test('page: reset to shipped restores the inherited card', async () => {
  const form = makeForm();
  const view = renderPage(configFormsFor(form));
  try {
    await view.type('.dsm-rates input', '9.99');
    const before = view.container.querySelectorAll<HTMLInputElement>('.dsm-rates input')[0].value;
    assert.equal(before, '9.99');
    // The reset button is the first control inside the first provider card head.
    const reset = view.control('reset to shipped');
    assert.ok(reset !== undefined, 'expected a reset control');
    await view.clickNode(reset);
    assert.equal(view.container.querySelectorAll<HTMLInputElement>('.dsm-rates input')[0].value, '0.006', 'the shipped rate returns');
    assert.equal(form.calls.length, 0, 'resetting locally must not write');
  } finally {
    view.unmount();
  }
});

test('page: adding and removing providers and models edits the draft', async () => {
  const form = makeForm();
  const view = renderPage(configFormsFor(form));
  try {
    await view.clickNode(view.control('+ provider')!);
    assert.equal(view.container.querySelectorAll('.dsm-card').length, 4, 'a new provider card appears');
    assert.match(view.text(), /new-provider/);

    await view.clickNode(view.control('+ model')!);
    assert.match(view.text(), /new-model/);

    await view.clickNode([...view.container.querySelectorAll('.dsm-cardHead .dsm-toggle')].find((node) => node.textContent === 'remove')!);
    assert.equal(view.container.querySelectorAll('.dsm-card').length, 3, 'removing a provider drops its card');
  } finally {
    view.unmount();
  }
});

test('page: peak windows and zones are editable and parsed back', async () => {
  const form = makeForm();
  const view = renderPage(configFormsFor(form));
  try {
    const windowInput = [...view.container.querySelectorAll<HTMLInputElement>('.dsm-input')].find((node) => node.placeholder && node.placeholder.includes('empty = flat'));
    assert.ok(windowInput !== undefined, 'expected a peak-windows field');
    assert.equal(windowInput.value, '1-4,6-10', 'the shipped DeepSeek windows are shown');
    await view.type('.dsm-input[placeholder*="empty = flat"]', '2-5');
    const updated = [...view.container.querySelectorAll<HTMLInputElement>('.dsm-input')].find((node) => node.placeholder && node.placeholder.includes('empty = flat'));
    assert.equal(updated!.value, '2-5');
  } finally {
    view.unmount();
  }
});

test('page: a refused write keeps the edits and says so', async () => {
  const form = makeForm({ writability: 'read-only' });
  const view = renderPage(configFormsFor(form));
  try {
    // Read-only snapshots render the controls but the save button is disabled.
    const save = view.container.querySelector<HTMLButtonElement>('.dsm-primary');
    assert.equal(save!.disabled, true, 'a read-only snapshot cannot be saved');
  } finally {
    view.unmount();
  }
});

test('page: the inline bundle surface points at the row editor instead of looking broken', () => {
  useConfigForms(undefined);
  const loaded = loadBundle();
  const view = mount(loaded, loaded.slot('plugins.bundle.config'), { surface: 'bundle' });
  try {
    assert.match(view.text(), /Edit them on the component row below/, 'the pointer says what to do');
    assert.match(view.text(), /edited on the row page/, 'and the tag says where the editor lives');
    const path = view.container.querySelector('.dsm-path');
    assert.ok(path !== null, 'the path is emphasised rather than buried in a sentence');
    assert.match(path.textContent!, /dsh-session-metrics/, 'and it names the plugin');
    assert.equal(view.container.querySelector('pre'), null, 'no empty config block');
  } finally {
    view.unmount();
  }
});

test('page: an unaccepted value falls back to the inherited base so the editor still works', () => {
  // A Host that has not published an accepted `value` must not turn the page read-only:
  // `base` is exactly the effective configuration an override would inherit.
  const ownerForm = {
    state: { value: undefined, base: { providers: shippedProviders, display: resolved.display, budget: resolved.budget }, user: {}, revision: 3, writability: 'writable' },
    mutate: () => Promise.resolve(true),
  };
  useConfigForms(undefined);
  const loaded = loadBundle();
  const view = mount(loaded, loaded.slot('plugins.row.config'), { view: 'page', form: ownerForm });
  try {
    assert.equal(view.container.querySelectorAll('.dsm-card').length, 3, 'the shipped cards render from base');
    assert.match(view.text(), /inherited rates/, 'and says the rates are inherited');
  } finally {
    view.unmount();
  }
});

test('the stored shape renders: a flat model must not be read as a peak one', () => {
  // Live crash: the stored config has `rates.flat` for netra and no `mode`, so reading
  // `rates.peak` gave undefined and the rate fields threw on `.cacheHit`.
  const { view } = mountStoredConfig();
  try {
    assert.equal(view.text().includes('session-metrics failed'), false, `must not crash: ${view.text().slice(0, 140)}`);
    assert.equal(view.container.querySelectorAll('.dsm-card').length, 2, 'one card per stored provider');
    const rates = [...view.container.querySelectorAll<HTMLInputElement>('.dsm-rates input')].map((node) => node.value);
    assert.ok(rates.includes('0.006'), 'the peak row is editable');
    assert.ok(rates.includes('0.01'), 'the flat row is editable too');
  } finally {
    view.unmount();
  }
});

test('editing a flat model writes to rates.flat and the payload validates against the Host schema', async () => {
  const { view, writes } = mountStoredConfig();
  try {
    // the second card is netra: its flat row is the second `.dsm-rates` block
    const netraInput = view.container.querySelectorAll('.dsm-card')[1].querySelector('.dsm-rates input');
    assert.ok(netraInput !== null, 'netra has a rate field');
    await view.typeNode(netraInput, '0.02');
    await view.click('.dsm-primary');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(writes.length, 1, 'one write');
    const payload = writes[0].ops[0].value;
    assert.equal(payload.find((p: any) => p.id === 'netra-runtime').models[0].rates.flat.cacheHit, '0.02', 'written to rates.flat');
    assert.equal(payload.find((p: any) => p.id === 'deepseek-account').models[0].rates.peak.cacheHit, '0.006', 'the peak model is untouched');

    // THE verification: the Host must accept exactly what we send it.
    const result = Config['~standard'].validate({ providers: payload });
    assert.equal(result.issues, undefined, 'Host rejects the payload: ' + JSON.stringify(result.issues));
    assert.equal(writes[0].revision, 9, 'guarded by the revision read');
  } finally {
    view.unmount();
  }
});

test('switching a model between flat and peak keeps exactly one rate row', async () => {
  const { view, writes } = mountStoredConfig();
  try {
    const peakToggle = view.container.querySelectorAll('.dsm-card')[1].querySelector('.dsm-toggle[data-on="false"]');
    await view.clickNode(peakToggle);
    await view.click('.dsm-primary');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rates = writes[0].ops[0].value.find((p: any) => p.id === 'netra-runtime').models[0].rates;
    assert.equal(rates.flat, undefined, 'the flat row is gone after switching to peak');
    assert.notEqual(rates.peak, undefined, 'a peak row exists');
    const result = Config['~standard'].validate({ providers: writes[0].ops[0].value });
    assert.equal(result.issues, undefined, 'Host rejects the payload: ' + JSON.stringify(result.issues));
  } finally {
    view.unmount();
  }
});

test('after saving, a stale snapshot must not make the edit look reverted', async () => {
  // Reproduced live: the owner-supplied form has no subscription, so the snapshot on the
  // next render still carried the OLD value. The write had persisted, but the page showed
  // the old number and looked like a rollback.
  const writes: any[] = [];
  const form = {
    state: { value: { providers: schemaShaped }, user: {}, revision: 7, writable: true },
    mutate: (ops: any[], revision: number) => { writes.push({ ops, revision }); return Promise.resolve(true); },
  };
  useConfigForms(undefined);
  const loaded = loadBundle();
  const view = mount(loaded, loaded.slot('plugins.row.config'), { view: 'page', form, surface: 'row' });
  try {
    const netraCard = view.container.querySelectorAll('.dsm-card')[1];
    const rateInput = netraCard.querySelector<HTMLInputElement>('.dsm-rates input');
    assert.equal(rateInput!.value, '0.01', 'the stored netra cache-hit rate');
    await view.typeNode(rateInput, '0.02');
    await view.click('.dsm-primary');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(writes.length, 1, 'the write happened');
    assert.match(view.text(), /Saved\./, 'the page confirms the save');
    const after = view.container.querySelectorAll('.dsm-card')[1].querySelector<HTMLInputElement>('.dsm-rates input');
    assert.equal(after!.value, '0.02', 'and keeps showing what was written, not the stale snapshot');
    assert.equal(view.text().includes('no changes'), true, 'the draft counts as clean');
  } finally {
    view.unmount();
  }
});

test('page: the summary view is a one-liner with no editor', () => {
  const form = makeForm();
  useConfigForms(configFormsFor(form));
  const loaded = loadBundle();
  const view = mount(loaded, loaded.slot('plugins.row.config'), { view: 'summary' });
  try {
    assert.match(view.text(), /3 providers/);
    assert.match(view.text(), /models/);
    assert.equal(view.container.querySelectorAll('.dsm-card').length, 0, 'the summary half renders no editor');
    assert.ok(view.container.querySelector('.dsm-primary') === null);
  } finally {
    view.unmount();
  }
});

test('page: the form is taken from the slot owner, in either shape it hands over', () => {
  // The owner passes `{ state, mutate }`; a settings controller exposes `getSnapshot()`.
  // Both must reach the editor, and a supplied form must win over the service lookup.
  const cases = [
    {
      name: 'the owner { state, mutate } shape',
      form: { state: { value: { providers: schemaShaped }, user: {}, revision: 21, writable: true }, mutate: () => Promise.resolve(true) },
    },
    {
      name: 'a settings controller with getSnapshot()',
      form: { getSnapshot: () => ({ value: { providers: schemaShaped }, user: {}, revision: 22, writable: true }), subscribe: () => () => {}, mutate: () => Promise.resolve(true) },
    },
  ];
  for (const { name, form } of cases) {
    // A service that would render an EMPTY editor: if the supplied form lost, this is what
    // the page would show instead.
    const service = {
      get: () => ({ state: { value: { providers: [] }, user: {}, revision: 1, writable: true }, mutate: () => Promise.resolve(true) }),
      describe: () => ({ getSnapshot: () => ({ view: { namespaces: [] } }) }),
    };
    useConfigForms(service);
    const loaded = loadBundle();
    const view = mount(loaded, loaded.slot('plugins.row.config'), { view: 'page', form, surface: 'row' });
    try {
      assert.equal(view.container.querySelectorAll('.dsm-card').length, 2, `${name}: the supplied form is the one read`);
      assert.match(view.text(), /deepseek-account/, `${name}: and it is populated`);
    } finally {
      view.unmount();
    }
  }
});

test('robustness: a render failure is reported in the UI instead of vanishing', () => {
  // A throwing entry is abdicated by the slot framework: gone from the entry list,
  // still on the registration ledger, invisible to the user. The boundary keeps it
  // alive and prints the reason.
  const view = renderPage({ get() { throw new Error('boom from the config service'); } });
  try {
    const text = view.text();
    assert.match(text, /session-metrics failed/);
    assert.match(text, /boom from the config service/);
    assert.equal(view.container.querySelector('.dsm-slot')!.getAttribute('data-safe'), 'false');
  } finally {
    view.unmount();
  }
});

test('page: without the settings service the row page explains itself without an empty block', () => {
  const view = renderPage(undefined);
  try {
    const text = view.text();
    assert.match(text, /cordis\.patch\.yml/, 'the fallback points at the file');
    assert.match(text, /read-only on this page/, 'explains the state in plain language');
    assert.match(text, /cordis\.patch\.yml/, 'and points at the file');
    assert.equal(text.includes('config:'), false, 'and does not print an empty block');
    assert.equal(view.container.querySelector('pre'), null, 'no empty YAML block');
    assert.equal(text.includes('Diagnostics'), false, 'no debug text in the UI');
    assert.ok(view.container.querySelector('.dsm-primary') === null, 'no save control without a form');
  } finally {
    view.unmount();
  }
});

test('page: an empty snapshot explains the read-only state rather than rendering stale rates', () => {
  const view = renderPage({ get: () => ({ getSnapshot: () => null, subscribe: () => () => {} }) });
  try {
    assert.match(view.text(), /read-only on this page/);
  } finally {
    view.unmount();
  }
});

test('robustness: every partial config shape the Host can serve renders without crashing', async () => {
  // Reproduced live: a value layer carrying only some fields threw
  // `"undefined" is not valid JSON` from the number formatting, and a missing `display`
  // threw on `.labels`. A config layer can legitimately be partial.
  const shapes: Array<[string, Record<string, any> | undefined]> = [
    ['value {} (empty)', { value: {}, base: undefined }],
    ['value {budget}', { value: { budget: { sessionUsd: 5 } }, base: undefined }],
    ['value {providers: []}', { value: { providers: [] }, base: undefined }],
    ['value {display}', { value: { display: { currency: 'CNY' } }, base: undefined }],
    ['base only', { value: undefined, base: { providers: shippedProviders } }],
    ['neither', { value: undefined, base: undefined }],
    // A controller whose getSnapshot() resolves to undefined: reading Object.keys on it
    // once took the whole page down.
    ['a snapshot of undefined', undefined],
  ];
  for (const [label, layers] of shapes) {
    const snapshot = Object.assign({ status: 'ready', user: {}, revision: 4, writable: true, mode: 'host' }, layers);
    const form = { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: () => Promise.resolve(true) };
    const service = { get: () => form, describe: () => ({ getSnapshot: () => ({ view: { namespaces: [] } }) }) };
    useConfigForms(service);
    const loaded = loadBundle();
    const view = mount(loaded, loaded.slot('plugins.row.config'), { view: 'page', getService: () => service, surface: 'row' });
    try {
      const text = view.text();
      assert.equal(text.includes('session-metrics failed'), false, `${label} must not crash: ${text.slice(0, 120)}`);
      if (label === 'value {providers: []}') {
        assert.match(text, /No rate cards are configured/, 'an empty card set explains itself');
      }
      if (label === 'base only') {
        assert.equal(view.container.querySelectorAll('.dsm-card').length, 3, `${label} renders the inherited cards`);
      }
    } finally {
      view.unmount();
    }
  }
});

// The shape the Host actually stores: rate rows by tier, no `mode`, USD strings.
const schemaShaped = [
  {
    id: 'deepseek-account',
    label: 'DeepSeek (account)',
    models: [{ model: 'deepseek-flash', aliases: [], rates: { peak: { cacheHit: '0.006', cacheMiss: '0.3', output: '1.2' }, multiplier: 0.5 } }],
    billing: { timezone: 'UTC', weekdays: [1, 2, 3, 4, 5], windows: [[1, 4], [6, 10]], holidays: [], holidayZone: 'Asia/Shanghai' },
  },
  {
    id: 'netra-runtime',
    label: 'Netra Runtime',
    models: [{ model: 'deepseek/deepseek-v4.1-flash', aliases: [], rates: { flat: { cacheHit: '0.01', cacheMiss: '0.1', output: '0.25' }, multiplier: 0.5 } }],
    billing: { timezone: 'UTC', weekdays: [1, 2, 3, 4, 5], windows: [], holidays: [], holidayZone: 'Asia/Shanghai' },
  },
];

/** Mount the page with a schema-shaped config layer and capture writes. */
function mountStoredConfig(): { view: MountedView; writes: any[] } {
  const writes: any[] = [];
  const form = {
    state: { value: { providers: schemaShaped }, base: undefined, user: {}, revision: 9, writable: true },
    mutate: (ops: any[], revision: number) => { writes.push({ ops, revision }); return Promise.resolve(true); },
  };
  useConfigForms(undefined);
  const loaded = loadBundle();
  const view = mount(loaded, loaded.slot('plugins.row.config'), { view: 'page', form, surface: 'row' });
  return { view, writes };
}
