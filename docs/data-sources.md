# Where every number comes from

This plugin shows only what the shipped stats pills cannot. This document is the
map, so no future change re-duplicates them — and so a reader can trace any
figure to its projection.

## What the shipped stats pills already show

Recorded here because it is not discoverable anywhere in the UI: the pills' three
sections and their detail fields.

| Section | Label | Detail fields |
|---|---|---|
| Session Statistics | `xx turns · xxx steps · xxx tok/s` | LLM Time, Tool Time, AVG TTFT, TPS |
| Token Usage | `xxx tok · Cache hit xx.x%` | Token Usage, Cache Hit, Uncached Input, Cached Input, Output |
| Context Used | `xx%` | % Context Used `xxK/xxM`, System Prompt, Tool Definitions, messages |

**This plugin must never render:** session token totals, cache-hit rate, context
percentage or composition, turns, steps, or tok/s.

## Projections this plugin reads

| Projection | Owner | Fields used |
|---|---|---|
| `tokenUsage` | `@deepseek-ai/dsh-token-meter` | `uncachedInputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens` |
| `modelSelection` | session controller | `lastUsed.provider`, `lastUsed.model` |
| `sessionMetrics` | **this plugin** | session cost inputs: per-step ledger rows, `provider · model · tier` bucket groups, and `discovered` — the pairs used with no rate card |

Projections this plugin deliberately does **not** read: `sessionStats`,
`contextPressure`, `contextBreakdown` — the pills own those.

None of these projection keys appear in the Plugins page or the built-in plugin
inventory. The inventory (`Settings → Built-in plugins`) lists Loader **rows** by
module name, so `@deepseek-ai/dsh-token-meter` and `@deepseek-ai/dsh-session-stats`
are visible there as rows of the `dsh-base` and `dsh-web-app` bundles — but the
projections themselves are surfaced nowhere. That is a real gap in DSH, not a
misunderstanding on the reader's part.

## Token bucket semantics — verified, not assumed

A provider's raw API may report cached tokens as a *subset* of prompt tokens
(Netra does). DSH normalises that: measured across all eight sessions available on
2026-10-15, for both `deepseek-account` and `netra-runtime`:

```
totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens   (exact, every sample)
```

So `inputTokens` **is already the uncached count**. Never subtract the cached
count from it — that is the raw provider formula and would undercount by roughly
the cache-hit ratio.

## Cost formula

```
cost(step) = cacheRead x cacheHitRate
           + (uncachedInput) x cacheMissRate
           + cacheWrite x cacheWriteRate
           + output x outputRate
total      = sum over every step, each priced at its own model's and tier's rate
saved      = cacheRead x (cacheMissRate - cacheHitRate)
tier       = flat | peak | off-peak, from the provider's own calendar
```

Money is held as integer **nanodollars in plain numbers**, never `BigInt`: a
projection's state is checkpointed and the checkpoint schema refuses anything
`JSON.stringify` cannot carry. 2^53 nanodollars is about 9,000,000 USD, so a
session is always a safe integer.

## Spike 0 findings (recorded so they are not rediscovered)

Verified live on 2026-10-15 against the running app.

### 1. Exporting `Config` does not break activation — if the schema is branded

`Config` may be exported from the entry, and Cordis validates the row's config
before activating. Two traps, both hit for real:

- **`~standard` must be an own enumerable property.** A prototype getter is
  dropped by the loader, and Cordis then throws
  `Cannot read properties of undefined (reading 'validate')`.
- **The row passes `undefined` when it has no `config:` key.** A bare object
  schema rejects that as `<root> is required`, leaving the entry permanently
  failed. Fixed two ways: `.withDefault({})` on the root schema, and an explicit
  `config: {}` on the row.

### 2. The Host only serves config for a *native* (Schemastery-branded) schema

`@deepseek-ai/dsh-tool-cordis` decides with a duck-typed brand check, not
`instanceof`:

```js
const meta = Reflect.get(value, "meta");
return Reflect.get(value, Symbol.for("schemastery")) === true
    && typeof Reflect.get(value, "type") === "string"
    && meta !== null && typeof meta === "object";
```

