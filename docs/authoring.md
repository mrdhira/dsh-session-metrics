# Authoring and validating a DSH Web plugin client half

Everything here was learned by shipping one and watching it stay invisible for
hours. It is written down because none of it is discoverable from the UI, and
because the failure mode is silent by construction.

## The shape of a bundle's client half

```js
window.__ModuleLoader__.load({
  id: 'dsh-session-metrics',          // MUST equal the package name
  factory(require) {
    const React = require('react');   // the only module in the browser table
    function apply(ctx) { /* register slots here */ }
    return { name: 'dsh-session-metrics', inject: ['slots'], apply };
  },
});
```

No JSX, no TypeScript, no imports, no build step: the file the host serves is the
file on disk. `package.json` points at it with `exports["./client"]`.

Inside `apply`, register into a slot the owner declares:

```js
ctx.slots.inject('conversation.input.dock', () =>
  ctx.slots.register({ name: 'conversation.input.dock', id: 'my-id', order: 20 }, MyComponent));
```

## The five rules that decide whether it renders at all

1. **Register only the options the slot declares.** Read them from the inspector:
   a `list` slot takes `id` / `order` / `label`, a `keyed` slot takes `key`. Passing
   an `inject` to a slot that does not declare it can replace the component's
   framework props — `useProjection`, `sessionId` — leaving it with nothing to read.

2. **Never read an undeclared service as a property.** On the restricted client
   context, `ctx.sessions` throws `cannot get property "sessions"`. Only services
   named in the plugin's `inject` may be properties. Everything else:

   ```js
   const sessions = (() => { try { return ctx.get('sessions'); } catch { return undefined; } })();
   ```

3. **Attach your own error boundary.** A component that throws is *abdicated*: the
   framework removes it from the slot's entry list for the rest of the
   registration's life while leaving it on the registration ledger. The result is an
   entry that looks installed and healthy and renders nothing. A boundary keeps the
   entry alive and prints the reason where someone can read it.

4. **Never return nothing.** A component that renders `null` is indistinguishable
   from one that crashed. Render the metrics or a diagnostic that names what is
   missing.

5. **Do not depend on a projection key of your own invention.** Shipped client
   packages read projections they declare; a third-party client half that needs host
   data should use a **Remote** (see `dsh-skills-manager`, which injects
   `['slots','sessions','remote','remote.skills']`) or read the store's erased path.
   If you do use `props.useProjection`, treat an absent key as "no data yet" and
   show the diagnostic.

## Validation recipe

The registration listing is **not** evidence. These are:

| check | command | pass condition |
|---|---|---|
| does the entry actually render? | `cordis_inspect_query` client `Slots` `listSubTree` `root=<slot>` | your entry listed with `active: true` |
| did the Host half activate and serve config? | host `Config` `listConfigs` | `status: "schema"` (not `unsupported`) |
| did the Host fold produce state? | read `~/.dsh/storages/session_projcache/sessions/<id>.json` | a row for your key with a plausible `val` |
| does the view survive the wire schema? | a test that runs the real `view` output through `viewSchema.parse` | no throw |

`active: false` next to a listed entry means **abdicated = crashed**. Treat it as a
failure, never as noise.

## Reloading after a change

Client bundles are served at **content-hashed, immutable URLs**, and the server
rejects a mismatched revision instead of serving newer bytes. So editing a client
file and reloading the page can still run the previous generation. Rebuild the graph
by toggling the bundle — `plugin_manager set_bundle` off, then on — which the running
page picks up without a reload. Host-side files are cached per row for the life of
the process and need an app restart.

## Test harness requirements

A jsdom harness must model the restricted context, or it will pass code that cannot
run in the browser:

- reading an undeclared service as a property **throws** (see rule 2);
- a failing assertion must never receive a DOM node as its actual value — the
  runner inspects it, walking React's fibers and jsdom's getters, which can allocate
  gigabytes from one failure;
- run everything under a memory cap (`~/.dsh/scripts/guard/guard.mjs`).

## The configuration-page prop (learned the hard way)

The `PluginConfigViewProps` interface is **type-only** — it appears in no shipped
JavaScript, so its runtime shape has to be read out of the owner
(`dsh-client-ui-plugin-manager`). An occupant of `plugins.row.config` or
`plugins.bundle.config` receives:

```js
{
  view: 'summary' | 'page',
  form: { state, mutate } | undefined,
}
```

- `state` is the resolved snapshot: `{ value, base, user, revision, writability, persistence }`.
  There is **no `getSnapshot()`** — a page that requires one rejects the real form and
  falls back to read-only, which is what happened here.
- `mutate(ops, revision)` performs one atomic write; pass the `revision` read when
  editing began so a concurrent change is refused rather than silently overwritten.
- `form` is `undefined` when the Host serves no namespace for the entry the owner
  looks up. The owner resolves one for a **row** page (`formFor(openRow.rowId)`), so an
  occupant registered on `plugins.bundle.config` — keyed by package name — normally
  gets none and must say so rather than render a broken editor.
- An unresolved service can be `null` as well as `undefined`; check both before
  reading a property off it.

