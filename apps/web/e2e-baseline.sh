#!/bin/bash
# ─── Scripted Set Builder admin tasks (NEO-214) ──────────────────────────────
# The Admin Tools panel is gone: "Reset Set Builder Data" is no longer a
# button any admin could click, it's a scripted task. This wraps the sole
# remaining entry point — `selectorOptions:resetSetBuilderDataFromCli`
# (apps/web/convex/selectorOptions.ts), an internalAction gated on
# `requireAdmin` (satisfied by --identity) + ALLOW_RESET_SET_BUILDER_DATA on
# the target deployment — for CI and for a maintainer's own shell alike.
#
# Jason, 2026-09-04: "I frequently want to wipe dev/preview data so we need to
# make sure it is callable from the command line locally." That's the whole
# reason this isn't just three lines inside run-e2e-smoke.sh: it has to be
# runnable standalone, print what it's about to hit, and refuse prod, whether
# it's CI or a laptop calling it.
#
# Runbook: docs/operations/neo214-set-builder-admin-scripts.md
#
# Usage:
#   ./e2e-baseline.sh reset [--deployment <name>] [--dry-run]
#
# Deployment targeting (first match wins):
#   1. --deployment <name>   Explicit override (CI passes the PR's preview slug).
#   2. $CONVEX_NAME          Same thing via env (what CI actually sets).
#   3. (neither set)         No --deployment flag is passed at all — the Convex
#                            CLI resolves its own default from CONVEX_DEPLOYMENT
#                            in .env.local / .env.convex, i.e. a maintainer's
#                            personal dev deployment. Same resolution
#                            e2e-local-up.sh:53-68 already relies on.
#
# Safety:
#   - `--prod` is refused outright — this script has no path to production.
#   - Any resolved deployment name matching the known prod deployment, or a
#     VITE_CONVEX_URL in .env.local pointing at it, is refused.
#   - Outside CI ($CI unset), the destructive `reset` requires either
#     E2E_BASELINE_CONFIRM=1 or an interactive "type RESET" prompt — so a
#     fat-fingered local run isn't silent.
#   - Never prints CONVEX_DEPLOY_KEY or any other secret.
#
# Exit non-zero on any failure: bad args, unresolved deployment, refused prod
# target, declined confirmation, or the `convex run` call itself failing.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"

# Production Convex deployment (docs/operations/neo190-convex-backups.md §2).
# Hardcoded refusal target — this script must never be able to reach it.
PROD_DEPLOYMENT_NAME="first-starfish-800"

# Pinned to match the version pr-pipeline.yml already trusts for the same
# kind of ad-hoc `npx convex …` CI call (:522) — verified 2026-09-04 that
# convex@1.39.1 supports every flag this script uses (--deployment,
# --identity, --typecheck, --codegen). `npx --yes` makes this hermetic: the
# `seed` job in e2e.yml never runs `npm ci` for apps/web (Maestro needs no
# node_modules), so a bare `npx convex` would have nothing installed to
# resolve and no TTY to confirm an ad-hoc install. Pinning also means local
# and CI runs execute the identical CLI build regardless of what's in
# apps/web's own node_modules.
CONVEX_CLI="convex@1.39.1"

usage() {
  cat >&2 <<'EOF'
Usage: ./e2e-baseline.sh reset [--deployment <name>] [--dry-run]

  reset             Run selectorOptions:resetSetBuilderDataFromCli. DESTRUCTIVE
                     — wipes selectorOptions / cardChecklist / cardCrossListings
                     / players / teams / leagues on the target deployment.

  --deployment NAME  Target Convex deployment slug (e.g. a PR preview). Same
                     as setting $CONVEX_NAME; this flag wins if both are given.
  --dry-run          Resolve and print the target deployment, then exit 0
                     without calling convex or prompting for confirmation.

Env:
  CONVEX_NAME             Deployment slug — same as --deployment. CI sets this.
  E2E_BASELINE_CONFIRM=1  Skip the interactive confirmation prompt outside CI.
  CI                      Set by GitHub Actions. When set, the confirmation
                           prompt is skipped — CI callers are presumed
                           intentional; the deployment is still printed.

Never targets production: refuses --prod, a deployment name that resolves to
production, and a VITE_CONVEX_URL in .env.local pointing at it. See
docs/operations/neo214-set-builder-admin-scripts.md for the (manual, armed)
prod runbook.
EOF
}

SUBCOMMAND="${1:-}"
[ $# -gt 0 ] && shift

DEPLOYMENT_ARG=""
DRY_RUN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --deployment)
      [ $# -ge 2 ] || { echo "✗ --deployment requires a value" >&2; exit 1; }
      DEPLOYMENT_ARG="$2"; shift 2 ;;
    --deployment=*) DEPLOYMENT_ARG="${1#--deployment=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --prod)
      echo "✗ refusing: --prod is never allowed here — this script cannot target production. See docs/operations/neo214-set-builder-admin-scripts.md." >&2
      exit 1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "✗ unrecognized argument: $1" >&2; usage; exit 1 ;;
  esac
done

case "$SUBCOMMAND" in
  reset) ;;
  ""|-h|--help) usage; exit 0 ;;
  *)
    echo "✗ unknown subcommand: \"$SUBCOMMAND\" — only \"reset\" is supported (NEO-214 removed the seed-teams fixture)." >&2
    usage
    exit 1 ;;
