---
name: patterns_bash_macos_empty_array
description: macOS ships bash 3.2 — "${arr[@]}" on an EMPTY array is fatal under `set -u`, even though the array is set. Fixed idiom to use in any script that must run on a maintainer's local shell.
metadata:
  type: patterns
---

macOS's `/bin/bash` is 3.2.57 (last GPLv2 release, frozen since ~2007) and
has a real bug: expanding `"${arr[@]}"` when `arr=()` (zero elements, but
very much *set*) throws `unbound variable` under `set -u` — reproduced
2026-09-04 while building NEO-214's `apps/web/e2e-baseline.sh`. Fixed in
bash 4.4+, but this repo's own local-dev scripts (e.g. `e2e-local-up.sh`'s
`DOTENV=()` pattern) target exactly this shell — any "must also work from a
maintainer's own shell, not just CI" requirement implies this constraint.

**Symptom:** a script with `set -euo pipefail` and an optionally-empty array
built like `ARGS=(); [ cond ] && ARGS=(--flag value)`, later expanded as
`"${ARGS[@]}"` in a command — crashes instantly with `bash: line N:
ARGS[@]: unbound variable`, but only when the array ended up empty, and only
on macOS's stock bash. Inside a `$(...)` command substitution assigned to a
variable, this failure is silent (empty output, `set -e` doesn't propagate)
— so it can hide there for a long time; in an `if ! cmd; then` or bare
command context it is loudly fatal and kills the whole script.

**Fix — use this idiom everywhere an array might be empty:**

```bash
"${ARGS[@]+"${ARGS[@]}"}"
```

instead of the bare `"${ARGS[@]}"`. Verified empty-array-safe AND
populated-array-safe under bash 3.2 with `set -euo pipefail`, in both a bare
command and an `if ! cmd; then` context. Applies to any array built
conditionally (`DOTENV=()`, `DEPLOY_ARGS=()`-style flag arrays) in a script
that has to run on a maintainer's laptop, not just in CI (where the runner's
bash is almost always ≥4).

**Pre-existing instance not fixed (out of scope, flagged only):**
`apps/web/e2e-local-up.sh`'s `DOTENV=()` / `"${DOTENV[@]}" npx convex env
get …` pattern (around :50-65) has the same latent bug, currently masked
because it runs inside a `$(...)` assignment (silent failure, not fatal) and
because this worktree's `.env.convex` exists (even empty), so `DOTENV` is
never actually empty in practice. Worth fixing if that script is next
touched.
