/**
 * NEO-254 — a player's career as a single span of years, and whether a card's
 * year falls inside it.
 *
 * ## What this is for
 *
 * `(nameNormalized, sportId)` is a DEDUP key, not a unique one. After the bulk
 * load a great many real names match more than one row — same name, same
 * sport, different people — and NEO-254's first answer was to send every one
 * of them to the review wizard. That is correct but expensive: a 1990 set with
 * eight hundred commons would hand the operator a decision for each collision,
 * almost all of which have exactly one plausible answer, because the other Bob
 * Allen retired in 1937.
 *
 * The card's own year settles most of them. A card printed in 1990 is a
 * statement about somebody who was playing around 1990, so a candidate whose
 * whole career ended fifty years earlier is not that man. That is a NARROWING,
 * never a decision: if it does not leave exactly one, the name still goes to a
 * human.
 *
 * ## Why the span is min-from .. max-to and not the stint list
 *
 * The question is "could this person be on a card of this year", and a career
 * has gaps a card does not care about — a season in the minors, an injury
 * year, a stint the source simply lacks. Excluding a man because the specific
 * year is missing from his stint list would reject him for a hole in OUR data.
 * The outer span is the claim we can actually defend.
 *
 * ## Unknown is never a reason to exclude
 *
 * A player with no stints on file has NO span, and `careerSpan` says so by
 * returning null rather than inventing one. `spanCoversCardYear` then answers
 * true for it — the row is not evidence of anything, and dropping the very
 * candidate we know least about is how the narrowing would pick the wrong man
 * with confidence. It stays in, which means the name goes to review, which is
 * the honest outcome.
 *
 * Pure, and in `lib/` rather than `convex/`, so a browser bundle can import it
 * without dragging `_generated/server` in behind it.
 */

/**
 * How far outside the span a card year may still fall.
 *
 * ±2 years, and both halves earn it. A rookie card is routinely printed the
 * season BEFORE the player's first recorded game (and "first recorded game" is
 * itself a source's opinion); a tribute, retirement or league-leaders card is
 * routinely printed the season or two AFTER the last one. A set's year is also
 * the set's, not the photograph's — 1991 Topps carries 1990 baseball.
 *
 * Deliberately generous, because the cost of the two mistakes is not
 * symmetric: too tight and the narrowing silently links a card to the wrong
 * person; too loose and it declines to narrow, which sends the name to the
 * operator — exactly where it was going before this existed.
 */
export const CARD_YEAR_TOLERANCE = 2;

/** One career stint. `toYear` absent means the stint is still running. */
export type CareerStint = { fromYear: number; toYear?: number };

/** The outer bounds of a career, both years inclusive. */
export type CareerSpan = { fromYear: number; toYear: number };

/**
 * The outer bounds of these stints, or null when there are none.
 *
 * An open stint (`toYear` absent) runs to `currentYear`. `currentYear` is a
 * parameter rather than a call to the clock so the function is pure and its
 * tests do not change answer in January.
 */
export function careerSpan(
  stints: ReadonlyArray<CareerStint>,
  currentYear: number,
): CareerSpan | null {
  let fromYear: number | undefined;
  let toYear: number | undefined;
  for (const stint of stints) {
    if (!Number.isFinite(stint.fromYear)) continue;
    const end = stint.toYear ?? currentYear;
    if (fromYear === undefined || stint.fromYear < fromYear) fromYear = stint.fromYear;
    if (toYear === undefined || end > toYear) toYear = end;
  }
  if (fromYear === undefined || toYear === undefined) return null;
  // A stored stint whose end precedes its start is refused by every writer, but
  // this reads rows written by paths that predate those validators. Widening to
  // the pair rather than trusting the order keeps a corrupt row from producing
  // an empty span that excludes its own player.
  return fromYear <= toYear
    ? { fromYear, toYear }
    : { fromYear: toYear, toYear: fromYear };
}

/**
 * Could a card of `cardYear` carry this career?
 *
 * A null span — nobody has recorded a single stint — answers TRUE. See the
 * module note: an unknown career is not evidence against the man.
 */
export function spanCoversCardYear(
  span: CareerSpan | null,
  cardYear: number,
  tolerance: number = CARD_YEAR_TOLERANCE,
): boolean {
  if (span === null) return true;
  return cardYear >= span.fromYear - tolerance && cardYear <= span.toYear + tolerance;
}

/**
 * Was this ONE stint running in `year`?
 *
 * No tolerance here, deliberately. The tolerance above exists because a set's
 * year is a loose statement about a career; this function answers the much
 * narrower question the team-on-card tie-break asks — "was he on THAT team
 * that season" — where a two-year cushion would let the previous club win the
 * tie for a player who had already been traded.
 */
export function stintCoversYear(
  stint: CareerStint,
  year: number,
  currentYear: number,
): boolean {
  return stint.fromYear <= year && year <= (stint.toYear ?? currentYear);
}
