---
name: product-bug-tests-are-fix-requests
description: A failing test titled "PRODUCT BUG (file:line)" in a concurrently-authored test file is a fix request for the builder who owns that file, not a test to edit or skip
metadata:
  type: feedback
---

When a parallel build round leaves a red test whose title starts with
`PRODUCT BUG (<file>:<line>)`, fix the product code in the named file if it is
yours; never touch the test file (unit-test-author owns it) and never report
the red as "their test is wrong" without checking the claim.

**Why:** unit-test-author's house rule is to report a product bug with a
failing test rather than silently fixing product code. In NEO-237 the test
`stripMatchedBrandPrefix("Choice-Biloxi", "Choice") → "Biloxi"` pinned a real
gap (the matcher accepts any non-alphanumeric boundary, the strip only trimmed
whitespace). Fixing the file it named made the round green without anyone
editing a test.

**How to apply:** run the untracked `*.test.ts` files beside your area as part
of the fast gate, read the title before deciding whose it is, and if a pinned
expectation conflicts with a DIFFERENT function's deliberate pin (here the
adapter's `stripBrandPrefixForLabel` keeps "-Series 1" on purpose), fix only
the function the test names and say why the two differ in its doc comment.
