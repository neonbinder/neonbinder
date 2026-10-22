---
name: draft-shape-changes-hit-the-ci-oneshot
description: Any change to what setbuild's draft emits (template array order, new fill-ins, new spec keys) is checked live by e2e.yml's setbuild-oneshot against the committed playwright/seed/oneshot.spec.json
metadata:
  type: reference
---

`mcp-oneshot.ts` merges the live draft's `template` with the committed
answers file by ARRAY INDEX (`mergeDraftAnswers`), then compares digests with
every `leave` and every review answer stripped (`withoutVolatile`), leaves as
a subset by `side:id`, review answers by name.

**Why it matters:** a draft change that adds a `<…>` fill-in, reorders a
review list, or adds a key outside `sync.pending` / `review` turns the CI
one-shot red unless `oneshot.spec.json` (in `playwright/`, often another
agent's area) is re-measured. Changes confined to `leave` entries (fewer,
or an extra display-only key) and to sets the draft stops listing are safe.

**How to apply:** before changing the draft's output, read `compareDraft` and
check the committed fixture for the case you touch (e.g. which review names
it answers, which conflicts). Say in the report whether the fixture needs a
re-measure. A stub read service in `mcp-tools.test.ts` returns a PARTIAL
report, so any MCP-side post-processing must read lists defensively.
A spec key the draft never drafts (an operator-only answer such as a
checklist's `autographFormat`, NEO-345) is DROPPED by the merge unless
`mergeDraftAnswers` carries it from the answers like `credentials` and
`pairing.unlink`; without that rule the committed answer makes the digest
check red.
Related: [[convex-typecheck-excludes-test-files]].
