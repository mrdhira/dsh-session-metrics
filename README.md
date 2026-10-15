# dsh-session-metrics

Session **cost and billing** metrics for the DSH Web GUI: what this conversation
cost, what the cache saved, and whether the current hour is peak or off-peak —
complementing the shipped stats pills instead of repeating them.

## What it adds

A strip below the composer, in the same seat as the shipped status pills:

| Chip | Shows |
|---|---|
| `cost` | the session's cost in USD, or `unpriced` when no rate card matches |
| `saved` | what cache hits saved versus paying the cache-miss rate |
| `▲ PEAK HOURS` / `● OFF-PEAK` | the billing tier **now**, with your local time and zone — no click needed |
| provider | shown when it is not your configured primary provider |
| `budget` | progress against an optional per-session ceiling |

A provider whose models are free renders `$0.00` (a real zero, from a zero-rate
card), not `unpriced`. `unpriced` means *no card*, and an unpriced pair is never
rendered as a number.

Clicking it opens the detail: cost breakdown (cache-hit / miss / write / output),
cache savings and blended rate, the rate window with a countdown to the next
change, cost per step, cost per model when a session switched models, and the
projections each figure came from.

## New providers and models are discovered, never silent

Integrate a provider and use it before its rates are configured, and the session's
own detail says so: a **Seen, unpriced** section lists every provider/model pair
the ledger actually observed with no rate card, with the tokens it used, and the
model table marks the row `unpriced`. Nothing is invented, and nothing is hidden —
the pair is named so a rate card can be added where rates are edited.

A free model needs a card of zeros, not the absence of one: the absence is what
prints `unpriced`. `docs/pricing.md` carries the details and the shipped cards.

## What it deliberately does not show

The shipped stats pills already own these, so this plugin never renders them:
session token totals, cache-hit rate, context percentage and composition, turns,
steps, or tok/s. `docs/data-sources.md` records exactly which projection feeds
which figure so the two can't drift back into duplication.

## Install

The plugin lives in the user profile, so every workspace on this machine gets it:

```
~/.dsh/profiles/desktop/dsh-session-metrics/
```

and is registered in that profile's `package.json`:

```json
"dependencies": { "dsh-session-metrics": "link:/Users/<you>/.dsh/profiles/desktop/dsh-session-metrics" }
```

Host-side changes need an app restart; client-side changes need a page reload.
(The running app caches a plugin module for the life of the process, so editing a
host file has no effect until restart — see `docs/data-sources.md`.)

## Configure

Rates ship for `deepseek-account`, `deepseek-official`, `netra-runtime` and
`openrouter`, so a **fresh install** needs no configuring; a profile patch that
lists its own `providers` replaces those shipped cards rather than adding to them
(see the note below). OpenRouter ships **only the
models its own catalog marks free** (the `:free` suffix, and the free-models
router) at zero rates; its paid models deliberately have no card, because the
profile lists no prices for them. To change a rate, either open the plugin's page
in the **Plugins** sidebar, or edit your profile's `cordis.patch.yml`:

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

A `providers:` list in your patch **replaces** the shipped cards rather than
adding to them, so a profile that pins its own providers stops shipping the
OpenRouter free cards with them. Add a card for the pair — or leave it out and
let the **Seen, unpriced** section name it (see above).

`docs/pricing.md` documents the full rate-card format, the shipped cards, the
free-model rule and the evidence behind Netra's rates.

## Develop

```bash
node --test "test/*.test.ts"                       # 103 tests
DSH_SESSION_LOG=<path>.jsonl.zstd node --test test/replay.test.js
```

The replay test compares this plugin's fold against a reimplementation of the
official `tokenUsage` projection over a real session log — it is what caught two
token-accounting bugs during development, and it is the guard that keeps the two
from disagreeing. `docs/data-sources.md` records the findings that shaped the
design, including the Host's native-schema requirement for a config page.


## Layout and commands

```
src/host/*.ts        host half: Config schema, projection, ledger, pricing   -> lib/v1/index.js
src/client/index.cts browser half: strip, detail panel, pricing page         -> lib/v1/client.js
types/dsh.d.ts       the DSH surfaces this plugin uses (the app ships no .d.ts)
build.mjs            esbuild: ESM host half, CJS browser half + loader handshake
```

`lib/**` is generated — never edit it. `npm run build` then `npm test` (`pretest` builds for you);
`npm run typecheck` gates three projects (host, browser half, tests).

**On a fresh clone, build before anything else.** The tests import `lib/**` and the test project's
typecheck resolves its types from those built bytes, so `lib/` must exist first — it is generated and
therefore not in the repository.

The strip shows, in order: peak state (`▲ ON PEAK HOURS` / `▼ OFF PEAK HOURS`), local time,
cost, cache savings and the provider. The detail panel shows a cost breakdown, a saving
breakdown, the provider/model table and the timezone comparison, with a tooltip on every
figure that needs one. Rates are edited on the plugin's component row (see below).

## Memory discipline

Two defects once took a developer machine to ~170 GB of resident memory. Both are
fixed, and the rules that keep them fixed are enforced by the test scripts.

**What happened.** A single integration test passed `sessionId: undefined`, which a
default parameter silently replaced, so its assertion failed — and the failing
assertion's `actual` value was a **React-rendered DOM element**. The runner's
assertion message inspects that value, walking React's fiber tree (whose props
carry the whole settings object and up to 200 ledger rows) and jsdom's getters, and
allocation ran away. Amplified by `node --test` spawning a child per file and by
several test runs overlapping in the background, it consumed the machine.

A second defect fed it: `nextBoundary()` constructed an `Intl.DateTimeFormat` for
every probed minute — up to 4,320 per call — and ran on **every render**, including
the one-second tick while the detail panel was open.

**The rules.**

1. **Never let a DOM node be an assertion's actual value.** Compare a primitive:
   `assert.ok(node === null)`, `assert.equal(list.length, 3)`,
   `assert.equal(node.getAttribute('x'), 'y')`. A failing node comparison is an
   unbounded allocation.
2. **Cap the process.** `--max-old-space-size` alone is not enough — it bounds V8's
   old space, not native allocation. `scripts/guard.mjs` watches the whole process
   tree's resident memory and SIGKILLs it past a limit (exit code 124):

   ```bash
   node scripts/guard.mjs --limit-mb 1024 -- node --max-old-space-size=384 --test ...
   ```

3. **Run the suite through the scripted entry points**, which carry the caps:
   `npm test`, `npm run test:fast`, `npm run test:dom`, `npm run test:replay`.
4. **One run at a time.** Never leave a suite running in the background while
   starting another.
5. **Do not scan for a boundary on every render.** The countdown is memoized to
   once a minute and computed only while the detail view is open; formatters are
   cached per zone.

**Measured** (Node v24, this suite): fast host tests 70 MB peak; the DOM file
180 MB; the whole suite with a real-log replay **277 MB peak under a 1 GB limit**.

## Building on it

`docs/authoring.md` records the contract for a DSH Web plugin's client half and the
validation recipe that actually reflects the running client — the acceptance signal
is the slot inspector's `active` flag, not the registration listing. It exists
because this plugin spent hours registered, reported healthy, and rendering nothing.

## Skill

The plugin registers an embedded agent skill, `session-metrics`, so after install
the agent can explain the figures and reconfigure the rates without reading the
source.

## Licence

MIT.
