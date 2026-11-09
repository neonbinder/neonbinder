---
name: patterns-neo475-body-scrubber
description: How to break a response-body/header scrubber that feeds public CI log artifacts — prefix-wildcard header allowlists, slice-before-redact, free-text kept keys, key names as data, HTML entities; run the copy, don't read it
metadata:
  type: feedback
---

Audit a telemetry scrubber by RUNNING adversarial inputs through a scratch copy
(`node --experimental-strip-types` on a copied .ts works; no repo edits). Reading
the regexes missed half of what the run showed.

Traps found in the NEO-475 BSC recorder (`convex/lib/bscCallTelemetry.ts`):

- **Header "allowlist" with a prefix wildcard** (`x-amzn-*`) is not an allowlist:
  API Gateway remaps reserved response headers to `x-amzn-Remapped-<name>`
  (Authorization, WWW-Authenticate, ...). And header values skipped `redact()`
  entirely, so a JWT in any allowed header went through verbatim. Ask for exact
  names plus redact on values.
- **Slice before redact**: per-field `.slice(0, N)` (values, key names) ran
  before the regex pass, so a cut mid-token leaves a <32-char fragment that the
  "opaque run" rule no longer matches. "Truncate after scrubbing" must hold at
  every slice, not only the final byte cap.
- **Kept free-text keys** (`message`, `title`, `error`) carry names, addresses,
  short ids, `(608) 555-1234`, `pwd x` — regex scrubbing is not PII scrubbing.
  For endpoints that serve personal/order data, keep only enum-like fields.
- **JSON key names are data** when the body is a map keyed by id/name; restrict
  keys to identifier shape or drop them.
- **HTML entities** (`&#64;`, `&#46;`) defeat email/JWT regexes after tag strip.
- `pathTemplate ?? path` fallback = the next dynamic path logs its raw id; make
  the template required.

Related: [[patterns-neo288-automated-access]] (redact quoted spans only),
[[patterns-neo278-session-lifetimes]] (undici error messages carry cookies),
[[cross-run-artifacts]].
