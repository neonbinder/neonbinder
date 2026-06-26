---
name: patterns-url-redirect-chains
description: Maestro sign-in URL redirect chain patterns — nested ?redirect= chains for sign-in → reset → seed → destination
metadata:
  type: project
---

## How redirect chains work
`/testing/sign-in?redirect=<URL>` signs the worker in then forwards to `<URL>`. Nested `?redirect=` chains are URI-encoded in practice but work as plain nesting in the YAML `url:` field.

## Seed-only chain (most flows)
```
.../testing/sign-in?redirect=/testing/seed-credentials?redirect=<DEST>&worker=${WORKER_INDEX || "0"}
```
Use when: the flow just needs real credentials available (set-selector flows, test-* credential flows).

## Reset-then-seed chain (worker bootstrap)
```
.../testing/sign-in?redirect=/testing/reset?redirect=/testing/seed-credentials?redirect=<DEST>&worker=${WORKER_INDEX || "0"}
```
Use when: the flow must wipe state before seeding (worker-bootstrap.yaml).

## Reset-only chain (existing pattern, do not break)
```
.../testing/sign-in?redirect=/testing/reset?redirect=<DEST>&worker=${WORKER_INDEX || "0"}
```
Used by flows that reset but don't need real credentials (e.g. fill-profile-data.yaml with `account=new-profile`).

## Key: `worker=` parameter
Always preserve the `&worker=${WORKER_INDEX || "0"}` parameter when updating URL chains — it tells sign-in which Clerk user to authenticate as.
