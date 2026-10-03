---
name: telemetry-awaited-in-a-workpool-worker-holds-the-slot
description: Anything awaited inside a workpool worker action (PostHog via ctx.runAction, heartbeats) is paid while the pool slot is held; plan side-channel telemetry as scheduler.runAfter(0), never an awaited runAction
metadata:
  type: feedback
---
Side-channel work inside a workpool worker action is on the critical path: the slot is held until the action returns, so an awaited `ctx.runAction` into a Node action plus a network flush costs throughput on every attempt.

**Why:** `recordAdapterCall` awaits a PostHog `captureEvent` Node action per preprocess attempt (NEO-314 perf plan, 2026-10-02); at 20 fast slots that is a fixed tax on every image.

**How to apply:** when a plan adds logging/metrics inside a worker or adapter call, keep the `console.log` synchronous and schedule the network side with `scheduler.runAfter(0, ...)`, resolving auth-dependent values (distinctId) before scheduling. Check adapter tests that pin "telemetry emitted per request" and restate them as "scheduled".
