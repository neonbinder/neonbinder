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

Note the Convex backend is still shared dev regardless of which Vite you run —
see [[local-validation-needs-a-pr-preview]].
