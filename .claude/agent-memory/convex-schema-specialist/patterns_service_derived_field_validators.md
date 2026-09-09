---
name: patterns-service-derived-field-validators
description: Convex validator rule for this repo — columns written from an external service response get loose validators, columns our own code produces get unions; plus the return-validator corollary
metadata:
  type: reference
---

**The rule NEO-170 established: a column whose value originates in an external service response gets a loose validator (`v.optional(v.string())` / `v.number()`), narrowed field-by-field at the consumer. A column whose value our own TypeScript produces gets a `v.union(v.literal(...))`.**

Examples in `apps/web/convex/schema.ts`: `placeholderImages.side`, `.croppedSource`, `.dhash`, `.errorCode` are loose (preprocess service owns them); `placeholderImages.status`, `.pairStatus` and `placeholderPairs.confidence` / `.mechanism` are unions (we produce them).

**Why the loose half:** the field is written inside a workpool `onComplete` mutation. A `v.union` rejection there throws at INSERT/PATCH time — *after* the work succeeded and the money was spent. The image row never reaches a terminal state, the job's counters never converge on `processed + failed === total`, and the batch hangs in `"processing"` forever with no error surfaced. The service's response shape ships from a different repo on a different cadence, so one additive vocabulary value would brick every job. A dropped/undefined field is the honest representation of "the service gave us nothing usable" and costs one image's metadata instead of the batch.

Note the *stated* reason in the schema comment ("the service owns the vocabulary") is the weaker one — the real argument is the stranding failure mode. Empirically `side` is already coerced to exactly `{front, back}` in `services/preprocess/app/classify.py`, so vocabulary ownership alone would not justify the looseness.

**Why the union half:** values our own code produces cannot drift behind our back, and the union is what gives the client an exhaustive discriminated type. Defend them at the boundary anyway — `asConfidence` / `asMechanism` in `convex/placeholderPairing.ts` degrade an unrecognized literal to the weakest honest value rather than failing a chunk.

**Return-validator corollary:** mirror the schema's union in the `returns:` validator for our own unions (so the React side gets exhaustive switch checking), and keep the loose validator for service-derived ones. Widening a union column to `v.string()` in `returns:` is a silent type-safety loss with nothing bought.

**Not applicable to `v.int64`.** Nothing in this domain needs it — counters, zip indexes, ms timestamps and scores are all inside `Number.MAX_SAFE_INTEGER`, and `v.int64` surfaces as `BigInt`, which does not survive JSON or client-side arithmetic cleanly. Perceptual hashes stay 16-char hex strings, not int64, because the hex is the wire format and `hammingDistance` parses to BigInt only on the rare same-side collision.

See [[project-neo170-placeholder-batch-schema]].
