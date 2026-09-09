---
name: patterns-forms-and-contrast
description: Verified contrast ratios for project neon/slate tokens on the dark background, and recurring form/status-message anti-patterns found across multiple components
metadata:
  type: project
---

# Verified Contrast Ratios (bg = `#0a0a0a`, the dark theme's `--background`)

Computed with the standard WCAG relative-luminance formula (script-verified, not
hand math — trust these over re-deriving by eye):

| Foreground | Hex | On `#0a0a0a` | On `bg-gray-900` (`#111827`) | Verdict |
|---|---|---|---|---|
| neon-teal | `#00E5C0` | 12.23:1 | 10.96:1 | Passes AA easily, any text size |
| neon-pink | `#FF2EB3` | 5.93:1 | — | Passes AA normal text |
| slate-300 | `#cbd5e1` | 13.33:1 | — | Passes |
| slate-400 | `#94a3b8` | 7.72:1 | — | Passes |
| **slate-500** | `#64748b` | **4.16:1** | — | **FAILS AA (4.5:1) for normal/small text** |

`text-slate-500 text-xs` is used project-wide for "(optional)" field hints and
similar small annotations — e.g. `PublicProfileEditor.tsx` (pre-existing),
`ReturnAddressEditor.tsx`, `app/labels/page.tsx` (both NEO-118). Every instance
of this exact class combination on the dark background is a real 1.4.3 failure.
The one-line fix per instance is swapping to `text-slate-400` (7.72:1, passes).
Worth proposing a single token-level fix (or a lint rule) rather than
whack-a-mole per component, since it clearly keeps getting copy-pasted forward.

# Status-message role pattern seen across the app

Some components use ONE `<p>` element with a single `role` for both success and
error feedback, toggling only the text color (not the role) based on an
`"success" | "error"` state — e.g. `ReturnAddressEditor.tsx`'s save banner uses
`role="status"` for both a successful save AND a validation/mutation error.
`role="status"` is a polite live region; error text deserves `role="alert"`
(assertive) so it isn't missed. The fix is always the same:
`role={type === "error" ? "alert" : "status"}`. Check for this pattern
specifically whenever a component has a single shared banner element for
mixed success/error feedback — it's an easy thing for an author to get half
right (matching the *other* form on the same page correctly uses two separate
elements with the correct distinct roles).

Also flag (Major, not just theoretical): banners rendered conditionally as
`{message && <p role="status">...}` mount/unmount the live-region node itself
rather than keeping a persistent node and only changing its text. This is a
known Safari/VoiceOver reliability gap for dynamically-inserted live regions.
Recommend keeping the container always mounted (empty when idle) instead.

# Nested interactive controls: `<a href><NeonButton /></a>`

Recurring anti-pattern for "go fix X on another page" empty-state CTAs:
wrapping a `NeonButton` (renders a real `<button>`) inside a plain `<a href="...">`.
Found in both `app/labels/page.tsx` (NEO-118) and `app/qr-code/page.tsx`
(pre-existing) — same copy-pasted empty-state shape. Invalid HTML content
model (interactive-in-interactive), ambiguous accessibility-tree role, and easy
to fix: drop the `<a>`, call `useNavigate()` and put `onClick={() =>
navigate("/target")}` directly on the `NeonButton`. Check any new "empty state
with a link to another settings page" for this exact shape — it's a copy-paste
pattern that already exists in at least two places.

See also [[patterns-neonbutton]] for other NeonButton quirks (inline-style
override, forwardRef, and now CONFIRMED-FAILING text contrast on `cancel`/`secondary`).

# Status badge pattern (`bg-neon-X/15 text-neon-X`) — CONFIRMED PASSES, script-verified 2026-08-18

