---
name: maestro-web-driver-primitives
description: "Ground-truth maestro-web/CdpWebDriver behaviour read out of maestro-client.jar (cli 2.6.0): native <select> options are tappable ONLY for the FIRST <select> on the page (synthetic option bounds collide across selects — see §1a); pressKey supports ONLY Enter/Backspace (Escape/Tab throw); text/id matching = FULL-anchored regex OR literal pattern equality; scrollUntilVisible = window.scrollTo only, so inner/fixed scrollers need an explicit swipe"
metadata:
  type: reference
---

Verified by disassembling `~/.maestro/lib/maestro-client.jar` (`maestro-web.js`,
`CdpWebDriver`, `Filters`, `KeyCode`) for Maestro CLI 2.6.0. Re-verify if the CLI
version in `.maestro/version` changes.

## 1. Native `<select>`: tap the dropdown, then tap the option (`childOf`)
`maestro-web.js` treats `<option>` as a **synthetic node**:
- `traverse()` includes an `<option>` **only when its parent `<select>` matches
  `:focus-within`** — so the options are invisible to Maestro until the select is
  focused (a `tapOn` the select does it; an `autoFocus`ed select already qualifies).
- Options get fake bounds `[100000, 100000 + indexInParent*20]` plus
  `ignoreBoundsFiltering: true`, so they are never filtered as off-screen.
