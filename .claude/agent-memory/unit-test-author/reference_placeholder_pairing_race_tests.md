---
name: placeholder-pairing-race-tests
description: placeholderPairingRace.test.ts patterns - hand-driven read/write interleave, two-layer guard break-checks, blind stored-pairs read via registry swap
metadata:
  type: reference
---

- Drive a read-then-write race by hand: call the action's read queries (`listDoneImagesForPairing`, `listPairsForDiff`) -> pure `computePairingDiff`, commit the competing mutation, then call the write mutation with the stale diff.
- Two layers guard the same race (status gate and one-pair-per-image skip), so disabling one alone leaves the interleave test green. Pin each with its own test: `final:false` for the gate, `final:true` for the skip.
- Reach a skip through the real action by swapping `listPairsForDiff` in the module registry (`"./placeholderPairing.ts": async () => ({...pairingModule, listPairsForDiff: internalQuery({handler: async () => []})})`) while a pair row already exists.
- HEAD~1 of a source whose mutation args gained a required field fails on the validator ("Unexpected field"), not on the symptom; to see the symptom, mutate HEAD (gate + skip off together).
- placeholderJobs status has no "canceled"; the schema set is pending/uploaded/collecting/extracting/processing/pairing/succeeded/failed.
