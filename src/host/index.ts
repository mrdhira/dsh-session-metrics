/**
 * Host half of the session-metrics plugin.
 *
 * Registers one session projection, `sessionMetrics`, carrying two things the
 * client needs and cannot derive: the **resolved settings** (per-provider rate
 * cards and billing calendars) and the **per-step ledger** (which model served
 * each step, and its token buckets).
 *
 * Session token totals are intentionally absent: the client reads them from the
 * authoritative `tokenUsage` projection so the two can never disagree. Money is
 * absent too — the client prices the ledger rows from the settings, so editing a
 * rate changes the displayed cost without re-folding any history.
 *
 * `Config` is exported so the Host validates and serves this row's configuration;
 * its `~standard` member is an own enumerable property (see `settings.js`) because
 * a loader that copies own enumerable exports would otherwise drop it and leave
 * the row permanently failed.
 */

import { Config, resolveSettings } from './settings.js';
import { createLedgerApply, initLedgerState, toLedgerView } from './ledger.js';
import { findCard, tierAt } from './pricing.js';
import { sessionMetricsWireSchema } from './schema.js';

export { Config } from './settings.js';

/** Cordis plugin name. */
export const name = 'session-metrics';

/** The projection registry is the point of the plugin; without it the fiber waits. */
export const inject = ['sessionProjections'];

/** The name of the embedded skill registered for the agent. */
const SKILL_NAME = 'session-metrics';

/**
 * The instruction body the agent receives. Kept short: it points at the
 * projection and the config rather than restating the README.
 */
const SKILL_CONTENT = `# session-metrics

The \`sessionMetrics\` projection on this deployment reports, per session, the
**cost** of the conversation and the **billing window** it ran in. It is
deliberately complementary to the shipped stats pills: the pills own turns,
steps, tok/s, token totals, cache-hit rate and context; this plugin owns money,
cache savings, the peak/off-peak tier, the provider and the budget.

## Where the numbers come from

| reading | source |
|---|---|
| token totals | \`tokenUsage\` projection (\`uncachedInputTokens\`, \`cacheReadTokens\`, \`cacheWriteTokens\`, \`outputTokens\`) |
| provider, model | \`modelSelection\` projection |
| per-step ledger, billing tier | \`sessionMetrics\` projection (this plugin) |
| cost, cache savings | computed in the client as buckets x configured rates x tier |

DSH reports \`inputTokens\` **exclusive** of cache reads, so never subtract the
cached count from the input count again — that is the raw provider formula and
would undercount.

## Configuring rates

Rates live per provider and per model in this plugin's Config, editable from the
Plugins sidebar (the \`dsh-session-metrics#session-metrics\` page) or in the
profile's \`cordis.patch.yml\`. Each model needs either a \`flat\` rate row or a
\`peak\` row with an optional \`offPeak\` row or \`multiplier\`. A provider with no
\`billing.windows\` is priced flat and shows no peak chip.

A model or provider with no rate card reports \`unpriced\`: tokens are still
shown, but no cost is invented. The ledger also keeps \`discovered\`: the
provider/model pairs a session actually used with no card, deduped and bounded,
which the panel lists under **Seen, unpriced** so a new integration is never
silently invisible. A model the provider designates free ships a zero-rate card,
so it prices to exactly \`$0.00\` rather than \`unpriced\`.
`;

/**
 * Register the projection and the embedded skill.
 * @param ctx - host context.
 * @param rawConfig - the row's configuration, resolved leniently here so a typo
 *   can never stop activation.
 */
export function apply(ctx: any, rawConfig: any) {
  const settings = resolveSettings(rawConfig ?? {});
  const billingById = new Map(settings.providers.map((provider) => [provider.id, provider.billing]));
  const tierFor = (providerId: any, dateMs: any) => {
    const billing = billingById.get(providerId);
    return billing === undefined ? 'flat' : tierAt(new Date(dateMs), billing);
  };

  const fold = createLedgerApply({
    tierFor,
    // The fold stays pure: pricing knowledge is injected as a predicate over the
    // resolved settings, so the ledger itself never reads configuration.
    hasCard: (providerId: any, modelId: any) => findCard(settings.providers, providerId, modelId).model !== null,
  });

  ctx.sessionProjections.register({
    key: 'sessionMetrics',
    stateVersion: 1,
    stateSchema: { parse: (value: any) => value },
    // Both halves stay pure: `init` builds a fresh state per session and `apply`
    // returns a new state, so no variable is shared between sessions.
    init: () => initLedgerState(),
    apply: (state: any, event: any) => fold(state, event),
    wire: {
      viewSchema: sessionMetricsWireSchema,
      view: (state: any) => ({ version: 1, settings, ledger: toLedgerView(state) }),
    },
  });

  // The skill is optional: a composition without the registry simply skips it.
  ctx.inject(['skills'], (injected: any) => {
    injected.skills.register({
      name: SKILL_NAME,
      description:
        'Session cost and billing window: per-provider rates, cache savings, peak/off-peak tier and budget for the DeepSeek Harness session metrics plugin.',
      content: SKILL_CONTENT,
      invocation: { modelInvocable: true, userInvocable: true },
    });
  });
}
