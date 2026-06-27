#!/bin/bash

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
