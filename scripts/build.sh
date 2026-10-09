#!/bin/bash
# Zero-build validation for @dsh-external/dsh-redteam-mode.
# The plugin ships as plain ESM (lib/*.mjs) — no tsc/tsdown required.
# This script validates syntax of every module and smoke-imports the entry.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Syntax check lib/**/*.(js|mjs) ==="
fail=0
while IFS= read -r file; do
  if ! node --check "$file"; then
    echo "syntax FAIL: $file" >&2
    fail=1
  fi
done < <(find lib -type f \( -name '*.mjs' -o -name '*.js' \) ! -name '*.bak')
if [ "$fail" -ne 0 ]; then exit 1; fi

echo "=== Import smoke (entry resolves without host) ==="
node --input-type=module -e "
import { pathToFileURL } from 'node:url';
import(pathToFileURL(process.argv[1]).href).then((mod) => {
  if (!mod.name || typeof mod.apply !== 'function') {
    console.error('entry missing name/apply'); process.exit(1);
  }
  console.log('entry OK:', mod.name);
}).catch((error) => { console.error('import FAIL:', error.message); process.exit(1); })
" "$ROOT/lib/index.js"

echo "=== Resources present ==="
for f in resources/instruction.ctf.md resources/prompts/Jailbreak.default.md resources/skills/SKILL.md; do
  [ -f "$f" ] || { echo "missing resource: $f" >&2; exit 1; }
done

echo "=== Tool JSON-Schema projection guard ==="
node scripts/schema.mjs

echo "=== Build complete (zero-build validated) ==="
