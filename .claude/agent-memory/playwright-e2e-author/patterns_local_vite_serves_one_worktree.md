---
name: local-vite-serves-one-worktree
description: :3000 may be another agent's worktree — check the Vite process cwd before trusting a local run, and start your own on a spare port with VITE_DEV_DISABLE_HTTPS=1
metadata:
  type: reference
---

Local E2E drives whatever bundle is on `APP_URL`. With several agents working in
parallel worktrees, the Vite already listening on `:3000` frequently belongs to a
DIFFERENT branch, so a "local validation" of your new spec can silently exercise a
bundle that does not contain your feature at all, and every new locator fails for
the wrong reason.

**Check first:**

```bash
PID=$(lsof -nP -iTCP:3000 -sTCP:LISTEN -t | head -1)
lsof -a -p $PID -d cwd -Fn | tail -1     # the worktree it is serving
```

**If it is not yours, do not restart or kill it.** Start your own alongside (full
recipe in CLAUDE.md "Debugging a red spec against the PR's own services" and GUIDE
"Running"):

```bash
cd <your worktree>/apps/web
VITE_DEV_DISABLE_HTTPS=1 npx vite --port 3001 --strictPort &
APP_URL=http://localhost:3001 WORKER_INDEX=0 \
  npx playwright test --project=e2e --no-deps <path-substring>
```

`VITE_DEV_DISABLE_HTTPS=1` matters: without it `vite-plugin-mkcert` serves
**https** and the browser (which does not accept the self-signed cert) never
finishes loading. **Failure signature when Vite is on https:** the first
navigation hangs, the screenshot is blank white, and EVERY spec fails
identically, including known-good ones like the worker bootstrap. **A blank
screenshot with every spec failing at its first navigation means the transport,
not your locators:** check `http` vs `https` (the `Local:` line in the Vite log)
before touching a spec. `curl -sk` against the same URL returning 200 does not
clear the server: curl does not enforce the cert.

Note the Convex backend is still whatever `VITE_CONVEX_URL` says regardless of
which Vite you run; see [[project_dev_must_carry_the_branch_before_a_local_run]].
