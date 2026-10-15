/**
 * The settings namespace, read from its one source of truth.
 *
 * The namespace is the row id the bundle's own `cordis.patch.yml` declares: the Loader
 * keys the row by it, `configForms.get(...)` accepts it, and the plugin-manager's row page
 * gates on `view.ns === openRow.rowId`. A test that hardcodes the string cannot notice a
 * rename — it would keep passing while the badge and the editor silently read nothing,
 * which is exactly the bug this suite was written for. So the tests read it here, from the
 * patch file, and assert the built client and host agree with it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PATCH_PATH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url));

/**
 * The `id:` of the bundle's one Loader row.
 *
 * Anchored so a commented-out example inside the patch cannot answer for it: a YAML
 * comment starts with `#`, which the pattern refuses to skip.
 */
export const ROW_ID = (function (): string {
  const match = readFileSync(PATCH_PATH, 'utf8').match(/^\s*-\s*id:\s*([^\s#]+)\s*$/m);
  assert.ok(match !== null, 'cordis.patch.yml must declare the row id');
  return match[1];
})();
