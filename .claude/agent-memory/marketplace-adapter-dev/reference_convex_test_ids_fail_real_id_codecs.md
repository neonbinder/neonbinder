---
name: convex-test-ids-fail-real-id-codecs
description: convex-test mints ids without the Convex checksum, so any codec that validates a real id (lib/listingSku) throws in convex-test; vi.mock the codec with the same shape minus the check
metadata:
  type: reference
---

convex-test ids look like `…0010cardChecklist`, not the backend's checksummed
base32. A helper that validates a real Convex id (the NEO-370 listing SKU
codec in `convex/lib/listingSku.ts`) refuses them with "cardId is not a
Convex id", so a convex-test file that reaches it must `vi.mock` the module
with a checksum-free build/parse in the same string shape. The codec's own
unit test pins the real checksum path.

Also: a test that only *inspects* `_scheduled_functions` (e.g. a cron fan-out
that schedules network actions at 0 ms) must `vi.useFakeTimers()` first, or the
scheduled action runs after the fetch stub is gone and the NEO-188 network
guard fails the whole file, naming a later test. See
[[scheduled-telemetry-unmasks-cross-test-leaks]].
