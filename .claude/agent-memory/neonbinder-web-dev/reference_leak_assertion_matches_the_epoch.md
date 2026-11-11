---
name: leak-assertion-matches-the-epoch
description: bscSeller.telemetry.test.ts asserts a log line not.toContain("555"), and the line carries an epoch-ms "at" — red whenever the clock's digits contain 555; rerun before attributing
metadata:
  type: reference
---

`convex/adapters/bscSeller.telemetry.test.ts` ("a 4xx naming an order, an address and a phone keeps only the code and status values") checks that short PII fragments ("555", "867", "5309", …) never appear in the serialized log line. The line also carries `"at": Date.now()`, so the test goes red on its own whenever the millisecond timestamp happens to contain one of those digit runs (seen 2026-11-10: `at":1794355596299`).

**Why it matters:** a full `npm run test:unit` red in that file looks like a telemetry leak from whoever touched the seller adapter, and it is not.

**How to apply:** on that failure, read the Received line; if the fragment only appears inside `"at":…`, it is this flake — rerun the file, and report it rather than blaming a sibling. The durable fix is a fake clock or stripping `at` before the substring check.
