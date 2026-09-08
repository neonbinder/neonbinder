---
name: typed-feature-controls-neo71-74
description: Set Selector feature rows that became typed controls (League/Era select, Rookie checkbox, Vintage derived) — which feature keys are still free-text and safe for propagation-engine E2E tests
metadata:
  type: reference
---

NEO-71–74 converted four Set Selector "feature" rows from free-text `<input>` to
typed controls (files: `components/SetSelector/CardFeaturesEditor.tsx`,
`SetAttributesPanel.tsx`, shared `FeatureValueControl.tsx`; keys defined in
`convex/features/expectedFeatures.ts`):

- **League** (`league`) → `<select>` constrained to MLB/NBA/NFL/NHL. Card + set level.
- **Era** (`era`) → `<select>` constrained to 4 eBay buckets ("Pre-WWII (Pre-1942)",
  "Post-WWII (1942-69)", "Vintage (1970-79)", "Modern (1980-Now)").
- **Rookie Card** (`isRookie`) → checkbox (card-level only, removed from set panel);
  bound to the real `cardChecklist.isRookie` boolean column, NOT the `features` map.
- **Reprint** (`isReprint`) + **Memorabilia Relic** (`isRelic`) → NOW `inputType:"checkbox"`
  (a NEW `CheckboxValueControl` in FeatureValueControl.tsx) storing "true"/"false" strings
  in the `features` map. Card + set level. Aria-label unchanged (`Value for Reprint` /
  `Value for Memorabilia Relic`) but they're `<input type=checkbox>` — `tapOn` toggles,
  `inputText`/`eraseText` do NOT work. **NO LONGER free-text** (they used to be).
- **Autographed** (`autographed`) → NEW `<select>` (None / On Card / Sticker/Label), card
  + set level, renders between Era and Signed By. A new row that shifts positions below it.
- **Vintage** (`vintage`) → read-only derived `<span>`; not editable, no input at all.

**CHECKBOX STATE IS NOT READABLE IN MAESTRO-WEB (hard limit, verified 2026-07-15).**
`maestro-web.js traverse` emits NO `checked` attribute for any node (so a `checked:`
selector NEVER matches — it shows `checked=null`), and a valueless `<input type=checkbox>`
reports `value="on"` for BOTH checked and unchecked, so `getNodeText`/a `text:` match can't
distinguish states either. You CANNOT assert a checkbox's true/false, nor read it back after
a reload. Toggling DOES fire the `Saved {label}` toast (each tap flips → always a real change
past the `handleSaveFeature` no-op guard), so a checkbox flow can prove the SAVE PATH + toast
+ re-hydration-across-reload (re-toggle → toast again), but never a specific persisted boolean.
This is why `new-chain-autopopulates-features.yaml` DROPPED its Reprint="false" assertion
(kept the 5 readable values; Reprint's 1-hop copy-down is redundantly covered by Manufacturer).

Aria-labels are unchanged (`Value for <Label>`), so a flow that only asserts the
row is *visible* still passes (e.g. topps-chrome-marketplace-read checks
`Value for League`). But you can no longer `inputText` arbitrary strings into
League/Era — and `convex/features/deriveCardFeatures.ts::validateFeatureValue`
(called inside setSelectorOptionFeature/setCardFeature) THROWS on an off-list
league/era write.

**NEO-71-74 also REMOVED the cascade/propagation engine + inherited/revert UI (2026-07-13, PR #73):**
- `setSelectorOptionFeature` (convex/selectorOptions.ts) now patches ONLY the single edited row (`features:{...row.features,[key]:value}`) and returns `null` — NO fan-out to descendant cards. `setCardFeature` likewise patches one card. Every row/card carries a complete write-once `features` snapshot copied down at CREATION.
- `SetAttributesPanel.handleSaveFeature` toast is now optimistic **`Saved {label}`** (e.g. `Saved Reprint`, `Saved Signed By`) — the old **`Updated N cards`** propagation toast is GONE. The `Will propagate to N cards` preview block is GONE. Assert the new toast with `.*Saved <Label>.*`. (The optimistic toast fires from a no-op guard `if (features[key]===trimmed) return;` — so to guarantee it fires, write a per-ATTEMPT_ID UNIQUE value, NOT a fixed sentinel — kills the [[reference_local_full_suite_harness_gotchas]] no-op-wedge class entirely.)
- `CardFeaturesEditor` (card-level) NO LONGER renders an `Inherited: X` label or a `Revert <key> to inherited` button — a card row is just a pre-filled input of the card's own snapshot value. Do NOT reference those in flows. "No cascade" is now proven by: give a card its own value, edit the ancestor set feature to a different value, re-open the card, assert it STILL shows its own value (combined `{id:"Value for Reprint", text:".*OWNVAL.*"}` selector).
- CLEANUP GOTCHA: deleting a card row while its inline EDIT FORM is still open does NOT surface the `Confirm?` delete prompt (the row `Del` tap COMPLETES but no confirm appears → assert fails). Always `Save card edit` (close form) + re-scroll to the player row BEFORE the `Delete card`/`Confirm?` sequence.
- Flows fixed to this behavior: `features-propagation.yaml` (full rewrite — set-edit save toast + no-cascade-to-card), `topps-chrome-add-feature.yaml` (Saved Reprint toast), `topps-chrome-marketplace-read.yaml` (dropped the Will-propagate assertion). All 3 GREEN locally 2026-07-13.

**Rule for propagation / no-cascade / override E2E tests (updated 2026-07-15):** the
subject field must be editable at BOTH the set (setName) level AND the card level, be
FREE-TEXT (a boolean can't hold 3 distinct sentinels — SET1/CARD/SET2 — needed to tell
"card kept its own value" from "cascade overwrote it", and its state isn't readable anyway).
After the checkbox conversion the ONLY such key left is **`signedBy`** (label "Signed By",
aria-label `Value for Signed By`) — free-text, `required:false` (no amber ⚠ to interfere),
applies at every set level + card level. `cardType`/`parallelName` are level-restricted
(applicableAtLevels variantType/insert/parallel → NOT rendered at setName, so no set-level
write). `manufacturer` is derived/verbatim (weird to sentinel). So `features-propagation.yaml`
was repointed **Reprint → Signed By** (SbyTest-SET1/CARD/SET2). `topps-chrome-add-feature.yaml`
stays on Reprint but is now a CHECKBOX-TOGGLE test (Saved Reprint toast + reload re-hydration).

**CardFeatureRow was MISSING `useFieldTestClass` — the checkbox change exposed it (fixed
2026-07-15, app change in `CardFeaturesEditor.tsx`).** maestro-web `inputText` reads
`activeElement`, then RE-FINDS it by an XPath built from its `class` (no id) — all card-feature
text inputs shared ONE className, so it typed into the FIRST match. Before, `isReprint` was the
first *text* input so card-level Reprint edits worked BY LUCK; making Reprint a checkbox moved
the first-text slot to **Card Type**, so `inputText` into Signed By silently landed in Card Type
(Signed By stayed empty). `SetFeatureRow` + 8 other components already use `useFieldTestClass`
for exactly this; `CardFeatureRow` didn't. Fix = add `const fieldClass = useFieldTestClass();`
and prepend `${fieldClass()}` to the text control's className. LESSON: any component with >1
editable `<input>` sharing a className needs `useFieldTestClass`, or Maestro `inputText` hits
the first one. All 4 flows GREEN locally 2026-07-15.
