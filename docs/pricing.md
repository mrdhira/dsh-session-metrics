# Pricing: rate cards, and how to get them right

## The shape

Rates are configured per **provider**, per **model**, in USD per 1M tokens:

```yaml
config:
  providers:
    - id: deepseek-account            # the id reported in the request header
      label: DeepSeek (account)
      models:
        - model: deepseek-flash
          aliases: [deepseek-v4-flash, deepseek-v4.1-flash]
          rates:
            peak: { cacheHit: 0.006, cacheMiss: 0.30, output: 1.20 }
            offPeak: { multiplier: 0.5 }     # or an explicit rate row
      billing:
        timezone: UTC                        # the zone the windows are written in
        weekdays: [1, 2, 3, 4, 5]
        windows: [[1, 4], [6, 10]]           # peak hours as [start, end)
        holidays: []                         # YYYY-MM-DD, charged off-peak
        holidayZone: Asia/Shanghai
```

A model takes **either** a `flat` row **or** a `peak` row (with `offPeak` derived
from `multiplier`, default 0.5). A provider with no `billing.windows` is flat and
shows no peak chip — that is how Netra is configured, because it has no peak
concept.

The same table is editable in the GUI: **Plugins sidebar → `dsh-session-metrics`**.
That page reads the schema-resolved configuration, so it shows the shipped cards
without duplicating them, and writes through the Host settings document with the
revision it read when editing began.

## Rules that keep it honest

- **Match by exact provider id**, then by model id or alias. A provider or model
  with no card reports **`unpriced`**: tokens are still shown, no cost is
  invented, and the strip never renders a fabricated `$0.0000`.
- **A free model needs a card of zeros, not the absence of a card.** `'0'` in
  every bucket is a rate that parses to 0 nanodollars, so a free session prices to
  exactly `$0.00`. An omitted card leaves `ratesAt` null, `priceBuckets` null and
  the strip reading `unpriced` — the same word a genuinely unknown provider gets,
  which would say "we do not know" about a model whose price is known to be zero.
- **Never ship a guessed paid rate.** The profile's model catalog lists ids, names
  and context windows, and no prices; a number invented for a paid model would be
  a fabricated bill. Paid models therefore ship without a card and are reported
  and discovered instead (below).
- **Never subtract the cached count from the input count.** DSH already does it:
  measured across every session available, `totalTokens = inputTokens +
  cacheReadTokens + cacheWriteTokens + outputTokens` exactly. `inputTokens` *is*
  the uncached count. The raw provider formula (`uncached = prompt − cached`)
  applies before DSH normalises it, not after.
- **Money is integer nanodollars in plain numbers**, never `BigInt`: a
  projection's state is checkpointed and the checkpoint schema refuses anything
  `JSON.stringify` cannot carry.
- `cacheWrite` defaults to the cache-miss rate when not stated.

## Discovery: an unconfigured pair is never invisible

A pair with no card is reported as `unpriced` in the strip and in the model
table, but that alone is a dead end: nothing on a configuration-only screen knows
which pairs have actually been seen, and the Pricing page cannot read session
data. So the host ledger keeps a second, small list.

- **Recorded where usage is attributed**, not at `request/header`: a header is a
  request that may never be billed, while a reported bucket set is spend that
  really happened and really cannot be priced.
- **Netted on replace, exactly like `totals`**: an in-step retry subtracts the
  report it replaces before banking the new one (and drops the pair when that was
  its last report), so the list never names a pair whose tokens no longer count.
- **Deduped by pair** and **bounded** (32 pairs): each row carries the pair, the
  total tokens seen, the number of reports (`reports`, not steps — one step can
  report twice and a replacement report counts once), and the first/last instants.
  The first pairs observed are the ones kept when the bound is reached.
- **Exposed on the existing projection** as `ledger.discovered` — same
  `sessionMetrics` channel, no new service and no change to any existing config
  field. The wire schema carries it, so a malformed row is refused at the
  boundary.
