#!/usr/bin/env bash
#
# link-deps.sh — make a git worktree runnable without a full reinstall.
#
# A fresh `git worktree add` has NO node_modules, so vitest / convex-test /
# @testing-library and friends can't resolve and `npm run test:unit` fails with
# "Cannot find package 'vitest'" (NEO-48). When this worktree's dependency set
# matches the primary checkout, we symlink node_modules to the primary's
# instead of paying a full `npm ci`. If package-lock.json has drifted, we refuse
# and tell you to install — a stale symlink would silently mask the drift.
#
# Usage (from the worktree):  ./link-deps.sh   or   npm run link-deps
set -euo pipefail

cd "$(dirname "$0")"

# Already populated (real dir or an existing symlink)? Nothing to do.
if [ -e node_modules ]; then
  echo "node_modules already present — nothing to do."
  exit 0
fi

# The primary worktree is the first entry of `git worktree list`.
primary="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
here="$(pwd -P)"

if [ "$primary" = "$here" ]; then
  echo "This IS the primary checkout — run 'npm ci' here, not link-deps.sh."
  exit 1
fi

if [ ! -d "$primary/node_modules" ]; then
  echo "Primary checkout has no node_modules: $primary"
  echo "Run 'npm ci' there first, then re-run this script."
  exit 1
fi

# Refuse to link if the dependency sets differ — a stale link hides drift.
if ! cmp -s package-lock.json "$primary/package-lock.json"; then
  echo "package-lock.json differs from the primary checkout."
  echo "Dependencies have drifted — run 'npm ci' in this worktree instead of linking."
  exit 1
fi

ln -s "$primary/node_modules" node_modules
echo "Linked node_modules -> $primary/node_modules"
echo "Now run: npm run test:unit"
