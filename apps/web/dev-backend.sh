#!/bin/bash

# NEO-249: this wraps `npx convex dev`, which targets the SHARED dev Convex
# deployment (there is one dev deployment per project, shared across every
# worktree/agent). That deployment is now a CI-managed mirror of `main`
# (release.yml's deploy-dev-convex job pushes it after every production
# release) — do not run this script against shared dev. It will immediately
# overwrite it with local/uncommitted function code, then drift again on the
# next merge to main. Point Vite at your PR's own Convex preview instead (see
# the root CLAUDE.md, "Debugging a red flow against the PR's own services").
# This comment does not change the script's behavior below.

# Check if a URL was provided as the first argument
if [ -n "$1" ]; then
  echo "Setting NEONBINDER_BROWSER_URL to: $1"
  npx convex env set NEONBINDER_BROWSER_URL "$1"
  echo "✅ Environment variable set successfully"
else
  echo "No browser URL provided, skipping environment variable setup"
fi

# Run the Convex dev command
echo "Starting Convex dev server..."
# The Convex CLI v1.27+ does not accept a --key flag. It reads configuration from env/.env.local.
# If you need to provide a deploy key, set CONVEX_DEPLOY_KEY in the environment or .env.local.

if [ -f ".env.convex" ]; then
  npx dotenv-cli -e .env.convex -- npx convex dev
else
  npx convex dev
fi
