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
 * ## NEO-284 — a name is answered by the row's name OR one of its aliases
 *
 * `findTeamsByFullName` now UNIONS two legs: the primary-name index on
 * `teams` and the flat `teamAliases` index (see the schema note on that
 * table). An alias hit joins the candidate set on equal footing — it is not a
 * fallback and it does not outrank a primary hit — because everything
 * downstream branches on the SIZE of the set: one row links silently, several
 * is a question for a human, and the era narrowing runs over whatever is
 * here. A string that is row A's name and row B's alias is therefore two
 * candidates, and the wizard asks; the same rule `players.sameNamePlayers`
 * applies. The two legs are exported separately only for the loader
 * (`convex/bulkLoad.ts`), which has to report HOW a row matched.
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
  pickTeamForYear,
  type TeamEra,
  type TeamEraPickOptions,
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
 * The rows whose PRIMARY name is `fullName` — the name leg on its own.
 *
 * Normalises the incoming full string (a marketplace payload, a Wikidata
 * label, an operator's typed text, or a composed Location + Name) and hits the
 * compound index. Never inserts.
 *
 * NEO-284: this was the whole of `findTeamsByFullName` before aliases; it is
 * exported because the NCAA/ABL loader reports whether a row matched on its
 * name or on an alias and so reads the two legs separately. Every OTHER caller
 * wants the union below — a lookup that sees only the name leg silently
 * re-parks every alias the operator has already taught the row.
 *
 * NEO-296: `limit` narrows the window; see `findTeamsByFullName`. One indexed
 * read either way — this leg is 1 system op whatever it returns.
 */
export async function findTeamsByExactName(
  ctx: QueryCtx | MutationCtx,
  sportId: Id<"selectorOptions">,
  fullName: string,
  limit: number = TEAM_ERA_SCAN_LIMIT,
): Promise<Doc<"teams">[]> {
  const nameNormalized = normalizeEntityName(fullName);
  if (nameNormalized.length === 0) return [];
  return await ctx.db
    .query("teams")
    .withIndex("by_name_normalized_and_sport_id", (q) =>
      q.eq("nameNormalized", nameNormalized).eq("sportId", sportId),
    )
    .take(Math.min(limit, TEAM_ERA_SCAN_LIMIT));
}

/**
 * NEO-284 — the rows that hold `fullName` as an ALIAS. The alias leg on its own.
 *
 * One indexed read of the flat `teamAliases` table under the same
 * token-sorted key the name leg uses, then a `db.get` per hit. A side row whose
 * team is gone, or whose team's `sportId` no longer agrees, is stale index
 * residue rather than a candidate: it cannot be cleaned up from a query
 * context, and leaving it out is the whole of the correction a reader needs
 * (the same rule `players.sameNamePlayers` applies to `playerAliases`).
 *
 * Capped at `TEAM_ERA_SCAN_LIMIT` like the name leg, and for the same reason:
 * every consumer branches on none / one / several.
 *
 * NEO-296: this is the leg with the fan-out. The indexed read is one system op
 * whatever it returns; the `db.get` per holder is the cost, so `limit` bounds
 * the GETS. See `findTeamsByFullName` for when a caller narrows it.
 */
export async function findTeamsByAlias(
  ctx: QueryCtx | MutationCtx,
  sportId: Id<"selectorOptions">,
  fullName: string,
  limit: number = TEAM_ERA_SCAN_LIMIT,
): Promise<Doc<"teams">[]> {
  const aliasNormalized = normalizeEntityName(fullName);
  if (aliasNormalized.length === 0) return [];
  const aliasRows = await ctx.db
    .query("teamAliases")
    .withIndex("by_alias_normalized_and_sport_id", (q) =>
      q.eq("aliasNormalized", aliasNormalized).eq("sportId", sportId),
    )
    .take(TEAM_ERA_SCAN_LIMIT);
  const out: Doc<"teams">[] = [];
  const seen = new Set<string>();
  for (const row of aliasRows) {
    // NEO-296: `limit` bounds the `db.get`s, which is where this leg's cost
    // is — the indexed read above is ONE system op whatever it returns. The
    // dedup below happens BEFORE the get, so a duplicate side row can never
    // consume part of the budget and hide a second holder behind itself.
    if (out.length >= limit) break;
    // Two side rows for one team under one key cannot be written by
    // `syncTeamAliases`, but a reader that trusted that would double-count a
    // legacy row, and double-counting is exactly what turns "one" into "ask".
    if (seen.has(row.teamId)) continue;
    seen.add(row.teamId);
    const team = await ctx.db.get(row.teamId);
    if (team && team.sportId === sportId) out.push(team);
  }
  return out;
}

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
 * NEO-284: the UNION of the name leg and the alias leg, deduped by `_id` (a
 * row whose alias and primary name both normalise to the query is one
 * candidate, not two — the writer drops an own-name alias, so this is belt
 * and braces against a legacy row) and capped at `TEAM_ERA_SCAN_LIMIT`.
 * Alias hits are not ranked below name hits: the consumers of this list count
 * it, and an alias that quietly won would skip the exactly-one guard that
 * keeps a shared string from binding a card to the wrong row. See the module
 * header. Never inserts.
 *
 * ── NEO-296: `limit`, for a caller that only needs to COUNT to two ──────────
 *
 * Convex charges one system op per call, so one of these lookups is 1 op for
 * the name leg, 1 for the alias leg, and one `db.get` per holder the alias leg
 * resolves — up to 18 with the default window. A caller that loops this over a
 * list pays that per entry, which is how `teams.resolveNames` reached ~1,152
 * ops for one player's career teams.
 *
 * A consumer that only branches on none / one / several does not need 16
 * candidates to reach its answer; it needs two. `limit` is that window, and at
 * 2 the lookup is at most 4 ops with no change to what any such consumer
 * concludes — "several" is settled by the second row, exactly as
 * `TEAM_ERA_SCAN_LIMIT`'s own note says.
 *
 * It is NOT for a caller that shows the candidates: a review panel listing
 * eras, `resolveTeamForSetYear`, `nearMatches` and the loaders all take the
 * default and must keep taking it. Narrowing the window there would shrink the
 * list an operator is choosing from. The default is unchanged, so every
 * existing caller reads exactly what it read before.
 */
export async function findTeamsByFullName(
  ctx: QueryCtx | MutationCtx,
  sportId: Id<"selectorOptions">,
  fullName: string,
  limit: number = TEAM_ERA_SCAN_LIMIT,
): Promise<Doc<"teams">[]> {
  const window = Math.min(limit, TEAM_ERA_SCAN_LIMIT);
  const byName = await findTeamsByExactName(ctx, sportId, fullName, window);
  if (byName.length >= window) return byName;
  const byAlias = await findTeamsByAlias(ctx, sportId, fullName, window);
  if (byAlias.length === 0) return byName;
  const seen = new Set<string>(byName.map((row) => row._id));
  const merged = [...byName];
  for (const row of byAlias) {
    if (merged.length >= window) break;
    if (seen.has(row._id)) continue;
    seen.add(row._id);
    merged.push(row);
  }
  return merged;
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
 * NEO-254 — the ONE place a team name off a card or a career stint becomes a
 * team id.
 *
 * The team counterpart of `players.narrowSameNamePlayersByCardYear`, and it
 * follows the same rules for the same reasons:
 *
 * 1. **One row is the row — a card can show a team's past, never its
 *    future.** Jason, 2026-09-25 (NEO-307): "a card can show a team's past,
 *    never its future." A single match used never to be a question, and for an
 *    UNDATED row it still is not: unknown years cannot contradict anything.
 *    A lone dated row answers for every year its era covers — and, for a CARD
 *    caller that passes `{ allowPastEra: true }`, every year after it ended:
 *    a 2026 Donruss Brooklyn Dodgers card is a retro card of the 1911–1957
 *    row, and refusing it raised a New Team step for a team we already hold.
 *    What a lone row never answers for is a year BEFORE its era began: a row
 *    dated 2011- is positive evidence that a 1985 card does NOT mean it, so
 *    that returns `null` with itself as the candidate — we hold a Winnipeg
 *    Jets, it is not this one, and a human decides whether the other era needs
 *    creating. The past-era link is logged as `team_linked_past_era`.
 *
 *    The allowance is opt-in because this function also answers for career
 *    STINTS, whose year is a season the player actually played. Nobody plays
 *    for a team after it folds, so a 2015 "Winnipeg Jets" stint with only the
 *    1972–1996 row held must stay a question, not link to the wrong
 *    franchise. A caller passing a stint's year leaves `allowPastEra` off.
 *    The rule lives in `pickTeamForYear` (`lib/teams/team-era.ts`); callers
 *    choose the mode and never restate it.
 * 2. **No set year → nothing is narrowed.** The year is the evidence; with
 *    none, several rows stay several and the name goes to a human. Never the
 *    first row an index returned.
 * 3. **Survivors are the rows whose era covers the year**, and a row with NO
 *    era is never excluded — see `lib/teams/team-era.ts`. Unknown is not
 *    absent.
 * 4. **Exactly one survivor wins; anything else is review.** The product
 *    invariant's card-number rule (#7) applied to team names: never key logic
 *    on a value that is not unique without an exactly-one guard. Rule 1's
 *    past-era allowance does NOT reach this case: two closed eras both before
 *    the set year are two franchises a retro card could equally mean, and
 *    picking one is a guess.
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
  /**
   * NEO-307 — `{ allowPastEra: true }` ONLY when `setYear` is a card's set
   * year. Omitted for a career stint's year. See rule 1 above.
   */
  options: TeamEraPickOptions = {},
): Promise<TeamNameResolution> {
  const candidates = await findTeamsByFullName(ctx, sportId, fullName);
  if (candidates.length === 0) return { teamId: null, candidates };
  // Rules 1-4 — all of them in `pickTeamForYear`, which reads the eras and
  // nothing else. Running it over a single candidate rather than
  // short-circuiting is what makes a lone dated row obey its era: covered
  // links, past links only for a card caller, future never does.
  const pick = pickTeamForYear(candidates, setYear, options);
  if (pick?.pastEra) {
    /*
     * NEO-307 — the one link this function makes OUTSIDE a row's era, so it
     * is the one worth being able to find afterwards. Ids and years only: the
     * string that found the row came off a checklist, and the id is what an
     * operator looks up.
     */
    console.log(
      JSON.stringify({
        msg: "team_linked_past_era",
        sportId,
        teamId: pick.row._id,
        setYear,
        eraFrom: pick.row.yearsActive?.from,
        eraTo: pick.row.yearsActive?.to,
      }),
    );
  }
  return { teamId: pick ? pick.row._id : null, candidates };
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
