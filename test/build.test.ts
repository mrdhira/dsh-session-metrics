/**
 * Build-artifact contract tests.
 *
 * These exist because of a real failure: when the host half was bundled, `lib/v1/*.js`
 * still contained hand-written pre-port files, and five test files imported those stale
 * artifacts — validating code that was no longer in the shipped bundle. Everything passed.
 *
 * The rule this file enforces is the one the suite assumes: **tests run against what
 * ships**. `lib/**` is generated, so it must mirror `src/**`, be no older than it, and
 * resolve every import inside the published package.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** `src/host/money.ts` is built to `lib/v1/money.js`. */
const HOST_MODULES: string[] = ['index', 'money', 'pricing', 'ledger', 'zod', 'schema', 'settings'];

const exists = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch (error) {
    return false;
  }
};

test('build: every source module has an artifact, and no artifact predates its source', () => {
  const pairs: Array<[string, string]> = HOST_MODULES.map((name) => [`src/host/${name}.ts`, `lib/v1/${name}.js`]);
  pairs.push(['src/client/index.cts', 'lib/v1/client.js']);
  const missing = pairs.filter(([, artifact]) => !exists(root + artifact)).map(([, artifact]) => artifact);
  assert.deepEqual(missing, [], 'run `npm run build`: these artifacts do not exist');

  const stale = pairs.filter(([source, artifact]) => statSync(root + artifact).mtimeMs < statSync(root + source).mtimeMs);
  assert.deepEqual(
    stale.map(([source]) => source),
    [],
    'these sources are newer than their artifacts, so the suite would validate stale bytes — run `npm run build`',
  );
});

test('build: the host entry is a mirror, and every import it makes is shipped', () => {
  // Unbundled on purpose: the tests import the built modules, so the Loader entry must
  // resolve siblings rather than carry a private copy of them.
  const entry = readFileSync(root + 'lib/v1/index.js', 'utf8');
  const specifiers = [...entry.matchAll(/from\s+"(\.\/[^"]+)"/g)].map((match) => match[1]);
  assert.ok(specifiers.length >= 4, `the entry should import its siblings: ${specifiers.join(', ')}`);
  for (const specifier of specifiers) {
    assert.equal(exists(root + 'lib/v1/' + specifier.replace('./', '')), true, `${specifier} is imported but not shipped`);
  }
});

test('build: no generated file imports something the package does not publish', () => {
  const files = readdirSync(root + 'lib/v1').filter((name) => name.endsWith('.js'));
  assert.ok(files.length >= 3, 'the build should have produced several modules');
  const broken: string[] = [];
  for (const name of files) {
    const text = readFileSync(root + 'lib/v1/' + name, 'utf8');
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.\/[^"']+)["']/g)) {
      if (!exists(root + 'lib/v1/' + match[1].replace('./', ''))) broken.push(`${name} -> ${match[1]}`);
    }
  }
  assert.deepEqual(broken, [], 'these relative imports do not resolve inside lib/v1');
});

test('build: the entrypoints the Loader reads are the files that exist', () => {
  const main = pkg.main.replace('./', '');
  assert.equal(exists(root + main), true, `main points at a missing file: ${pkg.main}`);
  for (const [key, value] of Object.entries(pkg.exports)) {
    const target = typeof value === 'string' ? value : (value as { default?: string }).default;
    if (target === undefined) continue;
    assert.equal(exists(root + target.replace('./', '')), true, `exports["${key}"] points at a missing file: ${target}`);
  }
  assert.equal(pkg.dsh.client.platform, 'web', 'the browser half declares its platform');
  assert.equal(pkg.dsh.client.immediately, true, 'and loads with the page rather than on demand');
});

test('build: the shipped client carries a build id naming the package and version', () => {
  const bundle = readFileSync(root + 'lib/v1/client.js', 'utf8');
  const expected = `${pkg.name}/${pkg.version}+`;
  assert.match(bundle, new RegExp(expected.replace(/[.+*?^${}()|[\]\\]/g, '\\$&')), 'a generation must be identifiable from the bundle alone');
  assert.match(bundle, /window\.__ModuleLoader__\.load\(\{ id: "dsh-session-metrics"/, 'and the handshake names the package');
  assert.match(bundle, /return module\.exports; \} \}\);/, 'and closes by returning the plugin to the loader');
});
