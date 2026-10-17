/**
 * Headless visual capture of the session-metrics strip and its detail popover — both
 * themes, committed as PNGs.
 *
 * Why this exists: the strip is a few chips wide and the panel is a floating dialog, and
 * neither had ever been looked at in the light theme. The running app has no debugging
 * port and must not be restarted, so this renders the strip's **real DOM and real CSS**
 * off-screen instead of screenshotting the app.
 *
 * How it stays honest:
 *
 * - the markup comes from `test/harness.ts` — the same `loadBundle()` / `mount(...)` path
 *   `test/client.dom.test.ts` uses: the real bundle, the real restricted context, the real
 *   component, with only the projections handed in as props. Nothing here re-implements a
 *   component or hand-writes a mock;
 * - the stylesheet is the one the bundle itself injects (`<style data-plugin-css>`), read
 *   back out of the jsdom document, so it is the shipped CSS and not a copy of it;
 * - the `--dsw-*` tokens are the app's own declarations, extracted from the shipped
 *   `app.asar` by `scripts/lib/app-aspect.mts` and emitted under the app's own selectors
 *   (`body` for light, `body[data-ds-dark-theme]` for dark). The dark page carries that
 *   marker on `<body>`, and a computed-style probe asserts the page really resolved to the
 *   dark tokens before a dark PNG is written;
 * - the width is the centre column the app's own `computeColumns()` would give this
 *   surface, evaluated from the layout bundle in the same asar — not a guessed number.
 *
 * Two things it deliberately does **not** model, so nobody reads more into a PNG than is
 * there:
 *
 * - the detail popover is shown **standalone**, centred by a layout wrapper, rather than
 *   anchored under the trigger. Its `left`/`bottom` come from a live
 *   `getBoundingClientRect()` of the docked trigger, and jsdom has no layout engine, so
 *   the anchor would be a zeroed rect and the invented position would be the only
 *   fabricated pixel in the file. The panel's own width (`min(560px, 100vw - 32px)`), its
 *   content and its styles are the real ones; only the surrounding page is a frame;
 * - the strip is rendered in a plain block at the centre-column width, not inside the app
 *   shell, so the PNG shows the strip's own geometry and not where the shell would put it.
 *   It is a `position: sticky` element with a transparent-to-background gradient; the
 *   gradient is drawn against the app's own background token, as the dock does.
 *
 * Run (through the guard, as every node run must be):
 *   node ~/.dsh/scripts/guard/guard.mjs --limit-mb 2560 -- \
 *     node --max-old-space-size=384 \
 *     ~/.dsh/profiles/desktop/plugins/dsh-session-metrics/scripts/capture-panel.mts
 *
 * The cap is 2560 MB, not the suite's 1024 MB, for a measured reason: this script's Node
 * half peaks at a few tens of MB (jsdom, one realm), but the headless Chrome it spawns
 * needs ~1.35 GB of process tree on macOS just to start (the reference measurement for a
 * blank page through these `--disable-*` flags: 1352 MB of 1639 MB). A 1024 MB cap kills
 * the tree before a single screenshot is written; 2560 MB still protects the run, because
 * a genuine leak would blow far past it. One Chrome runs at a time, sequentially.
 *
 * Nothing is cached and nothing is snapshotted: the bundle, the harness and the asar are
 * read fresh, so the script can be re-run after any client change.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSettings } from '../lib/v1/settings.js';
import { loadBundle, mount } from '../test/harness.ts';
import { ASAR_PATH, designTokens, layoutArithmetic, resolve, type Tokens } from './lib/app-aspect.mts';

// ------------------------------------------------------------------ paths

const HERE = new URL('..', import.meta.url);
const BUNDLE_PATH = fileURLToPath(new URL('lib/v1/client.js', HERE));
const OUT_DIR = fileURLToPath(new URL('docs/screenshots', HERE));
const TEMP_DIR = join(tmpdir(), `dsh-session-metrics-capture-${String(process.pid)}`);

/** Chrome, in the two places it lives on macOS. Missing means a sentence, not a blank PNG. */
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

// ------------------------------------------------------------------ the frame

/**
 * The viewport the capture presents.
 *
 * The app opens at whatever size the window is; `computeColumns` is viewport-driven and the
 * sidebar preference is the store's first-open 280, so the centre column each plugin
 * occupies is a function of this number. 1440×900 is named here as the representative
 * window — the derived width is printed at run time and follows the app if the arithmetic
 * changes.
 */
