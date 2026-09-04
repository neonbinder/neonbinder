---
name: local-vite-serves-one-worktree
description: :3000 may be another agent's worktree — check the Vite process cwd before trusting a local run, and start your own on :3001 with VITE_DEV_DISABLE_HTTPS=1
metadata:
  type: reference
---

Local E2E drives whatever bundle is on `APP_URL`. With several agents working
in parallel worktrees, the Vite already listening on `:3000` frequently belongs
to a DIFFERENT branch — so a "local validation" of your new flow can silently
exercise a bundle that does not contain your feature at all, and every new
selector fails for the wrong reason.

**Check first** (verified 2026-09-02):

```bash
PID=$(lsof -nP -iTCP:3000 -sTCP:LISTEN -t | head -1)
lsof -a -p $PID -d cwd -Fn | tail -1     # → the worktree it is serving
```

**If it is not yours, do not restart or kill it.** Start your own alongside and
point the run at it:

```bash
cd <your worktree>/apps/web
VITE_DEV_DISABLE_HTTPS=1 npx vite --port 3001 --strictPort &
APP_URL=http://localhost:3001 MAESTRO_PARALLELISM=1 MAESTRO_SKIP_BOOTSTRAP=1 \
  MAESTRO_NO_DEPS=1 npm run test:e2e:pick -- name:<flow>
```

`VITE_DEV_DISABLE_HTTPS=1` matters: without it `vite-plugin-mkcert` serves
**https**, and `run-e2e-smoke.sh` (and CI) drive plain `http`. `APP_URL` is
honoured by the runner (`APP_URL="${APP_URL:-http://localhost:3000}"`), so no
script edit is needed. Kill your extra Vite when you are done.

**Failure signature when Vite is on https** (cost two 5-min runs, 2026-09-03):
pointing `APP_URL` at `https://localhost:3000` does NOT fail fast. Chromedriver
runs with `acceptInsecureCerts: false`, so the mkcert page never finishes
loading and the FIRST assert hangs the full driver timeout — the flow dies at
~5m with `CommandFailed: java.util.concurrent.TimeoutException` on
`getCurrentUrl {}` and an all-white screenshot. Every flow fails identically,
including known-good ones like `profile/worker-bootstrap`. **A blank screenshot
plus a `getCurrentUrl` timeout means the transport, not your selectors** —
check `http` vs `https` before touching the flow. `curl -sk` against the same
URL returning 200 does not clear the server: curl does not enforce the cert.

**The MIRROR signature — Vite on https, runner on the default http** (2026-09-03):
if you start Vite without `VITE_DEV_DISABLE_HTTPS=1` and then just run
`npm run test:e2e:pick` (which defaults `APP_URL` to `http://localhost:3000`),
Phase 0 fails on EVERY worker in ~90 s with a plain
`Assertion is false: "Profile Settings" is visible`. Nothing in the message
points at the transport. **"Phase 0 bootstrap failed on worker 0/1/2" — all
workers, same assert — is a transport problem, never a flow problem**: check the
`➜  Local:` line in the Vite log for `http` vs `https` before anything else.

Note the Convex backend is still shared dev regardless of which Vite you run —
see [[local-validation-needs-a-pr-preview]].