Shape: a small pill `<span>` with a 15%-alpha tint of a neon token as background and the same neon
token at full opacity as text, nested inside a card/row whose own background is itself semi-transparent
(e.g. `bg-slate-900/40`) over the page's `#0a0a0a`. Naive eyeballing suggests this could be a contrast
trap (light text on a near-transparent tint sounds risky), but composited correctly it is NOT — the
15%-alpha tint barely moves the effective background luminance, so the ratio is dominated by the neon
text against the underlying near-black panel. Verified in `apps/web/app/pipeline-runs/page.tsx`
(`STATUS_META`, NEO-170): composite `slate-900/40` over `#0a0a0a` → effective panel bg ≈ `rgb(12,15,23)`;
composite each neon token at 15% over THAT → badge bg; contrast of solid neon text against that badge bg:
neon-green 7.57:1, neon-blue 7.23:1, neon-yellow 10.68:1, neon-pink 4.85:1 (the tightest, still clears
4.5:1). All pass AA normal text. Method: two sequential alpha composites (component-under-test's own bg
alpha over the page bg, THEN the badge's alpha over that result), not a single flat composite over
`#0a0a0a` — the intermediate panel matters and makes the true background slightly lighter than the raw
page color, which is why this passes rather than failing. Treat this exact `bg-neon-X/{alpha} text-neon-X`
badge shape as a *known-good* pattern going forward — recompute only if the alpha values, the panel's own
opacity, or the panel's base color change from what's described here.

Non-text contrast (1.4.11) of the badge's own tinted background against its panel is separately low
(~1.15–1.41:1, well under 3:1) — but this does NOT need flagging: the pill shape/fill is decorative
reinforcement, not a required graphical object, since the status is conveyed by the (sufficiently
contrasting) text itself. Don't flag pill-background-vs-panel contrast on this badge shape.

# `text-gray-500` fails too, not just `text-slate-500`

Same failure family as the `slate-500` note above but the `gray` palette instance:
`text-gray-500` (`#6b7280`) on `bg-gray-900` (`#111827`) = **3.67:1**, script-verified — fails AA
4.5:1 for non-large text. Found in `CardPairingModal.tsx:491` ("Nothing kept — every unmatched card
above will be discarded."). Same fix: swap to `text-gray-400` (`#9ca3af`, 6.99:1 on gray-900).
Heuristic for this codebase's dark panels: `*-500` grays/slates are the recurring trap; `*-400` and
lighter clear AA normal-text comfortably. Worth checking any new `text-{gray,slate}-500` on a
`bg-gray-900`/`#0a0a0a` panel on sight rather than re-deriving each time.

`text-gray-500` directly on `#0a0a0a` (not `bg-gray-900`) computes to **4.09:1** — still fails 4.5:1.
Confirmed a second instance: `app/print/placeholders/page.tsx:383` ("Shown reduced to fit...", `text-xs
text-gray-500`), alongside two `text-slate-500` instances in the same file (lines 225 and 273 — the
273 one is safety-relevant copy: "Copy this from your printer's two-sided setting. Get it wrong and
every back lands on the wrong card."). Treat any `text-{gray,slate}-500` on `#0a0a0a` OR `bg-gray-900`
as a near-certain 1.4.3 fail without re-deriving.

# Non-text contrast on option-row borders (`border-slate-800`)

`border-slate-800` (`#1e293b`) on `#0a0a0a` computes to only **~1.35:1** — well under the 3:1 needed for
1.4.11 Non-text Contrast. Found on the radio/checkbox option-row wrapper (`rounded-lg border
border-slate-800 p-3`) pattern used repeatedly in `app/print/placeholders/page.tsx`'s paper-size,
duplex, and flip-edge fieldsets. Applicability is arguable — the border is a decorative grouping/hit-area
boundary, not the native control itself (which the browser renders with its own default outline
regardless) — so treat as Minor rather than a hard blocker. If closing it out: `border-slate-600`
(`~2.6:1`) still isn't enough; `border-slate-500` (`#64748b`, `~4.16:1`) is the first step in this
palette that clears 3:1 against `#0a0a0a`.

# Filter-chip contrast (`bg-neon-X/20 text-neon-X` directly on `#0a0a0a`, no panel) — CONFIRMED PASSES

Distinct from the `/15`-on-a-panel badge shape above: this is a chip sitting directly on the page
background (no intermediate `bg-slate-900/40` wrapper), using a 20%-alpha tint. Verified for the status
filter chips in `apps/web/app/pipeline-runs/page.tsx` (`STATUS_FILTER_OPTIONS` buttons, NEO-170):
active chip `bg-neon-green/20 text-neon-green` on `#0a0a0a` → tint composite ≈ `rgb(8,51,26)`, full-opacity
green text against it ≈ **7.15:1** — passes AA. Inactive chip `bg-slate-800 text-slate-300` ≈ **9.85:1** —
passes AA. Focus ring `focus-visible:outline-neon-blue` on `#0a0a0a` ≈ **9.58:1**, and still ≈6.8:1 against
the active chip's own tint — clears 3:1 non-text contrast in every state. Treat 20%-tint-on-bare-background
chips as a second known-good contrast shape alongside the 15%-on-panel badge; recompute only if the alpha,
color, or background changes.

# Selected/active chip state conveyed by color alone (no secondary cue) — 1.4.1 risk, check the LUMINANCES not just the hex

A recurring shape distinct from the STATUS_META badges (where the state is carried primarily by the TEXT
LABEL, e.g. "Collecting" vs "Pending" — color is reinforcement only): a chip/tab-like control whose
**selected** dimension has no text difference at all (the label is identical, e.g. "All", whether active or
not) and is signaled ONLY by swapping both fill and text color (e.g. `bg-neon-green/20 text-neon-green` vs
`bg-slate-800 text-slate-300`). Found in the status-filter chips, `apps/web/app/pipeline-runs/page.tsx`
(NEO-170). Don't just eyeball the hex values here — compute the actual relative luminance of the two
**background** fills: in this instance they came out to ≈0.0246 vs ≈0.0218, a ~1.1:1 ratio, i.e.
indistinguishable from each other under grayscale/full color-blindness despite looking obviously different
(green vs gray) to full-color vision. The text luminances do differ more (≈0.48 active vs ≈0.66 inactive,
counter-intuitively the *inactive* text is the lighter one under grayscale) so the state isn't 100% lost,
but it's a weak, non-obvious signal. `aria-pressed` covers screen-reader users; this gap is specifically
about sighted users with a color-vision deficiency using the page visually. Flag as Major and recommend a
non-color cue on the active state — a checkmark glyph or `font-semibold`, not just a border/ring (still
color). Check any future "selected chip/tab where only the color swaps and the label text does not" for
this exact luminance-parity trap.

# `title`-only supplementary identifiers (no `aria-label`) — inconsistent with this file's own `<time>` pattern

`apps/web/app/pipeline-runs/page.tsx`'s Owner cell (NEO-170) shows a resolved human label as visible text
with the raw Clerk user id ONLY on the native `title` attribute — no `aria-label`/`aria-describedby`
equivalent, so the id is unreachable by keyboard-only or screen-reader users (native `title` is
mouse-hover-only). The SAME file's `<time>` elements two rows below do this correctly and say why in a
comment: "a native tooltip is mouse-only," so they pair `title` (sighted mouse users) with `aria-label`
(everyone else). Flag `title={someId}` with no parallel `aria-label` on any element as Major whenever the
id is plausibly needed for support/correlation by an admin persona — the fix is always to mirror the
`<time>` pattern: `aria-label={`${label} (id ${id})`}` alongside the existing `title`. Note: this page's
run-heading `<h2 title={run.jobId}>` (pre-existing, not from the NEO-170 filter/sort/source/owner change)
has the identical gap and was out of scope for the pass that found the Owner-cell instance — worth
checking on a future pass of this file if not already fixed.

# Mutually-exclusive filter as `role="group"` + `aria-pressed` buttons, not `radiogroup`/`radio`

Recurring design tension: a set of buttons where only ONE can be active at a time (a status filter, a
segmented control) implemented as `<div role="group" aria-label="...">` containing `<button
aria-pressed={active}>` chips. This is not a WCAG failure (each button's own true/false state is accurately
exposed, the group has an accessible name) but it's a semantic mismatch — `aria-pressed` per the WAI-ARIA
APG is the *toggle button* pattern for independently-toggleable buttons, not the pattern for a
single-select set. The more precise fit is `role="radiogroup"` with `role="radio"`/`aria-checked` children
and roving tabindex (one Tab stop for the whole group, arrow keys move selection) rather than N separate
Tab stops. Found in the pipeline-runs status filter (9 chips = 9 Tab stops today). Rate Minor/advisory, not
blocking — but note it explicitly if the project's own code comments call out a *different* constraint
(e.g. "chips not a second `<select>`, the E2E driver only reaches the first one") as the reason for the
button shape: that constraint is about element TYPE (button vs `<select>`), not about `aria-pressed` vs
`role="radio"` — switching roles within the button-chip approach doesn't reintroduce the select-driver
problem, so don't let that comment block recommending the radiogroup refinement.

# Chip target size sitting exactly at the 24px 2.5.8 floor

`text-xs` (Tailwind default 12px font / 16px line-height) + `py-1` (4px top + 4px bottom) padding with no
border computes to exactly 16+4+4 = **24px** tall — the bare SC 2.5.8 minimum, technically passing ("at
least 24px") but with zero margin. Seen on the status-filter chips in `pipeline-runs/page.tsx`. Not a
violation, but flag as a Minor/advisory buffer recommendation (e.g. `py-1.5`) on any `text-xs` + `py-1`
button/chip combo — this exact combination recurs as "just barely passing" rather than comfortably passing.

# Toggle/selection state conveyed by color only, no `aria-pressed`

Recurring shape: a plain `<button>` in a list whose "selected" visual state is a Tailwind class swap
only (e.g. `bg-cyan-900/60 text-cyan-100` vs `bg-gray-800/60 text-gray-200`) with a static
`aria-label` that doesn't change between states and no `aria-pressed`. Found in
`CardPairingModal.tsx`'s "select a BSC card, then click its SL match" linking flow (NEO-137). Screen
reader users have no way to know which item is currently armed. Fix is always the same:
`aria-pressed={isSelected}` plus varying the label text to include the state.

# `text-gray-500 dark:text-gray-400` is the ONE passing pair on this app's `bg-white`/`dark:bg-gray-800`
# panels — REVERSED (`text-gray-400 dark:text-gray-500`) is a copy-paste trap, script-verified 2026-09-03

Distinct from the `#0a0a0a`/`bg-gray-900` findings above: `SetSelector/CardChecklistItem.tsx`,
`CardDetailPanel.tsx` and `CardChecklist.tsx`'s quick-add form all sit on Radix-light panels
(`bg-white dark:bg-gray-800`, NOT the app's usual near-black background — this whole checklist/drawer
UI is dual-theme via Tailwind's default **media**-based `dark:` variant, not a forced-dark class, so a
visitor with a light OS preference genuinely sees the light values). On THIS specific bg pair:
- `text-gray-500` (`#6b7280`) on `bg-white` = **4.83:1** — passes.
- `text-gray-400` (`#9ca3af`) on `dark:bg-gray-800` (`#1f2937`) = **5.78:1** — passes.
So `text-gray-500 dark:text-gray-400` is the established, confirmed-passing idiom for secondary/label
text on these panels (used correctly in `CardChecklistItem.tsx`'s sub-line and in most of
`CardDetailPanel.tsx`'s field labels).

The REVERSE — `text-gray-400 dark:text-gray-500` — fails BOTH themes on the same panel: `text-gray-400`
on `bg-white` = **2.54:1**, `text-gray-500` on `dark:bg-gray-800` = **3.04:1**. Both well under 4.5:1.
Found live in `CardDetailPanel.tsx`'s NEO-208 "(unconfirmed)" annotation span and its hint paragraph —
copy-pasted backwards from the correct pair two lines above in the same block. **This is a trap worth
grep'ing for by name** (`text-gray-400 dark:text-gray-500`) any time a diff touches this dual-theme
checklist/drawer UI — it reads as "just dimming it a bit more" but is actually the single worst
4-color-token combination available on this background pair. Fix is always: swap to
`text-gray-500 dark:text-gray-400`.

# Bare `text-gray-400` (no `dark:` override) on the same `bg-white`/`bg-gray-50` panels — fails LIGHT mode only

Separate bug, same UI: several field labels (`text-[10px] uppercase tracking-wide text-gray-400 mb-1`,
used throughout `CardDetailPanel.tsx` and copied into `CardChecklist.tsx`'s NEO-208 "Team (optional)"
label) have no `dark:` variant at all. Since this app's `dark:` is Tailwind's default `media` strategy
(no forced `dark` class in `index.html`/`main.tsx` — confirmed, NEO-208 audit), a light-OS-preference
visitor gets the LIGHT value only: `text-gray-400` on `bg-white` = **2.54:1**, on the quick-add form's
`bg-gray-50` panel ≈ same (gray-50 is nearly white) — both fail 1.4.3. In dark mode the SAME bare value
happens to pass (5.78:1+ against `bg-gray-800`/composited `bg-gray-900/40`), which is exactly why this
class of bug survives a dark-mode-only review. Fix: always pair with `dark:text-gray-400` explicitly —
i.e. `text-gray-500 dark:text-gray-400`, not a bare `text-gray-400`. NEO-208 fixed only the ONE new
instance in scope (`CardChecklist.tsx`'s "Team (optional)" label); `CardDetailPanel.tsx`'s own "Teams"
label and ~10 other field labels in that file have the identical bare-`text-gray-400` gap and are
still unfixed as of 2026-09-03 — a good target for a follow-up sweep of that one file.

# `TeamPicker.tsx` popover — Tab-out is not covered by the existing outside-pointerdown close (NEO-208, 2026-09-03)

`components/SetSelector/TeamPicker.tsx` (shared by the card drawer, `MissingTeamFixer`/
`CardAttentionWalker`, and now `CardChecklist`'s quick-add form) already closes its `absolute top-full
z-10` popover on an outside `pointerdown` — the file's own comment says this is load-bearing because
the popover overlaps buttons below it (documented for `MissingTeamFixer`'s "Save & Next"/"No team on
this card"). That handler is **mouse/touch only**. There was no keyboard equivalent: Tab out of the
popover's last option walks focus onto whatever sits next in the DOM (in the quick-add form, the
Add/Cancel buttons immediately below the field) while the popover stays open and visually covers it —
WCAG 2.4.11 Focus Not Obscured. Fixed by adding an `onBlur` on the picker's root div that checks
`document.activeElement` **inside a deferred `setTimeout(0)`**, not off the blur event's own
`relatedTarget` — `relatedTarget` came back unreliable in this repo's jsdom/RTL setup even for an
ordinary synchronous `.focus()` call. Since this is a shared component, the fix covers all three call
sites at once.

**Test gotcha this surfaced**: `TeamPicker`'s own popover-open effect does
`setTimeout(() => inputRef.current?.focus(), 0)` to autofocus the search box. A test that opens the
popover and IMMEDIATELY (same synchronous tick) simulates a Tab-out via `someOtherElement.focus()`
races that autofocus timeout — if the autofocus timeout resolves AFTER the deliberate move-away, it
silently steals focus back into the popover and masks a close-on-blur assertion. Fix in the test, not
the component: `await waitFor(() => expect(document.activeElement).toBe(searchInput))` right after
opening the popover, BEFORE simulating the Tab-out, so the two timers can't interleave. Applies to any
future test that opens this popover and then moves focus programmatically in the same test.

# Concurrent-agent git races in a shared worktree — stage, verify, re-check before every commit

Confirmed in practice (NEO-208, 2026-09-03): this project runs multiple agents in the SAME worktree
concurrently (this session was told explicitly "another agent is editing convex/**, a third
.maestro/**"). A `git commit` attempt returned "no changes added to commit" — a concurrent agent's own
`git add`+`commit` had run between this session's `git add <my files>` and `git commit`, and picked up
some but not all of the staged files into ITS commit (their commit message even mentioned "the one
failure... is a concurrent accessibility-auditor work-in-progress test", i.e. they were aware of and
worked around the interleaving rather than blocking on it). Net effect: some staged files got swept
into their commit, others silently stayed staged with nothing committed. **Never assume a `git commit`
that errors or looks off did nothing** — check `git log --oneline -3` and `git show <path>` at HEAD for
each file you meant to commit, compare against the working tree, and only then commit whatever is still
staged. In this instance the working tree was never wrong (all edits were on disk and staged the whole
time) — the risk is entirely about which commit an already-staged change ends up in, not data loss.

# Script-verified ratios on the two SetSelector modal surfaces (2026-09-05, NEO-236)

The `SetSelector` dialogs are NOT on `#0a0a0a`. `EntityReviewWizard` and
`NewTeamDialog` both paint their panel `bg-gray-900` = **`#111827`**; chips and the
`TeamPicker` popover use `bg-gray-800` = **`#1f2937`**. Use these, not the `#0a0a0a`
table above, for anything inside those panels:

| Foreground | on `#111827` | on `#1f2937` | Verdict |
|---|---|---|---|
| gray-300 `#d1d5db` | 12.04 | 9.96 | pass |
| gray-400 `#9ca3af` | **6.99** | **5.78** | pass — the floor for small text |
| gray-500 `#6b7280` | **3.67** | **3.04** | **FAILS 1.4.3 on both** |
| gray-700 `#374151` | 1.72 | 1.42 | **FAILS 1.4.11 as a control border** |
| `#00D558` | 9.00 | 7.45 | pass |
| `#FF2EB3` | 5.32 | **4.40** | passes on gray-900; **marginal fail on gray-800** |
| `#00B7FF` | 7.79 | 6.44 | pass — good focus-ring colour on both |
| `#00D558` text on the `bg-[#00D558]/20` pill fill | 6.08 | 5.03 | pass |

`text-gray-500` remains the single most common 1.4.3 failure in this codebase — same
finding as the `slate-500` note above, different palette. Still live at
`EntityReviewWizard.tsx` around the "show raw enrichment" `<summary>` block (out of
scope for NEO-236, worth a sweep).

# `aria-describedby` fixes collide with other agents' exact-match tests

Adding a legitimate `aria-describedby` target (SC 3.3.2) breaks any test asserting
`getAttribute("aria-describedby")).toBe("<one-id>")` or `.toBeNull()`. Three such
assertions existed in `NewTeamForm.test.tsx` / `NewTeamDialog.test.tsx` at NEO-236.
When the audit brief says another agent owns the tests, apply the fix anyway and name
the exact assertions plus their `toContain(...)` replacements in the report — reverting
a correct fix to keep a test green is the wrong trade, but leaving it unannounced is worse.

# `components/SetSelector/EntityReviewWizard.tsx` is a live multi-agent file

During the NEO-236 audit this file changed **under a running patch script** (a new
`status.kind === "checking"` arm appeared mid-edit). Always re-read immediately before
patching it, match on small unique anchors, and assert `count(old) == 1` rather than
trusting a line number from an earlier read.