- `CdpWebDriver.tap()` routes any point with `x >= 100000 && y >= 100000` to
  `maestro.tapOnSyntheticElement`, which does
  `option.selected = true; select.dispatchEvent(new Event("change", {bubbles:true})); select.blur()`.
  That bubbling `change` is exactly what React's `onChange` for `<select>` listens
  to (select/file inputs bypass React's value-tracker dedupe), so a **controlled**
  `<select value={…}>` updates properly.

**Pattern (valid ONLY when the target is the first `<select>` in the document — see §1a):**
```yaml
- tapOn: { id: "Source Sport" }                 # focuses → options enter hierarchy
- tapOn:
    text: "E2E Test Sport 0"
    childOf: { id: "Source Sport" }             # childOf is NOT optional
- extendedWaitUntil:                            # the load-bearing assert
    visible: { id: "Source Sport", text: "E2E Test Sport 0" }
```
- `childOf` **is** implemented in 2.6.0 (`ElementSelector.childOf` → Orchestra
  `findElementViewHierarchy`). It is required whenever the same words also appear
  on the page behind a modal — options sort LAST by bounds (y≈100000), so an
  unscoped `tapOn` picks the page element instead.
- A `<select>`'s node text is **only its selected option's text**, so
  `{id, text}` combined is a precise "this dropdown currently reads X" assert.
  Loading state reads `"Loading…"`; gate with
  `extendedWaitUntil: notVisible: {id: "Source X", text: "Loading.*"}` (a disabled
  select ignores taps).
- **This supersedes** the older "maestro web can't tap `<select>` options; type the
  first letter via inputText, then `pressKey: Enter` to commit" workaround. That
  workaround still works but cannot disambiguate options sharing a prefix
  (`E2E Test Sport 0/1/2`) and is what caused the NEO-71-74 popup/commit flake.

## 1a. HARD LIMIT — only the FIRST `<select>` on the page is drivable
`getSyntheticNodeBounds(option)` encodes **`getIndexInParent(option)` ONLY**:
`y = 100000 + idx*20`, `x = 100000`, 100×20. So option #N of EVERY `<select>` in the
document gets **identical synthetic bounds**. `maestro.tapOnSyntheticElement(x,y)` then
does `Array.from(document.querySelectorAll('option'))` — the whole document, focus
irrelevant — and **returns on the FIRST option whose bounds contain the point**.

⇒ With 2+ `<select>`s rendered, tapping an option in the 2nd/3rd/... select silently
selects the **same-index option of the first select in document order**. Verified on
NEO-21's `CrossListingImportModal` (a stack of 6 dependent selects): tapping Year
"2026" (`indexInParent=1`) set the *Sport* select to its index-1 option "Baseball".
The option tap even reports COMPLETED ("Something has changed in the UI"), and the
paired `tapOnSyntheticCoordinateSpace` JS often throws
`MismatchedInputException: No content to map due to end-of-input` — neither surfaces
as a step failure, so the flow fails LATER at the value assert.
A deeper select only wins if its target index EXCEEDS every earlier select's option
count — never controllable in practice.

**No flow-side workaround exists.** All three tested and failed on the 2nd select
(NEO-21, 2026-07-26, 3 headless runs):
- `tapOn select` → `tapOn option childOf` → wrong select (above).
- `tapOn select` → `inputText` type-ahead → no commit; focus ends back on the FIRST
  select (its focus ring in the screenshot), so the keystrokes go to the wrong select.
- `tapOn` ×2 (close-the-popup trick) → same; and `+ pressKey: Enter` **submitted the
  surrounding `<form>`** (proving no popup was open and focus was not on the target).

Type-ahead DOES work on a select the **app itself** focused (`ref.focus()` /
`autoFocus`) with no tap involved — that is why level 1 of such a stack passes and
every level below it is unreachable. A UI that stacks dependent native `<select>`s is
therefore **not E2E-drivable**; the button-list drill (EntityColumn / `util-drill-to-*`)
is, which is why every other set-builder drill in this app tests fine.

**RESOLVED for NEO-21 (2026-07-26):** `CrossListingImportModal` was rebuilt from the
6-select stack into a one-level-at-a-time BUTTON wizard, and all 4 cross-release flows
now pass. See [[cross-release-import-modal-picker]]. The select limitation above is
unchanged as a general rule — the fix was to the UI, not to any flow-side workaround.

## 5. `when:` conditions cost the OPTIONAL lookup timeout when they miss
`Orchestra.evaluateCondition(condition, optional=true, timeoutMs=null)` → `findElement`
with the optional timeout. The only `long` constants in `Orchestra.class` (cli 2.6.0)
are **500 / 7000 / 17000**: `optionalLookupTimeoutMs = 7000`, `lookupTimeoutMs = 17000`.
So a `when: { visible: X }` that is FALSE burns a full 7s; a `when: { notVisible: X }`
where X is present burns 7s. A condition that HITS costs ~0 (verified in maestro.log:
`Run flow when id: Filter Sport options is visible RUNNING` → inner tap 365ms later).
⇒ Put the *common* case on the cheap side of the guard, and never pair
`when: visible` + `when: notVisible` on the same element (that is 7s every run).
Plain `assertVisible`/`tapOn` use the 17s lookup — it only costs that on failure.

## 2. `pressKey` on web: ONLY `Enter` and `Backspace`
`CdpWebDriver.mapToSeleniumKey` is a 2-case switch (ENTER → Keys.ENTER,
BACKSPACE → Keys.BACK_SPACE) with `default: throw IllegalStateException`.
So `pressKey: Escape` / `Tab` / arrows are **not testable at all** on maestro-web —
not "the handler doesn't receive it", the step throws. Escape-to-close and Tab
traversal must be covered manually or left as a documented gap; close modals with
their Cancel button instead.
Enter goes to `document.activeElement`, so HTML **implicit form submission** works
— but only when the form's submit button is ENABLED (a disabled default button
makes Enter a no-op). Pick whatever the form needs to enable submit first.

## 3. Text/id matching = FULL-anchored regex, plus a literal-equality escape hatch
`Filters.textMatches` (and the id equivalent) does, per node:
`text = attr.replace('\n',' ')` then `regex.matches(text) || regex.pattern == text`.
- `matches` = ENTIRE string, so `text: "Custom"` never matches `"+ Custom"`
  (the `^…$` in existing flows is belt-and-braces, not required).
- The `pattern == text` fallback is why `assertVisible: "Confirm?"` works even
  though `Confirm?` as a regex cannot match the literal `"Confirm?"`.
- Consequence: `id: "Hide cross-release cards"` does **not** match
  `"Hide cross-release cards (on)"` — the two toggle states are cleanly
  distinguishable (escape the parens: `\\(on\\)`).
