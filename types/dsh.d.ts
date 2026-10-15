/**
 * The DSH client contract this plugin's browser half relies on.
 *
 * **Observed, not published.** The packaged app ships zero `.d.ts` (verified by
 * listing the app tree), and the published `@deepseek-ai/dsh-*` packages describe
 * the host half only. Every shape below was read off a real surface — the slot
 * inspector's declared slot catalog, the shipped owner bundles under
 * `app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-*`, and the code paths
 * this file actually executes — and is marked with where it was seen. None of it
 * is presented as a published API: a DSH update can change it, and the failures
 * would be runtime failures, so each read in `src/client/index.cts` is guarded
 * rather than trusted.
 *
 * Deliberately **not** declared here: `window`, `document` and `Intl`. This
 * project is checked with `lib: ["ES2022", "DOM"]`, so the real DOM lib already
 * describes them; a local declaration would be a worse copy of a real contract.
 *
 * Two things that are genuinely unknown at the boundary — a projection value and
 * a config snapshot — are typed `unknown` on purpose. The point of this file is to
 * push the untyped edge as far out as it can go, so a wrong assumption is caught by
 * `tsc` at the one narrowing site instead of being laundered through an `any`.
 */

// ---------------------------------------------------------------- module plumbing

/**
 * The CommonJS `require` the client loader hands the bundle factory.
 *
 * Typed as a getter of an unknown value: every call site narrows or asserts the
 * specifier it asked for. The `require` the loader provides is real CommonJS, so
 * a bare `import` is not interchangeable and is never used in the browser half.
 */
declare const require: (name: string) => unknown;
/** The module object `build.mjs`'s banner creates; the factory returns its `exports`. */
declare const module: { exports: unknown };
/** The build stamp `build.mjs` injects with esbuild's `define`. */
declare const __BUILD_ID__: string;

// ---------------------------------------------------------------- slot surfaces

/**
 * The page subject `plugins.detail.badge` renders with.
 *
 * Read from the owner's own README and render sites (three detail pages, all
 * passing `{ subject }`, none filtering):
 *   ItemDetail:   `{ kind: 'item', id }`
 *   RowDetail:    `{ kind: 'row', pkg, row }`
 *   BundleDetail: `{ kind: 'bundle', pkg }`
 * Every part is optional at the boundary because the owner controls the shape and
 * a missing field is a page this plugin does not own, not a crash.
 */
interface DshSubject {
  readonly kind?: string;
  readonly id?: string;
  readonly pkg?: { readonly name?: string; readonly version?: string } | null;
  readonly row?: { readonly id?: string; readonly rowId?: string; readonly name?: string } | null;
}

/**
 * One pending-registration handle: calling it unregisters this contribution.
 *
 * `slots.inject(name, cb)` and `slots.register(spec, component)` both return
 * either a function or an object with `dispose`; the plugin never calls it (the
 * Loader disposes the whole entry), so the shape is left structural.
 */
type DshDisposable = (() => void) | { dispose?: () => void } | undefined;

/**
 * A slot contribution's registration options.
 *
 * The full option set the owner's list slots accept is `id`/`order`/`label`;
 * keyed slots take `key` instead. `inject` is deliberately typed here — and
 * deliberately never used by this plugin — because passing it on a slot that does
 * not declare it replaces the component's framework props (`useProjection`,
 * `sessionId`) with the injection's own value, which leaves the component with
 * nothing to read.
 */
interface DshSlotRegistration {
  readonly name: string;
  readonly id?: string;
  readonly key?: string;
  readonly order?: number;
  readonly label?: string;
  readonly inject?: unknown;
}

/**
 * The `slots` service, as this plugin uses it.
 *
 * `inject(slotName, run)` defers a contribution until the slot exists;
 * `register(spec, component)` contributes the component. Both were read from the
 * owner bundle and are exercised by the DOM harness through the real bundle.
 */
interface DshSlotsService {
  inject(slotName: string, run: () => DshDisposable): DshDisposable;
  register(spec: DshSlotRegistration, component: DshComponent): DshDisposable;
}

/**
 * The props the slot owner composes onto a registered entry, in the slots this
 * plugin contributes to.
 *
 * Every field is optional because different slots pass different subsets (the
 * badge slot passes `subject` and no `getService`; the row-config slot passes
 * `form`; the dock slot passes the projection hooks), and because a partial
 * framework prop set is a real, reproduced live failure mode rather than a
 * theoretical one. Nothing is read without a guard.
 */