const VIEWPORT = { width: 1440, height: 900 };

const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

/** One surface to capture: which screenshot name it lands in and what the PNG holds. */
interface Surface {
  readonly name: string;
  /** The markup to place in the page. */
  readonly markup: string;
  /** The page-level frame the markup sits in. */
  readonly frame: 'dock' | 'panel';
}

// ------------------------------------------------------------------ the fixture

/**
 * The projections the strip reads, shaped exactly as `test/client.dom.test.ts` shapes them.
 *
 * Two providers so the detail's per-model breakdown has two real rows, and a budget so the
 * strip draws the progress bar. The figures are the suite's own fixture: 910 output tokens
 * at $1.20/1M plus 375,040 cached prompt tokens is the third of a cent the test pins.
 */
function projection(): unknown {
  const buckets = (uncachedInputTokens: number, cacheReadTokens: number, outputTokens: number): Record<string, number> => ({
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    outputTokens,
  });
  const row = (
    turn: number,
    step: number,
    provider: string,
    model: string,
    tier: string,
    value: Record<string, number>
  ): Record<string, unknown> => ({
    turn,
    step,
    startTime: Date.now() - 90_000,
    endTime: Date.now() - 60_000,
    provider,
    model,
    tier,
    buckets: value,
  });
  const flash = buckets(377, 375_040, 910);
  const pro = buckets(1_204, 512_000, 3_310);
  return {
    version: 1,
    settings: resolveSettings({
      // `budget` is off by default; the shot shows it so the strip's progress state is
      // visible without a second fixture. Everything else is the shipped default.
      display: { primaryProvider: 'deepseek-account', labels: ['peak', 'time', 'cost', 'saved', 'provider', 'budget'] },
      budget: { sessionUsd: 5 },
    }),
    ledger: {
      turns: 2,
      steps: 3,
      totals: {
        'deepseek-account\u0000deepseek-flash\u0000peak': flash,
        'deepseek-account\u0000deepseek-v4-pro\u0000peak': pro,
      },
      rows: [
        row(1, 1, 'deepseek-account', 'deepseek-flash', 'peak', flash),
        row(1, 2, 'deepseek-account', 'deepseek-flash', 'peak', flash),
        row(2, 1, 'deepseek-account', 'deepseek-v4-pro', 'peak', pro),
      ],
    },
  };
}

/** The `tokenUsage` projection: the session's buckets, summed. */
const USAGE = { uncachedInputTokens: 1_581, cacheReadTokens: 887_040, cacheWriteTokens: 0, outputTokens: 4_220 };

/** The `modelSelection` projection: the catalogue the composer's own picker uses. */
const SELECTION = { lastUsed: { provider: 'deepseek-account', model: 'deepseek-flash' } };

/**
 * Mount the real strip and return the two states worth a PNG.
 *
 * `mount()` is the harness's, so the props are the props the slot owner passes: the
 * registration is at `conversation.input.dock`, whose spec carries no `inject`, so
 * `useProjection` and `sessionId` arrive from the owner and are handed in here.
 *
 * The second state is the popover after a real click on the real trigger; the markup is
 * read after React has re-rendered, exactly as the DOM tests read it.
 */
async function renderStates(): Promise<{ strip: string; detail: string }> {
  const loaded = loadBundle();
  const useProjection = (key: string): unknown => {
    if (key === 'sessionMetrics') return projection();
    if (key === 'tokenUsage') return USAGE;
    if (key === 'modelSelection') return SELECTION;
    return undefined;
  };
  const view = mount(loaded, loaded.slot('conversation.input.dock'), { sessionId: 'session-capture', useProjection });
  try {
    const strip = view.container.innerHTML;
    if (!strip.includes('dsm-trigger')) throw new Error('the strip rendered without its trigger');
    await view.click('.dsm-trigger');
    // Read the panel as a node rather than slicing the markup string: the panel is the one
    // thing the second shot is about, and a regex over nested divs is a bug waiting to
    // happen. `outerHTML` keeps the trigger out of the shot, so the two PNGs do not overlap.
    const panel = view.container.querySelector('.dsm-panel');
    if (panel === null) throw new Error('clicking the trigger rendered no detail panel');
    return { strip, detail: panel.outerHTML };
  } finally {
    // The harness shares one realm across mounts, so a container left behind would leak
    // into the next run in the same process.
    view.unmount();
  }
}

