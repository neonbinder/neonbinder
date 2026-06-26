# Flow #37 — `set-selector/variant-metadata-editor-insert` — Walk Plan (2026-06-15)

Last of the set-selector remainder. Audited against the **corrected** criteria (R4 keep `/testing/sign-in`
entry + no in-body login, R5 all-7s, R9 drill-via-util).

## R1 — Feature
Add a custom Insert variant ("META-TEST") in a per-worker custom set (`vme-insert-${WORKER_INDEX}`), tap it to
render `VariantMetadataEditor`, edit the **Prefix** field, Save, and confirm Save disappears + the panel stays
(Metadata / Prefix intact).

## Per-rule verdict
| Rule | Status | Notes |
|---|---|---|
| R1 feature | ✅ | clear single feature (VariantMetadataEditor Prefix edit + persistence) |
| **R2 assert-only** | 🔴 **finding** | idempotency on re-run (below) + generic `assertVisible "Insert"/"Parallel"/"Save"` (minor) |
| R3 dedup | ✅ | unique — sole VariantMetadataEditor test |
| **R4 entry** | 🟡 **finding** | keeps the `/testing/sign-in` entry ✅, but the landing is a **bare `assertVisible "Set Selector"`** (line 36) with no wait — should be `extendedWaitUntil visible:"Set Selector" timeout:45000` (the Clerk auth handshake can take ~5.6s + rate-limit retries; matches every green flow). No in-body login ✅. |
| R5 waits | ✅ | already all-7s default (comment says so); util owns the drill's marketplace-exception waits |
| **R6 redundant** | 🟡 **cleanup** | line 69-72: `scrollUntilVisible text:"Metadata"` then `assertVisible "Metadata"` (same element) → drop the assert |
| R7 destructive | ✅ | per-worker custom set; adds a variant + edits a field |
| **R8 centerElement** | 🟡 **cleanup** | three tap targets lack a centered scroll (below) |
| R9 drill-via-util | ✅ | drills via `runFlow util-drill-to-custom-set` (SET_NAME/VARIANT_TYPE env) |
| +9 tags | ✅ | `set-selector`, `regression` |

## 🔴 The real finding — idempotency on re-run (R2)
The variant **"META-TEST"** and its Prefix are **stable strings** on a **persistent** per-worker set
(`vme-insert-${WORKER_INDEX}`), and bootstrap's reset does NOT clear `selectorOptions`. So on the 2nd+ local run:
- META-TEST already exists (re-adding selects the existing row — OK), and its Prefix already holds the prior value.
- Then `tapOn "Prefix:"` → `inputText "TEST-"` into a **populated** field is non-deterministic: either a **no-op**
  (Prefix already `TEST-` → no change → **"Save" never appears → `assertVisible "Save"` FAILS**) or it **accumulates**
  (`TEST-TEST-…`, polluting the value while passing by accident).
- CI is unaffected (fresh preview DB each run), but **local re-validation is flaky/non-deterministic** — the exact
  class we keep hitting (#26/#28).

**Fix (the proven pattern):** make the Prefix edit a guaranteed fresh change each run —
`tapOn "Prefix:"` → **`eraseText: 20`** → `inputText "TEST-${ATTEMPT_ID}"`. Fresh value ⇒ Save always appears,
no accumulation; the META-TEST variant stays stable (reused, no new-row pollution). Then optionally strengthen
persistence by asserting the value survived: after Save, `assertVisible text: ".*TEST-${ATTEMPT_ID}.*"`.

## Cleanup findings
1. **R4** — `assertVisible "Set Selector"` (line 36) → `extendedWaitUntil { visible: "Set Selector", timeout: 45000 }`
   (the auth handshake needs the wait; bare assert is fragile under parallel sign-in).
2. **R6** — drop the redundant `assertVisible "Metadata"` (line 72) after its `scrollUntilVisible`.
3. **R8** — add `centerElement: true` to: the `scrollUntilVisible "META-TEST"` (line 63, it's a **tap** target);
   add a `scrollUntilVisible "Prefix:" centerElement: true` **before** `tapOn "Prefix:"` (last row in the panel,
   can sit in the footer-steal zone); and a centered scroll before `tapOn "Save"` (appears low, near Prefix).
4. **R2 minor** — `assertVisible "Insert"/"Parallel"/"Save"` are generic words that can match the Inserts column /
   variant type elsewhere. Low risk here (panel context), but prefer scoping (e.g. `below:`/`rightOf:` the panel)
   if a clean anchor exists; otherwise note it.

## Decision (single path)
**Cleanup + idempotency fix:** R4 sign-in `extendedWaitUntil 45s`; R6 drop redundant Metadata assert; R8
centerElement on the META-TEST / Prefix / Save taps; **R2 idempotency → `eraseText` + `TEST-${ATTEMPT_ID}`** for the
Prefix (and add the post-save value assert for real persistence coverage). Route through `maestro-e2e-author`
(edit-only), then enqueue #37 on the harness.

## After the decision
1. maestro-e2e-author applies it.
2. Validate: `./e2e-enqueue.sh .maestro/flows/set-selector/variant-metadata-editor-insert.yaml` → watch.
3. Update tracker: mark #37 walked + GREEN. **#37 completes the set-selector group** → next is Phase D (profile).
