# dsh-session-metrics

Session **cost and billing** metrics for the DSH Web GUI.

It answers three questions the shipped status pills do not: **what did this conversation cost**,
**what did the cache save**, and **am I in peak or off-peak billing hours right now**. It is built
as a companion to those pills, never a duplicate — token totals, context usage, turns and tok/s
still belong to the pills and stay there.

## What you get

A strip below the composer, in the same seat as the shipped status pills:

| Chip | Shows |
|---|---|
| `cost` | the session's cost in USD, or `unpriced` when no rate card matches |
| `saved` | what cache hits saved versus paying the cache-miss rate |
| `▲ PEAK HOURS` / `● OFF-PEAK` | the billing tier **now**, with your local time and zone — no click needed |
| provider | shown when it is not your configured primary provider |
| `budget` | progress against an optional per-session ceiling |

Click it to open the detail: cost breakdown (cache-hit / miss / write / output), cache savings and
blended rate, the rate window with a countdown to the next change, cost per step, cost per model when
a session switched models, and the projections each figure came from.

Every chip is optional and reorderable — see [Configure](#configure).

## Two guarantees

**A number is never invented.** A provider or model with no rate card reads `unpriced`: tokens are
still shown, no cost is fabricated. A free model is the opposite case — it ships a card of zeros and
reads a real `$0.00`, because *zero* and *unknown* are different claims and must not render alike.

**A new provider is never silent.** Integrate a provider and use it before its rates are configured,
and the session detail says so: a **Seen, unpriced** section lists every provider/model pair the
ledger actually observed, with the tokens it used, so you can go add the card. Nothing is hidden, and
the session tells you rather than leaving you to guess why a cost is missing.

## Install

The plugin is installed into your DSH **profile** — the same place DSH itself keeps its bundles — by
linking it as a dependency. It is not published to npm, so the clone is the source.

**1. Clone somewhere stable.** The path becomes your install path, so avoid a temporary directory:

```bash
git clone https://github.com/mrdhira/dsh-session-metrics.git ~/.dsh/plugins/dsh-session-metrics
cd ~/.dsh/plugins/dsh-session-metrics
```

**2. Install and build.** `pnpm install` fetches esbuild and runs the `prepare` script, which builds
the plugin. The built `lib/**` is the part DSH actually loads, and it is generated — never hand-edit
it.

```bash
pnpm install
```

**3. Register it with your profile.** In your profile's `package.json` (the one that lists the
bundles DSH starts with), add the dependency and the bundle name. Use an absolute path:

```json
{
  "dependencies": {
    "dsh-session-metrics": "link:/Users/<you>/.dsh/plugins/dsh-session-metrics"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-session-metrics"
      ]
    }
  }
}
```

**4. Install the link, then restart DSH:**

```bash
cd ~/.dsh/profiles/desktop && pnpm install
```

The bundle's Loader row is declared in its own `cordis.patch.yml`, so there is nothing to add by hand.

> **Restart, don't reload.** The host half of a plugin is loaded once per app process, so a host-side
> change needs a full quit and reopen (`⌘Q`, then reopen) — a page reload does not pick it up. A
> client-side (UI) change needs the bundle toggled in the plugin manager.

### Verify it is really working

The chip should appear under the composer immediately. If it does not, check that:

- `lib/v1/index.js` and `lib/v1/client.js` exist — if not, `pnpm install` did not finish building;
- the profile's `package.json` names `dsh-session-metrics` in **both** `dependencies` and
  `dsh.profile.bundles`;
- DSH was **restarted** after installing (a host half loads once, at startup).

