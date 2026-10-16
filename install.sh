#!/usr/bin/env bash
#
# Register (or unregister) the session-metrics bundle in a DSH profile.
#
#   ./install.sh                       register in the profile beside this checkout
#   ./install.sh --profile <dir>       register in a specific profile directory
#   ./install.sh --check               report what would change, write nothing
#   ./install.sh --remove              unregister the bundle again
#
# The plugin does NOT have to live inside the profile: it is linked by absolute
# path, so a clone anywhere (e.g. ~/.dsh/plugins/dsh-session-metrics) works. With no
# --profile, the profile is discovered from ~/.dsh/profiles/desktop, falling back to
# the directory containing this checkout.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_NAME="$(node -p "require('$HERE/package.json').name")"

MODE=install
PROFILE_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check)   MODE=check ;;
    --remove)  MODE=remove ;;
    --profile) PROFILE_DIR="${2:-}"; shift ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

# Profile discovery: explicit flag, then the desktop profile, then in-place.
if [ -z "$PROFILE_DIR" ]; then
  if [ -f "$HOME/.dsh/profiles/desktop/package.json" ]; then
    PROFILE_DIR="$HOME/.dsh/profiles/desktop"
  else
    PROFILE_DIR="$(dirname "$HERE")"
  fi
fi

PROFILE_PKG="$PROFILE_DIR/package.json"
[ -f "$PROFILE_PKG" ] || { echo "error: no profile package.json at $PROFILE_PKG" >&2; exit 1; }

node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('$PROFILE_PKG', 'utf8'));
const name = '$PACKAGE_NAME';
const link = 'link:$HERE';
const dep = pkg.dependencies?.[name];
const bundled = (pkg.dsh?.profile?.bundles ?? []).includes(name);
console.log('  profile      $PROFILE_PKG');
console.log('  checkout     $HERE');
console.log('  dependency   ' + (dep === undefined ? '(absent)' : dep) + (dep === link ? '  [ok]' : dep === undefined ? '' : '  [differs]'));
console.log('  bundles      ' + (bundled ? 'lists ' + name + '  [ok]' : 'does not list ' + name));
"

if [ "$MODE" = check ]; then
  echo
  echo "run ./install.sh to apply, or ./install.sh --remove to unregister"
  exit 0
fi

echo "backing up $PROFILE_PKG"
cp "$PROFILE_PKG" "$PROFILE_PKG.bak-$(date +%Y%m%d%H%M%S)"

node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('$PROFILE_PKG', 'utf8'));
const name = '$PACKAGE_NAME';
const link = 'link:$HERE';
const want = '$MODE';

if (want === 'install') {
  pkg.dependencies ??= {};
  pkg.dependencies[name] = link;
  pkg.dsh ??= {};
  pkg.dsh.profile ??= {};
  pkg.dsh.profile.bundles ??= [];
  if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name);
} else {
  delete pkg.dependencies[name];
  if (pkg.dsh?.profile?.bundles) {
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== name);
  }
}

fs.writeFileSync('$PROFILE_PKG', JSON.stringify(pkg, null, 2) + '\n');
console.log((want === 'install' ? 'registered' : 'unregistered') + '  ' + name);
"

# Build before linking: lib/** is generated and is what DSH actually loads.
if [ "$MODE" = install ]; then
  echo "building $HERE"
  (cd "$HERE" && pnpm install --prefer-offline)
fi

echo "installing $PROFILE_DIR"
(cd "$PROFILE_DIR" && pnpm install --prefer-offline)

echo "done"
echo
echo "The host half loads once per app process — restart DSH to pick this up (a page reload will not)."