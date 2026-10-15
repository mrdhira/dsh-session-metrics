/**
 * The detail-page badge (T-001) under jsdom.
 *
 * `plugins.detail.badge` is a **list** slot: the owner renders every entry on all three
 * detail pages and passes each one the page's `subject`, so an entry that does not gate
 * itself shows this plugin's configuration on *another* plugin's page. That is the
 * blocker this file pins: a foreign subject with a perfectly valid configuration behind it
 * must render nothing.
 *
 * The rest of the file covers the badge's contract in the order the code runs:
 * positive (our bundle, our row), negative (foreign and unrecognised subjects, empty
 * data), then robustness (the attachment doors, throws reaching the boundary, the tier
 * clock, and the namespace the whole thing is keyed by).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { name as HOST_PLUGIN_NAME } from '../lib/v1/index.js';
import { nextBoundary as hostNextBoundary, tierAt as hostTierAt } from '../lib/v1/pricing.js';
import { resolveSettings } from '../lib/v1/settings.js';
import {
  clientContext,
  loadBundle,
  mount,
  type ConfigFormsAttachment,
  type LoadedBundle,
  type MountedView,
  type Registration,
} from './harness.ts';
import { ROW_ID } from './namespace.ts';

// ---------------------------------------------------------------- fixtures

/** A Wednesday inside the peak window below, and the instant every case is read at. */
const IN_WINDOW_MS = Date.UTC(2026, 9, 14, 2, 0, 0);
/** The same Wednesday, outside every window below. */
const OUTSIDE_WINDOW_MS = Date.UTC(2026, 9, 14, 5, 0, 0);
/** Wednesday 23:00 UTC — Thursday in Asia/Tokyo, which is what the holiday case needs. */
const TOKYO_NEXT_DAY_MS = Date.UTC(2026, 9, 14, 23, 0, 0);

/** A calendar with a peak window, exactly as the Host schema resolves one. */
const PEAK = {
  timezone: 'UTC',
  weekdays: [1, 2, 3, 4, 5],
  windows: [[1, 4]],
  holidays: [],
  holidayZone: 'Asia/Shanghai',
};

/** A calendar with no peak concept: every hour is one rate. */
const FLAT = {
  timezone: 'UTC',
  weekdays: [1, 2, 3, 4, 5],
  windows: [],
  holidays: [],
  holidayZone: 'Asia/Shanghai',
};

/** Two providers, three models: only the first has a peak window. */
const PROVIDERS = [
  { id: 'deepseek-account', models: [{ model: 'deepseek-flash' }, { model: 'deepseek-v4-pro' }], billing: PEAK },
  { id: 'netra-runtime', models: [{ model: 'deepseek/deepseek-v4.1-flash' }], billing: FLAT },
];

/** The accepted configuration layer the badge reads. */
const valueOf = (providers: any[]) => ({ providers });

/** The package name: the bundle id and the `pkg.name` a bundle page's subject carries. */
const BUNDLE = 'dsh-session-metrics';

/** Our own bundle page's subject, as the owner passes it. */
const OURS_BUNDLE = { kind: 'bundle', pkg: { name: BUNDLE } };

/** Our own row page's subject. */
const OURS_ROW = { kind: 'row', pkg: { name: BUNDLE }, row: { rowId: ROW_ID } };

// ---------------------------------------------------------------- helpers

/** A stub `configForms` service; it records the namespace it was asked for. */
interface ServiceStub {
  namespaces: string[];
  get(namespace: string): unknown;
}

/** A service that serves one form under this plugin's namespace. */
function serviceFor(form: unknown): ServiceStub {
  const namespaces: string[] = [];
  return {
    namespaces,
    get(namespace: string) {
      namespaces.push(namespace);
      return form;
    },
  };
}

/**
 * A stub form shaped like the controller `configForms.get(namespace)` serves.
 * @param value - the accepted layer, or undefined to serve a snapshot without one.
 */