// ------------------------------------------------------------------ the page

/**
 * One HTML page: the app's token blocks, the plugin's own stylesheet, the markup.
 *
 * The token blocks carry the app's selectors verbatim — `body`, `body[data-ds-dark-theme]`
 * and their two darwin variants — and the dark page sets `data-ds-dark-theme` on `<body>`
 * exactly as the app does. That is what makes the app's own dark-scoped rules live in the
 * capture instead of being simulated by the injected values.
 */
function htmlDocument(args: {
  theme: Theme;
  tokens: Tokens;
  styles: string;
  surface: Surface;
  centerWidth: number;
  probe?: boolean;
}): { html: string; unresolved: string[] } {
  // The frame's own tokens come first. They must be resolved whether or not the plugin's
  // stylesheet happens to name them — the page background and text colour are the frame's,
  // not the plugin's — so this does not depend on which tokens a future stylesheet keeps.
  const frameTokens = ['--dsw-alias-bg-base', '--dsw-alias-label-primary'];
  const referenced = [
    ...new Set([
      ...frameTokens,
      ...[...args.styles.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1] as string),
    ]),
  ].sort();
  const set = args.theme === 'dark' ? args.tokens.dark : args.tokens.light;
  const unresolved: string[] = [];
  const resolved = new Map<string, string>();
  for (const token of referenced) {
    const value = resolve(token, set);
    if (value === null) unresolved.push(token);
    else resolved.set(token, value);
  }

  // Light selectors first, dark second, in the app's own declaration order. Every block
  // carries the same declarations, differing only in the values of the tokens that differ.
  const selectors = args.tokens.selectors.filter((selector) =>
    args.theme === 'dark' ? selector.includes('data-ds-dark-theme') : !selector.includes('data-ds-dark-theme')
  );
  const blocks = selectors
    .map((selector) => {
      const declarations = [...resolved].map(([name, value]) => `  ${name}: ${value};`).join('\n');
      return `${selector} {\n${declarations}\n}`;
    })
    .join('\n');

  const bodyMarker = args.theme === 'dark' ? ' data-ds-dark-theme' : '';
  // The app is a darwin build; the token string's darwin blocks are keyed on this, and a
  // capture that omitted it would resolve those two properties differently from the app.
  const htmlMarker = platform() === 'darwin' ? ' data-platform="darwin"' : '';

  const frame =
    args.surface.frame === 'dock'
      ? `<div id="dsh-surface" class="dsh-center" style="width:${String(args.centerWidth)}px">\n${args.surface.markup}\n</div>`
      : `<div id="dsh-surface" class="dsh-popover">\n${args.surface.markup}\n</div>`;

  // The probe reads back what the browser actually computed, so a page that silently
  // resolved to the light tokens cannot be written out as `-dark.png`. It also reports the
  // rendered height of the surface, so the window is sized to the content rather than to a
  // guess — the strip is ~30px of chips and does not deserve a 900px canvas.
  const probeScript = args.probe
    ? `
<script>
window.addEventListener('DOMContentLoaded', function () {
  var out = { body: getComputedStyle(document.body).backgroundColor, panel: null, trigger: null, height: 0 };
  var panel = document.querySelector('.dsm-panel');
  if (panel !== null) out.panel = getComputedStyle(panel).borderTopColor;
  var trigger = document.querySelector('.dsm-trigger');
  if (trigger !== null) out.trigger = getComputedStyle(trigger).borderTopColor;
  var node = document.getElementById('dsh-surface');
  if (node !== null) out.height = Math.ceil(node.getBoundingClientRect().height);
  var pre = document.createElement('pre');
  pre.id = 'dsh-capture-probe';
  pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
});
</script>`
    : '';

  const html = `<!doctype html>
<html${htmlMarker} data-dsh-theme="${args.theme}">
<head>
<meta charset="utf-8" />
<style>
${blocks}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; width: 100%; min-height: 100%; }
body {
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #0f1115);
  font-family: var(--dsw-font-family, ui-sans-serif, -apple-system, "Helvetica Neue", Arial, sans-serif);
}
/* The strip keeps a sticky band; centring is the only thing this frame adds. */
.dsh-center { margin: 0 auto; }
/* The popover's own width rule is min(560px, 100vw - 32px); the frame reproduces it so the
   panel is laid out at the width it declares rather than at the frame's. */
.dsh-popover { padding: 16px 32px; display: flex; flex-direction: column; align-items: center; }
/* The panel's shipped position: fixed, with left/bottom taken from a live trigger rect,
   is neutralised here so the real panel is laid out in flow; see the header for why. */
.dsh-popover .dsm-panel { position: static !important; width: min(560px, calc(100vw - 64px)); max-height: none; }
.dsh-popover .dsm-scrim { display: none !important; }
${args.styles}
</style>
</head>
<body${bodyMarker}>
${frame}${probeScript}
</body>
</html>
`;
  return { html, unresolved };
}

