---
name: route-key-is-the-object-name-not-the-path
description: When a spec routes the photo store's PUTs, key a file by the object's own name (the 32-hex in /copy-photos/<hex>/image.*), never by the whole pathname; a retry's path differs
metadata:
  type: feedback
---

A photo upload retry goes to the bucket's own host, whose pathname has no bucket prefix, so the same object has two different pathnames across tries. A spec that tells "the held photo" from "the other photo" by whole pathname counts the retry as a second photo and goes green on the old sequential code.

**Why:** NEO-466 "saves both at once" spec first passed against the pre-fix build for exactly this reason; only a run on the pre-fix code showed it.

**How to apply:** capture the object name with a regex group (`/copy-photos/([0-9a-f]{32})/image\.`) and compare that. Prove a concurrency spec red on the pre-fix code: `git archive HEAD apps/web` into the scratchpad, symlink node_modules, copy .env.local, run a second Vite on a spare port, point APP_URL at it (no git state touched), then remove it. Hold every try of the held object until the release, so the 2.5 s stall timer cannot let it finish early. See [[route-only-one-of-two-concurrent-puts]].
