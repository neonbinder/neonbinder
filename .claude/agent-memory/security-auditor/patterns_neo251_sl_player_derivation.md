---
name: patterns-neo251-sl-player-derivation
description: NEO-251 turns SportLots description text into NB players rows; the durable rules are that adapter-side caps are not the trust boundary (the client is), that two name normalizers USED to disagree about diacritics (resolved by NEO-253), that raw SL refs are already log-forgeable, and that a recorded SL page is a credentialed capture headed for a public repo
metadata:
  type: project
---

Plan audited 2026-09-05 (`todos/neo-251-252-plan.md` §"NEO-251 design", code at
`1091d95`). No credentials/PII in this surface — every entry point is
`requireAdmin` single-tenant operator tooling. The risk is hostile *content*:
SportLots free-text descriptions becoming durable `players` rows.

**1. The adapter is not the trust boundary; the client is.**
`parseSlSubjects` caps (≤4 names, ≤120 chars) run inside `fetchSportLotsChecklist`,
but every value it produces goes adapter → action return → **browser** →
`diffChecklistAgainstExisting` / `resolveChecklistEntities` / `commitCardChecklist`,
all of which take `previewCardValidator` from the wire. `players` is a bare
`v.optional(v.array(v.string()))` (`selectorOptions.ts:7575`), the only batch
guard is `assertCardBatchWithinLimits` (`:2239`, 5000 CARDS, nothing per card),
and the prelude's `ctx.db.insert("players", …)` (`:9315`) has no cap at all.
Rule for anything on this path: enforce at the public entry points and again at
the prelude, never only in the adapter.

**2. The caps already exist — reuse, do not invent.** `MAX_PLAYER_NAME_LENGTH`
= 120 (`players.ts:140`, enforced in every `players.*` write and documented at
`:187` to report the LENGTH and never the name), `MAX_TEAM_NAME_LENGTH` = 120
(`teams.ts:104`), `MAX_CARD_PLAYERS` = 20 / `MAX_CARD_TEAMS` = 8
(`features/cardAttention.ts:294/312`, enforced by `resolvePlayerIdsForWrite`
`selectorOptions.ts:3488` — which the checklist commit chunk does NOT go
through). A checklist-path cap that differs from these creates names one path
can write and another cannot edit.

**3. RESOLVED by NEO-253 (2026-09-06).** This entry used to read "two
normalizers disagree about diacritics" — `nameKey` folded NFD, the six
hand-copied `normalize*Name` chains did not, so SL's accented spelling minted a
duplicate `players` row. They are now one function
(`lib/entities/normalize-name.ts`) and every NB identity key aliases it. See
[[patterns-neo253-entity-name-fold]] for the shape of the fix and the read/write
pairs that still matter.

**4. Raw SportLots text is already in the logs unescaped and unbounded.**
`selectorOptions.ts:8176-8194` joins `indistinguishableSlRefs` /
`orphanedSlRefs` — each one a whole SL card description — into `console.warn`
with `.slice(0, 5)` bounding the COUNT but nothing bounding the length or
stripping newlines. A description carrying `\n` forges log lines. Anything
derived from that text (player names) must not repeat the pattern: log a count,
or a length-capped, control-char-stripped rendering.

**5. `platformRef` is a match key — never re-encode it.**
`adapters/sportlots.ts:1276` stores the raw description as `platformRef`, and
`existingIdBySlRef` matches stored rows on it byte-for-byte. HTML-entity
decoding added for name derivation must stay inside the pure parser; decoding
`fullDescription` before the push would silently orphan every previously stored
SL ref (mass re-insert). Same reason `cardName` must keep its current
derivation.

**6. Decode ONCE, then reject — never validate then decode.** The row regex
(`:1129`) is `[^<]+`, so raw markup cannot enter, but `&lt;script&gt;` can and
becomes `<script>` after a decode. Decode-then-reject is the correct order. A
denylist of `<`/`>`/control chars is still too narrow: prefer an ALLOWLIST for
a person's name (Unicode letters, apostrophe, hyphen, period, space), which
also excludes `&`, bidi overrides (U+202E), zero-width joiners and NBSP —
characters that both spoof an admin list and defeat the dedupe key in (3).

**7. A "recorded real SL page" fixture is a credentialed capture.** The
monorepo is PUBLIC and `fetchSportLotsChecklist` fetches `listcards` with the
operator's session cookie; the response carries account nav, pricing/inventory
context and hidden form inputs. The house convention is the opposite of a page
capture: `convex/adapters/__fixtures__/bsc-heritage-2021-cards.json` is the
parser's *derived shape*, not raw HTML. Any SL fixture must be a hand-authored
minimal `<td class="small(color)?left">` table or a scrubbed excerpt.

**8. The conflict-suppression rule wants to be narrower than "either side".**
`diffChecklistAgainstExisting` (`:10844`) is display-only — the write gate is
`applyFields` + `baseVersion` re-checked in the chunk (`:9736-9790`), so
suppressing a diff entry fails CLOSED. Still: "stored equals either marketplace
side ⇒ no change" is only ever needed for the LOSING side (equality with the
merged default produces no diff anyway), it must be per-FIELD (a card-level
suppression would hide `cardName`/`attributes` on the same row), and while a
conflict stands it makes a genuine upstream edit permanently invisible.

**9. A pre-seeded conflict choice inflates the edit count.**
`countPairingEdits` (`pairing-session-edits.ts:63-83`) counts a name conflict as
an operator edit whenever `chosen !== "bsc"`. `mergePair` seeds `chosen: "bsc"`
(`CardPairingModal.tsx:572`) precisely so the default is not counted. A
`playersConflict.preferred` seeded from stored NB `playerIds` must therefore
carry a separate "operator touched this" flag, or it will read as settled work
the operator never did.

See [[patterns-neo239-retire-custom]] for the per-side resolvability model this
sits on and [[patterns-neo211-additive-selector-sync]] for the NEO-47 rule that
raw adapter text never reaches reactive state.
