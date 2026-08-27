#!/bin/bash
#
# bootstrap-worktree-env.sh — give a fresh worktree the .env.local it needs.
#
# NEO-181: a per-ticket worktree starts with no .env.local (it is gitignored, so
# `git worktree add` cannot bring it), and nothing in apps/web runs without one —
# not dev, not local E2E. The fix was always "copy it from the main checkout by
# hand", which is easy to forget and produces a confusing first failure.
#
# The main checkout is resolved from git, NOT from a hardcoded relative path:
# `git worktree list --porcelain` always reports the main working tree first, so
# this works whatever directory layout the worktrees live in.
#
# Copies only what is missing; never overwrites. Safe to re-run.
#
#   ./bootstrap-worktree-env.sh          # copy if absent
#   ./bootstrap-worktree-env.sh --force  # replace an existing file
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# Path of apps/web relative to the repo root, so this keeps working if the
# script is invoked from elsewhere in the tree.
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
REL_DIR="${SCRIPT_DIR#"$REPO_ROOT"/}"

MAIN_WORKTREE="$(git -C "$SCRIPT_DIR" worktree list --porcelain \
  | awk '/^worktree /{print substr($0, 10); exit}')"

if [ -z "$MAIN_WORKTREE" ]; then
  echo "✗ could not resolve the main worktree from git" >&2
  exit 1
fi

if [ "$MAIN_WORKTREE" = "$REPO_ROOT" ]; then
  echo "ℹ️  This IS the main checkout — nothing to copy from."
  echo "    A first-time setup starts from env-template.txt:"
  echo "      cp $REL_DIR/env-template.txt $REL_DIR/.env.local"
  exit 0
fi

copied=0
skipped=0
missing=0

# .env.test.local is optional — only some machines carry E2E credentials.
for name in .env.local .env.test.local; do
  src="$MAIN_WORKTREE/$REL_DIR/$name"
  dst="$SCRIPT_DIR/$name"

  if [ ! -f "$src" ]; then
    [ "$name" = ".env.local" ] && {
      echo "✗ $name not found in the main checkout ($src)"
      echo "    Create it there first — that is the copy every worktree seeds from."
      missing=1
    }
    continue
  fi

  if [ -f "$dst" ] && [ "$FORCE" -eq 0 ]; then
    echo "• $name already present — left alone (use --force to replace)"
    skipped=$((skipped + 1))
    continue
  fi

  cp "$src" "$dst"
  # These hold real credentials; keep them owner-only regardless of the source's
  # mode or the umask that happened to be in effect.
  chmod 600 "$dst"
  echo "✓ $name ← $MAIN_WORKTREE"
  copied=$((copied + 1))
done

[ "$missing" -eq 1 ] && exit 1

echo ""
echo "Copied $copied file(s), left $skipped in place."
echo ""
echo "⚠️  Check VITE_CONVEX_URL before running E2E against this branch. The copy"
echo "    points at whatever deployment the main checkout uses; to exercise THIS"
echo "    PR's stack, point it at the PR's Convex preview (see CLAUDE.md,"
echo "    \"Debugging a red flow against the PR's own services\")."
