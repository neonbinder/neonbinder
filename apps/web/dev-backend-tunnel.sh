#!/bin/bash

TUNNEL_LOG=$(mktemp)

echo "Starting cloudflared tunnel to localhost:8080..."

# Start cloudflared quick tunnel in the background, capture output
cloudflared tunnel --url http://localhost:8080 2>"$TUNNEL_LOG" &
TUNNEL_PID=$!

# Clean up on exit
trap "echo 'Shutting down tunnel...'; kill $TUNNEL_PID 2>/dev/null; rm -f $TUNNEL_LOG" EXIT

# Wait for cloudflared to output the tunnel URL
TUNNEL_URL=""
for i in $(seq 1 30); do
  TUNNEL_URL=$(grep -o 'https://[a-z0-9\-]*\.trycloudflare\.com' "$TUNNEL_LOG" | head -1)
  if [ -n "$TUNNEL_URL" ]; then
    break
  fi
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  echo "ERROR: Failed to get tunnel URL after 30 seconds"
  cat "$TUNNEL_LOG"
  exit 1
fi

echo "Tunnel URL: $TUNNEL_URL"

# Start the backend with the tunnel URL
./dev-backend.sh "$TUNNEL_URL"
