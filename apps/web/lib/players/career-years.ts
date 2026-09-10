/**
 * NEO-254 — one floor for a career year, for every path that writes one.
 *
 * ## Why this had to be consolidated
 *
 * There were three copies of this number and they did not agree. The review
 * wizard's server validation (`entityReviewQueue.recordDecision`) refused
 * anything under 1869; `CareerTeamEntry` mirrored that by hand in a comment
 * that named the file it was mirroring; and `players.savePlayerFields` — the
 * OTHER route into the same `players.teamYears` field — used 1850.
 *
 * A stint entered on the Players page at 1855 was therefore storable, and the
 * identical stint entered in the wizard was not. Two validators guarding one
 * column must not be able to disagree about what the column accepts, and the
 * only way to guarantee that is for there to be one number.
 *
 * ## Why 1869 and not 1850
 *
 * 1869 is the Cincinnati Red Stockings, the first openly professional
 * baseball club — the earliest date at which a "career team" is a thing that
 * exists. 1850 was chosen as deliberate slack for a pre-league amateur era
 * that no card in this hobby documents, and the bulk preload settles the
 * argument in practice: Lahman's earliest league is the National Association
 * in 1871, and nflverse starts at 1920. Nothing the product can actually
 * ingest falls in the gap, so the looser bound bought nothing and cost the
 * two validators their agreement.
 *
 * Deliberately loose all the same. The job of this bound is to reject
 * nonsense — a year of 0, a negative, a mistyped five-digit year — not to
 * encode sport-specific history.
 *
 * Lives in `lib/` rather than `convex/` because a browser bundle imports it:
 * the wizard's year fields validate against it before the round-trip, and
 * `convex/_generated/server` must not be dragged in behind that.
 */
export const MIN_CAREER_YEAR = 1869;

/**
 * The latest year a career stint may name.
 *
 * Next year, not this one: a card printed in the autumn routinely carries the
 * following season, and refusing that would make every editor in the product
 * wrong each winter.
 *
 * A function rather than a constant because it is derived from the clock —
 * a module-level constant would freeze at whatever year the process started,
 * which for a long-lived Convex backend is a bug that surfaces once a year.
 */
export function maxCareerYear(now: Date = new Date()): number {
  return now.getFullYear() + 1;
}

/**
 * NEO-254 — earliest plausible BIRTH year for a player.
 *
 * Deliberately lower than `MIN_CAREER_YEAR`, and it has to be: a man born in
 * 1850 was playing in the 1870s, so a floor that refused him would refuse the
 * very rows the bulk preload is about to create. The two bounds guard
 * different facts, and only one of them is about when professional baseball
 * began.
 *
 * Same job as every other bound here — reject nonsense (a year of 0, a
 * mistyped five-digit year), not adjudicate history.
 */
export const MIN_BIRTH_YEAR = 1850;

/**
 * The latest year a birth year may name: THIS year, not next.
 *
 * The one place where the career bound's "next year" slack would be wrong. A
 * stint can legitimately name the season after this one — an autumn-printed
 * card routinely does — but nobody has been born in a year that has not
 * started.
 */
export function maxBirthYear(now: Date = new Date()): number {
  return now.getFullYear();
}