// ------------------------------------------------------------------ capture

/** Screenshot one HTML file with one headless Chrome, at an exact window size. */
function screenshot(chrome: string, file: string, out: string, width: number, height: number): void {
  const result = spawnSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--disable-extensions',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-component-update',
      '--disable-background-networking',
      `--window-size=${String(width)},${String(height)}`,
      `--screenshot=${out}`,
      '--run-all-compositor-stages-before-draw',
      '--virtual-time-budget=2000',
      `file://${file}`,
    ],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`headless Chrome exited ${String(result.status)}: ${(result.stderr ?? '').split('\n').slice(-3).join(' ')}`);
  }
}

/** A PNG's real pixel dimensions, so a capture that silently rendered wrong cannot pass. */
function pngSize(path: string): { width: number; height: number; bytes: number } {
  const buffer = readFileSync(path);
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path} is not a PNG`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), bytes: buffer.length };
}

/** Run the probe page and read the computed values it reported. */
function probeComputed(chrome: string, file: string): Record<string, string | null> {
  const result = spawnSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-component-update',
      '--disable-background-networking',
      '--virtual-time-budget=3000',
      '--dump-dom',
      `file://${file}`,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    throw new Error(`the computed-style probe exited ${String(result.status)}`);
  }
  const match = /<pre id="dsh-capture-probe">([^<]*)<\/pre>/.exec(result.stdout ?? '');
  if (match === null) throw new Error(`the computed-style probe did not run in ${file}`);
  return JSON.parse(match[1] as string) as Record<string, string | null>;
}

/** A resolved token as the `rgb(...)` string `getComputedStyle` returns. */
function cssColor(value: string): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (hex === null) return value.trim();
  const digits = hex[1] as string;
  const full = digits.length === 3 ? digits.replace(/./g, (digit) => digit + digit) : digits;
  const int = Number.parseInt(full, 16);
  return `rgb(${String((int >> 16) & 0xff)}, ${String((int >> 8) & 0xff)}, ${String(int & 0xff)})`;
}

/** Sum a hex colour's channels, for the light-is-lighter assertion. */
function luminance(value: string): number {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (hex === null) return Number.NaN;
  const digits = hex[1] as string;
  const full = digits.length === 3 ? digits.replace(/./g, (digit) => digit + digit) : digits;
  const int = Number.parseInt(full, 16);
  return ((int >> 16) & 0xff) + ((int >> 8) & 0xff) + (int & 0xff);
}

