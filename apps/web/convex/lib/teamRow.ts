/**
 * NEO-236 — the ONE place a team row's identity fields are derived.
 *
 * Every insert into `teams`, and every write that changes `name` or
 * `location`, goes through `teamRowFields` so the invariant
 *
 *     nameNormalized === normalizeTeamName(teamFullName(row))
 *
 * holds by construction rather than by discipline. A writer that computes
 * `nameNormalized` from `name` alone would silently split "San Diego Padres"
 * into a second row the moment the first one carries a location; the dedup
 * pin test (`convex/teams.dedupPin.test.ts`) greps for exactly that.
 *
 * Team creation takes Location + Name as separate inputs (Jason, 2026-09-05:
 * "We simply shouldn't allow for full string creation"). Automated paths —
 * checklist commit, the BSC team queue, Wikidata career teams — only LOOK UP
 * by the composed full name; they never insert.
 *
 * ## NEO-254 — the name alone is no longer an identity
 *
 * A sport may now hold SEVERAL rows under one name, told apart by their era:
 * identity is `(nameNormalized, sportId, yearsActive.from)`. There are two
 * Winnipeg Jets — 1972-1996, which became the Coyotes and then Utah, and 2011-,
 * the revived name on the old Atlanta Thrashers — and under the old key they
 * folded into one row, so a 1985 card and a 2015 card pointed at the same team.
 *
 * The consequence for this module is that a lookup by name returns a LIST.
 * `findTeamsByFullName` is that lookup; `resolveTeamForSetYear` is the one
 * place a list becomes a single row, and it does so only when the card's own
 * year leaves exactly one candidate. There is deliberately no helper here that
 * takes a name and hands back "the" team — that shape is what bound 1985 cards
 * to a 2011 franchise, and `convex/teams.dedupPin.test.ts` greps to keep it
 * from coming back.
 *
 * A "does this sport hold the name at all" helper was written alongside these
 * and then deleted unused: every caller that looked like it wanted one turned
 * out to need the YEAR too (the career-team staging loop narrows by the stint's
 * own start). Left out on purpose — an existence check that ignores the era is
 * the shape this ticket removed, and having one available invites its return.
 *
 * Pure apart from the `ctx.db` reads. Imports the
 * verbatim normaliser copy from `entityNearMatch` (parity with
 * `teams.normalizeTeamName` is asserted in `entityNearMatch.test.ts`) so this
 * module stays importable without dragging `teams.ts` and its `_generated`
 * graph into callers.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { teamFullName } from "../../lib/teams/team-name";
import { normalizeEntityName } from "./entityNearMatch";
import {
  erasOverlap,
  teamsActiveInYear,
  type TeamEra,
} from "../../lib/teams/team-era";

export type TeamIdentityInput = { name: string; location?: string | null };

export type TeamIdentityFields = {
  name: string;
  location?: string;
  nameNormalized: string;
};

/**
 * Trim both parts, drop an empty location, and derive the dedup key from the
 * COMPOSED full name. Throws on an empty name; callers surface their own
 * user-facing message before reaching here.
 */
export function teamRowFields(input: TeamIdentityInput): TeamIdentityFields {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length === 0) throw new Error("Team name cannot be empty");
  const location = input.location?.trim().replace(/\s+/g, " ") || undefined;
  const fields: TeamIdentityFields = {
    name,
    nameNormalized: normalizeEntityName(teamFullName({ name, location })),
  };
  if (location) fields.location = location;
  return fields;
}

/**
 * How many rows one name may resolve to before the read is cut short.
 *
 * A real franchise name has one era, occasionally two, and three would be
 * remarkable. The cap is not a paging boundary — it is the guard that stops a
 * bad import turning a per-card lookup into an unbounded scan. Deliberately
 * generous, because every consumer branches on none / one / several and a
 * truncated read that still said "several" would reach the same answer.
 */
export const TEAM_ERA_SCAN_LIMIT = 16;

/**
 * Every row this sport holds under `fullName` — the identity lookup all paths
 * share.
 *
 * Returns a LIST, and that is the NEO-254 change. Before it, this took the
 * `.first()` row and handed it back as "the team", which is exactly how a 1985
 * Winnipeg Jets card came to point at the franchise that started in 2011. A
 * caller that wants one row must say which year it is asking about — see
 * `resolveTeamForSetYear`.
 *
 * Normalises the incoming full string (a marketplace payload, a Wikidata
 * label, an operator's typed text, or a composed Location + Name) and hits the
 * compound index. Never inserts.
 */
