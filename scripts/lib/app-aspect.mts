/**
 * The app facts a headless capture must borrow: the layout arithmetic that decides how
 * wide this plugin's surface is, and the theme tokens its stylesheet resolves against.
 *
 * Nothing here reads the plugin. Both facts come out of the shipped `app.asar`, so a
 * capture cannot drift from the app it claims to show:
 *
 * - **the width** is `computeColumns(viewport, sidebar, rightbar, collapsedWidth)` —
 *   evaluated from the function's own source in
 *   `@deepseek-ai/dsh-client-ui-layout/lib/client.js`, not re-implemented here. The
 *   sidebar is clamped 264–420 and the store's first-open width (280) is read from the
 *   same bundle, so the number in a capture is the number the app would give it.
 * - **the theme** is the app's own token tiers: the `base_css_default` string (radii,
 *   font stacks — theme-independent) plus the `design_platform_css_default` string,
 *   whose blocks carry the app's own selectors — a light `body` block and a dark
 *   `body[data-ds-dark-theme]` block, each repeated under `html[data-platform=darwin]`
 *   at equal specificity. Every selector is emitted so the capture cascade is the app's
 *   cascade rather than an approximation of it.
 *
 * The asar is 116 MB and is never read whole: markers are found with a chunked scan and
 * only the window around one is decoded.
 */
import { openSync, closeSync, readSync, statSync, existsSync } from 'node:fs';

/** The macOS bundle. A capture elsewhere stops with a sentence rather than a wrong PNG. */
export const ASAR_PATH = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';

/** The exact marker the layout module's own loader call carries. */
const LAYOUT_MARKER = 'id: "@deepseek-ai/dsh-client-ui-layout"';

/** Opening of the theme-independent tier: radii, font stacks. */
const BASE_MARKER = 'base_css_default = "';

/** Opening of the two-theme tier: the aliases and the primitives they point at. */
const DESIGN_MARKER = 'design_platform_css_default = "';

/** The token sets a page can be rendered with. */
export interface Tokens {
  /** Every declaration that applies to a light page. */
  readonly light: Map<string, string>;
  /** The same, with the app's dark block layered over it. */
  readonly dark: Map<string, string>;
  /** The selectors the token blocks use, in the order the app declares them. */
  readonly selectors: readonly string[];
}

// ------------------------------------------------------------------ reading the asar

/** Read `[start, start + length)` of the asar, bounded and never held whole. */
function readWindow(fd: number, start: number, length: number): string {
  const size = statSync(ASAR_PATH).size;
  const from = Math.max(0, start);
  const to = Math.min(size, start + length);
  const buffer = Buffer.allocUnsafe(Math.max(0, to - from));
  let filled = 0;
  while (filled < buffer.length) {
    const got = readSync(fd, buffer, filled, buffer.length - filled, from + filled);
    if (got <= 0) break;
    filled += got;
  }
  return buffer.subarray(0, filled).toString('utf8');
}

/** The absolute byte offset of a marker, found with a bounded chunked scan, or -1. */
function findMarker(fd: number, marker: string): number {
  const needle = Buffer.from(marker, 'utf8');
  const size = statSync(ASAR_PATH).size;
  const CHUNK = 4 * 1024 * 1024;
  let position = 0;
  let tail = Buffer.alloc(0);
  while (position < size) {
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK, size - position));
    const got = readSync(fd, buffer, 0, buffer.length, position);
    if (got <= 0) break;
    const haystack = Buffer.concat([tail, buffer.subarray(0, got)]);
    const found = haystack.indexOf(needle);
    if (found >= 0) return position - tail.length + found;
    tail = haystack.subarray(Math.max(0, haystack.length - (needle.length - 1)));
    position += got;
  }
  return -1;
}

/**
 * The body of a JS double-quoted string, with escapes resolved.
 *
 * A plain search for the next `"` is not safe: the app's CSS carries escaped quotes in its
 * font stacks (`\"Segoe UI\"`), so an escape-aware walk is what keeps the string from
 * ending at the first of them.
 */
