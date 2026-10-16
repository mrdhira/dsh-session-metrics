# AGENTS.md — dsh-session-metrics

Project-level instructions. These **add** to `~/.dsh/AGENTS.md` (the user-global brain) and never
weaken it. Precedence, always: safety > truth > persona.

## Who commits

**Every commit in this repository is authored and committed by Dhira Wigata
`<dwigata.putra@gmail.com>`. Nobody else is credited.**

This is a rule, not a preference:

1. **No `Co-authored-by`.** Ever. Not for an agent, not for a teammate, not for a pair-programming
   session. The trailer implies shared authorship of a claim this repository makes about one person.
2. **No agent bylines or footers.** `Generated with …`, `🤖 Generated with …`, `Assisted-by:`,
   `Co-developed-by:`, `Generated-by:` — none of them, in the subject or the body.
3. **Agents assist; they do not author.** Work an agent did is described in the commit *body* as
   prose ("Evidence: …"), never as an authorship trailer.
4. **`Signed-off-by:` is allowed** — it is Dhira's own sign-off (`git commit -s`), not a second author.
5. **CI is the gate.** `.github/workflows/ci.yml` checks the whole history — one identity, no
   authorship trailers — and runs build, typecheck and the suite. There is no local hook: the rule is
   checked where it cannot be skipped (`--no-verify` does not reach CI).

Identity is set **repo-locally**, so it applies here and nowhere else:

```bash
git config --local user.name  "Dhira Wigata"
git config --local user.email "dwigata.putra@gmail.com"
```

### Why

History was rewritten once because all eleven commits carried
`J.A.R.V.I.S. <jarvis@dsh>` as author *and* committer — a machine identity publishing under Dhira's
GitHub account. See `tasks/lesson.md` in `~/.dsh` for the incident anchor, and
`~/.dsh/rules/GIT-AUTHORSHIP.md` for the rule.

## The loop — how work happens here

```
SCOPE    one task folder, one write scope, one owner.
ACT      the smallest correct change. No feature nobody asked for.
VERIFY   a gate that can actually run: build + typecheck + tests against built output,
         and the slot inspector for a client half.
LEARN    a correction becomes durable (a rule or a doc), never a chat apology.
STOP     acceptance met, or the same failure twice — then re-plan, never grind.
REPORT   changed / why / evidence / unverified.
```

## Gates

- **Cap every `node` run through the guard.** `scripts/guard.mjs` is a byte-identical copy of the
  canonical `~/.dsh/scripts/guard/guard.mjs`; a structure check fails if they diverge.
  512 MB for pure logic, 1 GB for the DOM/replay suites. **Exit 124 means the cap was hit — bisect,
  never raise it.** One run at a time.
- **Tests import built artifacts.** `pnpm run build` first. `lib/**` is generated and gitignored; a
  fresh clone has none, and a test run against a stale `lib/` is green and wrong.
- **`lib/**` is never hand-edited.** Custom plugins are authored in TypeScript and built with esbuild.
- **A client half is not done until the slot inspector says `active: true`.** A registered, "healthy"
  entry that renders nothing is the exact failure this rule exists for.
- **Client change → toggle the bundle. Host change → restart the app.** A page reload does neither.
- **Never assert on a DOM node.** Compare primitives (`assert.ok(node === null)`); walking a failing
  React/jsdom node's fibers allocated gigabytes and forced a power-off.

## Layout

```
src/host/*.ts         host half: config schema, projection, ledger, pricing  -> lib/v1/index.js
src/client/index.cts  browser half: strip, detail panel, pricing page        -> lib/v1/client.js
types/dsh.d.ts        the DSH surfaces this plugin uses (the app ships no .d.ts)
build.mjs             esbuild: ESM host half, CJS browser half + loader handshake
docs/authoring.md     the client-half contract and the validation recipe
docs/data-sources.md  which projection feeds which figure, and why
docs/pricing.md       the shipped rate cards and the rules behind them
```

## Deployment

The plugin is `private: true` and **not published to npm** — it is installed into the DSH profile by
link. Changing it changes the running app on this machine:

- Host-side change → **restart the app** (`⌘Q` and reopen).
- Client-side change → **toggle the bundle** in the plugin manager.

`README.md` §Install carries the link recipe.