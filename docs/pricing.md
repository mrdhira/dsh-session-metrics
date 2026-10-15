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
- **Never subtract the cached count from the input count.** DSH already does it:
  measured across every session available, `totalTokens = inputTokens +
  cacheReadTokens + cacheWriteTokens + outputTokens` exactly. `inputTokens` *is*
  the uncached count. The raw provider formula (`uncached = prompt − cached`)
  applies before DSH normalises it, not after.
- **Money is integer nanodollars in plain numbers**, never `BigInt`: a
  projection's state is checkpointed and the checkpoint schema refuses anything
  `JSON.stringify` cannot carry.
- `cacheWrite` defaults to the cache-miss rate when not stated.

## Shipped defaults

| Provider | Model | cacheHit | cacheMiss | output | Window |
|---|---|---:|---:|---:|---|
| `deepseek-account` | `deepseek-flash` | 0.006 | 0.30 | 1.20 | peak, off-peak x0.5 |
| `deepseek-account` | `deepseek-v4-pro` | 0.044 | 1.32 | 3.96 | peak, off-peak x0.5 |
| `deepseek-official` | same two cards | | | | peak, off-peak x0.5 |
| `netra-runtime` | `deepseek/deepseek-v4.1-flash` | 0.01 | 0.10 | 0.25 | flat |
| `netra-runtime` | `deepseek/deepseek-v4-flash-0731` | 0.01 | 0.10 | 0.25 | flat |

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