function formFor(value: unknown) {
  const snapshot = value === undefined
    ? { base: { providers: PROVIDERS }, revision: 1, writability: 'writable' }
    : { value, revision: 1, writability: 'writable' };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
  };
}

/** Read `Date.now()` as one fixed instant for the duration of `run`. */
function withNow<T>(ms: number, run: () => T): T {
  const real = Date.now;
  Date.now = () => ms;
  try {
    return run();
  } finally {
    Date.now = real;
  }
}

/** The attachment mode and service a mount should use. */
interface AttachOptions {
  attachment?: ConfigFormsAttachment;
  service?: unknown;
}

/** Apply the bundle's plugin to a context with the requested attachment, and find the badge. */
function attach(options: AttachOptions = {}): { registration: Registration | null; registrations: Registration[]; loaded: LoadedBundle } {
  const loaded = loadBundle();
  const registrations: Registration[] = [];
  const ctx = clientContext({
    registrations,
    attachment: options.attachment,
    configForms: () => (options.service === undefined ? null : options.service),
  });
  loaded.plugin.apply(ctx);
  const badges = registrations.filter((entry) => entry.spec.name === 'plugins.detail.badge');
  assert.equal(badges.length <= 1, true, `expected at most one badge registration, got ${badges.length}`);
  return { registration: badges[0] ?? null, registrations, loaded };
}

/** Mount the badge with one subject, at one instant. */
function mountBadge(subject: unknown, options: AttachOptions & { nowMs?: number } = {}): MountedView {
  const { registration, loaded } = attach(options);
  assert.ok(registration !== null, 'the badge must be registered for this attachment mode');
  const nowMs = options.nowMs ?? IN_WINDOW_MS;
  return withNow(nowMs, () => mount(loaded, registration, { subject }));
}

/** The tier segment the chip actually rendered, or null when it shows none. */
function renderedTier(view: MountedView): string | null {
  if (view.container.querySelector('.dsm-peak') !== null) return 'peak';
  if (view.container.querySelector('.dsm-off') !== null) return 'off-peak';
  return null;
}

/** A valid configuration behind the badge, so a missing subject gate would show a chip. */
const configured = () => serviceFor(formFor(valueOf(PROVIDERS)));

// ---------------------------------------------------------------- positive

test('badge: our bundle subject renders the configured counts and the current tier', () => {
  const view = mountBadge(OURS_BUNDLE, { service: configured(), nowMs: IN_WINDOW_MS });
  try {
    assert.equal(view.text(), '2 providers\u00b73 models\u00b7peak', `unexpected chip: ${view.text()}`);
    assert.equal(view.container.querySelector('.dsm-badge') !== null, true, 'the chip is present');
  } finally {
    view.unmount();
  }
});

test('badge: our row subject renders too', () => {
  const view = mountBadge(OURS_ROW, { service: configured(), nowMs: IN_WINDOW_MS });
  try {
    assert.equal(view.text(), '2 providers\u00b73 models\u00b7peak', `unexpected chip: ${view.text()}`);
  } finally {
    view.unmount();
  }
});

test('badge: the registration carries only the options its slot declares', () => {
  const { registration } = attach({ service: configured() });
  assert.ok(registration !== null, 'the badge registers through the fallback door');
  assert.equal(registration.spec.id, BUNDLE);
  assert.equal(registration.spec.order, 20);
  assert.equal(registration.spec.inject, undefined, 'no inject option: it would replace the owner props');
  assert.equal(String(Object.keys(registration.spec).sort()), 'id,label,name,order');
});

