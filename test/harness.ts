/**
 * Shared jsdom harness for the client bundle.
 *
 * The bundle is a plain-JS `window.__ModuleLoader__.load({...})` script, so it is
 * evaluated through a stub loader — the same path the browser takes — rather than
 * imported. Both client test files mount components from the real file.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import React from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { act, Simulate } from 'react-dom/test-utils';

const CLIENT_PATH = fileURLToPath(new URL('../lib/v1/client.js', import.meta.url));
const SOURCE = readFileSync(CLIENT_PATH, 'utf8');

/** One registration the bundle made, as the stub loader captured it. */
export interface Registration {
  spec: {
    name: string;
    id?: string;
    key?: string;
    order?: number;
    inject?: unknown;
  };
  /** The bundle's component; its props are the app's own shape, so it stays loose. */
  component: React.ComponentType<Record<string, unknown>>;
}

/** What the bundle registered, and the DOM it was evaluated against. */
export interface LoadedBundle {
  dom: JSDOM;
  inject: unknown;
  registrations: Registration[];
  /** The registration for one slot name. */
  slot(name: string): Registration;
}

/** Handles for interacting with one mounted tree. */
export interface MountedView {
  dom: JSDOM;
  container: HTMLDivElement;
  root: Root;
  /** Re-render with new props. */
  rerender(next: Record<string, unknown>): void;
  /** Unmount and drop this test's container; the shared document lives on. */
  unmount(): void;
  /** Click the first element matching a selector. */
  click(selector: string): Promise<void>;
  /** Click an already-resolved node. */
  clickNode(node: Element | null): Promise<void>;
  /** Find a control by its visible text. */
  control(label: string): HTMLButtonElement | undefined;
  /** Hover an element the way a pointer does: React's enter/leave pair. */
  hover(node: Element | null | undefined): Promise<void>;
  /** Move the pointer away. */
  unhover(node: Element | null | undefined): Promise<void>;
  /** Type into an already-resolved input node. */
  typeNode(node: Element | null | undefined, value: string): Promise<void>;
  /** Type into the first element matching a selector. */
  type(selector: string, value: string): Promise<void>;
  text(): string;
  styles(): string;
}

declare global {
  /** React's `act()` opt-in flag; @types/react 18 does not declare it. */
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The one evaluated bundle for this file.
 *
 * A realm per test was the harness's real cost: each JSDOM document and VM
 * context is megabytes of native state, and building ~20 of them left V8 with
 * gigabytes of off-heap garbage to collect after the tests had already finished.
 * The bundle is realm-scoped anyway, so one realm plus a fresh container per mount
 * is both faster and closer to the browser, where the module is evaluated once.
 */
let shared: LoadedBundle | null = null;

/** The `configForms` stub the shared context serves, set per test. */
let currentConfigForms: unknown = null;

/**
 * Serve one `configForms` stub to the shared client context.
 * @param stub - the stub, or null to clear it.
 */
export function useConfigForms(stub: unknown): void {
  currentConfigForms = stub === undefined ? null : stub;
}

/**
 * Evaluate the bundle once against a shared DOM.
 * @returns the DOM, what the bundle registered, and the plugin's inject list.
 */
export function loadBundle(): LoadedBundle {
  if (shared !== null) return shared;
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://localhost/',
  });
  // React renders in this realm while the component is defined in the VM realm,
  // so the DOM globals must exist on both sides.
  const realm = dom.window as unknown as Window & typeof globalThis;
  globalThis.window = realm;
  globalThis.document = realm.document;

  const registrations: Registration[] = [];
  const SENTINEL = Symbol('not-applied');
  let applied: unknown = SENTINEL;
  let inject: unknown = null;

  const sandbox: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    Intl,
    Date,
    Math,
    JSON,
    Promise,
    console,
    setTimeout: dom.window.setTimeout.bind(dom.window),
    clearTimeout: dom.window.clearTimeout.bind(dom.window),
  };
  sandbox.globalThis = sandbox;

  dom.window.__ModuleLoader__ = {
    load({ id, factory }: { id: string; factory: (require: (specifier: string) => unknown) => any }) {
      assert.equal(id, 'dsh-session-metrics', 'the bundle id must equal the package name');
      const plugin = factory((specifier) => {
        if (specifier === 'react') return React;
        if (specifier === 'react-dom') return ReactDOM;
        throw new Error(`unexpected require("${specifier}")`);
      });
      // Compared as a string: the bundle runs in a VM realm, so its Array has a
      // different prototype and a strict deep-equality check would fail on that alone.
      assert.equal(String(plugin.inject), 'slots');
      inject = plugin.inject;
      // Mirrors the real restricted client context exactly:
      //   - a service named in the plugin's `inject` may be read as a property;
      //   - any other service read as a property THROWS (this is what crashed the
      //     live strip), while `ctx.get(name)` stays safe and may return undefined.
      const slotsService = {
        inject(dependency: string, callback: () => void) {
          callback();
          return () => {};
        },
        register(spec: Registration['spec'], component: Registration['component']) {
          registrations.push({ spec, component });
          return () => {};
        },
      };
      const sessionsService = { refreshProjections: () => Promise.resolve() };
      const target = {
        get(name: string) {
          if (name === 'configForms') return currentConfigForms;
          if (name === 'sessions') return sessionsService;
          return undefined;
        },
        slots: slotsService,
      };
      const ctx = new Proxy(target, {
        get(object, property) {
          if (property in object || typeof property === 'symbol') return Reflect.get(object, property);
          throw new Error(`cannot get property "${String(property)}" without declaring it (use ctx.get)`);
        },
      });
      applied = plugin.apply(ctx);
    },
  };

  runInContext(SOURCE, createContext(sandbox));
  // Strict: `assert.notEqual` is loose, and `null == undefined` would fail here
  // even when the bundle loaded perfectly.
  assert.notStrictEqual(applied, SENTINEL, 'the bundle should have loaded');

  shared = {
    dom,
    inject,
    registrations,
    /** The registration for one slot name. */
    slot(name: string): Registration {
      const found = registrations.filter((entry) => entry.spec.name === name);
      assert.equal(found.length, 1, `expected exactly one ${name} registration, got ${found.length}`);
      return found[0];
    },
  };
  return shared;
}