An `unpriced` chip is a working install with no matching rate card — not a failure. See
[Configure](#configure).

## Configure

**A fresh install needs no configuration.** Rate cards ship for `deepseek-account`,
`deepseek-official`, `netra-runtime` and `openrouter`, so the cost chip works right away. OpenRouter
ships **only the models its own catalog marks free** (the `:free` suffix and the free-models router)
at zero rates; its paid models deliberately carry no card, because DSH reports no prices for them.

Rates are edited in the GUI: **Plugins sidebar → `dsh-session-metrics`**. The same table can be set in
your profile's `cordis.patch.yml`:

```yaml
- id: session-metrics
  name: dsh-session-metrics
  config:
    display: { currency: USD, primaryProvider: deepseek-account }
    budget: { sessionUsd: 5, warnAt: 0.75 }
    providers:
      - id: my-router
        models:
          - model: some/model
            rates: { flat: { cacheHit: 0.01, cacheMiss: 0.1, output: 0.25 } }
        billing: { windows: [] }      # no peak concept
```

Rates are USD per 1M tokens. A model takes **either** a `flat` row **or** a `peak` row with
`offPeak`. A provider with no `billing.windows` is flat and shows no peak chip.

> **A `providers:` list in your patch replaces the shipped cards** rather than adding to them. Pin your
> own providers and the OpenRouter free cards stop shipping with them — add a card for each pair you
> need, or let **Seen, unpriced** name the ones you missed.

Common settings:

| Setting | Default | What it does |
|---|---|---|
| `display.currency` | `USD` | `USD` or `CNY` |
| `display.primaryProvider` | — | hides the provider chip when the session uses this provider |
| `display.chips` | all | which chips to show, and in what order |
| `budget.sessionUsd` | off | per-session ceiling; omit to disable |
| `budget.warnAt` | `0.75` | fraction of the budget at which the strip warns |

The full rate-card format, the shipped cards and the reasoning behind them are in
[`docs/pricing.md`](docs/pricing.md).

## How it works

Costs are derived from the Host's own `tokenUsage` projection — the same source the stats pills read —
so this plugin adds interpretation, not a second ledger. Cache savings compare each cache-hit token
against the rate you would have paid on a miss, per the card in effect. Peak and off-peak windows are
resolved in the provider's own timezone, holidays included, and the countdown is computed once a
minute while the detail view is open rather than on every render.

[`docs/data-sources.md`](docs/data-sources.md) records exactly which projection feeds which figure,
which is what keeps this plugin and the shipped pills from drifting back into duplication.

## Requirements

- **DSH** with the Web GUI, and a profile you can edit (`~/.dsh/profiles/<profile>/`).
- **Node.js 22+** and **pnpm** to build from source. The built artifact needs nothing extra at runtime.

## Development

```bash
pnpm install                  # installs deps and builds (prepare)
pnpm run build                # rebuild lib/**
pnpm test                     # 111 tests: 105 pass, 6 skipped without a session log
pnpm run typecheck            # three projects: host, browser half, tests
pnpm run test:fast            # host logic only — the quick loop
pnpm run test:dom             # the UI half under jsdom
DSH_SESSION_LOG=<path>.jsonl.zstd pnpm run test:replay   # replays a real session
```

The six skipped tests are the replay ones; they need `DSH_SESSION_LOG` pointing at a real recorded
session (`.jsonl.zstd`). With one, the suite is **111/111**.

```
src/host/*.ts         host half: config schema, projection, ledger, pricing  -> lib/v1/index.js
src/client/index.cts  browser half: strip, detail panel, pricing page        -> lib/v1/client.js
types/dsh.d.ts        the DSH surfaces this plugin uses (the app ships no .d.ts)
build.mjs             esbuild: ESM host half, CJS browser half + loader handshake
```

**Build before you test.** The tests import the generated `lib/**`, so a run against a stale build is
green and wrong. `pnpm test` builds for you via `pretest`.

### Memory discipline

Two defects once drove a developer machine to ~170 GB of resident memory, so the suite is capped
rather than trusted:

- **Never let a DOM node be an assertion's actual value** — compare primitives
  (`assert.ok(node === null)`, `assert.equal(list.length, 3)`). A failing node comparison makes the
  test runner walk React's fiber tree and allocate without bound.
- **Cap the process.** `scripts/guard.mjs` watches the whole process tree's resident memory and kills
  it past the limit (exit code **124**). `--max-old-space-size` alone bounds V8's heap, not native
  allocation. Run the suite through the scripted entry points, which carry the caps, and one run at a
  time.

Measured on Node v24: host tests peak ~70 MB, the DOM file ~180 MB, and the full suite with a real-log
replay **277 MB under a 1 GB limit**.

## Agent skill

Installing the plugin also registers an agent skill, `session-metrics`, so an agent can explain the
figures and reconfigure the rates without reading the source.

## Contributing

Issues and pull requests are welcome. `AGENTS.md` describes the project's conventions and the gates a
change must pass — build, typecheck and the test suite — before it can be merged.

## Licence

[MIT](LICENSE) © Dhira Wigata