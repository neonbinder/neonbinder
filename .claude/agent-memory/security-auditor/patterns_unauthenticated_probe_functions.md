---
name: patterns-unauthenticated-probe-functions
description: How to audit a deliberately unauthenticated public Convex function (latency probe, health ping) - marginal cost vs an auth-failing call, arg bounds, env gating, registry entry, and the CI artifacts it feeds
metadata:
  type: project
---

NEO-407 added `latencyProbe.ping` (query) / `pingMutation` (mutation): public,
no identity check, one `.first()` read, `returns: v.null()`, deployed to prod
like every other module.

**How to weigh the abuse surface**
- Compare to the baseline, not to zero: any public function that throws
  "not signed in" still bills one function call. A no-auth ping that reads one
  doc adds ~one doc read per call, so it is not an amplifier. It becomes one
  only if the handler grows (collect, scan, schedule, fetch, write) - pin the
  shape with a test (returns null, writes nothing, reads at most one doc).
- Unique args (a nonce) defeat the query cache by design: every call executes.
  That is the point of the probe and also what an attacker gets for free; it
  is no worse than any other public query called with varying args.
- `v.string()` has no length bound; Convex caps args (MiB scale). Prefer a
  handler-side length check for diagnostics args anyway.
- There is still no rate-limiter component in `convex.config.ts`, so "rate
  limit it" is a new dependency, not a config line.
- A probe meant only for CI previews can fail closed in prod the same way the
  testing endpoints do (`TESTING_RESET_SECRET` presence, see
  [[patterns_testing_endpoint_gate]]): return null before the read when unset.
  That keeps the public prod surface identical to before.
- Register it in `publicFunctionAuth.test.ts` as an intentional-public entry
  (see [[public-function-auth-registry]]); a colocated test is not enough.

**CI side**
- A step that only needs the deployment URL should carry no secret in its
  `env:` - check the start step does not copy the neighbouring log-capture
  step's deploy key.
- Background `nohup ... & disown` + PID via `$GITHUB_ENV` + `if: always()` stop
  step is the house pattern (the convex-logs capture uses it too).
- Probe output rows should be fixed-shape (time, kind, ms, ok, truncated error
  message). The only free text is the client error message; check it cannot
  carry a header/token (ConvexHttpClient errors carry request ids and server
  error text, not auth headers when no auth is set).
- Function-call volume from a per-shard probe is real money at CI cadence
  (calls/s x shard minutes x shards x passes x runs/day) against the team's
  monthly function-call quota; state it as a cost note.

**Write-path probe (pingWrite)**
- An anonymous write is acceptable when it is gated the same way, targets its
  own single-row table (patch-or-insert on `.first()`), has no reader and no
  user-visible effect; pin "exactly one row when enabled, zero when unset" in
  both the colocated test and the registry entry, and count the gate line
  occurrences in source so a new probe cannot skip it.
- Racing first calls can insert two rows (both see no row); harmless for a
  beat table, but `.first()` keeps the bound at "small", not strictly one.
- A probe started in a step BEFORE the deploy-key step does not inherit that
  key (env is fixed at spawn). Same-UID /proc reach is no new exposure when the
  keyed step already runs PR code.
