---
name: reference-toggleoptions-pills-maestro
description: NEO-71-74 toggleOptions feature controls (Autographed/Short Print) render as two-pill toggle groups; how to drive + assert them in Maestro-web
metadata:
  type: reference
---

NEO-71-74 replaced the Autographed native `<select>` with a two-pill exclusive
toggle group (`ToggleOptionsValueControl` in `components/SetSelector/FeatureValueControl.tsx`).
Same control backs Short Print (SP/SSP). Used by BOTH `CardFeatureRow`
(CardDetailPanel/CardFeaturesEditor) AND `SetFeatureRow` (SetAttributesPanel) — so
it renders as pills at the card drawer AND the set-selector column.

RENDERED MARKUP (autographed): `options=["None","On Card","Sticker/Label"]`,
`toggleLabels=["None","Auto (On Card)","Auto (Sticker)"]`. `options[0]` ("None")
is the implicit OFF value and gets NO pill. Two pill `<button>`s render:
  aria-label "Value for Autographed: Auto (On Card)"  (stored value "On Card")
  aria-label "Value for Autographed: Auto (Sticker)"  (stored value "Sticker/Label")
`aria-pressed` = true when active. `handleChange`: click an INACTIVE pill → sets
that value DIRECTLY (not a toggle); click the ACTIVE pill → reverts to options[0]
("None"). Each pill is `disabled={busy}` while its onSave Convex patch is in flight.

TWO MAESTRO GOTCHAS (both hit + fixed in signed-by-autofills-from-players.yaml):
1. PAREN ESCAPING — Maestro compiles `id:`/`text:` as a REGEX. The literal parens
   in "Auto (Sticker)" are parsed as a capture group and DON'T match the real
   resource-id → assertVisible/tapOn silently fail ("Assertion is false … is
   visible"). Escape them: `id: ".*Value for Autographed: Auto \\(Sticker\\).*"`
   (double-quoted YAML `\\(` → regex `\(` → literal paren). Leading/trailing `.*`
   guards full-vs-substring id semantics.
2. PRESSED-STATE UNREADABLE — Maestro-web cannot read a pill's `aria-pressed`
   (same CDP-bridge limit card-detail-panel.yaml documents for the RC attribute
   chip). So you CANNOT branch on "is this pill currently active?". Assert the
   flip's SIDE-EFFECT instead (e.g. the Signed By auto-fill), never the pill state.

STATE-FREE NORMALIZE→FLIP PATTERN (when you need a deterministic None→"On Card"
transition without reading pressed-state, and the flow is the card's SOLE writer
so reachable start states are only {None, On Card} — never Sticker):
  tap "Auto (Sticker)"  → Sticker INACTIVE in both None & On Card → SETS Sticker (deterministic)
  tap "Auto (Sticker)"  → now ACTIVE → reverts to "None" (the wasBlank precondition)
  tap "Auto (On Card)"  → INACTIVE at None → SETS "On Card" (the None→On Card action)
Put `waitToSettleTimeoutMs: 2000` on the taps that precede another tap, so the
in-flight onSave finishes and the `disabled={busy}` pill re-enables before the next
tap (a tap on a disabled pill no-ops). A fixed blind sequence CANNOT reach a known
state if Sticker is also reachable (toggle parity) — this pattern only works because
Sticker is unreachable for a sole-writer that never sets it.

PASSIVE-PANEL (SetAttributesPanel) "None" IS UNASSERTABLE — DON'T port the tap
pattern there. On the SET column the toggleOptions OFF value (options[0]="None")
is FUNDAMENTALLY not observable: no pill, no text node anywhere, and both pills
render identically regardless of value (pressed-state unreadable). Unlike the
CardDetailPanel case, a SET-level toggle change has NO observable side-effect to
assert (no signedBy-style auto-fill), and any tap would MUTATE the write-once
feature snapshot on a REUSED per-worker fixture node (destructive, R7) while STILL
giving no readable discriminator. So the state-free normalize→flip pattern above
CANNOT be ported to a passive derived-value assertion — there's nothing to observe.
Fix (done 2026-07-20 in `new-chain-autopopulates-features.yaml`, was old-`<select>`
`{id:"Value for Autographed", text:"None"}` at ~277-283): REMOVED the Autographed
assertion; its setName-origin 1-hop copy-down is already proven by the readable
plain-text siblings Card Thickness ("20pt") + Country of Origin ("USA"), both
`deriveSetLevelFeatures` unconditional setName defaults — same origin level & hop.
Exactly parallels the flow's own prior decision to drop isReprint (checkbox state
unobservable). RULE: to assert a setName-origin default copied down on the set
panel, pick a plain-text (`<input>`) or `<select>` feature whose VALUE is readable
(getNodeText) — never a checkbox/toggleOptions whose off-state has no node.

CARD-DETAIL (CardDetailPanel drawer) SAME CALL — `card-autograph-always-visible-saves.yaml`
(green 158s, 2026-07-20). Predated the redesign (native-`<select>` type-ahead +
`{id:"Value for Autographed", text:"None"}` default assert + change→Cancel→reopen
immediate-save proof) → all obsolete. On its per-worker CUSTOM card the value is
UNOBSERVABLE (None=options[0] no pill/text + aria-pressed unreadable), and the only
proxy (signedBy None→set auto-fill) needs real playerIds a custom card never has
(util-add-custom-card → pendingPlayerNames only). Option-2 fix: KEPT R1 (promoted-out-
of-editor) by asserting `id: ".*Value for Autographed: Auto \\(On Card\\).*"` visible
WHILE "Show features editor" is still the collapsed trigger; DROPPED the immediate-
save-across-cancel assert as unobservable. Did NOT attach a real player to re-derive
the auto-fill — that would DUPLICATE signed-by-autofills-from-players.yaml (R3). Ran
with SKIP_BOOTSTRAP (fully custom, no marketplace) — but harness STILL runs
worker-bootstrap prereqs (~55-59s each) regardless; budget for it.
(That flow still can't go fully green: it dies EARLIER at 6b Vintage — but ⚠️
**CORRECTED 2026-07-20: 6b is NOT env-red/backfill.** After a clean Reset-Data +
setup reseed on the shared dev deployment, the screenshot shows Vintage DERIVED CORRECTLY
(green "Vintage" pill + Era "Vintage (1970-79)"). 6b fails because Vintage is now
an `aria-pressed` toggle-pill, not a `<span>`, so its stale `text:"true"` assert
can't match — see [[write-once-feature-snapshots-panel-assertability]]. Fix = DROP
6b, redundant with 6a Era. NOT a data/backfill problem.)
