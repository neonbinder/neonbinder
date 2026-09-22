---
name: reference-component-test-at-a-real-cap-times-out
description: A happy-dom test that renders a production-sized cap (1,000+ rows) passes alone and times out in the full suite — inject the limit as a prop and test it at 3
metadata:
  type: project
---

A `components` test that builds a fixture at a production ceiling —
`MAX_OPERATOR_DELETE_IDS` is 1,000, so the fixture was 1,005 checkbox rows —
runs in ~4s alone and **times out past 30s in `npm run test:unit`**, because
the components project runs eight workers and every `fireEvent` re-renders the
whole list.

**Why:** the behaviour under test is the arithmetic and the copy, neither of
which cares what the number is. Building the ceiling to test the ceiling makes
a test that only ever passes in isolation, which is the same as no test.

**How to apply:** give the component an optional prop defaulting to the shared
constant (`maxDeleteSelection = MAX_OPERATOR_DELETE_IDS`), document it as the
injection point, and test the capped behaviour at 3. That the default matches
the server's limit is a type-level fact — both sides import the same module
under `lib/` — not something a runtime assertion can add to. Keep one cheap
under-cap test that passes **no** prop, so the real default is still rendered.
Merging the heavy cases into one `it` with a raised timeout does not fix it;
the contention scales with the render, not the test count.