esac

# ── Resolve the target deployment ────────────────────────────────────────
DOTENV=()
[ -f .env.convex ] && DOTENV=(npx dotenv-cli -e .env.convex --)

TARGET="${DEPLOYMENT_ARG:-${CONVEX_NAME:-}}"
DEPLOY_ARGS=()
if [ -n "$TARGET" ]; then
  DEPLOY_ARGS=(--deployment "$TARGET")
  DISPLAY_TARGET="$TARGET (explicit)"
else
  # Nothing explicit — read CONVEX_DEPLOYMENT purely to PRINT/GUARD it. The
  # actual `convex run` call below still passes no --deployment flag, so the
  # CLI does its own resolution from .env.local / .env.convex, exactly as
  # e2e-local-up.sh:53-68 does for CONVEX_SITE_URL.
  RESOLVED=""
  for f in .env.convex .env.local; do
    [ -f "$f" ] || continue
    # `npx convex dev` writes this line as `dev:name # team: …, project: …` —
    # strip that trailing comment along with surrounding quotes/whitespace.
    RESOLVED="$(grep -E '^CONVEX_DEPLOYMENT=' "$f" 2>/dev/null | head -1 | sed -E 's/^CONVEX_DEPLOYMENT=//; s/[[:space:]]*#.*$//; s/^["'\'']//; s/["'\'']$//; s/[[:space:]]+$//')"
    [ -n "$RESOLVED" ] && break
  done
  if [ -z "$RESOLVED" ]; then
    echo "✗ Could not resolve a target deployment. Set CONVEX_NAME, pass --deployment <name>, or run from a checkout with CONVEX_DEPLOYMENT in .env.local / .env.convex (bootstrap-worktree-env.sh sets this up)." >&2
    exit 1
  fi
  DISPLAY_TARGET="$RESOLVED (CLI default, resolved from .env.local/.env.convex — not passed explicitly)"
  TARGET="$RESOLVED"
fi

# ── Refuse production, however it was reached ────────────────────────────
# TARGET may carry a "dev:"/"prod:" prefix when it came from CONVEX_DEPLOYMENT;
# strip it before comparing against the known prod slug.
TARGET_BARE="${TARGET#dev:}"; TARGET_BARE="${TARGET_BARE#prod:}"
if [ "$TARGET_BARE" = "$PROD_DEPLOYMENT_NAME" ]; then
  echo "✗ refusing: target deployment resolves to PRODUCTION ($PROD_DEPLOYMENT_NAME). This script never targets prod — see docs/operations/neo214-set-builder-admin-scripts.md for the manual, armed prod runbook." >&2
  exit 1
fi
if [ -f .env.local ]; then
  VITE_URL="$(grep -E '^VITE_CONVEX_URL=' .env.local 2>/dev/null | head -1 | sed -E 's/^VITE_CONVEX_URL=//; s/^["'\'']//; s/["'\'']$//')"
  case "$VITE_URL" in
    *"$PROD_DEPLOYMENT_NAME"*)
      echo "✗ refusing: .env.local's VITE_CONVEX_URL points at production ($VITE_URL)." >&2
      exit 1 ;;
  esac
fi

echo "── e2e-baseline.sh $SUBCOMMAND ──"
echo "   target deployment: $DISPLAY_TARGET"

if [ -n "$DRY_RUN" ]; then
  echo "── --dry-run: stopping before calling convex ──"
  exit 0
fi

# ── Confirmation gate (outside CI only) ──────────────────────────────────
if [ -z "${CI:-}" ] && [ "${E2E_BASELINE_CONFIRM:-}" != "1" ]; then
  if [ -t 0 ]; then
    read -r -p "Type RESET to wipe Set Builder data on '$DISPLAY_TARGET': " answer
    if [ "$answer" != "RESET" ]; then
      echo "✗ aborted — confirmation did not match." >&2
      exit 1
    fi
  else
    echo "✗ refusing: not running in CI, and no TTY to confirm. Set E2E_BASELINE_CONFIRM=1 to run non-interactively." >&2
    exit 1
  fi
fi

echo "▶ running resetSetBuilderDataFromCli against $DISPLAY_TARGET ..."
# NOTE: `"${arr[@]+"${arr[@]}"}"` rather than a bare `"${arr[@]}"` — bash 3.2
# (macOS's default /bin/bash, and this script's own local-shell target per
# decision 3) throws "unbound variable" under `set -u` when expanding an
# EMPTY array's `[@]`, even though the array itself is very much set. Fixed
# in bash 4.4+, but this has to run on a maintainer's stock macOS bash too.
if ! "${DOTENV[@]+"${DOTENV[@]}"}" npx --yes "$CONVEX_CLI" run selectorOptions:resetSetBuilderDataFromCli \
    '{"confirm":"RESET"}' --identity '{"role":"admin"}' \
    --typecheck disable --codegen disable \
    "${DEPLOY_ARGS[@]+"${DEPLOY_ARGS[@]}"}"; then
  echo "✗ reset failed — see the convex run output above. If it says the deployment isn't armed, see docs/operations/neo214-set-builder-admin-scripts.md." >&2
  exit 1
fi
echo "✅ Set Builder data reset on $DISPLAY_TARGET."