test('badge: the title names the provider whose calendar the tier came from', () => {
  // Only the first provider has a window; the sentence must not attribute its state to
  // all of them, which is what "for 2 configured providers" claimed before.
  const view = mountBadge(OURS_BUNDLE, { service: configured(), nowMs: IN_WINDOW_MS });
  try {
    const badge = view.container.querySelector('.dsm-badge');
    assert.ok(badge !== null, 'the chip is present');
    const title = badge.getAttribute('title') || '';
    assert.match(title, /calendar of "deepseek-account"/, `the tier names its provider: ${title}`);
    assert.match(title, /in UTC/, 'and the zone it was read in');
    assert.match(title, /2 provider\(s\) and 3 model\(s\) are configured/, 'the counts stay separate facts');
    assert.equal(/for 2 configured/.test(title), false, 'the aggregate claim is gone');
  } finally {
    view.unmount();
  }
});

// ---------------------------------------------------------------- negative

test('badge: a foreign subject renders nothing, even with our configuration behind it', () => {
  // THE regression test for the blocker. `plugins.detail.badge` is a list slot whose
  // owner renders every entry on all three detail pages with no filter, so without the
  // subject gate this exact mount shows "2 providers · 3 models · peak" on another
  // plugin's page. The service is live on purpose: the gate, not the absence of data,
  // is what must suppress the chip.
  const foreign: Array<[string, unknown]> = [
    ['another bundle', { kind: 'bundle', pkg: { name: 'deepseek-account' } }],
    ['another row', { kind: 'row', pkg: { name: 'dsh-skills-manager' }, row: { rowId: 'skills' } }],
    ['another item', { kind: 'item', id: 'other-plugin#config' }],
  ];
  for (const [label, subject] of foreign) {
    const view = mountBadge(subject, { service: configured(), nowMs: IN_WINDOW_MS });
    try {
      assert.equal(view.text(), '', `${label}: nothing may render`);
      assert.equal(view.container.querySelector('.dsm-badge') === null, true, `${label}: no chip`);
      assert.equal(view.container.querySelector('.dsm-trigger') === null, true, `${label}: and no failure chip either`);
    } finally {
      view.unmount();
    }
  }
});

test('badge: an item page, a missing package and an unrecognised subject render nothing', () => {
  const cases: Array<[string, unknown]> = [
    ['our own item id (we contribute no item)', { kind: 'item', id: ROW_ID }],
    ['a bundle subject with no pkg', { kind: 'bundle' }],
    ['a row subject whose pkg carries no name', { kind: 'row', pkg: {} }],
    ['an unrecognised kind', { kind: 'mystery', pkg: { name: BUNDLE } }],
    ['a null subject', null],
    ['an undefined subject', undefined],
    ['a primitive subject', 'session-metrics'],
  ];
  for (const [label, subject] of cases) {
    const view = mountBadge(subject, { service: configured(), nowMs: IN_WINDOW_MS });
    try {
      assert.equal(view.text(), '', `${label}: nothing may render`);
    } finally {
      view.unmount();
    }
  }
});

test('badge: absent data renders no empty chip', () => {
  const cases: Array<[string, AttachOptions]> = [
    ['no configForms service at all', {}],
    ['a service with no form for this namespace', { service: serviceFor(null) }],
    ['a snapshot with no accepted value layer', { service: serviceFor(formFor(undefined)) }],
    ['an empty provider list', { service: serviceFor(formFor(valueOf([]))) }],
    ['a providers value that is not an array', { service: serviceFor(formFor({ providers: 'nope' })) }],
    ['a form that serves nothing', { service: { get: () => undefined } }],
  ];
  for (const [label, options] of cases) {
    const view = mountBadge(OURS_BUNDLE, { ...options, nowMs: IN_WINDOW_MS });
    try {
      assert.equal(view.text(), '', `${label}: nothing may render`);
    } finally {
      view.unmount();
    }
  }
});

// ---------------------------------------------------------------- attachment doors

