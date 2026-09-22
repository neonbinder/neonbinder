/**
 * NEO-294 — the brands NB RECOGNISES BY NAME, so a set whose name starts with
 * one is filed under that brand instead of the year's Unknown row.
 *
 * ENV-FREE and importable from the SPA: a plain constant plus one matcher
 * over `matchesBrandPrefix`. No Convex imports, no `process.env`.
 *
 * ## What this list is, and what it is NOT
 *
 * It is a VOCABULARY, not a set of rows. Nothing here mints a brand on its
 * own: the brand row for a given year is created only if and when a set that
 * fits it is found in that year (`ensureBrandRow`, called from the set sync
 * and from `backfillKnownBrands`). It is year- and sport-independent, and it
 * is NOT derived from the brands NB already has — on dev, 2026-09-22, 955
 * sets sat under Unknown across the synced years and not one of the top
 * names among them was a brand NB knew, so a list derived from existing rows
 * would have filed exactly zero sets.
 *
 * It is also not a marketplace value. These are NB's own words for brands NB
 * recognises; a marketplace is asked nothing about them and never decides
 * whether one is on the list (product invariant 4). The names travel one way
 * only: into `metadata.setNamePrefix` on a brand row NB creates.
 *
 * ## How it was curated (and why it is not a word-frequency list)
 *
 * A hobby pass over all 955 real Unknown set names, not the leading word of
 * each. A LEADING WORD IS NOT A BRAND — that is the whole discipline here:
 *
 *   • A PRODUCT LINE OF A BRAND NB ALREADY HAS never becomes its own brand.
 *     A bare "MVP" set is Upper Deck MVP; an "MVP" entry here would file it
 *     away from the brand it belongs to and make it very hard to find again.
 *     Those sets are either already claimed by the existing brand's prefix or
 *     they stay in Unknown, which is the honest answer.
 *   • CITIES AND TEAMS are not brands: `Philadelphia` (six sets) is rejected
 *     for the same reason, as are sponsors with no line of their own
 *     (7-Eleven, Burger King, Coca-Cola, Kodak, Whataburger).
 *   • EVERY SINGULAR/PLURAL PAIR is rejected — "Historic Limited Edition"
 *     and "Historic Limited Editions", "Publication International" and
 *     "Publications International". Either spelling would claim only half
 *     the sets, and the pair would break the no-prefix invariant below.
 *   • SUFFIX-ONLY DESCRIPTORS (Police, Smokey, SGA) need no rejecting: a
 *     PREFIX matcher ignores them for free.
 *
 * ## The invariant: NO ENTRY MAY PREFIX ANOTHER
 *
 * Under `matchesBrandPrefix` — whole word, case-insensitive — no entry here
 * word-boundary-prefixes any other. That is why the list says `ONIT Athlete`
 * and not `ONIT`, `Grand Slam` and not `Grand` (Grandstand is a different
 * issuer, and "Grand" would swallow it), and `Historic Autographs` and not
 * `Historic` (which merges two issuers). With the invariant held, at most one
 * entry can ever match a name — if two did, the shorter would by definition
 * be a whole-word prefix of the longer — so `matchKnownBrand` has exactly one
 * answer and two syncs can never disagree about it. `knownBrands.test.ts`
 * asserts the invariant over the whole list rather than trusting a reviewer's
 * eye; that test is the guard on every future addition.
 *
 * ## Known, accepted risks (Jason, 2026-09-22)
 *
 * `Star`, `Best` and `Choice` are common English words, and they are the
 * three biggest claims in the sample (88, 48 and 301 sets). Any future set
 * whose name literally begins with one lands under that brand. That is
 * accepted and PERMANENT — which is precisely why this ticket also ships the
 * operator's move control in the attributes panel: auto-creation without a
 * way back would be irreversible. A move stamps the row
 * (`metadata.brandSetByOperator`) and every automatic re-home skips it, so
 * the operator's answer outlives every later sync.
 *
 * ## The fold is case + trim, deliberately
 *
 * `selectorValueKey` lowercases and trims and does nothing else, so `Kahn's`
 * and `Mother's Cookies` stop matching the moment a marketplace returns a
 * TYPOGRAPHIC apostrophe (’) instead of an ASCII one. That FAILS SAFE: the
 * set stays in Unknown, where it was anyway, and an operator moves it in one
 * click. It must NOT be "fixed" by loosening `selectorValueKey` — that fold
 * is shared with the sibling-clash check and the rename-suggestion door, and
 * widening it there would silently merge rows those two keep apart (see its
 * own doc comment: "Gold /50" and "Gold 50" are apart by design). If the
 * apostrophe ever matters enough, the fix is a second entry, not a wider
 * fold.
 *
 * ## Adding a brand
 *
 * Edit this array. It is a code constant on purpose (operator editing is out
 * of scope for NEO-294): adding a brand is a one-line PR, and the test file
 * keeps the invariant honest.
 */

