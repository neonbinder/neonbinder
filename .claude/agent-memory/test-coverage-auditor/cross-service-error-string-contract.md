---
name: cross-service-error-string-contract
description: a Convex matcher keyed on text the preprocess service's error produces is tested with hand-typed strings on both sides; ask for a contract test or a live fixture, plus a hook test when only a mock emits a new outcome field
metadata:
  type: feedback
---

When one side decides behaviour by regex-matching an error string built on
the other side (Convex `isRasterTooLargeError` vs the adapter's
`preprocess <code> (HTTP n)` wrapper, which wraps the service's `error_code`),
unit tests usually type the string literally on each side and never join them.
A change to the wrapper or the code name keeps every test green and silently
turns a terminal "too big" photo back into a retryable generic failure.

**Why:** NEO-446 audit: the pixel-ceiling classification had unit tests on the
matcher, on the settle and on the service's 413 body, but nothing fed the real
adapter-built message into the matcher, and no spec dropped an over-limit loose
photo.

**How to apply:**
- Ask `unit-test-author` for a test that builds the error through the adapter's
  own wrapper (or exports a builder both sides use) and asserts the matcher
  accepts it.
- A hook whose new outcome fields are only produced by a mock in component
  tests (`usePlaceholderUpload` `kind` / `overLimitMb`) needs its own test of
  the real hook.
- A spec proving one branch of a many-branch notice function (all-rejected)
  does not prove the siblings (some-rejected, loose photo too big, warn plus
  outlined variants); list the user-visible ones that cross a service boundary
  as needing a live spec, and name the fixture shape (a flat-colour image over
  the limit is a few hundred KB).
- Related: [[one-big-spec-many-screens-axe-gap]]
