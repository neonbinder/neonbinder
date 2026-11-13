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
 * A hobby pass over real Unknown set names, not the leading word of each —
 * first all 955 baseball ones (2026-09-22), then the 266 that remained after
 * Football 2025 + 1994 and Basketball 2026 + 2025 + 1994 were loaded. A
 * LEADING WORD IS NOT A BRAND — that is the whole discipline here:
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
 *     (`Collector's Edge` / `Collectors Edge` is a DELIBERATE exception,
 *     argued below — an apostrophe is not a plural.)
 *   • SUFFIX-ONLY DESCRIPTORS (Police, Smokey, SGA) need no rejecting: a
 *     PREFIX matcher ignores them for free.
 *
 * ## WHEN A PRODUCT LINE EARNS ITS OWN ROW (Jason, 2026-09-22)
 *
 * The rule above says a line of a brand NB already has is not a brand. The
 * exception, and its test: A LINE EARNS ITS OWN BRAND ROW WHEN THE HOBBY'S
 * CATALOGUE HEADING IS THAT NAME ALONE **AND** THE LINE CROSSED OWNERS.
 *
 * `Hoops` passes both halves. The catalogue heading is "Hoops", never
 * "Fleer Hoops", and the line went Hoops Inc./SkyBox → Fleer → Panini — so
 * filing it under any one of those three is wrong for half its life. NB
 * already does exactly this for Ultra (Fleer), Stadium Club and Finest
 * (Topps), SP and Bowman: each is its own brand row, not a line under its
 * owner of the moment (and, since NEO-527, its own entry here — see "The
 * majors" below).
 *
 * `Flair` clears only the first half — the heading is "Flair", but the line
 * is Fleer-only — which is why it is filed here as PROBABLE rather than
 * certain. If it ever wants removing, that is the half that failed.
 *
 * This is NOT a licence to promote any line with a recognisable name. Both
 * halves, or it stays a line: `MVP` is Upper Deck's throughout, so it is
 * still rejected, and so is `Collector's Choice` (12 sets) — the hobby says
 * "UD Collector's Choice", it never left Upper Deck, and it is the `MVP`
 * shape exactly.
 *
 * ## TWO ROWS FOR ONE ISSUER, ON PURPOSE
 *
 * Three pairs here are two spellings of one thing, and both spellings ship.
 * That is a deliberate exception to the singular/plural rejection, taken
 * because the source spells it both ways and the sets are worth having:
 *
 *   • `Collector's Edge` + `Collectors Edge` — 11 sets of a major 90s
 *     football maker. The fold is case + trim only (below), so one entry
 *     would claim its own spelling and leave the other in Unknown.
 *   • `UNO Elite` + `UNO Fandom` — Mattel's crossover, two named lines.
 *   • `Hoops` + `NBA Hoops` — "NBA Hoops" is a MARKETPLACE-ARTIFACT
 *     spelling of the same line, and it is the bigger claim of the two (13
 *     sets against 5). The matcher is anchored at the start of the name, so
 *     `Hoops` alone cannot claim a set whose name begins "NBA Hoops".
 *
 * Neither member of a pair prefixes the other, so the invariant below holds
 * and the test proves it. The two rows are two brands in the UI; an operator
 * who wants them as one moves the sets, which is what the move control is
 * for.
 *
 * ## DELIBERATE REJECTIONS — do not "fix" these by adding an entry
 *
 *   • `Collector's Choice` (12 sets) — Upper Deck's line; the `MVP` shape.
 *   • `Select` — 1994 Select is Score/Pinnacle's, but "Select" today means
 *     *Panini Select*. An entry would quietly claim every future Panini
 *     Select set AWAY from Panini, which is the worst trap in this data: it
 *     looks like a win on the 1994 sample and silently mis-files the ones
 *     that matter.
 *   • `Pro Cards` — a spacing variant of the shipped `ProCards`. The fold
 *     does not close spaces (and must not), so this is a separate string;
 *     unlike the apostrophe pairs above, the set count does not earn a
 *     second row.
 *   • `NFL Properties`, the Chris Martin Enterprises cluster (spelled four
 *     different ways in the source), and every 1–2-set long-tail issuer.
 *   • `Valiant` (NEO-527, Jason 2026-11-12) — the 2026 Football Unknown
 *     sample carries two Valiant Michigan sets; considered with the majors
 *     and rejected. They stay in Unknown.
 *
 * ## The majors (NEO-527)
 *
 * Until NEO-527 this list deliberately left out every big manufacturer —
 * Topps, Panini, Upper Deck and the rest — because SportLots' brand list
 * supplied them: a year synced from SportLots got a brand row for each, and
 * this list existed only for the issuers that list lacked.
 *
 * While SportLots is paused, a year synced gets no major brand rows, so
 * every Topps, Bowman, Panini, Donruss and Upper Deck set in it would be
 * filed under Unknown. Product invariant 1 says NB's data must stand without any one
 * marketplace, so NB's OWN vocabulary now names the majors too: every brand
 * SportLots supplied that this list lacked, read once from the brand rows
 * NB already had (Jason, 2026-11-12). They are spelled exactly as those
 * pre-pause rows are, so `ensureBrandRowForName` ADOPTS an existing row by
 * folded name rather than minting a second one beside it.
 *
 * Nothing else about the list changes. These entries are compared only
 * against NB set names, through the same matcher; no marketplace is asked
 * about them and none decides whether they are on the list. An existing NB
 * brand (by id or by its own `setNamePrefix`) still wins before the list is
 * consulted, so a year that already has a Topps row files its sets exactly
 * as it did.
 *
 * Two shapes worth knowing, both the existing prefix rule and not new:
 *
 *   • A set is claimed by the brand its NAME STARTS WITH. "Upper Deck SP
 *     Authentic" is Upper Deck's and "SP Authentic" is SP's; "Fleer Ultra"
 *     is Fleer's and "Ultra" is Ultra's; "Topps Stadium Club" is Topps'.
 *   • `SP` is a whole word, so "SPx" (another Upper Deck line) is NOT
 *     claimed by it and stays where it was.
 *
 * `Classic` and `SP` are CERTAIN, despite looking risky: every real
 * Classic line belongs to Classic Inc., and every "SP …" set is Upper
 * Deck's SP line (collector review). `Score` alone is PROBABLE, for the
 * reason `Star`, `Best` and `Choice` carry a risk note: it is a common word,
 * and "Score Board" is a different company.
 *
 * ## `Other` IS NOT AND MUST NEVER BE AN ENTRY
 *
 * "Other" is a MARKETPLACE BUCKET WORD that has been concatenated into NB
 * set names at ingest: the data carries `Other ONIT Athlete LSU Tigers` and
 * `Other King B Discs` sitting beside a bare `King B Discs`. Keying a brand
 * on it would be keying NB behaviour on a marketplace's own grouping label —
 * product invariant 4, directly. Leaving those names in Unknown FAILS SAFE.
 *
 * The visible cost, recorded so it is not mistaken for a bug: `ONIT Athlete`
 * files ZERO football sets today, because every one of them arrives with
 * "Other " in front of the name and the matcher is anchored at the start.
 * The fix belongs at the ADAPTER BOUNDARY — stop concatenating the bucket
 * word into the set name on the way in — and is its own ticket. It is not
 * fixed here, and it is not fixed by loosening the matcher.
 *
 * ## The invariant: NO ENTRY MAY PREFIX ANOTHER
 *
 * Under `matchesBrandPrefix` — whole word, case-insensitive — no entry here
 * word-boundary-prefixes any other. That is why the list says `ONIT Athlete`
 * and not `ONIT`, `Grand Slam` and not `Grand` (Grandstand is a different
 * issuer, and "Grand" would swallow it), `Historic Autographs` and not
 * `Historic` (which merges two issuers), `Ted Williams` and not `Ted`, and
 * `UNO Elite` and not `UNO` (which is also University of Nebraska Omaha).
 * With the invariant held, at most one entry can ever match a name — if two
 * did, the shorter would by definition be a whole-word prefix of the longer
 * — so `matchKnownBrand` has exactly one answer and two syncs can never
 * disagree about it. `knownBrands.test.ts` asserts the invariant over the
 * whole list rather than trusting a reviewer's eye; that test is the guard
 * on every future addition.
 *
 * ## Known, accepted risks (Jason, 2026-09-22)
 *
 * `Star`, `Best` and `Choice` are common English words, and they are the
 * three biggest claims in the baseball sample (88, 48 and 301 sets); `Hoops`
 * and `Playoff` join them from the basketball and football pass. Any future
 * set whose name literally begins with one lands under that brand. That is
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
 * TYPOGRAPHIC apostrophe (’) instead of an ASCII one — and the same is true
 * of `Champion's Deck` and `Collector's Edge`. That FAILS SAFE: the set
 * stays in Unknown, where it was anyway, and an operator moves it in one
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
 * The 70 brands NB recognises, sorted by folded name. Counts in the comments
 * are sets claimed in the dev samples — Baseball 1990/2025/2026 on
 * 2026-09-22, then Football 2025/1994 and Basketball 2026/2025/1994 in the
 * same week — so they are FLOORS, not totals: the list is sport- and
 * year-independent. The 17 majors (NEO-527) carry no count: they were never
 * sampled, because SportLots supplied them; where 2026 Football's Unknown
 * row had sets for one, that number is given instead.
 *
 * Grouped as Jason approved them, certain and probable taken as one block
 * each time: 27 + 11 + one of his own in the first pass, then 10 + 4 from
 * the collector pass over the 266 sets still in Unknown afterwards, then
 * the 17 majors SportLots used to supply (16 + 1 probable, NEO-527).
 */
export const KNOWN_BRANDS: readonly string[] = [
  "Action Packed", // 7 — its own manufacturer; catalogues never say "Pinnacle Action Packed"
  "Bandai", // 9
  "Barry Colla", // 4 — probable
  "BBM", // 40
  "Best", // 48 — a common word; see the risks above
  "Bleachers", // 4
  "Bowman", // 4 in 2026 Football — NEO-527 major; also claims "Bowman's Best"
  "Boxscores", // 1 — probable
  "Calbee", // 5
  "Champion's Deck", // 3 — NIL issuer, the ONIT Athlete class; ASCII apostrophe only
  "Choice", // 301 — a common word; the single biggest claim in the sample
  "Classic", // NEO-527 major — certain: every real Classic line is Classic Inc.'s
  "CMC", // 27
  "Collector's Edge", // 2 — the apostrophe spelling; see "two rows for one issuer"
  "Collectors Edge", // 9 — the same issuer, the other spelling, on purpose
  "Diamond Cards", // 4
  "Donruss", // 1 in 2026 Football — NEO-527 major
  "Eclipse", // 1 — probable
  "Epoch", // 16
  "Finest", // NEO-527 major — its own row; a "Topps Finest" name is still Topps'
  "Flair", // 2 — probable: the heading is "Flair", but the line is Fleer-only
  "Fleer", // NEO-527 major
  "Futera", // 8
  "Grand Slam", // 14 — never "Grand": Grandstand is a different issuer
  "Historic Autographs", // 1 — never "Historic": that merges two issuers
  "Hoops", // 5 — a line that earned its own row: Hoops Inc./SkyBox → Fleer → Panini
  "ITG", // NEO-527 major — In The Game
  "JOGO", // 11 — JOGO Inc., CFL
  "Juco World Series", // 8 — Jason's call: "a brand along with Star"
  "Kahn's", // 4 — probable; ASCII apostrophe only, see the fold note above
  "Kenner", // 2 — probable
  "Leaf", // 14
  "Little Sun", // 2 — probable
  "Mother's Cookies", // 11 — ASCII apostrophe only
  "MSA", // 2 — probable
  "NBA Hoops", // 13 — probable; the marketplace-artifact spelling of Hoops
  "O-Pee-Chee", // NEO-527 major
  "ONIT Athlete", // 43 — never "ONIT": one entry must not prefix another
  "Onyx", // 3
  "Pacific", // NEO-527 major
  "Panini", // 3 in 2026 Football — NEO-527 major
  "Perez-Steele", // 1
  "Pinnacle", // NEO-527 major
  "Playoff", // 2 — probable
  "Post", // 1 — probable
  "Pro Set", // 1
  "ProCards", // 6 — never "Pro Cards": a spacing variant, deliberately rejected
  "Pucko", // 6
  "Pulse", // 10
  "SAGE", // 28 — SAGE Collectibles, the live draft-pick maker
  "SCC", // 3 — probable
  "Score", // NEO-527 major — probable: a common word, and "Score Board" is another company
  "Sisson Printing", // 3 — probable
  "Skybox", // NEO-527 major
  "SP", // NEO-527 major — certain: every "SP …" set is Upper Deck's SP line; whole-word, so never "SPx"
  "Sport Pro", // 5
  "Sportflics", // 1
  "SportsPrint", // 4
  "Stadium Club", // NEO-527 major — its own row, like Finest
  "Star", // 88 — a common word; see the risks above
  "Swell", // 1
  "Takara", // 12
  "Ted Williams", // 10 — the Ted Williams Card Co.; NEVER a bare "Ted"
  "Topps", // 12 in 2026 Football — NEO-527 major
  "Ultra", // NEO-527 major — its own row; "Fleer Ultra" is still Fleer's
  "UNO Elite", // 3 — Mattel's crossover; NEVER a bare "UNO" (Nebraska Omaha)
  "UNO Fandom", // 1 — probable; the other UNO line
  "Upper Deck", // 1 in 2026 Football — NEO-527 major
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