test('badge: attached through the optional configForms injection', () => {
  const { registration, registrations } = attach({ attachment: 'present', service: configured() });
  assert.equal(registrations.filter((entry) => entry.spec.name === 'plugins.detail.badge').length, 1,
    'the injected context registers the badge');
  assert.ok(registration !== null, 'and it is the registration we mount');
  const view = withNow(IN_WINDOW_MS, () => mount(loadBundle(), registration, { subject: OURS_BUNDLE }));
  try {
    assert.equal(view.text(), '2 providers\u00b73 models\u00b7peak', `unexpected chip: ${view.text()}`);
  } finally {
    view.unmount();
  }
});

test('badge: attached through the root context when the injection is not offered', () => {
  const service = configured();
  const { registration } = attach({ attachment: 'none', service });
  assert.ok(registration !== null, 'without ctx.inject the root path still registers the badge');
  const view = withNow(IN_WINDOW_MS, () => mount(loadBundle(), registration, { subject: OURS_BUNDLE }));
  try {
    assert.equal(view.text(), '2 providers\u00b73 models\u00b7peak', `unexpected chip: ${view.text()}`);
  } finally {
    view.unmount();
  }
});

test('badge: a deployment where configForms never arrives registers nothing', () => {
  // `ctx.inject(['configForms'], …)` runs its callback only while the service is
  // provided, so the documentation-without-the-settings-UI deployment contributes no
  // badge at all rather than an empty one.
  const { registrations } = attach({ attachment: 'absent', service: configured() });
  assert.equal(registrations.filter((entry) => entry.spec.name === 'plugins.detail.badge').length, 0,
    'no service, no registration');
  assert.equal(registrations.length > 0, true, 'and the other registrations still happen');
});

// ---------------------------------------------------------------- tier correctness

test('badge: the tier is the host tier, from the host-resolved calendar', () => {
  // `hostWant` is the Host's own verdict (`flat` for a calendar with no windows);
  // `badgeWant` is what the chip shows, and a flat calendar has no tier segment at all.
  const cases: Array<[string, number, Record<string, any>, string, string | null]> = [
    ['inside the window', IN_WINDOW_MS, PEAK, 'peak', 'peak'],
    ['outside the window', OUTSIDE_WINDOW_MS, PEAK, 'off-peak', 'off-peak'],
    ['a flat calendar has no tier segment', IN_WINDOW_MS, FLAT, 'flat', null],
    // The bug this file was written for: a partial layer with windows but no `weekdays`
    // used to become "no peak day" and read off-peak while the Host charged peak.
    ['a partial calendar takes the Host weekday default', IN_WINDOW_MS, { timezone: 'UTC', windows: [[1, 4]] }, 'peak', 'peak'],
    [
      'a holiday resolves in the holiday zone, not the billing zone',
      TOKYO_NEXT_DAY_MS,
      { timezone: 'UTC', weekdays: [1, 2, 3, 4, 5], windows: [[22, 24]], holidays: ['2026-10-15'], holidayZone: 'Asia/Tokyo' },
      'off-peak',
      'off-peak',
    ],
  ];
  for (const [label, nowMs, billing, hostWant, badgeWant] of cases) {
    const provider = { id: 'case-provider', models: [{ model: 'case-model' }], billing };
    // The expectation comes from the Host's own resolution and tier rule, not from a
    // restatement: same raw config, same instant, one calendar.
    const resolved = resolveSettings({ providers: [provider] }).providers[0].billing;
    assert.equal(hostTierAt(new Date(nowMs), resolved), hostWant, `${label}: the host must resolve ${hostWant}`);
    const view = mountBadge(OURS_BUNDLE, { service: serviceFor(formFor(valueOf([provider]))), nowMs });
    try {
      assert.equal(renderedTier(view), badgeWant, `${label}: the badge must agree with the host`);
    } finally {
      view.unmount();
    }
  }
});

