---
name: collect-mode-and-preview-side-effects
description: Run-to-the-end (collect) engines must key dependency state by target, not by step invocation; mocked-adapter zero-write tests cannot see credential-refresh side effects
metadata:
  type: reference
---

Two patterns from the NEO-339 one-shot set build audit.

- **Collect mode keys its gates by target.** When a runner keeps going past an
  open decision (`stopAt: "end"`), the "this step waits on that one" state must
  live at run level and be keyed by what it guards (the folded set path, the
  brand-year key). If it is local to one step invocation, a spec that names the
  same set twice gets a second step with an empty gate. That step then writes
  what stop-at-first would have blocked. Check for a run-level map, or for a
  schema refinement that refuses the repeat, and for a test of the duplicate
  case.
- **"Read-only" previews are read-only on NB data, not side-effect free.** A
  preview that reuses the real adapters inherits their 401 → refresh path:
  Secret Manager writes through the browser service, re-auth lock rows, and
  telemetry. Zero-write tests that mock the adapters cannot see any of it.
  Word docs and tool descriptions as "read-only on NB data", and make sure a
  caller stops sending a side's previews once that side reports signed out.

Related: [[confirm-phrase-and-read-write-splits]], [[inline-reauth-bypasses-backoff]].