/**
 * Mount one registered component.
 * @param loaded - the result of `loadBundle`.
 * @param registration - the registration to mount.
 * @param props - extra props.
 * @returns handles for interacting with the mounted tree.
 */
export function mount(
  loaded: LoadedBundle,
  registration: Registration,
  props: Record<string, unknown>,
): MountedView {
  const { dom } = loaded;
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(registration.component, props));
  });
  return {
    dom,
    container,
    root,
    /** Re-render with new props. */
    rerender(next: Record<string, unknown>) {
      act(() => {
        root.render(React.createElement(registration.component, next));
      });
    },
    /** Unmount and drop this test's container; the shared document lives on. */
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
    /**
     * Click the first element matching a selector.
     *
     * Awaiting matters: a state update raised inside a discrete event is settled
     * asynchronously, so a synchronous `act` can return before the tree reflects
     * the click.
     */
    async click(selector: string): Promise<void> {
      const node = container.querySelector(selector);
      // Never pass a DOM node to an assertion: a failure makes the runner inspect it,
      // which walks React's fibers and jsdom's getters and can allocate gigabytes.
      assert.ok(node !== null, `expected ${selector} to exist`);
      await act(async () => {
        node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
    },
    /** Click an already-resolved node. */
    async clickNode(node: Element | null): Promise<void> {
      assert.ok(node !== null, 'expected a node to click');
      await act(async () => {
        node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
    },
    /** Find a control by its visible text. */
    control(label: string): HTMLButtonElement | undefined {
      return [...container.querySelectorAll('button')].find((node) => node.textContent === label);
    },
    /** Hover an element the way a pointer does: React's enter/leave pair. */
    async hover(node: Element | null | undefined): Promise<void> {
      assert.ok(node !== null && node !== undefined, 'expected a node to hover');
      await act(async () => {
        Simulate.mouseEnter(node, { relatedTarget: node.ownerDocument!.body });
      });
    },
    /** Move the pointer away. */
    async unhover(node: Element | null | undefined): Promise<void> {
      assert.ok(node !== null && node !== undefined, 'expected a node to leave');
      await act(async () => {
        Simulate.mouseLeave(node, { relatedTarget: node.ownerDocument!.body });
      });
    },
    /** Type into an already-resolved input node. */
    async typeNode(node: Element | null | undefined, value: string): Promise<void> {
      assert.ok(node !== null && node !== undefined, 'expected an input node');
      await act(async () => {
        // React reads `target.value` off this object; the published type narrows
        // `target` to `EventTarget`, which cannot carry a value.
        Simulate.change(node, { target: { value } } as unknown as Parameters<typeof Simulate.change>[1]);
      });
    },
    /**
     * Type into the first element matching a selector.
     *
     * Uses React's own `Simulate.change` rather than a hand-dispatched native
     * `input` event: React's value tracker ignores a programmatic value assignment
     * followed by a synthetic event, so the handler would never run and the test
     * would silently assert against the value it had just written.
     */
    async type(selector: string, value: string): Promise<void> {
      const node = container.querySelector(selector);
      // Never pass a DOM node to an assertion: a failure makes the runner inspect it,
      // which walks React's fibers and jsdom's getters and can allocate gigabytes.
      assert.ok(node !== null, `expected ${selector} to exist`);
      await act(async () => {
        // See `typeNode`: the change payload carries a value the published type omits.
        Simulate.change(node, { target: { value } } as unknown as Parameters<typeof Simulate.change>[1]);
      });
    },
    // Typed as a string because every caller treats it as text; a `null` (an empty
    // container) would throw at the caller's assertion either way.
    text: () => container.textContent as string,
    styles: () => [...dom.window.document.querySelectorAll('style')].map((node) => node.textContent).join('\n'),
  };
}
