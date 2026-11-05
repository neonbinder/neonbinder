---
name: turn-count-waits-are-load-dependent-under-web-crypto
description: Unit tests that "flush N event-loop turns" go red on a loaded CI runner when Web Crypto signing (aws4fetch R2 PUTs) sits on the path; wait positives by the clock, negatives by a positive precondition plus a short bounded settle
metadata:
  type: feedback
---

A test helper that yields a fixed count of `setImmediate` turns until a condition holds is not deterministic once `crypto.subtle` is on the path (aws4fetch signs every R2 PUT with it; the digest runs on the libuv threadpool, so how many turns it takes depends on runner load). NEO-427: two attach tests passed locally and went red on CI with 1 of 4 PUTs seen after 500 turns.

**Why:** a turn count is a proxy for time only when every await is a microtask or a mocked promise; threadpool work (Web Crypto, zlib, fs) finishes by the clock, not by turns.

**How to apply:** a wait for something that WILL happen is clock-bounded (a few seconds, then the assertion reports what was missing). A wait for something that must NOT happen is never a clock wait (it burns the whole budget and crowds vitest's 5 s default): wait for the positive precondition that proves the other side got as far as it can, then settle a small fixed number of turns, then assert the negative. Check the file's runtime after the change: a negative written as a clock wait shows up as a ~4 s test.
