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
 *
 * ## …and the one direction a lone row may be out of its era (NEO-307)
 *
 * Jason, 2026-09-25: "a card can show a team's past, never its future." A
 * retro card of a team that folded is still that team's card, so a LONE dated
 * row answers for a SET year after its era ended — and never for one before
 * it began. A career stint's year gets no such allowance: nobody plays for a
 * team after it folds. `pickTeamForYear` is where that is decided, opt-in per
 * caller; the filters below stay strict, because between SEVERAL rows a closed
 * era is still no answer.
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
 * What `pickTeamForYear` concluded: the row, and whether it won only because a
 * card may show a team's PAST.
 */
export type TeamEraPick<T> = { row: T; pastEra: boolean };

/** How `pickTeamForYear` may read a year. */
export type TeamEraPickOptions = {
  /**
   * NEO-307 — `true` only when `year` is a CARD's (set) year. A card can show
   * a team's past; a career stint cannot be after its team folded, so a stint
   * caller leaves this off and a lone row outside its era stays a question.
   * Off by default: a new caller has to decide which kind of year it holds.
   */
  allowPastEra?: boolean;
};

/**
 * NEO-254 + NEO-307 — which of a name's rows `year` means, or `null` when a
 * human has to decide.
 *
 * ## Rule 1: a card can show a team's past, never its future
 *
 * Jason, 2026-09-25: "a card can show a team's past, never its future."
 *
 * A 2026 Donruss card of the Brooklyn Dodgers is a retro card. It is still a
 * Brooklyn Dodgers card, and when the sport holds exactly one row under that
 * name — dated 1911–1957 — that row is the one it means. Refusing it (the
 * NEO-254 behaviour) raised a New Team step for a team we already hold.
 *
 * The other direction is still a refusal. A 1985 card cannot show a team that
 * did not exist until 2011, so a lone Winnipeg Jets row dated 2011– is
 * positive evidence the card means some other Jets, and the answer is `null`:
 * we hold a Winnipeg Jets, it is not this one, and a human decides whether the
 * earlier era needs creating.
 *
 * The allowance is a CARD rule, so it is opt-in (`allowPastEra`). A career
 * stint is a season a player actually played: a 2015 stint at "Winnipeg Jets"
 * cannot mean the 1972–1996 franchise, so with only that row held the stint
 * gets a step to create the 2011 era rather than a link to the wrong one.
 *
 * In full:
 *
 * - **One row, and its era covers the year (or it has none)** → that row.
 *   Unknown years cannot contradict anything.
 * - **One row, and the year is after its era ended** → with `allowPastEra`,
 *   that row with `pastEra: true` (the card shows the team's past); without
 *   it, `null`.
 * - **One row, and the year is before its era began** → `null`. Nothing shows
 *   a team's future.
 * - **Several rows** → the one whose era covers the year, when exactly one
 *   does; otherwise `null`, whatever `allowPastEra` says. Two closed eras both
 *   before the year are two franchises a retro card could equally mean, and
 *   choosing between them is a guess. Never guess.
 * - **No year** → nothing is narrowed, so one row is the row and several are
 *   a question. See `teamsActiveInYear`.
 *
 * Pure and era-only by design. It reads `yearsActive` and nothing else — never
 * a name, never a marketplace value — so what the card said has already done
 * its only job (finding the candidates) before this runs.
 */
export function pickTeamForYear<T extends TeamEraRow>(
  rows: readonly T[],
  year: number | undefined,
  options: TeamEraPickOptions = {},
): TeamEraPick<T> | null {
  const survivors = teamsActiveInYear(rows, year);
  if (survivors.length === 1) return { row: survivors[0], pastEra: false };
  if (survivors.length > 0 || rows.length !== 1) return null;
  if (!options.allowPastEra) return null;
  // Exactly one row and its era excludes the year — which can only happen when
  // the year is an integer and the row is dated. Past, or future?
  const lone = rows[0];
  const end = lone.yearsActive?.to;
  if (year !== undefined && end !== undefined && year > end) {
    return { row: lone, pastEra: true };
  }
  return null;
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