function stringBody(text: string, from: number): string {
  const out: string[] = [];
  let index = from;
  while (index < text.length) {
    const ch = text[index] as string;
    if (ch === '\\') {
      const next = text[index + 1] as string | undefined;
      if (next === undefined) break;
      out.push(next === 'n' ? '\n' : next);
      index += 2;
      continue;
    }
    if (ch === '"') return out.join('');
    out.push(ch);
    index += 1;
  }
  throw new Error('unterminated CSS string in the app bundle');
}

/** Read one embedded CSS string by its marker. Throws when the marker moved. */
function readCss(fd: number, marker: string): string {
  const at = findMarker(fd, marker);
  if (at < 0) throw new Error(`${marker} is no longer in the asar; the capture cannot read the app's tokens`);
  return stringBody(readWindow(fd, at + marker.length, 512 * 1024), 0);
}

// ------------------------------------------------------------------ CSS parsing

/** `selector -> declarations`, at any nesting depth and merged in source order. */
function rulesOf(css: string): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>();
  let selectorStart = 0;
  let cursor = 0;
  while (cursor < css.length) {
    const open = css.indexOf('{', cursor);
    if (open < 0) break;
    let depth = 1;
    let scan = open + 1;
    while (scan < css.length && depth > 0) {
      const ch = css[scan] as string;
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      scan += 1;
    }
    if (depth !== 0) throw new Error('unbalanced braces in the app CSS string');
    const selector = css.slice(selectorStart, open).trim();
    let table = rules.get(selector);
    if (table === undefined) {
      table = new Map<string, string>();
      rules.set(selector, table);
    }
    for (const match of css.slice(open + 1, scan - 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
      table.set(match[1] as string, (match[2] as string).trim());
    }
    selectorStart = scan;
    cursor = scan;
  }
  return rules;
}

/** Every declaration that applies to a page carrying `marker` on `<body>`. */
function themeTokens(
  base: Map<string, Map<string, string>>,
  design: Map<string, Map<string, string>>,
  marker: string,
  selectors: readonly string[]
): Map<string, string> {
  const out = new Map<string, string>();
  for (const table of base.values()) for (const [name, value] of table) out.set(name, value);
  /** True when `selector` addresses `known` — bare, or under the darwin platform block. */
  const addresses = (selector: string, known: string): boolean =>
    selector === known || selector.endsWith(` ${known}`);
  for (const [selector, table] of design) {
    // The app writes each theme twice: bare, then under the darwin platform block.
    const mine = addresses(selector, marker);
    // A block that addresses another theme is that theme's; one that addresses none is a
    // shared primitive and applies here too. Getting this wrong is not hypothetical: the
    // first version compared the bare selector only, so the light `body` alias block was
    // layered over the dark primitives and both themes resolved to the dark background.
    const other = selectors.some((known) => known !== marker && addresses(selector, known));
    if (!mine && other) continue;
    for (const [name, value] of table) out.set(name, value);
  }
  return out;
}

/**
 * The app's token tiers, ready to emit.
 *
 * The base tier applies to every theme; each theme block then layers its own aliases on
 * top, which is the order the app's stylesheet uses.
 */
