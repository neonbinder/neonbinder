#!/bin/bash

# NEO-249: this wraps `npx convex dev`, which targets a Convex *dev*
# deployment. A dev deployment is a DEVELOPER'S PERSONAL deployment, not a
# shared dev server, and nobody deploys to dev from CI — no workflow pushes
# it. Run this against your own dev deployment when you want to test locally,
# or at the same time you push to a PR. When you need to exercise the PR's own
# backend code, point local Vite at that PR's Convex preview instead (see the
# root CLAUDE.md, "Debugging a red flow against the PR's own services"). Now
# that every PR gets its own preview, the dev deployment is mostly unused.
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
