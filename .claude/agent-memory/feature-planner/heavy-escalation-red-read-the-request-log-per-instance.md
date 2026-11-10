---
name: heavy-escalation-red-read-the-request-log-per-instance
description: Placeholder photo E2E red (heavy AND fast lane): "All N photos read." counts failed photos; the decisive artifact is the heavy service's Cloud Run request log grouped by instance, where a burst can queue serially behind ONE cold instance while warm ones idle; compare cold start + (N-1) x inference to the per-call budget
metadata:
  type: feedback
---

When `pipeline-escalation-cold-start` (or any heavy-escalation spec) goes red at
the pairs count, do not reason from the Convex log alone: pull the heavy
preprocess service's Cloud Run log for the window and group it by instance id.

**Why:** On 2026-11-05 a six-photo escalation burst hit a service with one
warm instance free. One request got it (61 s); the other five were queued and
then served one after another by the single instance their arrival started,
even though two instances that had been booting for an earlier burst came
ready three minutes before it. Two warm-and-idle instances had been scaled in
within two minutes of their last request. So the wall-clock for the queued
requests was cold start (~240 s on that revision) + k x ~40 s inference; the
5th and 6th crossed the fixed per-call heavy budget by 0.6 s and 44 s, the
7-minute photo deadline (counted from the first heavy start) expired 20 s after
the budget, so the pool's 40 s-backoff retry could never land, and both photos
failed PHOTO_TIMED_OUT. The Convex side looked healthy throughout.

**How to apply:**
- "All N photos read." is the `waiting` stage: every row terminal, failed rows
  included. It does not prove none failed; the pairs count and the absence of
  the "N photos couldn't be read" group do. Read the hierarchy dump for that
  group and the Recent runs row ("Finished — 4 of 6 images, 2 failed") first.
- A web-only PR's preview calls the SHARED dev heavy service at dev pool width
  (pr-pipeline.yml comments). Check whether another PR's run, or a laptop
  deployment, was in flight; if not, the per-instance request log is the
  whole story.
- Per-call budget, retry backoff and the photo deadline are one arithmetic:
  budget + shortest backoff must fit inside the deadline or a timed-out call is
  a failed photo by construction. Any change to those numbers is Jason's call;
  state it as a question with the measured cold start and queue depth.
- This is a product fragility (a real six-photo batch loses two photos and is
  told "All 6 photos read."), not a spec or timing problem; the 7 s assert on
  the pairs count is correct and was not what failed. Related:
  [[turn-count-waits-are-load-dependent-under-web-crypto]].

**Fast lane too (NEO-446, 2026-11-07).** A fast-lane photo red can be a spec whose
own reads never left Convex: the fast pool is deployment-wide and only as wide as
the instance ceiling (3 on a preview), so another shard's burst whose calls Cloud
Run holds for a booting instance (one start took ~2 min while two siblings were
ready and idle) occupies every slot for ~60 s (fast per-call timeout) and the next
three for ~55 s. The red spec's calls then dispatch a minute late and take 2-8 s.
Tell-tale: the red job's `preprocessProcessEntryFast` lines end long after its
extract, with short `duration_ms`, while another jobId shows `error_class: timeout`
at ~60 s. Cloud Run's request-log `latency` there excludes the pending time, so
compare the request `timestamp` with the app's own lines for the same index.