import { matchesBrandPrefix, selectorValueKey } from "./selectorSyncMatch";

/**
 * The 39 brands NB recognises, sorted by folded name. Counts in the comments
 * are sets claimed in the 2026-09-22 dev sample (Baseball 1990/2025/2026 were
 * the years available to check), so they are FLOORS, not totals — the list is
 * sport- and year-independent.
 *
 * Grouped as Jason approved them: 27 the collector pass vouched for
 * unreservedly, 11 "probable" taken as one block, and one of his own.
 */
export const KNOWN_BRANDS: readonly string[] = [
  "Bandai", // 9
  "Barry Colla", // 4 — probable
  "BBM", // 40
  "Best", // 48 — a common word; see the risks above
  "Boxscores", // 1 — probable
  "Calbee", // 5
  "Choice", // 301 — a common word; the single biggest claim in the sample
  "CMC", // 27
  "Diamond Cards", // 4
  "Eclipse", // 1 — probable
  "Epoch", // 16
  "Futera", // 8
  "Grand Slam", // 14 — never "Grand": Grandstand is a different issuer
  "Historic Autographs", // 1 — never "Historic": that merges two issuers
  "Juco World Series", // 8 — Jason's call: "a brand along with Star"
  "Kahn's", // 4 — probable; ASCII apostrophe only, see the fold note above
  "Kenner", // 2 — probable
  "Leaf", // 14
  "Little Sun", // 2 — probable
  "Mother's Cookies", // 11 — ASCII apostrophe only
  "MSA", // 2 — probable
  "ONIT Athlete", // 43 — never "ONIT": one entry must not prefix another
  "Onyx", // 3
  "Perez-Steele", // 1
  "Post", // 1 — probable
  "Pro Set", // 1
  "ProCards", // 6
  "Pucko", // 6
  "Pulse", // 10
  "SCC", // 3 — probable
  "Sisson Printing", // 3 — probable
  "Sport Pro", // 5
  "Sportflics", // 1
  "SportsPrint", // 4
  "Star", // 88 — a common word; see the risks above
  "Swell", // 1
  "Takara", // 12
  "Wild Card", // 2
  "WTHBALLS", // 2 — probable
];

/**
 * The known brand that claims `setName`, or `undefined` when none does.
 *
 * The rule is `matchesBrandPrefix` and nothing else — the same whole-word,
 * case-insensitive matcher the BSC bucketing, the SportLots narrowing and the
 * re-home all use, so a set this function claims is a set those three agree
 * belongs to that brand.
 *
 * LONGEST MATCH WINS, defensively: the no-entry-prefixes-another invariant
 * means at most one entry can match, and the loop's tie-break is there so a
 * future addition that breaks the invariant degrades to "the more specific
 * name" instead of "whichever came first in the array" — while the test
 * fails and says so.
 *
 * CALLED ONLY where a set would otherwise land in Unknown. An existing NB
 * brand — by id, or by its own `setNamePrefix` — always wins before this is
 * consulted, and a row an operator placed by hand is never reconsidered at
 * all (`metadata.brandSetByOperator`).
 */
export function matchKnownBrand(setName: string): string | undefined {
  let best: string | undefined;
  let bestLength = 0;
  for (const brand of KNOWN_BRANDS) {
    if (!matchesBrandPrefix(setName, brand)) continue;
    const length = selectorValueKey(brand).length;
    if (best === undefined || length > bestLength) {
      best = brand;
      bestLength = length;
    }
  }
  return best;
}
