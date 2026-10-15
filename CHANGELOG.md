# Changelog

All notable changes to this plugin. The version appears in the build id, so it identifies which
generation of the halves the app is running.

## [1.1.0] — 2026-10-15

### Added

- **Detail-page status badge** (`plugins.detail.badge`): providers, models and the current peak state
  beside the plugin title, gated to this plugin's own bundle and row subjects.
- **Model discovery**: a provider/model pair the ledger sees without a rate card is recorded (deduped,
  bounded) and shown as *Seen, unpriced* in the session detail. A newly integrated provider is visible
  before anyone configures it.
- **OpenRouter support**: a shipped `openrouter` provider with 20 zero-rate cards (the catalog's `:free`
  ids plus the free router). A free model now reads `$0.00` instead of `unpriced`; `openrouter/auto`
  stays unpriced because its routed model varies and any fixed rate would be a fabrication.
- **TypeScript test suite** (9 files plus the harness), a third `typecheck` project, and
  `strict: true` for the browser half with vendored DSH client types — **zero `any`** (was 40).

### Fixed

- **Settings namespace**: `configForms` is keyed by the settings namespace (`session-metrics`), not by
  the Loader entry id (`include:session-metrics`). The wrong id returned a controller whose value layer
  was unavailable, which is indistinguishable from "nothing configured" — this is what made the badge
  silently absent.
- **Badge scope**: the badge ignored its `subject`, and the slot owner renders every entry on all three
  detail pages, so the chip appeared on every other plugin's page.
- **Ledger state version**: the state shape and fold semantics changed without bumping `stateVersion`,
  so stored checkpoints were trusted and discovery would have been silently empty for every
  pre-existing session. Now `2`, which forces a refold.
- **Discovery accounting**: reports were summed while `totals` replaces, so an in-step retry claimed
  2058 tokens for a 60-token step and left rows for groups that no longer exist. Discovery now nets on
  the same path as `totals`; the field is `reports`.
- **Badge calendar**: a second calendar normalizer defaulted `weekdays` to `[]` against the schema's
  `[1,2,3,4,5]` and dropped `holidayZone`, so the badge could disagree with the strip. One normalizer
  now serves both.

### Changed

- `billingOf` removed in favour of the strip's normalizer; the badge reads its configuration through an
  optional `ctx.inject(['configForms'], …)` and renders nothing when the service is absent.
- Numeric labels and detail sections are deduplicated per model rather than per tier.