test('badge: a windowed chip schedules a re-render at the next tier boundary, a flat one does not', () => {
  // The tier is a claim about "right now": without a tick it keeps claiming the state it
  // was rendered in. The boundary is the Host's own `nextBoundary` over the same calendar.
  const win = loadBundle().dom.window;
  const real = win.setTimeout;
  const scheduled: number[] = [];
  win.setTimeout = ((fn: () => void, ms: number) => {
    scheduled.push(ms);
    return real(fn, ms);
  }) as typeof win.setTimeout;
  try {
    const windowed = { id: 'windowed', models: [{ model: 'm' }], billing: PEAK };
    const hostBilling = resolveSettings({ providers: [windowed] }).providers[0].billing;
    const expected = hostNextBoundary(IN_WINDOW_MS, hostBilling);
    assert.equal(typeof expected, 'number', 'the fixture has a boundary to schedule for');
    const view = mountBadge(OURS_BUNDLE, { service: serviceFor(formFor(valueOf([windowed]))), nowMs: IN_WINDOW_MS });
    try {
      // The timer waits for the boundary, so its delay is boundary − now.
      assert.equal(scheduled.includes((expected as number) - IN_WINDOW_MS), true,
        `expected a timer to the boundary ${expected}, got ${JSON.stringify(scheduled)}`);
    } finally {
      view.unmount();
    }

    const flat = { id: 'flat', models: [{ model: 'm' }], billing: FLAT };
    const quiet: number[] = [];
    win.setTimeout = ((fn: () => void, ms: number) => {
      quiet.push(ms);
      return real(fn, ms);
    }) as typeof win.setTimeout;
    const flatView = mountBadge(OURS_BUNDLE, { service: serviceFor(formFor(valueOf([flat]))), nowMs: IN_WINDOW_MS });
    try {
      assert.deepEqual(quiet.filter((ms) => ms > 1000), [], 'a flat calendar has no tier to keep live');
    } finally {
      flatView.unmount();
    }
  } finally {
    win.setTimeout = real;
  }
});

// ---------------------------------------------------------------- robustness

test('badge: a throwing service or form is reported by the boundary, not swallowed', () => {
  // The badge used to `catch { return null }` around every read, so a drifted namespace
  // or a changed controller shape vanished with no error anywhere. `MetricsBoundary`
  // already renders a readable failure chip; these rows pin that the message survives.
  const cases: Array<[string, AttachOptions]> = [
    ['the service throws on get', {
      service: { get() { throw new Error('boom from the badge service'); } },
    }],
    ['the snapshot throws', {
      service: serviceFor({ getSnapshot() { throw new Error('boom from the form snapshot'); }, subscribe: () => () => {} }),
    }],
    ['the subscription throws', {
      service: serviceFor({ getSnapshot: () => ({ value: valueOf(PROVIDERS) }), subscribe() { throw new Error('boom from subscribe'); } }),
    }],
  ];
  for (const [label, options] of cases) {
    const view = mountBadge(OURS_BUNDLE, { ...options, nowMs: IN_WINDOW_MS });
    try {
      assert.match(view.text(), /session-metrics failed/, `${label}: the failure is visible`);
      assert.match(view.text(), /boom/, `${label}: and names its cause`);
    } finally {
      view.unmount();
    }
  }
});

// ---------------------------------------------------------------- namespace parity

test('namespace: the built client and host both use the row id the patch declares', () => {
  // A namespace rename used to leave every assertion green while the badge read nothing:
  // the string lived in five places and the tests pinned one of them. Here the client's
  // read is observed on the built bundle and compared with the patch file's own row id.
  const service = configured();
  const view = mountBadge(OURS_BUNDLE, { service, nowMs: IN_WINDOW_MS });
  try {
    assert.equal(view.text(), '2 providers\u00b73 models\u00b7peak', 'the badge rendered through the namespace');
  } finally {
    view.unmount();
  }
  assert.deepEqual(service.namespaces, [ROW_ID], 'the built client asks for the patch row id');
  assert.equal(HOST_PLUGIN_NAME, ROW_ID, 'and the host half exports the same name');
});