interface DshSlotProps {
  /** The session this entry was rendered for; a note, never a gate (the projections are session-scoped). */
  readonly sessionId?: string;
  /** `plugins.row.config` renders `summary` on the row and `page` in the pane. */
  readonly view?: 'page' | 'summary';
  /** Which surface this copy of the config page is: the bundle's inline page or the row page. */
  readonly surface?: 'bundle' | 'row';
  /**
   * The framework's projection reader. Absent only if the framework props were
   * replaced — a fault the strip names on screen instead of hiding.
   * The value is `unknown`: a projection is a cross-half wire value whose shape
   * this side narrows itself.
   */
  readonly useProjection?: (key: string) => unknown;
  /** Ask the sessions service to (re)load this session's projection baseline. */
  readonly refreshProjections?: (sessionId?: string) => void;
  /** Look a service up by name. Absent on the `plugins.detail.badge` slot. */
  readonly getService?: (name: string) => unknown;
  /**
   * The config snapshot the owner supplies to `plugins.row.config` /
   * `plugins.bundle.config`: the resolved `{ state, mutate }` face. `unknown`
   * because the two shapes this plugin tolerates (that face, and a settings
   * controller with `getSnapshot`) are narrowed in one documented place.
   */
  readonly form?: unknown;
  /** The `configForms` service, if the owner passes it as a prop rather than a getter. */
  readonly configForms?: DshConfigFormsService | null;
  /** The badge slot's page subject; see `DshSubject`. */
  readonly subject?: DshSubject | null;
}

/** A registered slot component: a function component, or a class such as the error boundary. */
type DshComponent =
  | ((props: DshSlotProps) => unknown)
  | (new (props: DshSlotProps) => { render(): unknown; componentDidCatch?(error: unknown): void });

/**
 * The restricted client context a plugin half is applied with.
 *
 * On the real client context, reading an **undeclared** service as a property
 * throws (`cannot get property "sessions"`), which is what crashed this strip's
 * first render and had the slot abdicate it. Only `ctx.get(name)` is safe for
 * services this plugin does not declare, and only `slots` is injected.
 */
interface DshClientContext {
  get(name: string): unknown;
  readonly slots: DshSlotsService;
  /**
   * Optional-service injection: the callback runs only while every named service
   * is provided, and inside it the service is a legal property read. Absent
   * entirely on a context that does not offer it — the badge then falls back to
   * `ctx.get`.
   */
  inject?(dependencies: string[], run: (child: DshClientContext & { configForms?: DshConfigFormsService }) => void): DshDisposable;
}

// ---------------------------------------------------------------- settings service

/**
 * The snapshot shape `form.state` or `form.getSnapshot()` serves.
 *
 * `value` is the accepted configuration, `base` what an override would inherit,
 * and both can be absent or partial — a partial config is normal, and reading it
 * as complete is what produced the live `rates.peak` crash.
 */
interface DshConfigSnapshot {
  readonly value?: unknown;
  readonly base?: unknown;
  readonly revision?: unknown;
  readonly writability?: string;
  readonly writable?: boolean;
}

/**
 * The owner-supplied config form face, and the settings controller face.
 *
 * Both are tolerated by the same reader: the owner hands the row page a resolved
 * `{ state, mutate }` snapshot plus one atomic write, while `configForms.get(ns)`
 * returns a controller with `getSnapshot()`. `subscribe` exists on only one of them.
 */
interface DshConfigForm {
  readonly state?: DshConfigSnapshot;
  getSnapshot?(): DshConfigSnapshot;
  subscribe?(listener: () => void): (() => void) | undefined;
  mutate?(ops: ReadonlyArray<{ op: string; path: string[]; value: unknown }>, revision: unknown): unknown;
}

/**
 * The `configForms` service.
 *
 * Keyed by settings **namespace** (the patch id, `session-metrics`), not by the
 * Loader entry id (`include:session-metrics`): the wrong key returns a controller
 * whose value layer is unavailable, which is silent rather than loud.
 */
interface DshConfigFormsService {
  get(namespace: string): DshConfigForm | null | undefined;
  describe?(): unknown;
}

/** The `sessions` service, limited to the one call this plugin makes. */
interface DshSessionsService {
  refreshProjections(sessionId?: string): unknown;
}
