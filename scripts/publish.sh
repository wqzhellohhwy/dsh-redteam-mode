#!/bin/bash
# One-shot publish pipeline for dsh-redteam-mode.
# 1) Runs the full validation suite (build + smoke + schema guard).
# 2) Commits any pending changes.
# 3) Creates a PUBLIC GitHub repo (with About description) if it does not exist.
# 4) Adds the remote and pushes.
#
# Usage: bash scripts/publish.sh
#   - Uses the gh CLI's authenticated account for the repo namespace.
#   - Override the repo name / description with env vars:
#       REPO_NAME (default dsh-redteam-mode)
#       REPO_DESC (default "Hook-enforced red-team mode for DeepSeek Harness (DSH)")
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REPO_NAME="${REPO_NAME:-dsh-redteam-mode}"
REPO_DESC="${REPO_DESC:-Hook-enforced red-team mode for DeepSeek Harness (DSH) — native port of codex-redteam-mode}"

echo "=== 1/4 Validate ==="
bash scripts/build.sh
node scripts/smoke.mjs
node scripts/schema.mjs

echo "=== 2/4 Commit pending changes ==="
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "  git repo not initialized — initializing"
  git init
  git branch -M "$(git symbolic-ref --short HEAD 2>/dev/null || echo main)"
fi
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "chore: publish-ready — schema guard, docs, license, portable README"
else
  echo "  nothing to commit"
fi

echo "=== 3/4 Create public GitHub repo (if missing) ==="
if ! git remote get-url origin >/dev/null 2>&1; then
  gh repo create "$REPO_NAME" --public --source . --remote origin --description "$REPO_DESC"
  echo "  created + attached origin"
else
  echo "  origin already set: $(git remote get-url origin)"
fi

echo "=== 4/4 Push ==="
BRANCH="$(git branch --show-current)"
git push -u origin "$BRANCH"

echo
echo "Published: $(gh repo view --json url --jq .url)"