export async function findTeamsByFullName(
  ctx: QueryCtx | MutationCtx,
  sportId: Id<"selectorOptions">,
  fullName: string,
): Promise<Doc<"teams">[]> {
  const nameNormalized = normalizeEntityName(fullName);
  if (nameNormalized.length === 0) return [];
  return await ctx.db
    .query("teams")
    .withIndex("by_name_normalized_and_sport_id", (q) =>
      q.eq("nameNormalized", nameNormalized).eq("sportId", sportId),
    )
    .take(TEAM_ERA_SCAN_LIMIT);
}

/** What resolving a card's team name concluded. */
export type TeamNameResolution = {
  /**
   * The one row this card means, or null when a human has to decide. Null
   * covers both "we hold no such team" and "we hold several and the year did
   * not separate them"; `candidates` tells them apart.
   */
  teamId: Id<"teams"> | null;
  /**
   * Every row under the name, unnarrowed — what a review panel lists so the
   * operator can pick an era. Empty when the name is genuinely unknown.
   */
  candidates: Doc<"teams">[];
};

/**
 * NEO-254 — the ONE place a card's team name becomes a team id.
 *
 * The team counterpart of `players.narrowSameNamePlayersByCardYear`, and it
 * follows the same rules for the same reasons:
 *
 * 1. **One row is the row — unless its era rules the card out.** A single
 *    match used never to be a question, and for an UNDATED row it still is not:
 *    unknown years cannot contradict anything. But a lone row dated 2011- is
 *    positive evidence that a 1985 card does NOT mean it, and linking anyway is
 *    the same wrong answer this function exists to stop — just harder to see,
 *    because there is no second row to make the mistake obvious. So a dated
 *    lone row whose era excludes the set year returns `null`, with itself as
 *    the candidate: we hold a Winnipeg Jets, it is not this one, and a human
 *    decides whether the other era needs creating.
 * 2. **No set year → nothing is narrowed.** The year is the evidence; with
 *    none, several rows stay several and the name goes to a human. Never the
 *    first row an index returned.
 * 3. **Survivors are the rows whose era covers the year**, and a row with NO
 *    era is never excluded — see `lib/teams/team-era.ts`. Unknown is not
 *    absent.
 * 4. **Exactly one survivor wins; anything else is review.** The product
 *    invariant's card-number rule (#7) applied to team names: never key logic
 *    on a value that is not unique without an exactly-one guard.
 *
 * There is no team-name tie-breaker equivalent to the player narrowing's
 * "which team is printed on the card", because the team name IS the thing being
 * resolved. When the year cannot separate two eras, nothing else on the card
 * can either.
 */
export async function resolveTeamForSetYear(
  ctx: QueryCtx | MutationCtx,
  sportId: Id<"selectorOptions">,
  fullName: string,
  setYear: number | undefined,
): Promise<TeamNameResolution> {
  const candidates = await findTeamsByFullName(ctx, sportId, fullName);
  if (candidates.length === 0) return { teamId: null, candidates };
  // Rule 1 — and `teamsActiveInYear` is what encodes both halves of it: an
  // undated row survives every year, a dated one only its own. Running it over
  // a single candidate rather than short-circuiting is what makes the lone
  // dated row obey the same rule as a row with rivals.
  const survivors = teamsActiveInYear(candidates, setYear);
  return {
    teamId: survivors.length === 1 ? survivors[0]._id : null,
    candidates,
  };
}

/**
 * The rows this one would collide with — same name, overlapping era.
 *
 * The identity check for a WRITE, as opposed to `resolveTeamForSetYear`'s check
 * for a read. Two rows may share a name as long as their eras are disjoint;
 * `erasOverlap` treats an undated side as unknown and therefore as colliding,
 * which is the safe direction for a refusal (see `lib/teams/team-era.ts`).
 *
 * `excludeId` is the row being edited, which must not collide with itself.
 */
export async function findCollidingTeams(
  ctx: QueryCtx | MutationCtx,
  sportId: Id<"selectorOptions">,
  fullName: string,
  yearsActive: TeamEra | undefined,
  excludeId?: Id<"teams">,
): Promise<Doc<"teams">[]> {
  const rows = await findTeamsByFullName(ctx, sportId, fullName);
  return rows.filter(
    (row) =>
      row._id !== excludeId && erasOverlap(row.yearsActive, yearsActive),
  );
}
