---
name: feedback_adversarial_pass_patterns
description: What an adversarial unit-test pass on an already-well-tested NeonBinder feature (NEO-101) actually found — where the real gaps hide when the author already wrote thorough tests
metadata:
  type: feedback
---

NEO-101 (listing-title length limits, `apps/web/convex/features/generateListing.ts`
+ `listingLimits.ts` + `cardAttention.ts` + `TitleLengthMeter.tsx` etc.) shipped
with unusually thorough self-authored tests (fuzz test with a seeded PRNG,
surrogate-pair guards, dedupe-by-case tests, a byte-identical contract test
between two hand-kept input mappings). An adversarial pass on top of that still
found one real source bug and several real gaps. Patterns worth re-applying:

1. **A word-boundary text-truncation function that operates on a JOINED string
   (players joined by " & ", tags joined by ", ", etc.) can strand the
   CONNECTOR itself as the last surviving "word".** `cutAtWordBoundary` cut at
   the last space and called it done — but "&" between two spaces looks like a
   whole word to a naive word-boundary cut, producing `"Aaron Judge &"` (a
   title that reads as promising a second player and not delivering one).
   Found by: constructing a card number long enough to force the cut to land
   exactly after the connector's trailing space (padding the reserved suffix
   is the general technique — `maxPrefixLen = CAP - reserved.length`, solve for
   the reserved length that puts the cut boundary where you want it), then
   confirmed independently by the project's own fuzz test once one more
   assertion was added to it. **How to apply:** any time you review a
   word/token truncation helper, ask what happens when the cut lands
   immediately after a JOIN separator rather than after a content word, and
   prove it with a padded-length test rather than trusting the prose-cut
   "whole word" tests already in the suite (those all cut mid-CONTENT, never
   at a connector).

2. **A pure function that IS exported and IS imported by production UI code can
   still have zero dedicated test file**, even in a codebase with excellent
   coverage elsewhere, when it lives inside a `.tsx` component file
   (`TitleLengthMeter.tsx` exporting `titleLengthState`) and every existing test
   exercises it only THROUGH a rendered field (`CardDetailPanel.titleLimits`,
   `TitleFixer.test.tsx`). Those integration-shaped tests prove the drawer
   behaves right at the 2-3 lengths the author happened to pick; they do not
   walk every boundary (54/55/56, 69/70/71, 79/80/81) because that is not their
   job. **How to apply:** when a plan explicitly calls out "band boundaries" or
   "off-by-one at exactly N", grep for a dedicated test file next to the pure
   function first — `find <dir> -iname "*TheModule*"` — before assuming
   integration tests cover it just because the module is imported everywhere.

3. **A registry/tie-break rule** (here: `pickAttentionFixer` — first item in
   array order whose kind has a registered fixer wins, when a row is flagged
   for two DIFFERENT registered kinds owned by two different tickets/sessions)
   **is exactly the kind of cross-cutting behavior neither ticket's own test
   suite is positioned to cover**, because each session tests its own kind in
   isolation. Worth a dedicated test combining both real kinds (not just kind
   vs. "an unregistered kind", which was already covered) once two tickets
   share one registry.

4. Whitespace-only input (`"   "`) is a distinct case from empty string (`""`)
   even when the code trims before checking length — worth its own test
   whenever a mutation trims-then-clears, because "does trim-to-empty behave
   like the already-tested empty-string clear path" is not implied by testing
   the two ends separately.

See [[project_convex_test_patterns]] and [[project_vitest_projects_setup]] for
the harness details this pass used unchanged.
