#!/usr/bin/env bash
# Run the preprocess service locally against real Vision + Anthropic.
#
# - Loads env from .env.local (ANTHROPIC_API_KEY at minimum).
# - Defaults INTERNAL_API_KEY to "dev-key" if not already set (override by
#   exporting before invoking).
# - Vision uses your ADC; run `gcloud auth application-default login` first.
# - Extra args pass through to uvicorn, e.g. ./run_local.sh --port 9090
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -x .venv/bin/uvicorn ]]; then
  echo "error: .venv/bin/uvicorn not found. create the venv first:" >&2
  echo "  python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt" >&2
  exit 1
fi

if [[ -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "warning: ANTHROPIC_API_KEY is not set; /process will 502 on classify." >&2
fi

export INTERNAL_API_KEY="${INTERNAL_API_KEY:-dev-key}"

echo "preprocess: starting on http://localhost:8080 (internal key: $INTERNAL_API_KEY)"
echo "example: curl -H 'x-internal-key: $INTERNAL_API_KEY' -F image=@card.jpg http://localhost:8080/process"
echo

exec .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload "$@"
