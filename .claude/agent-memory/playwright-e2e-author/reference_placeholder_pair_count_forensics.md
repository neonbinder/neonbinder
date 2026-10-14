---
name: placeholder-pair-count-forensics
description: How to explain a wrong "N pairs ready to print." from convex-logs — placeholder_pair_decided/pairing_done per writer, and the provisional-run vs close-finalize duplicate-insert race
metadata:
  type: reference
---

A wrong pair count on the placeholder specs is answered from the uploaded Convex
logs artifact, not the screenshot (the pair grid can be below the fold).

- Find the spec's job: the escalation spec is the only one with
  `preprocessProcessEntryHeavy` lines; group by `jobId`.
- Every writer logs `placeholder_pair_decided` (front/back index + name, labels,
  textCount, cardNumber, player, orientedBy, mechanism, confidence) per pair it
  WROTE, then `placeholder_pairing_done` with `inserted/revised/removed`. Writers:
  `placeholderPairing:runPairing` (Action; `final:false` = debounced provisional
  run) and `placeholderStream:closePlaceholderStream` (Mutation; inline finalize,
  logs decisions but no done line).
- Sum the inserts across writers and compare to the screen. A count that is too
  HIGH, with the same frontIndex/backIndex decided by both a `final:true` close and
  a `final:false` runPairing within ~100 ms, is the duplicate-insert race (NEO-325
  diagnosis, 2026-10-09): the action checks job status once, reads stored pairs,
  then blind-inserts via `applyPairDiff` after the close mutation already inserted
  them. A product bug; never pad the spec's Finish timing.
- Classification identical across pass/fail runs (same labels, textCounts, card
  numbers) rules the preprocess/classifier out.

Related: [[measure-a-fixture-from-ci-artifacts]]