export function designTokens(): Tokens {
  if (!existsSync(ASAR_PATH)) {
    throw new Error(`no app bundle at ${ASAR_PATH} — this capture reads the app's own layout code and tokens`);
  }
  const fd = openSync(ASAR_PATH, 'r');
  try {
    const base = rulesOf(readCss(fd, BASE_MARKER));
    const design = rulesOf(readCss(fd, DESIGN_MARKER));
    const selectors = [...design.keys()];
    for (const required of ['body', 'body[data-ds-dark-theme]']) {
      if (!selectors.includes(required)) {
        throw new Error(`the design-platform string no longer declares ${required}: ${selectors.join(', ')}`);
      }
    }
    return {
      light: themeTokens(base, design, 'body', selectors),
      dark: themeTokens(base, design, 'body[data-ds-dark-theme]', selectors),
      selectors,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Follow a `var()` chain to a concrete value.
 *
 * Returns `null` rather than a guess when the chain leaves the set, so the caller lets the
 * plugin's own literal fallback apply instead of inventing a colour.
 */
export function resolve(token: string, tokens: Map<string, string>): string | null {
  const seen = new Set<string>();
  let current = tokens.get(token);
  while (current !== undefined) {
    const variable = /^var\((--[\w-]+)(?:\s*,\s*(.+))?\)$/.exec(current.trim());
    if (variable === null) break;
    const next = variable[1] as string;
    if (seen.has(next)) return null;
    seen.add(next);
    const value = tokens.get(next);
    if (value === undefined) return null;
    current = value;
  }
  return current ?? null;
}

// ------------------------------------------------------------------ layout

/** The three tracks the frame solves for one viewport. */
export interface Columns {
  readonly sidebar: number;
  readonly center: number;
  readonly rightbar: number;
}

/**
 * The app's own `computeColumns`, lifted from the shipped layout bundle.
 *
 * Extracting the function's source and its neighbour `clampWidth` rather than retyping the
 * arithmetic is the point: if the app's clamps move, this capture moves with them or
 * throws. The sidebar contract (264–420), the 400px right-panel reserve and the store's
 * first-open width are asserted against the extracted source so a silent change fails the
 * run instead of producing a plausible wrong number.
 */
export function layoutArithmetic(): {
  computeColumns: (viewport: number, sidebar: number, rightbar: number, collapsedWidth?: number) => Columns;
  firstOpenSidebar: number;
  source: string;
} {
  if (!existsSync(ASAR_PATH)) {
    throw new Error(`no app bundle at ${ASAR_PATH} — the capture derives its width from the app's layout code`);
  }
  const fd = openSync(ASAR_PATH, 'r');
  let window: string;
  try {
    const at = findMarker(fd, LAYOUT_MARKER);
    if (at < 0) throw new Error(`the layout module (${LAYOUT_MARKER}) is not in the asar`);
    window = readWindow(fd, at, 24 * 1024);
  } finally {
    closeSync(fd);
  }

  const start = window.indexOf('function computeColumns(');
  if (start < 0) throw new Error('computeColumns is no longer a named function in the layout bundle');
  let depth = 0;
  let end = -1;
  for (let index = window.indexOf('{', start); index >= 0 && index < window.length; index += 1) {
    const ch = window[index] as string;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error('computeColumns has unbalanced braces');
  const body = window.slice(start, end);

  const clamp = /clampWidth\(\s*sidebar\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(window);
  if (clamp === null) throw new Error('computeColumns no longer clamps the sidebar; its contract moved');
  const [, min, max] = clamp;
  if (min !== '264' || max !== '420') {
    throw new Error(`the sidebar clamp is now ${String(min)}–${String(max)}; update the documented contract before capturing`);
  }
  if (!/viewport\s*-\s*s\s*-\s*400/.test(window)) {
    throw new Error('computeColumns no longer reserves 400px for the right panel');
  }
  const clampSource = /function clampWidth\([\s\S]*?\n\t\t\}/.exec(window);
  if (clampSource === null) throw new Error('clampWidth is no longer a named function beside computeColumns');
  const firstOpen = /layoutInfo:\s*\{\s*sidebar:\s*(\d+)/.exec(window);
  if (firstOpen === null) throw new Error('the layout store no longer declares its first-open sidebar width');

  // Evaluated from the extracted source, not retyped here.
  const factory = new Function(`${clampSource[0]}\n${body}\nreturn computeColumns;`);
  return {
    computeColumns: factory() as (viewport: number, sidebar: number, rightbar: number, collapsedWidth?: number) => Columns,
    firstOpenSidebar: Number(firstOpen[1]),
    source: body,
  };
}