async function main(): Promise<void> {
  const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (chrome === undefined) {
    throw new Error(`no headless Chrome at ${CHROME_CANDIDATES.join(' or ')} — nothing was written`);
  }
  if (!existsSync(ASAR_PATH)) throw new Error(`no app bundle at ${ASAR_PATH}`);
  statSync(BUNDLE_PATH); // fail loudly when the bundle has not been built

  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });

  const tokens = designTokens();
  const layout = layoutArithmetic();
  const columns = layout.computeColumns(VIEWPORT.width, layout.firstOpenSidebar, 0);
  console.log(`[layout] computeColumns(${String(VIEWPORT.width)}, ${String(layout.firstOpenSidebar)}, 0) => ${JSON.stringify(columns)}`);
  console.log(`[layout] source: ${layout.source.replace(/\s+/g, ' ')}`);
  console.log(`[width ] strip surface: ${String(columns.center)}px centre column at ${String(VIEWPORT.width)}×${String(VIEWPORT.height)}`);

  const lightBase = resolve('--dsw-alias-bg-base', tokens.light);
  const darkBase = resolve('--dsw-alias-bg-base', tokens.dark);
  console.log(`[tokens] body -> --dsw-alias-bg-base => ${String(lightBase)}`);
  console.log(`[tokens] body[data-ds-dark-theme] -> --dsw-alias-bg-base => ${String(darkBase)}`);
  if (lightBase === null || darkBase === null) throw new Error('could not resolve --dsw-alias-bg-base in both themes');
  if (!(luminance(lightBase) > luminance(darkBase))) {
    throw new Error(`light/dark look swapped: body=${lightBase} is not lighter than dark=${darkBase}`);
  }

  const styles = loadBundle()
    .dom.window.document.querySelectorAll('style[data-plugin-css]');
  const pluginCss = [...styles].map((node) => node.textContent ?? '').join('\n');
  if (pluginCss.trim().length === 0) throw new Error('the bundle injected no stylesheet; nothing to render');
  console.log(`[styles] ${String(pluginCss.length)} chars from <style data-plugin-css> in the evaluated bundle`);

  const states = await renderStates();
  console.log(`[render] strip ${String(states.strip.length)} chars; detail ${String(states.detail.length)} chars`);

  const surfaces: Surface[] = [
    { name: 'panel', markup: states.strip, frame: 'dock' },
    { name: 'detail', markup: states.detail, frame: 'panel' },
  ];

  const written: string[] = [];
  const fallbacks: string[] = [];

  for (const theme of THEMES) {
    for (const surface of surfaces) {
      const page = htmlDocument({
        theme,
        tokens,
        styles: pluginCss,
        surface,
        centerWidth: columns.center,
      });
      for (const token of page.unresolved) fallbacks.push(`${theme}/${surface.name}: ${token}`);
      const file = join(TEMP_DIR, `${surface.name}-${theme}.html`);
      writeFileSync(file, page.html, 'utf8');

      // The probe page is built first because it also measures: the window is sized to the
      // content, and the theme assertion is made before any PNG is written.
      const probeFile = join(TEMP_DIR, `${surface.name}-${theme}-probe.html`);
      writeFileSync(
        probeFile,
        htmlDocument({ theme, tokens, styles: pluginCss, surface, centerWidth: columns.center, probe: true }).html,
        'utf8'
      );
      const computed = probeComputed(chrome, probeFile);
      const expected = cssColor(theme === 'dark' ? (darkBase as string) : (lightBase as string));
      if (computed.body !== expected) {
        throw new Error(`${theme}: the page computed body ${String(computed.body)}, expected ${expected} — the dark marker is not scoping the capture`);
      }
      const measured = Number(computed.height);
      if (!Number.isFinite(measured) || measured < 20) throw new Error(`${theme}/${surface.name}: the surface measured ${String(computed.height)}px tall`);

      const isStrip = surface.frame === 'dock';
      const width = isStrip ? columns.center : 640;
      const height = isStrip ? measured + 16 : measured + 32;
      console.log(`[probe ] ${theme.padEnd(5)} ${surface.name.padEnd(6)} body ${String(computed.body)}; surface ${String(measured)}px tall`);

      const out = join(OUT_DIR, `${surface.name}-${theme}.png`);
      screenshot(chrome, file, out, width, height);
      const png = pngSize(out);
      if (png.bytes < 800) throw new Error(`${out} is only ${String(png.bytes)} bytes — the capture looks blank`);
      if (png.width !== width || png.height !== height) {
        throw new Error(`${out} is ${String(png.width)}×${String(png.height)}, expected ${String(width)}×${String(height)}`);
      }
      written.push(`${surface.name}-${theme}.png  ${String(png.bytes)} bytes  ${String(png.width)}×${String(png.height)}`);
    }
  }

  if (process.env.SESSION_METRICS_CAPTURE_KEEP_TEMP !== '1') rmSync(TEMP_DIR, { recursive: true, force: true });

  console.log(`\n[summary] ${String(written.length)} PNGs written to ${OUT_DIR}`);
  for (const line of written) console.log(`  ${line}`);
  if (fallbacks.length > 0) {
    console.log('\n[fallback] tokens not defined by the app (the plugin\'s own literal fallback applies):');
    for (const line of [...new Set(fallbacks)]) console.log(`  ${line}`);
  } else {
    console.log('\n[fallback] every referenced token resolved from the app bundle');
  }
}

await main();
