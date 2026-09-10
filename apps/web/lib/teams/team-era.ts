/**
 * NEO-254 — a team's ERA, and what it is allowed to decide.
 *
 * ## Why a team name is no longer unique in a sport
 *
 * Jason, at the hockey checkpoint: "lets fix the lineage issue now … when we
 * are done loading, all of the data is correct."
 *
 * There are two Winnipeg Jets. The first played 1972-1996 and became the
 * Phoenix Coyotes and then Utah; the second is the 2011 Atlanta Thrashers
 * under a revived name. They are different franchises, different players and
 * different cards, and under the NEO-236 key `(nameNormalized, sportId)` they
 * folded into one row — so a 1985 Jets card and a 2015 Jets card pointed at the
 * same team. The Browns/Ravens split and the Charlotte/New Orleans Hornets do
 * the same thing in other sports.
 *
 * Identity therefore becomes `(nameNormalized, sportId, yearsActive.from)`.
 * The name still does the finding; the ERA is what tells two findings apart.
 *
 * ## What this module is for
 *
 * The era arithmetic, and nothing else. Pure — no Convex imports, no I/O — for
 * the same reason `lib/teams/team-name.ts` is: it is read by Convex functions,
 * by React components and by tests in three environments, and a
 * `_generated/server` import here would break the client build.
 *
 * ## The one rule that matters more than the arithmetic
 *
 * **A row with no `yearsActive` is never excluded.** Not by the card-year
 * narrowing, not by the overlap check. "We have not recorded this team's years"
 * and "this team was not active then" are different facts, and every path here
 * treats the first as unknown rather than as no. The consequence is deliberate
 * and it is the safe direction: an undated row keeps a card name ambiguous and
 * sends it to a human, instead of being quietly ruled out so that some other
 * era can win by default.
 *
 * That mirrors the player side exactly — see `lib/players/career-span.ts`,
 * where a player with no stints has no span and is never filtered out.
 */

/** A team's lifespan. `to` absent means "still going". */
export type TeamEra = { from: number; to?: number };

/** The minimum a row must expose for the era helpers. */
export type TeamEraRow = { yearsActive?: TeamEra };

/**
 * "1972–1996", "2011–present", or "" for a team nobody has dated.
 *
 * An en dash, not a hyphen: this is a range, and it is rendered beside team
 * names in pickers and candidate lists where the distinction is the whole
 * point of the label.
 */
export function eraLabel(years: TeamEra | undefined): string {
  if (!years) return "";
  return `${years.from}–${years.to ?? "present"}`;
}

/**
 * Does this row's era contain `year`?
 *
 * `true` for a row with no era at all — see the module note. That is what makes
 * this safe to use as a filter: it removes rows KNOWN to be wrong and never
 * rows merely unproven.
 *
 * No tolerance window, unlike the player narrowing's `CARD_YEAR_TOLERANCE`. A
 * career span is assembled from stints that may be missing their first or last
 * season, so it needs slack; a franchise's `yearsActive` is a single recorded
 * fact about when the team existed, and widening it would let a 1996 Jets card
 * match the 1997 team that did not exist yet.
 */
export function eraCoversYear(
  years: TeamEra | undefined,
  year: number,
): boolean {
  if (!years) return true;
  if (year < years.from) return false;
  return years.to === undefined || year <= years.to;
}

/**
 * Could these two eras be the same team's?
 *
 * Two closed spans overlap when each starts no later than the other ends; an
 * open `to` runs forever. Either side being undated returns `true` — unknown,
 * so not ruled out.
 *
 * This is the collision test, not the narrowing test, and the asymmetry is
 * deliberate. `eraCoversYear` decides which row a CARD means and errs toward
 * asking a human. This decides whether two ROWS are the same team and errs
 * toward refusing the write: an operator renaming a row onto an undated
 * same-name row is told to go and look, rather than being allowed to create the
 * second Winnipeg Jets this ticket exists to keep apart.
 */
export function erasOverlap(
  a: TeamEra | undefined,
  b: TeamEra | undefined,
): boolean {
  if (!a || !b) return true;
  return a.from <= (b.to ?? Infinity) && b.from <= (a.to ?? Infinity);
}

/**
 * The rows a card from `year` could be naming.
 *
 * Returns every row when `year` is undefined: with no evidence nothing is
 * narrowed, which is rule 1 of the player narrowing restated. The caller then
 * sees "more than one" and sends the name to review, rather than picking.
 */
export function teamsActiveInYear<T extends TeamEraRow>(
  rows: readonly T[],
  year: number | undefined,
): T[] {
  if (year === undefined || !Number.isInteger(year)) return [...rows];
  return rows.filter((row) => eraCoversYear(row.yearsActive, year));
}

/**
 * The row a still-running dataset means: the one whose era is open, or which
 * has no era at all.
 *
 * `seedTeamColors` is the caller. Its dataset carries CURRENT franchises with
 * no years on them, so among two Winnipeg Jets it means the 2011 one — and
 * "the one that has not ended" is the only honest way to say that from the
 * data. Returns null when several rows are open, which the seed treats as
 * "leave them all alone": a colour is not worth guessing an era for.
 */
export function currentEraTeam<T extends TeamEraRow>(
  rows: readonly T[],
): T | null {
  if (rows.length === 1) return rows[0];
  const open = rows.filter(
    (row) => row.yearsActive === undefined || row.yearsActive.to === undefined,
  );
  return open.length === 1 ? open[0] : null;
}

/**
 * "San Diego Padres · 1969–present" — a team named the way a picker has to name
 * it once two rows can share the name.
 *
 * The era is appended only when the row HAS one: "Winnipeg Jets · " with
 * nothing after it reads as a rendering bug, and an undated row is common
 * enough that it must look deliberate.
 */
export function teamOptionLabel(
  fullName: string,
  years: TeamEra | undefined,
): string {
  const era = eraLabel(years);
  return era ? `${fullName} · ${era}` : fullName;
}
