---
name: reference-happy-dom-xhr-bypasses-fetch-guard
description: Since NEO-466 photo uploads go over XMLHttpRequest (lib/collection/xhr-transport.ts); happy-dom's XHR is NOT covered by the vitest network guard, which wraps fetch, so a test that stubs fetch now makes a real outbound XHR
metadata:
  type: reference
---

`uploadWithRetry` defaults to an XHR transport (upload progress drives its stall
timer; fetch can't report request-body progress). In the `components` project
happy-dom implements XHR itself, and the network guard only wraps `fetch`, so:

- a test that `vi.stubGlobal("fetch", ...)` and then drives a photo upload
  (RequestsDialog, requests/photos, anything calling `addPhoto`) silently makes
  a real XHR to whatever URL the fake action returned, and fails slowly;
- inject `transport` via `uploadWithRetry(request, { transport })`, or mock the
  module, rather than stubbing fetch.

**Why:** found while building NEO-466; the old fetch-based tests went red with a
`copy_photo_put_failed ... status: null, attempts: 3` line instead of a guard trip.

**How to apply:** any new code path that sends bytes with XHR needs an injectable
transport, and its tests must inject it. Related: Chromium only reports upload
progress for `xhr.upload` listeners attached BEFORE `send()`. See [[gates-in-a-shared-worktree]].
