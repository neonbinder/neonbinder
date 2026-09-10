/**
 * NEO-254 — one line of career, for telling two players with the same name
 * apart.
 *
 * ## Why this is a shared pure function and not a template in the wizard
 *
 * The review wizard's candidate list is rendered from a string the SERVER
 * built (`entityReviewQueue.enrichment.existingCandidates[].careerSummary`),
 * because drawing it on the client would mean joining every candidate's
 * `teamYears` to `teams` — N round trips to answer "which Bob Allen is this?",
 * on a panel that exists to be read in a second. The Players page, which
 * already holds the team rows it needs, formats the same shape locally. Two
 * call sites, one format: a candidate the operator links from the wizard has
 * to read the same way as the row they then open.
 *
 * Pure, and deliberately in `lib/` rather than `convex/`: a browser bundle
 * imports it, so it must not pull `_generated/server` in behind it.
 */

/**
 * How many teams a summary names before it stops counting.
 *
 * Three is not a display cap so much as a recognition cap. The summary answers
 * one question — "is this the man on the card?" — and that question is settled
 * by the first franchise or two; a twelve-team journeyman rendered in full
 * stops being scannable and starts being a paragraph. The remainder is
 * reported rather than dropped, so nobody reads a truncated career as a
 * complete one.
 */
export const CAREER_SUMMARY_MAX_TEAMS = 3;

/** One stint, already resolved to a team NAME — see `formatCareerSummary`. */
export type CareerSummaryStint = {
  teamName: string;
  fromYear: number;
  toYear?: number;
};

/**
 * "Padres 1982–2001 · Yankees 2003–present +2 more".
 *
 * Renders the stints IN THE ORDER GIVEN. Callers hand this a chronologically
 * sorted list (`sortTeamYears`), and re-sorting here would hide a caller that
 * forgot to — the same reason `sortTeamYears` is called at the write site.
 *
 * Repeated teams are NOT collapsed. A player traded away and re-signed has two
 * stints at one franchise, and that gap is exactly the kind of detail that
 * settles which of two same-named men is on a 1993 card; merging them into one
 * span would state years that never happened.
 *
 * An open-ended stint reads "–present" rather than being left dangling,
 * matching every other career line in the app.
 *
 * Returns "" for a player with no recorded stints. That is a real and common
 * state (a row created from a card and never enriched), and it is the CALLER's
 * job to say so in its own voice — a formatter that invents "No career on
 * file" would put copy in a module nobody would think to look in.
 */
export function formatCareerSummary(
  stints: ReadonlyArray<CareerSummaryStint>,
  options: {
    maxTeams?: number;
    /**
     * Stints the caller KNOWS exist but did not resolve to names.
     *
     * The server builder reads only as many team documents as it can render,
     * because each one is a point lookup and it does this for up to eight
     * candidates at once. Without this it would have to choose between reading
     * a player's whole career just to print a number, and printing a truncated
     * career as if it were complete. Counted into "+N more" alongside the
     * stints that were resolved and then trimmed.
     */
    extra?: number;
  } = {},
): string {
  // Floored at 1: a caller passing 0 or a negative means "as few as possible",
  // and rendering nothing but "+7 more" answers no question at all.
  const shown = Math.max(
    1,
    Math.floor(options.maxTeams ?? CAREER_SUMMARY_MAX_TEAMS),
  );
  const extra = Math.max(0, Math.floor(options.extra ?? 0));
  // Nothing nameable. "+3 more" on its own would be a summary of nothing, so
  // this is the same empty answer as a player with no stints at all — the
  // caller says what an empty career means in its own voice.
  if (stints.length === 0) return "";
  const head = stints
    .slice(0, shown)
    .map((s) => `${s.teamName} ${s.fromYear}–${s.toYear ?? "present"}`)
    .join(" · ");
  const rest = Math.max(0, stints.length - shown) + extra;
  return rest > 0 ? `${head} +${rest} more` : head;
}
