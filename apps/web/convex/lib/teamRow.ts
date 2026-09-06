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
 * by the composed full name via `findTeamByFullName`; they never insert.
 *
 * Pure apart from the `ctx.db` read in `findTeamByFullName`. Imports the
 * verbatim normaliser copy from `entityNearMatch` (parity with
 * `teams.normalizeTeamName` is asserted in `entityNearMatch.test.ts`) so this
 * module stays importable without dragging `teams.ts` and its `_generated`
 * graph into callers.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { teamFullName } from "../../lib/teams/team-name";
import { normalizeEntityName } from "./entityNearMatch";

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
 * The identity lookup every path shares: normalise the incoming full string
 * (a marketplace payload, a Wikidata label, an operator's typed text, or a
 * composed Location + Name) and hit the compound index. Returns the row or
 * null; never inserts.
 */
export async function findTeamByFullName(
  ctx: QueryCtx | MutationCtx,
  sportId: Id<"selectorOptions">,
  fullName: string,
): Promise<Doc<"teams"> | null> {
  const nameNormalized = normalizeEntityName(fullName);
  if (nameNormalized.length === 0) return null;
  return await ctx.db
    .query("teams")
    .withIndex("by_name_normalized_and_sport_id", (q) =>
      q.eq("nameNormalized", nameNormalized).eq("sportId", sportId),
    )
    .first();
}