- Newlines→spaces happens before matching; JSX also strips whitespace-with-newline
  around text children, so `Linked {n} card{s}.` really is the node text
  `"Linked 1 card."`.
- **The regex flags are `IGNORE_CASE`, `DOT_MATCHES_ALL`, `MULTILINE`** —
  `Orchestra.REGEX_OPTIONS`, verified by `javap -c maestro/orchestra/Orchestra.class`
  (cli 2.6.0). So: matching IS case-insensitive on the regex path (`"Sportlots"`
  still matches a node reading `"SportLots"` — a product casing fix does NOT
  require touching the flows), and `.` spans newlines, so a two-fragment pattern
  like `".*Could not sign in to X.*Nothing was saved.*"` matches a wrapped
  sentence. The `pattern == text` literal fallback is case-SENSITIVE, but it only
  matters for patterns that are not valid/matching regexes.

## 3a. OFF-SCREEN = ABSENT. The hierarchy is pruned by viewport BEFORE any filter
**CORRECTED 2026-08-13 (NEO-157) — the old claim here ("`visible` has NO viewport
test") was WRONG and cost a debugging cycle.** It is true that
`UiElement.isWithinViewPortBounds` is never called and that maestro-web's
`traverse()` emits raw `getBoundingClientRect` with no clipping test — but the
pruning happens on the Kotlin side, one layer up:

`maestro.ViewHierarchyKt.filterOutOfBounds(TreeNode, width, height)` walks the
tree and **returns null for any node whose `UiElement.getVisiblePercentage(w,h)
< 0.1` AND whose already-filtered children list is empty** (verified by
`javap -c maestro.ViewHierarchyKt`, cli 2.6.0: `ldc2_w 0.1d; dcmpg; ifge`). The
`ignoreBoundsFiltering: true` that maestro-web stamps on synthetic `<option>`
nodes exists precisely to exempt them from this pass — that flag is the tell.

⇒ An element scrolled off the 1024×629 viewport is **not in the hierarchy at
all**, so `assertVisible` / `assertNotVisible` / a relational anchor / `tapOn`
all behave as if it does not exist. Corollaries:
- A leaf needs ≥10% of its area on screen to survive. An ancestor survives as
  long as one descendant did, so a big container can outlive its own children.
- Scroll to the target BEFORE asserting it. Prefer letting `scrollUntilVisible`
  carry the assertion (it scrolls AND asserts — R6).
- `assertNotVisible` is weak on its own: it also passes when you are simply
  scrolled somewhere else. Pair it with a positive `assertVisible` of a sibling
  that would be on screen next to the thing you claim is gone.
- A failing `visible` at a known-good scroll position is still real evidence the
  thing was never rendered — chase the action that should have created it.
- A passing `visible` still proves nothing about tappability; `tapOn` fires at
  raw layout coordinates, so it can land on whatever is *visually* there.

## 3b. `containsDescendants` does NOT work inside a relational sub-selector
NEO-157, bisected in one headless run (2026-08-13). On the same screen, with the
same target on screen throughout:
- `{text: "3", above: {text: "6"}}` → PASS
- `{containsChild: {text: "3"}, above: {text: "6"}}` → PASS
- `{text: "3", above: {containsChild: {text: "6"}}}` → PASS
- `{text: "3", above: {containsChild: {text: "6"}, containsDescendants: [{text: "BACK"}]}}` → **FAIL** (17s lookup, then "Assertion is false")

`containsDescendants` at the TOP level of a selector is fine, and `containsChild`
nests fine. Only `containsDescendants` **inside** an `above`/`below`/`leftOf`/
`rightOf` anchor silently resolves to nothing, which empties the anchor list and
makes the whole relational filter match nothing. Workaround: keep
`containsDescendants` on the candidate and give the anchor a plain `text:` (or
`containsChild`) that is unambiguous on its own.

## 3c. HARD BUG — a `<form>` containing a control named `name` wedges EVERY hierarchy read
Proven on NEO-172 (2026-08-18) against Clerk's `<APIKeys/>` create form.

`traverse()` in `maestro-web.js` builds each node's resource-id as
`node.id || node.ariaLabel || node.name || title || node.htmlFor || data-testid`.
`node.title` is type-guarded (`typeof === 'string'`); **`node.name` is NOT**.
`HTMLFormElement` is spec'd `[LegacyOverrideBuiltIns]`, so its named-control getter
**overrides** the built-in `name` IDL attribute: on `<form>` containing
`<input name="name">`, `form.name` returns that INPUT ELEMENT. The element (with
its circular React fibers) lands in the tree returned by
`maestro.getContentDescription()`, which then cannot be serialized back over CDP.

Signature — do NOT read this as a flake or a missed tap:
- the step that fails is the `tapOn` **whose post-tap `hierarchyBasedTap` read** first
  sees the form (i.e. the tap that OPENS the form — the click itself DID land),
- `maestro.drivers.CdpWebDriver: Failed to execute JS` +
  `MismatchedInputException: No content to map due to end-of-input`, ~10× at ~130ms,
- then `CommandFailed: Could not retrieve hierarchy through
  maestro.getContentDescription() (tried 10 times`,
- the failure screenshot looks **perfect** (element present, unobstructed, 100% visible).

Confirm it in Chrome in one line — no Maestro needed:
`[...document.querySelectorAll('*')].filter(e => e.name && typeof e.name !== 'string')`
and `JSON.stringify` of a mini-traverse throws *Converting circular structure to JSON*.
Setting an `id` **or** an `aria-label` on that `<form>` makes it serialize again
(both short-circuit before `node.name`), which toggles the bug cleanly on/off.

**There is NO flow-level workaround** — every command reads the hierarchy, so a flow
cannot do anything at all while such a form is mounted (`waitToSettleTimeoutMs` only
changes the tap's own wait, not the next command's read). The fix belongs in the tool:
guard `node.name` the way `node.title` already is. Our own app has no at-risk form
today; **never name a form control exactly `name`** or you make that form undrivable.

## 4. Scrolling: `scrollUntilVisible` cannot reach inner or fixed scrollers
`CdpWebDriver.swipe(SwipeDirection)` — which is what `scrollUntilVisible` drives —
is literally `window.scrollTo(window.scrollX, window.scrollY ± innerHeight/2)`.
Only `swipe: { start: "x%,y%", end: "x%,y%" }` uses a real TOUCH PointerInput,
which is what scrolls an `overflow-y-auto` child or a `position: fixed` panel.
So: a fixed modal is **tapped directly, never scrolled to** (footer buttons in a
z-50 portal are always reachable), and any content that overflows *inside* a modal
needs an explicit `swipe` — or, better, an ordering that keeps it on screen
(e.g. fill the text box while the panel is still short, before the drill adds rows).

## 5. Relational filters (`below`/`above`/`leftOf`/`rightOf`) = ONE bounds edge, no overlap test
`Filters.below$lambda` (javap of `maestro/Filters.class`, jar 2026-07-31) is exactly
`it.bounds.y > other.bounds.y` — the **top edges**, y-axis only. There is NO
horizontal-overlap requirement, and no use of the element's center or height. So an
anchor in a different column still constrains a candidate, and two items in one
`items-end` flex row can each be "above" the other depending on their heights.
Candidates surviving the filter are then `sortedBy` distance, so the nearest wins.
Anchors can be any sub-selector — a plain `text:` regex anchor works (`below: {text:
"1 of .* teams.*"}` verified green 2026-09-01), not just the `id:` form the drills use.

**The pattern this buys you:** filtering a list by a value that IS a row's text makes
the *filter input itself* a match for that text (§getNodeText: an input's text is its
value), and the input sits above the list. An unanchored `tapOn` can then land in the
search box. Anchor the tap below something rendered BETWEEN the input and the list —
e.g. `/admin/teams`' "N of M teams" counter — and the row is the only candidate. Use
this whenever the input has no aria-label to hang `below: {id: …}` off.

> Jar re-checked 2026-09-01 against **CLI 2.8.0** (`~/.maestro/lib/maestro-cli-2.8.0.jar`);
> the §1–§4 behaviour above still matches. The "2.6.0" in this file's header is the
> version it was first written against.