Anything else is reported as `status: "unsupported"`, and an unsupported entry
gets no served config namespace — which is what a Plugins-sidebar configuration
page needs in order to read and write. `@deepseek-ai/schemastery` is **not**
resolvable from a profile package (`ERR_MODULE_NOT_FOUND`; the profile's
`node_modules` holds only the linked user packages), so a plugin must satisfy the
brand itself.

The Host's projector (`createConfigProjector` in `@deepseek-ai/dsh-app-boot`)
walks a branded node graph and reads exactly:

- **types:** `any`, `never`, `const`, `boolean`, `string`, `number`, `object`,
  `array`, `dict`, `tuple`, `union`, `transform`
- **fields:** `type`, `meta`, `value`, `dict` (object children), `inner`
  (array/dict child), `list` (tuple/union children)
- **meta keys:** `required`, `default`, `description`, `min`, `max`, `step`,
  `pattern`, `loose`, `volatile`

### 3. The app caches a plugin module for the life of the process

Once a row's module has been imported, editing it, changing `package.json`
`main`/`exports`, toggling the row, and re-installing the bundle all leave the
**already-imported instance** in place — Cordis keeps validating against the old
`Config`. A subpath specifier (`pkg/host`) does force a fresh import, but shipped
subpath rows resolve while a *profile* package's subpath failed to import. The
practical conclusion: **host-side code changes require an app restart.** Client
changes only need a page reload.

## The strip: label keys and their data

`display.labels` selects and orders the chips. Default:
`['peak', 'time', 'cost', 'saved', 'provider']`. Legacy aliases still resolve:
`window` expands to `peak` + `time`, `savings` to `saved`. `budget` is available but off by
default.

| key | renders | source |
|---|---|---|
| `peak` | `▲ ON PEAK HOURS` (up, error colour) or `▼ OFF PEAK HOURS` (down, success colour) | `tierAt(now, provider.billing)`; hidden entirely for a flat provider |
| `time` | `16:41 Tokyo` — 24-hour local time | the viewer's IANA zone, re-rendered on a minute-aligned tick |
| `cost` | `Cost $2.55`, or `unpriced`, or `< $0.01` below a cent | `priceSession().totalNano`, rounded half-up to cents |
| `saved` | `Saved $76.30` (hidden at zero) | `Σ cacheReadTokens × (cacheMiss − cacheHit)` |
| `provider` | `deepseek-account` | `modelSelection`, falling back to the ledger's newest row |
| `budget` | `Budget $2.55 / $5.00` | `display.budget.sessionUsd` |

The model name and the build tag were removed from the strip: the model is in the detail's
Model provider table, and the build id is in the detail footer.

## The detail panel: four sections, a discovery list and a footer

| section | columns | source |
|---|---|---|
| Cost breakdown | `Input` = uncached input **+** cache writes, `Output`, `Cached`; each with its cost, its token count, and a three-segment bar | `tokenUsage` buckets priced per ledger group |
| Saving breakdown | `Saved` (cached tokens × rate difference), `Blended rate` (total cost ÷ total tokens), `From cache reads` (cached cost ÷ total) | the priced groups |
| Model provider | `provider`, `model`, `peak hours` = `On` / `Off` / `None` (flat); an unpriced row also shows `unpriced` | ledger groups × the rate cards' billing calendars |
| Seen, unpriced (only when non-empty) | `provider · model` and the tokens seen, labelled `unpriced` — never a cost | `ledger.discovered`, the pairs observed with no rate card |
| Timezone | `Local time`, `Provider time`, `Peak hours` = `None — flat rate` / `Peak hours ongoing` / `Next peak in 2h 11m` | `billing.timezone` and the viewer zone |
| footer | build id, and the sources or any config problems | — |

The per-step table is gone from the UI. The ledger rows are still in the projection, so a
step-by-step view can return behind an explicit toggle without any host change.

Every figure that needs a sentence carries one in a `title` attribute; the three jargon
metrics (Saved, Blended rate, From cache reads) also render a `?` affordance so the
explanation is discoverable rather than hidden.