## Language: TypeScript, built with esbuild

This plugin is the reference layout: `src/**` is the source of truth, `lib/**` is generated
by `npm run build`, and the tests import the **built** files so a green suite means the
shipped bytes work. `src/client/index.cts` is CommonJS on purpose — the loader's factory
returns `module.exports`, and `.cts` keeps esbuild from treating it as ESM under
`"type": "module"`. `npm run typecheck` runs two projects: `tsconfig.json` is `strict` for
the domain modules, `tsconfig.dynamic.json` covers the browser half and the dynamic schema
shim (`src/host/zod.ts`, `@ts-nocheck` with its compensating tests named in the file).
The packaged app ships no `.d.ts`, so `types/dsh.d.ts` declares the surfaces this plugin
actually uses.

## History: TypeScript is the norm, via a build step

Community and official practice is TypeScript bundled to the loader's format:

- host half: `src/index.ts` → `lib/index.js` (ESM, `@deepseek-ai/dsh-*` external);
- browser half: `src/client/index.tsx` → `lib/client.js`, esbuild `format: 'cjs'`,
  `platform: 'browser'`, wrapped in the factory handshake —

  ```js
  banner: { js: "window.__ModuleLoader__.load({ id: '<pkg>', factory: (require) => { var module = { exports: {} }; var exports = module.exports;" },
  footer: { js: 'return module.exports; } });' }
  ```

  with `react`, `react-dom`, `scheduler` and `@deepseek-ai/dsh-*` externalized. A
  hand-written plain-JS file with the same handshake is equally valid and needs no
  build; the one hard rule is **no cross-plugin value imports** (type-only imports are
  fine) because the client's bundle-purity gate rejects them.

Reference build: <https://github.com/FSMargoo/dsh-at-file/blob/main/build.mjs>.
Interface guide: <https://developer.aliyun.com/article/1767674>.

Types would not have caught the failures recorded here — every one was a runtime
contract (`ctx` property access, an abdicating crash, a prop shape). They do help
with ordinary authoring.

## Editable settings require `.volatile()`

`dsh-settings` exposes **only volatile fields** from active, uniquely addressed
profile entries. A schema without any is read-only in every hosted form, which is
exactly how this plugin's Pricing section appeared as a bare YAML block.

```js
const Config = z.object({
  budget: z.object({ … }).withDefault({}).volatile(),   // a fixed object path
  providers: z.array(provider).withDefault(SHIPPED).volatile(),
});
```

The constraint that shapes the design: the Host's projector throws
`volatile fields require a fixed object path without an enclosing volatile field`,
and array/union/`inner` children are visited **blocked**. So a rate row inside
`providers[].models[]` can never be individually volatile — the editable unit is the
whole `providers` value, and a per-rate UI has to be a custom card (the
`settings.plugin.item` slot, keyed by namespace, reading through `ctx.settingsScope`
with its `value` / `base` / `user` layers) rather than generated fields.

## `lib/**` is a generated mirror, and the tests depend on it

The host half is built **per module** (`bundle: false`, `outdir: lib/v1`) rather than
bundled, so `lib/v1/<name>.js` mirrors `src/host/<name>.ts` one-to-one and the tests can
import real build artifacts instead of sources or stale copies. The Loader imports the entry
with `await import(pathToFileURL(...))`, so the entry's relative sibling imports resolve
normally.

This is not academic. While the host half was bundled, `lib/v1/*.js` still held
hand-written pre-port files; five test files imported those, and the suite validated code
that was no longer in the shipped bundle — green, and wrong. `test/build.test.js` now fails
when a source is newer than its artifact, and when a shipped file imports something the
package does not publish.

Two consequences worth remembering:

- `npm test` runs `pretest` → `npm run build`. A bare `node --test` on edited sources
  rejects them, which is the intended signal.
- The browser half stays a single bundled file: it is fetched as one immutable URL, so it
  cannot rely on sibling resolution.

## What the suite does and does not cover

- `test/build.test.js` — artifacts mirror sources, are fresh, and resolve inside the package.
- `test/parity.test.js` — the browser half's embedded cost arithmetic against the host's,
  across a matrix of cards, tiers and token mixes, driven through the shipped bundle.
- `test/pricing.test.js`, `settings.test.js`, `ledger.test.js` — the pure host logic.
- `test/replay.test.js` — a real session log, comparing the ledger against the official
  `tokenUsage` fold. It uses a `maybe(...)` wrapper and **skips when `DSH_SESSION_LOG` is
  unset**; the runner reports those skips rather than passing them silently.
- `test/client.dom.test.js`, `test/pricing-page.dom.test.js` — the two client surfaces under
  jsdom through a stub loader that mirrors the restricted context.

Typing is deliberate and uneven: the host domain modules are `strict`, while the dynamic
schema shim (`src/host/zod.ts`) is `@ts-nocheck` and the browser half is checked without
implicit-any gates — DSH publishes no client-slot prop types. The tests are JavaScript on
purpose: they must exercise the built artifacts, and they assert on primitives.
