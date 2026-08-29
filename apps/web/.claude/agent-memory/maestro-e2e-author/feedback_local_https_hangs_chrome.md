---
name: local-https-hangs-chrome
description: A local run against the mkcert HTTPS Vite server never mounts the app — always drive plain HTTP (vite-keeper.sh), even when handed an https:// APP_URL
metadata:
  type: feedback
---

**Never validate a flow against `https://localhost:<port>`. Use the plain-HTTP
dev server (`./vite-keeper.sh`) and an `http://` APP_URL** — even when the task
hands you an `https://` URL and says a dev server is already running there.

**Why:** Chrome for Testing hangs against the mkcert HTTPS dev server. Two
`/node_modules/.vite/deps/*.js` requests never complete, `#root` stays empty,
and Selenium's `getCurrentUrl` blocks until its 180s timeout — so the flow dies
on its first `extendedWaitUntil` with a blank (correctly sized, 1024x625)
screenshot. It reads exactly like a product bug or a bad selector. Branded
Chrome copes only because it has a long-lived profile; chromedriver hands Chrome
for Testing a fresh `--user-data-dir` every run. This is already written up in
the `APP_URL` comment block in `run-e2e-smoke.sh` and at the top of
`vite-keeper.sh` — read those before diagnosing a first-step hang.

Measured 2026-08-29, same worktree, cold browser profile:

| server | time to mount |
|---|---|
| `https://localhost:3001` (mkcert) | never (still empty at 150s) |
| `http://localhost:3002` (`VITE_DEV_DISABLE_HTTPS=1`) | 2s |

**How to apply:** before the first Maestro run, confirm the app actually mounts
in a cold headless profile. If `#root` is empty and only `deps/*.js` requests are
pending, it is this, not your flow. `./vite-keeper.sh` starts the right server
(it exports `VITE_DEV_DISABLE_HTTPS=1`, so `vite.config.ts` skips mkcert
entirely) and auto-increments off any occupied port — read the port it prints
and pass it as `APP_URL`. `http://localhost` is a secure context per spec, so
Clerk and `crypto.subtle` behave exactly as under TLS.

A second Vite on another port is fine and does not disturb another agent's
server; starting/killing servers may be permission-gated, in which case the repo
script is the one to reach for.

**Corollary — write NOTHING inside the Vite project root while a run is in
flight.** The watcher fires on any file under `apps/web` (agent-memory notes and
`.maestro/*.md` included, none of which are in `server.watch.ignored`), the page
mutates under the running command, and Maestro dies with
`CommandFailed: null cannot be cast to non-null type kotlin.String` (or
`kotlin.Int`) somewhere inside a drill util — which reads exactly like a flake in
shared code. Confirmed 2026-08-29: a `MEMORY.md` write at 10:34:05 produced that
crash at 10:34:06 in a flow that passed twice with no writes in flight. Do the
authoring first, run second; park scratch files outside the repo.

See also [[presynced-setup-data]].
