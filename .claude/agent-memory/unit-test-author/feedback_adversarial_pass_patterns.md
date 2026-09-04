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

## Round 2 (NEO-216/217, 2026-09-04) — autosave race + clearable fields

Target: `CardDetailPanel.tsx` (per-field autosave on `useReactiveField`),
`updateCard`'s `printRun` null-clear, and `applyFeatureEdit`'s `""`-clear
shared by `setSelectorOptionFeature`/`setCardFeature`. Already had 41+ 
component tests and a large convex suite from the feature's own authors.
Genuine gaps found, none of them regressions — all net-new coverage:

1. **The already-tested race has an untested INVERSE.** The feature's own
   tests proved "typed text survives an external patch while FOCUSED". They
   never proved the twin case: a commit already fired (blurred, mutation
   promise unresolved, `busyRef.current === true`) when an external patch
   arrives. Same guard code path (`useReactiveField`'s mirror effect checks
   `busyRef.current` before `document.activeElement`), but a focused-only
   test suite never exercises it. Whenever a hook guards on TWO independent
   conditions (focused OR busy), each needs its own test with the other
   condition explicitly false — testing "focused" doesn't imply "busy" got
   covered too, even structurally.

2. **A busy-guard's own SYNCHRONOUS-vs-`await` boundary is worth pinning
   directly**, not just its externally-visible effect. `runCommit` sets
   `busyRef.current = true` synchronously, before its first `await` —
   meaning Enter-then-blur in the same tick, or two rapid Enters, can never
   double-fire, and a second edit attempted mid-save is DROPPED (not queued;
   nothing re-applies it once the first resolves). All three are one-line
   tests once you know to ask "what happens if the SECOND trigger fires
   before the first `await` yields control back?" — worth asking of any hook
   with a `busyRef`/`isPending` guard set outside an async callback.

3. **A rejected optimistic-looking write with NO optimistic state is a
   different contract than "revert to server value".** The attribute chips
   render straight from the live `card.attributes` prop — there is no local
   "next" state shown before the mutation resolves. So "the chip reverts on
   rejection" is trivially true (it never moved), and the real thing worth
   testing is that the error surfaces AND a retry after the failure isn't
   left wedged by the busy guard. Don't assume a component described as
   "optimistic" in a ticket actually holds optimistic state — check whether
   the control's rendered value comes from local state or the live prop
   before writing a "reverts" test; on the live-prop shape, the interesting
   assertion is "still exactly what the prop says", not "changed back".

4. **A concurrent sibling-agent edit landing on a file mid-session showed up
   as a genuine, deterministic (non-flaky) failure in an EXISTING test**,
   not a new one: an a11y-auditor pass swapped `disabled={busy}` for
   `aria-disabled={busy || undefined}` on the attribute chips (native
   `disabled` forces a browser blur the instant it applies, dropping focus
   for a keyboard user mid-toggle — a real WCAG finding, not a mistake).
   `git diff HEAD -- <file>` against the source file under test is the fast
   way to confirm "is this MY regression or a concurrent, intentional source
   change" before spending time debugging the wrong side. The fix here was a
   one-line assertion update in the EXISTING test (native `.disabled` →
   `getAttribute("aria-disabled") === "true"`) — updating an existing test to
   track a verified, well-reasoned concurrent behavior change is test
   maintenance, not the "don't edit source" boundary; only silently deleting
   or weakening the assertion to make it pass would have crossed that line.

5. **A validator's numeric guard (`Number.isInteger(x) && x >= 1`) has real
   edge values worth enumerating beyond the obvious `0`/`-1`/`2.5`**: `NaN`
   (typeof "number", not an integer — still rejected, but worth pinning
   since a validator that only checks `typeof === "number"` would let it
   through), `Infinity` (`Number.isInteger(Infinity)` is `false`), and `-0`
   (an integer per `Number.isInteger`, but `-0 < 1` is `true` — rejected via
   the OTHER half of the guard, which is worth distinguishing from the
   `Number.isInteger` half in case one is ever "fixed" independently). Also
   worth PROVING, not assuming: `Number.isInteger` is `true` for any
   magnitude with no fractional part, so a guard with no explicit upper
   bound silently accepts something like `1e21` — not necessarily a bug to
   fix, but a finding worth surfacing to the coordinator rather than leaving
   implicit, and worth pinning at BOTH the client (whatever parses a text
   input into a number before the call) and the server layer so the two
   can't quietly diverge on where the ceiling is.

6. **`{...(existing ?? {})}` then `delete cleared[key]` on a clear helper
   returns `{}`, not `undefined`, when `existing` was `undefined`** — worth
   its own test with a fixture that genuinely never set the object at all
   (not one pre-seeded with sibling keys), since every "clear" test that
   starts from a non-empty object never exercises the `existing ?? {}`
   fallback's own return shape.

7. **"Does a per-row clear cascade to already-materialized descendants?" is
   worth testing for CLEAR specifically even when the SET direction is
   already proven not to cascade** — a reader who accepts "set doesn't
   cascade" can still expect "clear" to behave differently (un-setting reads
   as more global than setting, intuitively), so if a shared helper
   (`applyFeatureEdit`) drives both, the negative test is cheap and closes a
   real "is this intentional or a bug" support-desk question before it's
   asked. Confirm the code path shares the exact same helper before treating
   this as separately worth testing, though — if set and clear used
   different functions it would need actual investigation, not just an
   extrapolated test.