- **Surfaced in the detail panel** as a *Seen, unpriced* section listing each pair
  with its token count and the word `unpriced`, and as a visible `unpriced` marker
  on the model-table row. The section renders only when the list is non-empty, so
  a fully priced session looks exactly as it did.
- **Never rendered as a cost.** Discovery rows show tokens, never money: there is
  no rate to apply, and a zero would be a claim about a price nobody knows.

A pair with a card — including a free one at zero — is priced and therefore *not*
discovered. That is the difference the tests pin: a free session reads `$0.00`
and has an empty discovery list; a session on an integrated-but-unpriced pair
reads `unpriced` and appears under *Seen, unpriced*.


## Shipped defaults

| Provider | Model | cacheHit | cacheMiss | output | Window |
|---|---|---:|---:|---:|---|
| `deepseek-account` | `deepseek-flash` | 0.006 | 0.30 | 1.20 | peak, off-peak x0.5 |
| `deepseek-account` | `deepseek-v4-pro` | 0.044 | 1.32 | 3.96 | peak, off-peak x0.5 |
| `deepseek-official` | same two cards | | | | peak, off-peak x0.5 |
| `netra-runtime` | `deepseek/deepseek-v4.1-flash` | 0.01 | 0.10 | 0.25 | flat |
| `netra-runtime` | `deepseek/deepseek-v4-flash-0731` | 0.01 | 0.10 | 0.25 | flat |
| `openrouter` | the 19 `:free` catalog models, plus `free` (`openrouter/free`) | 0 | 0 | 0 | flat |

These are the **defaults for a fresh install**: a non-empty `providers` list in the profile's
`cordis.patch.yml` *replaces* this whole table rather than adding to it, so on this machine — where
the patch pins `openrouter` to two cards — only `nvidia/nemotron-3.5-lightning:free` and `free` are
carded and the other 17 `:free` catalog ids read `unpriced`.

### Why OpenRouter ships only free cards

The profile's `llm-pi-ai` catalog lists ~200 OpenRouter models with `id`, `name`,
`contextWindow` and `maxTokens` — and **no prices**. The only price signal it
carries is the provider's own free designation: the `:free` id suffix and the
`"(free)"` display name. Those 19 models (for example
`nvidia/nemotron-3.5-lightning:free`, the model `agent-default-model` configures)
ship a zero card while this table is the effective one (see the replacement rule above), so a
session on one prices to exactly `$0.00`.

The paid models deliberately ship no card. Their rates are not in the profile,
and a guessed number would be a fabricated bill; instead a session that used one
is reported `unpriced` and listed under *Seen, unpriced* (above), which is what
the discovery list exists for.

`free` is the provider's own free-models router: the catalog calls it
`openrouter/free`, while the request header strips the provider prefix (the same
session data records the catalog's `openrouter/auto` as the wire model `auto`),
so the card answers to both spellings.

### Why Netra uses 0.10 / 0.01 / 0.25

Netra's public docs publish `0.30 / 0.05 / 1.20`. Those are **stale**. Netra's own
authenticated catalog and the billing ledger agree on `0.10 / 0.01 / 0.25`: over a
24-hour window of 689 requests,

```
prompt_tokens      127,602,320
cached_tokens      122,940,672     (a subset of prompt)
completion_tokens      350,875
uncached             4,661,648

billed (cost_nanos)  1,783,290,270 nanodollars = $1.783290
live rates 0.10/0.01/0.25                      = $1.783290   exact
docs rates 0.30/0.05/1.20                      = $7.966578   4.47x too high
```

The live catalog reproduces the bill to the cent. If a rate card is ever in doubt,
reconcile against the billing ledger rather than the published table.

## The peak calendar

Peak windows are per provider and expressed in that provider's zone; the display
always converts to the viewer's zone. DeepSeek's published windows are 01:00-04:00
and 06:00-10:00 UTC on weekdays, with a half-price off-peak rate, and Chinese
public holidays charged off-peak.

The strip shows the tier **for the current instant** so it needs no click; the
cost is priced **per step**, at that step's own model and tier, so a session that
crossed a window boundary or switched models is not averaged into a wrong number.
