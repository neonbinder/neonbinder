#!/bin/bash

# This script runs before dev to sync environment variables with Convex

echo "🔄 Syncing environment variables with Convex..."

# Check if FUSION_ENV_ORIGIN is set and update Convex
if [ -n "$FUSION_ENV_ORIGIN" ]; then
  echo "🔄 Updating Convex with FUSION_ENV_ORIGIN: $FUSION_ENV_ORIGIN"
  npx convex env set FUSION_ENV_ORIGIN "$FUSION_ENV_ORIGIN"
  npx convex env set SITE_URL "$FUSION_ENV_ORIGIN"
  echo "✅ FUSION_ENV_ORIGIN synced to Convex"
else
  echo "ℹ️  FUSION_ENV_ORIGIN not set, skipping Convex env sync"
  echo "✅ SITE_URL set to localhost:3000"
  npx convex env set SITE_URL "http://localhost:3000"
fi

echo "✅ Environment sync complete"
