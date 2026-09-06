import { query, mutation, internalMutation, internalQuery, action } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import { getCurrentUserId, requireAdmin, requireSignedIn } from "./auth";
import type { Doc, Id } from "./_generated/dataModel";
import {
  longestToken,
  nameTokens,
  // NEO-254: `undatedCareerTeams` holds TEAM names, so it dedupes on the key
  // `teams` dedupes on — and this IS that key (`teams.normalizeTeamName` is the
  // same function). Imported from here rather than from `./teams`, which
  // already imports `normalizePlayerName` from this file: a cycle between two
  // Convex modules is not worth a shorter import path.
  normalizeEntityName,
  rankPlayerCandidates,
} from "./lib/entityNearMatch";
import { sortTeamYears } from "../lib/players/team-tenure";
import {
  CAREER_SUMMARY_MAX_TEAMS,
  formatCareerSummary,
  type CareerSummaryStint,
} from "../lib/players/career-summary";
// NEO-212 security review: `Q<digits>` is validated in exactly one place now.
// See lib/players/wikidata-id.ts for why the render sites needed a chokepoint
// they could share with the write path.
import { isWikidataQid } from "../lib/players/wikidata-id";
// NEO-251: one home for the bound — shared with the SportLots parser and the
// pairing modal's roster field. See the note on the re-export below.
import {
  MAX_PLAYER_NAME_LENGTH,
  PLAYER_AMBIGUITY_SCAN_LIMIT,
} from "../lib/players/name-limits";
// NEO-254 — this file used to carry its own 1850 while
// `entityReviewQueue.recordDecision` refused anything under 1869. Both guard
// `players.teamYears`, so a stint was storable through one editor and refused
// by the other. One constant now; see lib/players/career-years.ts for why the
// answer is 1869.
import {
  MIN_BIRTH_YEAR,
  MIN_CAREER_YEAR,
  maxBirthYear,
  maxCareerYear,
} from "../lib/players/career-years";

/**
 * Lowercase + collapse whitespace + strip punctuation + token-sort. Used
 * as the dedup key on `players.nameNormalized`. Token-sorting "Smith,
 * John" and "John Smith" to the same key prevents marketplace formatting
 * differences from creating duplicate player rows.
 */
export function normalizePlayerName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,'"`’]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

/**
 * One career stint: a player on a team from `fromYear` until `toYear`
 * (open-ended while they are still there). Mirrors the `players.teamYears`
 * element shape in the schema.
 */
export type PlayerTeamYear = {
  teamId: Id<"teams">;
  fromYear: number;
  toYear?: number;
};

/**
 * Players are intentionally globally-shared rows: a single (name, sport)
 * key resolves to the same `players._id` regardless of which user added
 * it first. Mike Trout is Mike Trout. Do NOT add per-user fields to this
 * table — push user-specific data (notes, watchlist, etc.) onto separate
 * per-user join tables instead.
 *
 * `createdByUserId` is kept for audit only and MUST NOT appear in
 * client-facing query responses. Using `playerDocValidator` (with the
 * field) is reserved for `internalQuery`/`internalMutation`; the public
 * `query`s use `playerDocPublicValidator`. Leaking `createdByUserId`
 * into the client response would let any user enumerate which Clerk
 * subject first registered any given player — a small but real
 * cross-user identity correlation leak.
 */
const playerDocPublicValidator = v.object({
  _id: v.id("players"),
  _creationTime: v.number(),
  name: v.string(),
  nameNormalized: v.string(),
  // NEO-96: reference to the sport-level selectorOptions row.
  sportId: v.id("selectorOptions"),
  teamYears: v.optional(v.array(v.object({
    teamId: v.id("teams"),
    fromYear: v.number(),
    toYear: v.optional(v.number()),
  }))),
  isHallOfFame: v.optional(v.boolean()),
  // NEO-254. `birthYear` is the field that tells two same-name players apart,
  // so it is public: the review wizard's candidate list and the Players page
  // both put it in front of an operator choosing between them. See schema.ts.
  birthYear: v.optional(v.number()),
  // NEO-254 — Wikidata teams nobody has dated yet. Read-only context on the
  // Players page; never career data. See schema.ts.
  undatedCareerTeams: v.optional(v.array(v.string())),
  externalIds: v.optional(v.object({
    wikidataId: v.optional(v.string()),
    // NEO-254 preload linkage. Carried through the public shape only because
    // this validator has to accept every field the row can hold; no UI reads
    // them, and nothing user-facing may key on them.
    lahmanId: v.optional(v.string()),
    nflverseId: v.optional(v.string()),
  })),
  lastUpdated: v.number(),
});

const playerDocValidator = v.object({
  _id: v.id("players"),
  _creationTime: v.number(),
  name: v.string(),
  nameNormalized: v.string(),
  // NEO-96: reference to the sport-level selectorOptions row.
  sportId: v.id("selectorOptions"),
  teamYears: v.optional(v.array(v.object({
    teamId: v.id("teams"),
    fromYear: v.number(),
    toYear: v.optional(v.number()),
  }))),
  isHallOfFame: v.optional(v.boolean()),
  birthYear: v.optional(v.number()),
  undatedCareerTeams: v.optional(v.array(v.string())),
  externalIds: v.optional(v.object({
    wikidataId: v.optional(v.string()),
    lahmanId: v.optional(v.string()),
    nflverseId: v.optional(v.string()),
  })),
  createdByUserId: v.optional(v.string()),
  lastUpdated: v.number(),
});

/**
 * Strip the audit-only `createdByUserId` field from a player document
 * before returning it to a public query handler. See the comment on
 * `playerDocPublicValidator` for rationale.
 */
function toPublicPlayer<T extends { createdByUserId?: string }>(doc: T): Omit<T, "createdByUserId"> {
  // Destructure to peel off createdByUserId — `_` is the discarded slot,
  // explicitly marked unused for the linter.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { createdByUserId: _omit, ...rest } = doc;
  return rest;
}

/**
 * Look up THE player with this sport + normalized name, or null.
 *
 * Public query — `createdByUserId` is omitted from the response.
 *
 * ## NEO-254 — null now means "not exactly one", not "not found"
 *
 * `(nameNormalized, sportId)` is a dedup key, not a unique one. This used to
 * `.collect()` the whole cross-sport `by_name_normalized` index and hand back
 * `.find(...)` — the first row of however many shared the name, presented to
 * every caller as though it were the only one. That is the same coin flip the
 * write paths in this file were carrying, and it is worse here, because the
 * shape of the answer (`player | null`) actively tells the caller there was
 * nothing to choose between.
 *
 * Two or more matches now return null. The question this query asks is "which
 * player is this name?", and when the answer is "one of these two" there is no
 * honest way to express it in this shape — so it says it does not know, which
 * is true, rather than picking. A caller that needs to tell the two cases
 * apart uses `resolveNameForReview`, whose `matchCount` was added for exactly
 * that and which is what the review gate now calls.
 *
 * Also narrowed to the compound index: a common surname matches in every sport
 * we track, and collecting all of them to throw most away was a read the
 * narrow index makes unnecessary.
 */
export const findByNameAndSport = query({
  args: {
    name: v.string(),
    sportId: v.id("selectorOptions"),
  },
  returns: v.union(playerDocPublicValidator, v.null()),
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
    const normalized = normalizePlayerName(args.name);
    if (!normalized) return null;
    const matches = await sameNamePlayers(ctx, normalized, args.sportId);
    return matches.length === 1 ? toPublicPlayer(matches[0]) : null;
  },
});

/**
 * NEO-254 — re-exported from `lib/players/name-limits.ts`, which is where it
 * has to live: the review wizard's candidate panel reads it too, and that is a
 * browser bundle. Same split, same reasoning as `MAX_PLAYER_NAME_LENGTH`
 * above.
 */
export { PLAYER_AMBIGUITY_SCAN_LIMIT } from "../lib/players/name-limits";

/**
 * NEO-254 — the rows already filed under this exact dedup key, capped.
 *
 * ## Why this is not `.first()`
 *
 * `(nameNormalized, sportId)` is a DEDUP key, not a UNIQUE key: nothing in the
 * schema stops a second "Bob Allen" from existing, and after the bulk preload
 * (plan decision 3) a great many of them do — same name, same sport, different
 * people. Every caller in this file used to take the first row the index
 * returned and treat it as *the* player, which silently attached one man's
 * cards to another man's row and gave the operator no clue it had happened.
 *
 * The rule this enables is the same one the card-number invariant states:
 * never key logic on a value that is not unique without an exactly-one guard.
 * Zero rows and one row keep behaving exactly as they always did; two or more
 * is a question for a human, and every caller here raises it as one.
 */
async function sameNamePlayers(
  ctx: QueryCtx | MutationCtx,
  nameNormalized: string,
  sportId: Id<"selectorOptions">,
): Promise<Array<Doc<"players">>> {
  return await ctx.db
    .query("players")
    .withIndex("by_name_normalized_and_sport_id", (q) =>
      q.eq("nameNormalized", nameNormalized).eq("sportId", sportId),
    )
    .take(PLAYER_AMBIGUITY_SCAN_LIMIT);
}

/**
 * NEO-254 — refuse a birth year that cannot be one.
 *
 * Shared by the three write paths that accept one (`findOrCreate`,
 * `createByAdmin`, `savePlayerFields`) so they cannot disagree about what
 * the column holds — the same drift the two career-year floors had before
 * `lib/players/career-years.ts` existed.
 *
 * The refusal carries the value, which is both safe and useful here: it is a
 * NUMBER the operator just typed, not a name, so there is nothing in it to
 * leak, and seeing it back is how they spot the transposed digits.
 */
function assertBirthYear(birthYear: number): void {
  const maxYear = maxBirthYear();
  if (
    !Number.isInteger(birthYear) ||
    birthYear < MIN_BIRTH_YEAR ||
    birthYear > maxYear
  ) {
    throw new ConvexError(
      `A birth year must be a whole year between ${MIN_BIRTH_YEAR} and ${maxYear}.`,
    );
  }
}

/**
 * NEO-254 — is this name a question rather than a lookup?
 *
 * True when two or more `players` rows already share it in this sport. The
 * LIVE answer, read from the index at the moment it is asked — deliberately
 * not the stored `enrichment.existingCandidates` marker, which is only as good
 * as the moment it was written.
 *
 * That distinction is the whole reason this exists. The marker is attached
 * when a review row is enqueued and refreshed when its lookup lands, and
 * between those two points a preload run, another operator's commit, or a
 * merge can turn an ordinary name into an ambiguous one. Anything that would
 * CREATE a row off the back of "this name is fine" has to ask the index, not
 * the marker — otherwise a bulk action mints a duplicate for a name that
 * became ambiguous five seconds ago, which is the failure this ticket is
 * about, arriving one deploy later.
 */
export async function isAmbiguousPlayerName(
  ctx: QueryCtx | MutationCtx,
  name: string,
  sportId: Id<"selectorOptions">,
): Promise<boolean> {
  const normalized = normalizePlayerName(name);
  if (!normalized) return false;
  return (await sameNamePlayers(ctx, normalized, sportId)).length > 1;
}

/**
 * NEO-254 — pick the one candidate a birth year identifies, if it identifies
 * exactly one.
 *
 * A birth year is the only thing on a player row that reliably separates two
 * people with one name, which is why the preload writes it. It disambiguates
 * only when it is DECISIVE: two rows sharing both the name and the year are
 * still a question, and a year that matches nothing is not evidence that the
 * caller means a new person — the existing rows may simply predate the column.
 * Both of those return null, and the caller refuses rather than guessing.
 */
function candidateForBirthYear(
  candidates: ReadonlyArray<Doc<"players">>,
  birthYear: number | undefined,
): Doc<"players"> | null {
  if (birthYear === undefined) return null;
  const hits = candidates.filter((p) => p.birthYear === birthYear);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * NEO-254 — adopt one of these rows, fork a new one, or refuse: the decision
 * `createByAdmin` makes, and ONLY `createByAdmin`.
 *
 * Returns the row to adopt, `null` to insert a new one, or throws when the
 * question cannot be answered from what is on file.
 *
 * ## Why this differs from `findOrCreate`
 *
 * `findOrCreate` backs the pickers, whose job is to LINK a card to a player.
 * One match there is an answer and it adopts, full stop — a picker that forked
 * a second row because a birth year disagreed would mint duplicates from a
 * typo, in a control the operator uses hundreds of times a session.
 *
 * `createByAdmin` backs the Player Management add form, whose job is to CREATE.
 * That form has already shown the operator the row they are about to duplicate
 * — the near-match panel promotes "Open {name}" to the primary — and creation
 * only happens if they then press "Create anyway". So a birth year arriving
 * here is not a hint, it is the operator saying "I have seen that row, and this
 * is a different man born in {year}". Adopting anyway made that button unable
 * to do what it says, and left plan decision 3's identity rule (a distinct
 * birth year means a distinct person) unreachable from the UI: the "Same name,
 * different people" panel could only ever be produced by the preload.
 *
 * ## An ABSENT year on the candidate counts as different
 *
 * One candidate, no `birthYear` on it, and the operator explicitly asks to
 * create anyway with 1975. It would be possible to read that as "the row you
 * already have is probably this man, we just never recorded his year" — but
 * that reading discards an explicit human gesture in favour of a guess about a
 * missing field, on the one screen whose entire purpose is telling same-named
 * people apart. The operator can see the existing row; they pressed the button
 * that says "anyway". So it forks, and the undated row is left exactly as it
 * was.
 *
 * That leniency does NOT extend past one candidate. With several rivals the
 * form offers no way to rule on each, and an undated one could be the very man
 * being added — so any candidate missing a year, with no exact match, is a
 * refusal rather than a fork.
 */
function adoptOrForkOnCreate(
  candidates: ReadonlyArray<Doc<"players">>,
  birthYear: number | undefined,
  name: string,
): Doc<"players"> | null {
  if (candidates.length === 0) return null;

  // The name is what the CALLER typed, so echoing it leaks nothing they do not
  // already hold — unlike the other rows' `createdByUserId`, which is why this
  // counts them rather than listing them.
  const refuse = (): never => {
    throw new ConvexError(
      `${candidates.length} players are already filed under ${name}. Pick the right one instead of adding another.`,
    );
  };

  if (birthYear === undefined) {
    // No tiebreaker offered. One row is the row; several is a question.
    if (candidates.length === 1) return candidates[0];
    return refuse();
  }

  const hits = candidates.filter((p) => p.birthYear === birthYear);
  // Exactly one row IS this man — adopt it, however many rivals there were.
  if (hits.length === 1) return hits[0];
  // Two rows share the name AND the year. The tiebreaker does not tie-break,
  // and forking would add a third indistinguishable row.
  if (hits.length > 1) return refuse();

  // Nothing on file has this year.
  if (candidates.length === 1) return null; // fork — see the note above.
  // Every rival is dated and none of them is this year, so none of them is
  // this man. Anything undated could be, and is not ours to rule out.
  if (candidates.every((p) => p.birthYear !== undefined)) return null;
  return refuse();
}

/**
 * NEO-254 — how many undated Wikidata team names one player row may carry, and
 * how long each may be.
 *
 * Same guard-rail reasoning as `MAX_PLAYER_TEAM_YEARS` below: an array written
 * from an upstream payload reaches a globally-shared row, and "the operator is
 * an admin" is not the same as "this cannot be driven by a UI bug". The length
 * bound is deliberately generous — the longest real thing this holds is a
 * college programme's full name ("San Diego State Aztecs baseball").
 */
const MAX_UNDATED_CAREER_TEAMS = 64;
const MAX_UNDATED_CAREER_TEAM_NAME_LENGTH = 120;

/**
 * NEO-254 — clean a list of undated career-team names for storage.
 *
 * ## Why this DROPS rather than throws
 *
 * Every other bounded array in this file refuses an over-long input, because
 * every one of them is data. This one is not: a name here is a LEAD — "Wikidata
 * says maybe, nobody has confirmed the years" — and its only job is to survive
 * until a human looks at it. The list is built inside `commitCardChecklist`'s
 * prelude, at the end of a commit that may have written nine hundred cards, so
 * a single freak Wikidata label must not be able to fail that commit. Dropping
 * what cannot be stored and keeping the rest is the outcome that loses least.
 *
 * Truncating an over-long name would be worse than dropping it: a half a team
 * name is a wrong team name, and it would then be shown to an operator as if
 * somebody had meant it.
 *
 * Deduped on the key `teams` itself dedupes on, first spelling winning, then
 * sorted alphabetically so the same lookup reads back the same way twice.
 */
export function normalizeUndatedCareerTeams(
  names: ReadonlyArray<string>,
): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name || name.length > MAX_UNDATED_CAREER_TEAM_NAME_LENGTH) continue;
    const key = normalizeEntityName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(name);
    if (kept.length >= MAX_UNDATED_CAREER_TEAMS) break;
  }
  return kept.sort((a, b) => a.localeCompare(b));
}

/**
 * Bound on a player name — same value and same reasoning as
 * `teams.MAX_TEAM_NAME_LENGTH`. Over-length is refused rather than trimmed:
 * silently storing something other than what was typed is how a mangled name
 * becomes canonical for every listing title and spine label downstream.
 *
 * NEO-251 moved the NUMBER to `lib/players/name-limits.ts` and re-exports it
 * here. It is no longer only an operator-typed bound: the SportLots parser
 * refuses an over-length subject against it, and the pairing modal's custom
 * roster field refuses one too, so an adapter or an operator cannot produce a
 * name the mutations below would then reject at the end of a 900-card commit.
 * Three enforcement points that must not be able to disagree therefore need
 * one home, and it cannot be this file — the modal is a browser bundle and
 * this module pulls in `./_generated/server`.
 */
export { MAX_PLAYER_NAME_LENGTH } from "../lib/players/name-limits";

/**
 * Create-if-missing player by name + sport. Idempotent — calling twice
 * with the same inputs returns the same id.
 *
 * NEO-220 corrected a stale claim here: this is NOT what the checklist
 * commit path calls. `commitCardChecklistFinalize` inserts into `players`
 * directly (see the player loop in `selectorOptions.ts`), already enriched.
 * The ONLY caller of this mutation is `SetSelector/PlayerPicker`'s "+ Create"
 * row, reached from the card drawer, the attention walker's
 * `UnreviewedNameFixer`, and the checklist quick-add form — every one of them
 * under `/admin/set-builder`.
 *
 * Cross-user note: the row this returns may have been created by a
 * different user. That's intentional — see playerDocPublicValidator's
 * docstring. Do NOT add per-user state to the returned row.
 */
export const findOrCreate = mutation({
  args: {
    name: v.string(),
    sportId: v.id("selectorOptions"),
    /**
     * NEO-254 — which of several same-name players the caller means.
     *
     * Consulted ONLY when the name is ambiguous (two or more rows already
     * share it in this sport). With no match it is stored on the new row; with
     * exactly one match it is ignored, because one match was never a question
     * and letting a mistyped year fork a second row would defeat the dedupe
     * this mutation exists for.
     */
    birthYear: v.optional(v.number()),
  },
  returns: v.id("players"),
  handler: async (ctx, args): Promise<Id<"players">> => {
    /**
     * NEO-208 left this at signed-in while raising its `teams.findOrCreate`
     * twin to admin, on the reasoning that this one scheduled no enrichment
     * and so gained no cost vector. NEO-220 gives it that enrichment (below),
     * which retires the reasoning along with the asymmetry.
     *
     * `requireAdmin`, for the two reasons the teams twin already carries:
     * sign-up is open, so "signed in" is not a meaningful bound on who may
     * create globally-shared rows; and the insert branch now enqueues pooled
     * Wikidata work whose CONCURRENCY — not total volume — `wikidataPool`
     * bounds. Nothing legitimate loses access: every caller is
     * `SetSelector/PlayerPicker`, mounted only under `/admin/set-builder`,
     * whose sibling mutations (`addCustomCard`, `updateCard`) are already
     * `requireAdmin` — a non-admin who reached this could create a player but
     * could not attach it to anything.
     */
    const userId = await requireAdmin(ctx);

    const name = args.name.trim();
    if (name.length === 0) {
      throw new ConvexError("A player name is required.");
    }
    if (name.length > MAX_PLAYER_NAME_LENGTH) {
      // The LENGTH, never the name: this string reaches Sentry and the browser
      // console through Convex's error path. Same bound and same reasoning as
      // `createByAdmin` below and `teams.findOrCreate`; over-length is refused
      // rather than trimmed, because silently storing something other than
      // what was typed is how a mangled name becomes canonical.
      throw new ConvexError(
        `A player name is ${name.length} characters; the limit is ${MAX_PLAYER_NAME_LENGTH}.`,
      );
    }

    // `sportId` is a bare `v.id("selectorOptions")` — the validator proves it
    // is an id in that table, not that it points at a SPORT. A player hung off
    // a variantType row is unreachable by `list`, `search` and
    // `findByNameAndSport`, all of which key on the sport row id, so it would
    // be an orphan. Same check `createByAdmin` and `teams.findOrCreate` make.
    const sportRow = await ctx.db.get(args.sportId);
    if (!sportRow || sportRow.level !== "sport") {
      throw new ConvexError("A player must be created under a sport.");
    }

    // NEO-254: refused before it is used to disambiguate OR stored. A bad year
    // that merely failed to match would silently become "no tiebreaker" and
    // the caller would get an ambiguity error naming the wrong problem.
    if (args.birthYear !== undefined) assertBirthYear(args.birthYear);

    const normalized = normalizePlayerName(name);
    /**
     * NEO-254 — the compound index, bounded, instead of `by_name_normalized`
     * collected across every sport and then filtered in memory. Two changes in
     * one: the read is narrow (a common surname matches in every sport we
     * track), and it can SEE that there is more than one match instead of
     * calling `.find` and taking whichever row came back first.
     */
    const candidates = await sameNamePlayers(ctx, normalized, args.sportId);
    // NOT enqueued — see the creation-only note on the insert below.
    if (candidates.length === 1) return candidates[0]._id;
    if (candidates.length > 1) {
      /**
       * NEO-254 — two or more people are already filed under this name, and
       * this mutation has no way to know which one a typeahead meant.
       *
       * Returning the first row is the failure this guard exists to stop: it
       * attaches a card to a player who did not appear on it, silently, and
       * the operator's only clue is a career history that grows a team the man
       * never played for. Refusing is the honest answer — the picker's search
       * already lists both rows, so the way forward is to pick one.
       *
       * A `birthYear` settles it when it is decisive; see
       * `candidateForBirthYear` for why "matches nothing" is not decisive.
       */
      const byBirthYear = candidateForBirthYear(candidates, args.birthYear);
      if (byBirthYear) return byBirthYear._id;
      // The name is what the CALLER typed, so echoing it leaks nothing they do
      // not already hold — unlike the other rows' `createdByUserId`, which is
      // why this counts rather than lists them.
      throw new ConvexError(
        `${candidates.length} players are already filed under ${name}. Pick the right one instead of adding another.`,
      );
    }

    const id = await ctx.db.insert("players", {
      name,
      nameNormalized: normalized,
      sportId: args.sportId,
      ...(args.birthYear !== undefined ? { birthYear: args.birthYear } : {}),
      createdByUserId: userId,
      lastUpdated: Date.now(),
    });

    // An audit trail for a shared-row creation an operator triggers from a
    // typeahead. Structured JSON, not concatenation — the name is operator
    // input and must not be able to shape a log line.
    console.log(
      JSON.stringify({ msg: "player_created", playerId: id, sportId: args.sportId, userId }),
    );

    /**
     * NEO-220 — enrich the player we just INSERTED, and only that.
     *
     * This was the last player-creation path in the product with no enrichment
     * at all, and the quick-add form is what made that matter: a player born
     * from this picker stayed BARE forever — no career teams, no Hall of Fame
     * flag, no Wikidata id — because enrichment fires only at creation and an
     * explicit admin force is the sole re-enrich path. Every other route
     * already covers itself: the review wizard enriches before its insert
     * (`processEntityReviewQueue` → `lookupPlayerEnrichment`), the commit
     * prelude inserts already-enriched rows, and `createByAdmin` enqueues.
     * Reusing that same enqueue verbatim rather than inventing another.
     *
     * The early `return existing._id` above is what makes this honour
     * `enqueueEnrichment`'s CREATION-ONLY contract (see the contract note in
     * `wikidataPool.ts`): a player this mutation FOUND leaves without being
     * enqueued. Jason, 2026-09-02: "if the player is already known we should
     * not try to look up the data again."
     *
     * No `force` — that flag belongs to `enrichFromWikidata`, the human "this
     * answer is wrong, look again" remedy. Automatic callers never set it.
     * Scheduled rather than awaited inline because enrichment is a network
     * round-trip and this is a mutation.
     */
    await ctx.scheduler.runAfter(0, internal.wikidataPool.enqueueEnrichment, {
      playerIds: [id],
    });

    return id;
  },
});

/**
 * NEO-254 — "is this name already resolved, and is it resolved to exactly one
 * person?" — the read that decides whether a checklist name opens the review
 * wizard.
 *
 * ## Why this exists instead of another `findByNameAndSport` call
 *
 * `resolveUnknownsAndStartBatch` (selectorOptions.ts) used to ask
 * `findByNameAndSport`, whose answer is a player or null — a shape that cannot
 * express the case this ticket is about. After the bulk preload a name can
 * match SEVERAL rows, and "here is one of them" reads to the caller as "this
 * name is known, no review needed", which is how an ambiguous name got
 * silently bound to an arbitrary row without ever reaching an operator.
 *
 * The public query keeps its old shape (it is signed-in-readable reference
 * data with other consumers); this one is internal, answers the question the
 * gate actually has, and returns a COUNT rather than the rows — the caller
 * only branches on none / one / more than one, and the rows themselves are
 * rebuilt for the wizard by `buildExistingPlayerCandidates` below when and
 * only when a batch is really being opened.
 *
 * `matchCount` is capped at `PLAYER_AMBIGUITY_SCAN_LIMIT`; "8" means "at least
 * 8", which is the same branch as "2".
 */
export const resolveNameForReview = internalQuery({
  args: {
    name: v.string(),
    sportId: v.id("selectorOptions"),
  },
  returns: v.object({
    matchCount: v.number(),
    playerId: v.optional(v.id("players")),
  }),
  handler: async (ctx, args) => {
    const normalized = normalizePlayerName(args.name);
    // A name that normalizes to nothing (punctuation only) can never match a
    // stored key. Reported as no match, so it goes to review rather than being
    // silently treated as resolved.
    if (!normalized) return { matchCount: 0 };
    const candidates = await sameNamePlayers(ctx, normalized, args.sportId);
    return {
      matchCount: candidates.length,
      // Only when it is unambiguous. Handing back one id out of several is the
      // exact thing this query was written to stop.
      ...(candidates.length === 1 ? { playerId: candidates[0]._id } : {}),
    };
  },
});

/**
 * NEO-254 — the NB rows already filed under this name, shaped for the review
 * wizard's "which of these is it?" list.
 *
 * Returns [] unless there are TWO OR MORE. One match is not a choice: the
 * commit prelude adopts it exactly as it always has, and putting a lone
 * candidate in front of the operator would turn every ordinary name into a
 * decision. Called by `entityReviewQueue.applyLookupResult`, which is where
 * the enrichment for a review row is written.
 *
 * `careerSummary` is rendered HERE, on the server, from `teamYears` joined to
 * `teams`. The alternative — shipping ids and letting the wizard join — costs
 * one round trip per candidate on a panel whose whole value is being readable
 * at a glance, and it would put the same format in two places.
 *
 * Bounded twice over: at most `PLAYER_AMBIGUITY_SCAN_LIMIT` candidates, and at
 * most `CAREER_SUMMARY_MAX_TEAMS + 1` team reads each, so the worst case is a
 * couple of dozen point lookups inside a mutation that is otherwise a patch.
 *
 * Exported as a plain function rather than registered as a query: its caller is
 * a mutation, and a mutation cannot `ctx.runQuery` itself.
 */
export async function buildExistingPlayerCandidates(
  ctx: QueryCtx | MutationCtx,
  name: string,
  sportId: Id<"selectorOptions">,
): Promise<
  Array<{
    playerId: Id<"players">;
    name: string;
    birthYear?: number;
    careerSummary: string;
  }>
> {
  const normalized = normalizePlayerName(name);
  if (!normalized) return [];
  const candidates = await sameNamePlayers(ctx, normalized, sportId);
  if (candidates.length < 2) return [];

  const teamNameById = new Map<string, string>();
  const results: Array<{
    playerId: Id<"players">;
    name: string;
    birthYear?: number;
    careerSummary: string;
  }> = [];

  for (const player of candidates) {
    // `sortTeamYears` because the summary reads chronologically and nothing
    // guarantees the stored order (a row written before that sort existed, or
    // one hand-edited since, can be in any order).
    const allStints = sortTeamYears(player.teamYears ?? []);
    // Only the stints that will actually be NAMED are resolved. Each name is a
    // point lookup, this runs for up to eight candidates, and the rest of the
    // career is reported as a count rather than read — see `extra` below.
    const named = allStints.slice(0, CAREER_SUMMARY_MAX_TEAMS);
    const resolved: CareerSummaryStint[] = [];
    for (const stint of named) {
      const key = stint.teamId as string;
      if (!teamNameById.has(key)) {
        const team = await ctx.db.get(stint.teamId);
        // A dangling team id renders as a placeholder rather than throwing:
        // this is a disambiguation hint, and one unreadable stint must not
        // cost the operator the whole candidate.
        teamNameById.set(key, team?.name ?? "Unknown team");
      }
      resolved.push({
        teamName: teamNameById.get(key)!,
        fromYear: stint.fromYear,
        ...(stint.toYear !== undefined ? { toYear: stint.toYear } : {}),
      });
    }
    results.push({
      playerId: player._id,
      name: player.name,
      ...(player.birthYear !== undefined ? { birthYear: player.birthYear } : {}),
      careerSummary: formatCareerSummary(resolved, {
        extra: allStints.length - resolved.length,
      }),
    });
  }
  return results;
}

/**
 * List players for the picker UI. Filterable by sport for binder shells
 * that scope to a single league. Returns name + key flags only — full
 * documents are fetched on demand.
 */
export const list = query({
  args: {
    sportId: v.optional(v.id("selectorOptions")),
    limit: v.optional(v.number()),
  },
  returns: v.array(playerDocPublicValidator),
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
    const limit = args.limit ?? 100;
    const docs = args.sportId
      ? await ctx.db
          .query("players")
          .withIndex("by_sport_id", (q) => q.eq("sportId", args.sportId!))
          .take(limit)
      : await ctx.db.query("players").take(limit);
    return docs.map(toPublicPlayer);
  },
});

/**
 * Default and maximum result counts for `search`.
 *
 * A typeahead list is read, not scrolled — past roughly ten rows the user is
 * better served by typing another character than by scanning further. The cap
 * matters more than the default: it is what stops a caller quietly turning
 * this back into the 500-row fetch it replaces.
 */
const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 25;

/**
 * NEO-147: server-side player typeahead, backing the `PlayerAutocomplete`
 * primitive.
 *
 * The four typeaheads that predate this (SetSelector's PlayerPicker,
 * TeamPicker, EntityLinkSearch, CareerTeamEntry) each fetch up to 500 rows and
 * filter in the browser with `.includes()`. That holds for an admin working
 * inside a single sport; it does not hold for a collector searching every
 * player we know from the spine-label designer. This queries the `search_name`
 * index instead — see the schema for why that indexes `name` and deliberately
 * not `nameNormalized`.
 *
 * `sportId` is an optional filter rather than a requirement: the spine-label
 * designer has no sport context (a collector simply types a name), while an
 * admin surface that does have one should pass it to keep results relevant.
 *
 * An empty query returns nothing rather than "the first N players" — a
 * typeahead that suggests before you type is noise, and it would also be an
 * unbounded browse of the table.
 *
 * Public, like `list` and `get` above: player rows are globally-shared
 * reference data and `toPublicPlayer` strips `createdByUserId`.
 *
 * Unlike `list`/`get`/`getManyByIds` above, this one DOES require a signed-in
 * caller. Not for confidentiality — the data is the same public reference data
 * — but for cost. A Convex deployment URL ships in the client bundle, so an
 * ungated public query is internet-reachable by anyone, and search is the most
 * expensive query class Convex offers; this is the codebase's first search
 * index. Every real caller (`/print/spine-label`, `/design/primitives`) already
 * sits behind `ProtectedLayout`, so the check costs nothing functionally.
 * Returns empty rather than throwing, so a signed-out render is a quiet no-op.
 */
export const search = query({
  args: {
    query: v.string(),
    sportId: v.optional(v.id("selectorOptions")),
    limit: v.optional(v.number()),
  },
  returns: v.array(playerDocPublicValidator),
  handler: async (ctx, args) => {
    if (!(await getCurrentUserId(ctx))) return [];

    const term = args.query.trim();
    if (!term) return [];

    const limit = Math.min(args.limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);

    const docs = await ctx.db
      .query("players")
      .withSearchIndex("search_name", (q) => {
        const search = q.search("name", term);
        return args.sportId ? search.eq("sportId", args.sportId) : search;
      })
      .take(limit);

    return docs.map(toPublicPlayer);
  },
});

/**
 * How many search-index rows feed the ranker, and how many rank out by default.
 *
 * NEO-212 security review: the `limit` argument is FLOORED as well as capped —
 * `Math.max(1, Math.min(...))`. `Math.min` alone left `limit: 0` (an empty
 * result that reads as "no near matches", i.e. "safe to create") and
 * `limit: -1` (`.slice(0, -1)` drops the LAST candidate, silently hiding one)
 * both reachable from the client. Neither is a data leak; both turn this
 * query's only job — warning before a duplicate write — into a warning that
 * quietly does not fire.
 */
const NEAR_MATCH_SEARCH_CANDIDATES = 10;
const NEAR_MATCH_DEFAULT_LIMIT = 5;
const NEAR_MATCH_MAX_LIMIT = 25;

/**
 * NEO-212: the "did you mean?" prompt in front of creating a player. The twin
 * of `teams.nearMatches` — see the section header above that function for what
 * Convex's search index actually does (OR-ish over terms, prefix matching on
 * the final term only, no typo tolerance) and why the fallback query below is
 * a second search rather than a bigger `.take()`.
 *
 * Three steps, widening:
 *
 *   1. The exact dedup key, via `by_name_normalized_and_sport_id`. This is the
 *      hit that must never be missed — a row `findOrCreate` would reuse.
 *   2. `search_name` on the whole name; if that returns nothing, a second
 *      search on the LAST token. Last, not longest: the ladder in
 *      `lib/pairing/names.ts` treats the final token as the surname and
 *      refuses to match anything whose surname disagrees, so the surname is
 *      the only term whose absence guarantees a miss. "Shohei" would happily
 *      out-rank the row we want; "Ohtani" cannot. `longestToken` is the
 *      fallback's fallback, for the degenerate name with no tokens left after
 *      normalisation.
 *   3. `rankPlayerCandidates` over the union, dropping everything it ranks
 *      neither exact nor close.
 *
 * Advisory only — `close` fires on a shared surname plus an initial, and two
 * brothers share both. The operator decides; this query only offers.
 *
 * Admin-gated, unlike `search` above: this one exists to guard a write to
 * globally-shared reference data, and its only caller is the review wizard.
 * Returns the public shape (never `createdByUserId` — see `toPublicPlayer`).
 */
export const nearMatches = query({
  args: {
    name: v.string(),
    sportId: v.id("selectorOptions"),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      _id: v.id("players"),
      name: v.string(),
      confidence: v.union(v.literal("exact"), v.literal("close")),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const name = args.name.trim();
    if (!name) return [];
    // NEO-212 security review: the same bound `createByAdmin` and
    // `savePlayerFields` put on a stored name, applied to the SEARCH TERM too.
    // An unbounded term is fed straight to a search index and to
    // `rankPlayerCandidates`'s per-token work; nothing that could ever match a
    // stored row is longer than a storable name, so refusing costs nothing
    // real. Refused rather than truncated, matching the write paths.
    if (name.length > MAX_PLAYER_NAME_LENGTH) {
      throw new ConvexError(
        `A player name is ${name.length} characters; the limit is ${MAX_PLAYER_NAME_LENGTH}.`,
      );
    }

    // Floored as well as capped — see NEAR_MATCH_DEFAULT_LIMIT above for what
    // `limit: 0` and `limit: -1` did without the `Math.max`.
    const limit = Math.max(
      1,
      Math.min(args.limit ?? NEAR_MATCH_DEFAULT_LIMIT, NEAR_MATCH_MAX_LIMIT),
    );

    // Keyed by id so the exact hit and a search hit for the same row collapse.
    const candidates = new Map<
      Id<"players">,
      { _id: Id<"players">; name: string }
    >();

    const normalized = normalizePlayerName(name);
    if (normalized) {
      /**
       * NEO-254 — every row on the exact key, not just the first.
       *
       * `.first()` was defensible while the key behaved as if it were unique.
       * It is not unique, and the bulk preload makes that ordinary: with two
       * "Bob Allen"s on file this panel showed ONE of them as an exact match,
       * and the wizard then promoted that single row to its primary "Link to
       * Bob Allen" button — a one-tap path to binding a card to the wrong man,
       * with the other row nowhere on screen. Listing them all is what turns
       * that into the choice it always was.
       */
      const exact = await sameNamePlayers(ctx, normalized, args.sportId);
      for (const row of exact) {
        candidates.set(row._id, { _id: row._id, name: row.name });
      }
    }

    const searchPlayers = async (term: string) =>
      await ctx.db
        .query("players")
        .withSearchIndex("search_name", (q) =>
          q.search("name", term).eq("sportId", args.sportId),
        )
        .take(NEAR_MATCH_SEARCH_CANDIDATES);

    let hits = await searchPlayers(name);
    if (hits.length === 0) {
      const tokens = nameTokens(name);
      const fallbackTerm = tokens.length > 0 ? tokens[tokens.length - 1] : longestToken(name);
      if (fallbackTerm) hits = await searchPlayers(fallbackTerm);
    }
    for (const hit of hits) {
      candidates.set(hit._id, { _id: hit._id, name: hit.name });
    }

    const rows = [...candidates.values()];
    return rankPlayerCandidates(name, rows)
      .slice(0, limit)
      .map(({ index, confidence }) => ({
        _id: rows[index]._id,
        name: rows[index].name,
        confidence,
      }));
  },
});

export const get = query({
  args: { id: v.id("players") },
  returns: v.union(playerDocPublicValidator, v.null()),
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
    const doc = await ctx.db.get(args.id);
    return doc ? toPublicPlayer(doc) : null;
  },
});

/**
 * NEO-235 — `get`, for an id that came out of a URL rather than out of a query.
 *
 * `/admin/players?player=<id>` puts a player id in a place anybody can retype,
 * and `get` above takes `v.id("players")`. An id argument that does not parse
 * is an ARGUMENT VALIDATION failure, which Convex raises before the handler
 * runs and the client surfaces as a thrown query — on a `useQuery` that means
 * the render throws and the screen is replaced by the app-level error boundary.
 * A hand-mangled query string is not a broken application, so it must not look
 * like one.
 *
 * Fixed on the SERVER rather than by validating the string in the browser,
 * because the browser cannot actually tell: a Convex id's shape is not a
 * documented format to regex against, and `normalizeId` is the only honest
 * check — it is also the one that knows the id names THIS table. A client-side
 * guess would have to be either loose (and still throw) or tight (and reject
 * ids that are fine).
 *
 * Same gate and same public shape as `get`, so the two cannot drift: the only
 * difference is that an unparseable or wrong-table id is answered `null`, the
 * same answer a well-formed id for a deleted row already got. The screen has
 * one "no such player" branch and this keeps it that way.
 *
 * `get` stays rather than being replaced by this. The two are not
 * interchangeable and the difference is the type check: a caller that already
 * holds a real `Id<"players">` — one that came out of another query, in this
 * backend's other clients as much as this one — should be made to prove it at
 * the boundary, and be told loudly if it cannot. This looser door is for the
 * one caller that genuinely holds a string a human could have typed.
 */
export const getByIdParam = query({
  args: { id: v.string() },
  returns: v.union(playerDocPublicValidator, v.null()),
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
    const id = ctx.db.normalizeId("players", args.id);
    if (id === null) return null;
    const doc = await ctx.db.get(id);
    return doc ? toPublicPlayer(doc) : null;
  },
});

/**
 * Batch lookup for resolving a list of playerIds back to display rows.
 * NEO-25: the card detail panel renders player-name chips from
 * `cardChecklist.playerIds[]` without N round-trips. Mirrors
 * `teams.getManyByIds`. Missing IDs are silently dropped (an orphaned
 * link is a soft data error, not fatal). `createdByUserId` is stripped
 * via `toPublicPlayer`.
 *
 * NEO-202: this was the only function in this file with no identity check,
 * and the mirror it names — `teams.getManyByIds` — calls `requireSignedIn`.
 * That asymmetry is the exact shape NEO-154 called out (`teams.findOrCreate`
 * had no guard while its `players.findOrCreate` twin did), recurring with the
 * sides swapped. `requireSignedIn`, not `requireAdmin`: `players` is
 * signed-in-readable reference data — `get`, `search` and `findByNameAndSport`
 * all settle for signed-in — and the only callers (PlayerPicker, the card
 * detail chips) sit behind `ProtectedLayout` anyway.
 */
export const getManyByIds = query({
  args: { ids: v.array(v.id("players")) },
  returns: v.array(playerDocPublicValidator),
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
    const rows = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return rows
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map(toPublicPlayer);
  },
});

/**
 * Internal counterpart of `get` — used by Wikidata enrichment actions that
 * run outside the user's auth context. Internal queries never enforce
 * Clerk identity so background enrichment can read freely.
 */
export const getInternal = internalQuery({
  args: { id: v.id("players") },
  returns: v.union(playerDocValidator, v.null()),
  handler: async (ctx, args) => await ctx.db.get(args.id),
});

/**
 * Apply Wikidata enrichment to an existing player row. Called from the
 * Wikidata adapter action so this runs in a mutation context with no
 * external IO. Updates teamYears, isHallOfFame, externalIds.
 *
 * NEO-203 — deliberately a full write, unlike its `teams` twin, which fills
 * gaps only. The asymmetry is not an oversight:
 *
 *  - `teams.applyEnrichmentInternal` guards because `teams.saveTeamFields`
 *    lets an operator hand-edit city / yearsActive / colors, so a blind write
 *    there destroys human input. `players` has NO such editor — there is no
 *    mutation in this file that writes `teamYears` or `isHallOfFame` from a
 *    person — so there is nothing here for a gap-fill rule to protect.
 *  - The only two callers left are a player being CREATED (nothing to
 *    clobber) and the operator's own force path, whose entire purpose is to
 *    replace an answer that turned out to be wrong. A gap-fill rule would
 *    defeat that second one.
 *
 * If a player editor is ever added, this needs the `teams` treatment — and
 * `convex/teams.applyEnrichmentInternal.test.ts` is the shape to copy.
 */
export const applyEnrichmentInternal = internalMutation({
  args: {
    id: v.id("players"),
    teamYears: v.optional(v.array(v.object({
      teamId: v.id("teams"),
      fromYear: v.number(),
      toYear: v.optional(v.number()),
    }))),
    isHallOfFame: v.optional(v.boolean()),
    wikidataId: v.optional(v.string()),
    /**
     * NEO-254 — the lookup's undated career teams (NEO-235's
     * `undatedCareerTeams`), by name.
     *
     * The commit prelude has stored these since NEO-254 landed, but this
     * mutation is the OTHER way a player gets Wikidata data — the admin's
     * "Re-enrich from Wikidata", and the automatic enrichment behind
     * `findOrCreate` and `createByAdmin`. Without it, a player created through
     * the admin form never received its leads at all, and a forced re-enrich
     * on a preloaded or wizard-created player silently dropped the ones it had.
     */
    undatedCareerTeams: v.optional(v.array(v.string())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) return null;

    const patch: {
      teamYears?: Array<{ teamId: Id<"teams">; fromYear: number; toYear?: number }>;
      isHallOfFame?: boolean;
      externalIds?: { wikidataId?: string };
      undatedCareerTeams?: string[];
      lastUpdated: number;
    } = { lastUpdated: Date.now() };

    if (args.teamYears !== undefined) patch.teamYears = args.teamYears;

    if (args.undatedCareerTeams !== undefined) {
      /**
       * NEO-254 — MERGED with what is already on the row, never replacing it.
       *
       * Every other field here is a blind full write, and that is defensible
       * for them: this path only runs at creation or on the operator's own
       * explicit "this answer is wrong, look again", where replacing is the
       * request. It is NOT defensible for this one. A lead is a standing
       * question addressed to a human, and a re-enrich that dropped a name the
       * operator had been meaning to date would destroy the only record that
       * Wikidata ever mentioned it — the exact loss NEO-254 exists to stop,
       * arriving through the remedy for it.
       *
       * A name that has since been DATED is pruned rather than merged back in,
       * on the row's own `teamYears`, so a re-enrich cannot resurrect a lead
       * the operator already closed. Same rule and same key as
       * `savePlayerFields`; the team names come from the row's stints, which
       * are read here anyway.
       */
      const datedKeys = new Set<string>();
      for (const stint of patch.teamYears ?? existing.teamYears ?? []) {
        const team = await ctx.db.get(stint.teamId);
        if (team) datedKeys.add(normalizeEntityName(team.name));
      }
      const merged = normalizeUndatedCareerTeams([
        ...(existing.undatedCareerTeams ?? []),
        ...args.undatedCareerTeams,
      ]).filter((name) => !datedKeys.has(normalizeEntityName(name)));
      patch.undatedCareerTeams = merged.length > 0 ? merged : undefined;
    }

    if (args.isHallOfFame !== undefined) patch.isHallOfFame = args.isHallOfFame;
    // NEO-212 security review: an id that is not `Q<digits>` is DROPPED, not
    // stored. The value here originates at query.wikidata.org, so it is
    // external input arriving on a path with no operator in it, and a stored
    // id is later interpolated into an outbound link. Dropping is the right
    // failure: `enrichPlayer` treats any stored `wikidataId` as "already
    // enriched" and skips the row forever, so persisting a malformed one would
    // permanently opt the player out of enrichment — worse than having none.
    if (args.wikidataId !== undefined && isWikidataQid(args.wikidataId)) {
      patch.externalIds = { ...(existing.externalIds ?? {}), wikidataId: args.wikidataId };
    }
    await ctx.db.patch(args.id, patch);
    return null;
  },
});

/**
 * Wikidata enrichment kickoff — non-blocking. `enrichPlayer` runs the SPARQL
 * query and writes results back via applyEnrichmentInternal. Failures are
 * logged but never thrown; an unenriched player is still usable.
 *
 * NEO-99: enqueues onto the shared Wikidata pool (convex/wikidataPool.ts)
 * rather than running the enrichment inline, so this entry point spends the
 * SAME deployment-wide 5-parallel SPARQL budget as the review-wizard drain
 * instead of adding an uncoordinated request that could push Wikidata past its
 * per-IP ceiling. Still fire-and-forget — the pool runs the work in the
 * background and enrichPlayer persists its own result.
 *
 * ## THE ONLY SANCTIONED PATH TO RE-LOOK-UP AN EXISTING PLAYER (NEO-203)
 *
 * Jason, 2026-09-02: "if the player is already known we should not try to look
 * up the data again." Automatic enrichment is creation-only; `enrichPlayer`
 * enforces that structurally by skipping any player that already carries
 * career teams, a Hall-of-Fame answer, or a Wikidata id.
 *
 * This action is the deliberate exception, exactly as its `teams` twin is: it
 * is admin-gated, human-initiated on a specific row, and its purpose is the one
 * case where the stored answer is wrong. It therefore passes `force`. No
 * automatic caller may — see `wikidataPool.enqueueEnrichment`.
 *
 * Note what is NOT an exception: the entity-review wizard's preview lookup.
 * That runs on unresolved NAMES before any row exists (`runEntityReviewLookup`
 * writes only to `entityReviewQueue`), and `resolveUnknownsAndStartBatch`
 * queues a name only when `players.resolveNameForReview` reports a match count
 * other than exactly one — NEO-254 moved the gate off `findByNameAndSport`,
 * whose `player | null` answer could not distinguish "nothing matched" from
 * "several did". Neither outcome enriches an existing row. A "link" decision —
 * the operator pointing an unknown name at an existing player — likewise
 * triggers no lookup for that player: the commit prelude reads the linked row
 * once, to validate it and take its spelling, and enqueues nothing.
 */
export const enrichFromWikidata = action({
  args: { id: v.id("players") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    // NEO-147: gated for the same reason as the `teams` twin, and it had the
    // same shape — a public action with no authorization and no callers, which
    // let any client spend an outbound Wikidata round-trip per call, for any
    // player id, at any rate. Enrichment writes to globally-shared player rows.
    await requireAdmin(ctx);
    try {
      await ctx.runMutation(internal.wikidataPool.enqueueEnrichment, {
        playerIds: [args.id],
        // NEO-203: the operator exception — see the note above. Automatic
        // callers must never set this.
        force: true,
      });
    } catch (error) {
      console.error("[players.enrichFromWikidata] failed:", error);
    }
    return null;
  },
});

// ===========================================================================
// NEO-212 — Player Management (/admin/players)
//
// The three functions below back the admin Players page, a mirror of
// /admin/teams. They are the only human-driven writers of `players` rows, and
// they are the reason `applyEnrichmentInternal`'s docstring above now has a
// live answer to its own "if a player editor is ever added" caveat — see the
// note on `savePlayerFields`.
//
// User-facing failures throw `ConvexError`, not bare `Error`. Convex replaces a
// plain `Error`'s message with "Server Error" in a deployed backend, and the
// NAME_TAKEN message below is *load-bearing UI data* (the page turns it into a
// link to the colliding player), so it has to survive the trip. Same choice
// `teams.findOrCreate` made in NEO-208.
// ===========================================================================

/**
 * Hard ceiling on rows returned by `listForManagement`.
 *
 * Lower than `teams`' 2000 on purpose: there are one or two orders of
 * magnitude more players than teams, and unlike the team screen this page has
 * a real server-side search (`players.search`) to fall back on, so the full
 * list only ever has to be a starting point rather than the whole dataset.
 */
const PLAYER_MANAGEMENT_CAP = 500;



/**
 * NEO-212 security review: upper bound on how many career stints one
 * `savePlayerFields` call may write to a single player row.
 *
 * The same guard rail, for the same reason, as
 * `MAX_MANUAL_CAREER_TEAMS` / `MAX_EXCLUDED_CAREER_TEAM_NAMES` in
 * `convex/entityReviewQueue.ts` — and it was the gap those two left. That path
 * capped the wizard's route into `players.teamYears`; this editor is the OTHER
 * route into the same field and had no bound at all, so an unbounded array
 * reached the row through a per-stint validation loop that does a `ctx.db.get`
 * PER ENTRY. Ten thousand stints is ten thousand reads inside one mutation.
 *
 * Not a confidentiality boundary — this path is admin-gated — but admin-gated
 * is not the same as "cannot be driven by a compromised session or a UI bug",
 * and an unbounded write into a globally-shared reference row is worth
 * refusing on its own. A real career spans a handful of stints; 64 is generous
 * headroom and matches the wizard's number so the two routes agree.
 *
 * The refusal carries the COUNT, never the names: the message reaches Sentry
 * and the browser console through Convex's error path, and the names are
 * operator input. Same rule as `teams.resolveNames`'s over-length refusal.
 */
const MAX_PLAYER_TEAM_YEARS = 64;

/**
 * NEO-212: the whole player list, for the Player Management page.
 *
 * This is the "nothing typed yet" view, and only that. The page switches to
 * `players.search` — the `search_name` index — the moment the admin types a
 * character, so this query never has to be the thing that finds a specific
 * player among tens of thousands. That is what lets it stay a capped `.take()`
 * rather than becoming a paginated browse.
 *
 * `truncated` is reported rather than silently dropped, for the same reason
 * `teams.listForManagement` reports it: a list that quietly stops at the cap
 * reads as "that is all the players", which is the kind of wrong the operator
 * cannot see. Here it is not a distant scale worry — 500 is a number a real
 * deployment passes early — so the flag is load-bearing from day one, and the
 * page uses it to say "keep typing" instead of implying completeness.
 *
 * `createdByUserId` is stripped by `toPublicPlayer`, exactly as in every other
 * public query in this file. Admin-gated, but that is not a licence to leak the
 * audit field: the validator is what enforces it and the validator is public.
 */
export const listForManagement = query({
  args: {
    sportId: v.optional(v.id("selectorOptions")),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    players: v.array(playerDocPublicValidator),
    totalCount: v.number(),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    // The cap is a ceiling, not a suggestion: a caller passing 10_000 gets 500.
    const limit = Math.max(
      1,
      Math.min(args.limit ?? PLAYER_MANAGEMENT_CAP, PLAYER_MANAGEMENT_CAP),
    );

    // limit + 1 is the truncation probe — one row past the cap is how we learn
    // there is more without paying for a count of the whole table.
    const rows = args.sportId
      ? await ctx.db
          .query("players")
          .withIndex("by_sport_id", (q) => q.eq("sportId", args.sportId!))
          .take(limit + 1)
      : await ctx.db.query("players").take(limit + 1);

    const truncated = rows.length > limit;
    const players = rows.slice(0, limit).map(toPublicPlayer);
    players.sort((a, b) => a.name.localeCompare(b.name));

    return { players, totalCount: players.length, truncated };
  },
});

/**
 * NEO-212: admin quick-add for a player, the counterpart of `teams.findOrCreate`.
 *
 * NEO-220 REDREW the line this used to sit on. The old reasoning was that
 * `findOrCreate` was the SIGNED-IN reconciler and scheduled no enrichment,
 * while this one was admin-only and did — so they could not be one function
 * with a flag. Both halves are gone: `findOrCreate` is `requireAdmin` now and
 * enqueues on its own insert branch, and it was never what the commit path
 * calls (that inserts directly, already enriched).
 *
 * They stay separate for what is left, which is the RETURN CONTRACT. This one
 * answers `{ id, created }`, because the Player Management form has to say
 * "already here" and jump to the existing row rather than claim a creation;
 * `findOrCreate` answers a bare id, because a typeahead chip does not care
 * which branch produced it. Merging them would make every picker call site
 * destructure an answer it has no use for.
 *
 * Idempotent, and that is a correctness requirement rather than a convenience:
 * players are globally-shared rows keyed on (normalized name, sport), so a
 * double-submitted form must resolve to the existing row instead of creating a
 * second Mike Trout. `created` tells the page which happened, so it can say
 * "already here" and jump to the row rather than claiming a creation.
 */
export const createByAdmin = mutation({
  args: {
    name: v.string(),
    sportId: v.id("selectorOptions"),
    /** NEO-254 — see the identical arg on `findOrCreate` above. */
    birthYear: v.optional(v.number()),
  },
  returns: v.object({
    id: v.id("players"),
    created: v.boolean(),
  }),
  handler: async (ctx, args): Promise<{ id: Id<"players">; created: boolean }> => {
    const userId = await requireAdmin(ctx);

    const name = args.name.trim();
    if (name.length === 0) {
      throw new ConvexError("A player name is required.");
    }
    if (name.length > MAX_PLAYER_NAME_LENGTH) {
      // The LENGTH, never the name: this string reaches Sentry and the browser
      // console through Convex's error path.
      throw new ConvexError(
        `A player name is ${name.length} characters; the limit is ${MAX_PLAYER_NAME_LENGTH}.`,
      );
    }

    // `sportId` is a bare `v.id("selectorOptions")` — the validator proves it
    // is an id in that table, not that it points at a SPORT. A player hung off,
    // say, a variantType row is unreachable by every query that matters
    // (`list`, `search` and `findByNameAndSport` all key on the sport row id),
    // so it would be an orphan. Same check `teams.findOrCreate` makes.
    const sportRow = await ctx.db.get(args.sportId);
    if (!sportRow || sportRow.level !== "sport") {
      throw new ConvexError("A player must be created under a sport.");
    }

    // NEO-254 — see the identical check in `findOrCreate` above.
    if (args.birthYear !== undefined) assertBirthYear(args.birthYear);

    const nameNormalized = normalizePlayerName(name);
    // The compound index, not `by_name_normalized` + a client-side sport
    // filter: a common surname matches across every sport we track, and the
    // narrow read is the difference on a table this size.
    //
    // NEO-254: bounded `.take()` rather than `.first()`, for the reason spelled
    // out on `sameNamePlayers` — the key is a dedup key, not a unique one.
    const candidates = await sameNamePlayers(ctx, nameNormalized, args.sportId);
    /**
     * NEO-254 — adopt, fork, or refuse. See `adoptOrForkOnCreate` for the full
     * rule and for why this form's answer differs from `findOrCreate`'s.
     *
     * This used to `return { created: false }` on the single-candidate branch
     * BEFORE it ever looked at `birthYear`, which made the form's own
     * "Create anyway" button unable to create anything: an operator adding the
     * second Bob Allen was silently handed the first one back, and told the
     * player already existed. A refusal the operator can act on lands on the
     * page's status line, which sits directly above a search that lists the
     * rows in question.
     */
    const adopted = adoptOrForkOnCreate(candidates, args.birthYear, name);
    // NOT enqueued — see the creation-only note on the insert below.
    if (adopted) return { id: adopted._id, created: false };

    const id = await ctx.db.insert("players", {
      name,
      nameNormalized,
      sportId: args.sportId,
      ...(args.birthYear !== undefined ? { birthYear: args.birthYear } : {}),
      createdByUserId: userId,
      lastUpdated: Date.now(),
    });

    // An audit trail for a shared-row creation an operator triggers from a
    // form. Structured JSON, not concatenation — the name is operator input and
    // must not be able to shape a log line.
    console.log(
      JSON.stringify({ msg: "player_created", playerId: id, sportId: args.sportId, userId }),
    );

    /**
     * Enrich the player we just INSERTED, and only that.
     *
     * The early `return { id: existing._id, created: false }` above is what
     * makes this honour `enqueueEnrichment`'s CREATION-ONLY contract (see the
     * contract note in `wikidataPool.ts`): a player this mutation FOUND leaves
     * without being enqueued. Jason, 2026-09-02: "if the player is already
     * known we should not try to look up the data again."
     *
     * No `force` — that flag belongs to `enrichFromWikidata`, the human "this
     * answer is wrong, look again" remedy. This is an automatic caller and
     * automatic callers never set it.
     *
     * Scheduled rather than awaited inline because enrichment is a network
     * round-trip and this is a mutation — the same reason `teams.findOrCreate`
     * schedules its own.
     */
    await ctx.scheduler.runAfter(0, internal.wikidataPool.enqueueEnrichment, {
      playerIds: [id],
    });

    return { id, created: true };
  },
});

/**
 * NEO-212: manual field entry for the player editor — the counterpart of
 * `teams.saveTeamFields`.
 *
 * ## This is the editor `applyEnrichmentInternal` warned about
 *
 * That function's docstring justifies its blind full write by observing that
 * `players` has no hand-editor, so there is no human input for a gap-fill rule
 * to protect. This function is that editor, and the caveat it names ("if a
 * player editor is ever added, this needs the `teams` treatment") now applies.
 *
 * It is NOT resolved here, deliberately: `enrichPlayer`'s creation-only guard
 * (NEO-203, pinned by convex/enrichmentCreationOnly.test.ts) means an
 * automatic lookup never fires for a player carrying career teams, a
 * Hall-of-Fame answer, or a Wikidata id — which is every player this function
 * has touched. The only path that still reaches `applyEnrichmentInternal` for
 * an edited row is `enrichFromWikidata`, the admin's own explicit "look this
 * up again", whose entire purpose is to replace the stored answer. Overwriting
 * on that path is the request, not a bug.
 *
 * ## Field semantics
 *
 * Omitting a field leaves it alone. `wikidataId: null` clears it — the same
 * optional-and-clearable shape `saveTeamFields` uses, and for the same reason:
 * "" and "unset" are different states, and only one of them is a valid QID.
 *
 * `name` changes rewrite `nameNormalized` too, or the row becomes invisible to
 * every `by_name_normalized` lookup that resolves checklist names back onto it
 * — silently, and only discovered later as a duplicate player.
 *
 * `createdByUserId` is never touched. It is an audit field; an edit is not a
 * re-creation and rewriting it would erase who actually introduced the row.
 */
export const savePlayerFields = mutation({
  args: {
    id: v.id("players"),
    name: v.optional(v.string()),
    isHallOfFame: v.optional(v.boolean()),
    /** `null` clears `externalIds.wikidataId`; a string must be a `Q<digits>` id. */
    wikidataId: v.optional(v.union(v.string(), v.null())),
    /**
     * The player's whole career history, replaced wholesale. An empty array is
     * a legitimate value and clears it — "this player has no recorded stints"
     * is a real answer, distinct from "nobody has said".
     */
    teamYears: v.optional(
      v.array(
        v.object({
          teamId: v.id("teams"),
          fromYear: v.number(),
          toYear: v.optional(v.number()),
        }),
      ),
    ),
    /**
     * NEO-254 — the player's birth year, or `null` to clear it.
     *
     * Editable because it is the field that tells two same-name players apart,
     * and therefore the field an operator most needs to be able to correct: a
     * wrong one makes the review wizard's candidate list actively misleading,
     * and `findOrCreate`'s tiebreaker resolve to the wrong man. Clearable for
     * the same reason `wikidataId` is — "" and "unset" are different states,
     * and a year nobody is sure of is better absent than wrong.
     */
    birthYear: v.optional(v.union(v.number(), v.null())),
    /**
     * NEO-254 — the undated Wikidata team names still awaiting a human,
     * replaced wholesale. An empty array clears the list, which is how the
     * operator says "none of these leads is worth chasing".
     *
     * Usually omitted: a name normally leaves this list by being DATED, and
     * the `teamYears` branch below prunes it automatically for that case, so
     * the page does not have to send both halves of one gesture and cannot get
     * them out of step. This arg is the other exit — dismissing a lead that is
     * simply wrong (Wikidata's college and national-team memberships are
     * routinely neither) without inventing a stint to get rid of it.
     */
    undatedCareerTeams: v.optional(v.array(v.string())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const existing = await ctx.db.get(args.id);
    if (!existing) throw new ConvexError("Player not found");

    const patch: {
      name?: string;
      nameNormalized?: string;
      isHallOfFame?: boolean;
      externalIds?: { wikidataId?: string; lahmanId?: string; nflverseId?: string };
      teamYears?: PlayerTeamYear[];
      birthYear?: number;
      undatedCareerTeams?: string[];
      lastUpdated: number;
    } = { lastUpdated: Date.now() };

    if (args.birthYear !== undefined) {
      if (args.birthYear === null) {
        // Dropped entirely, so a cleared row is indistinguishable from one
        // that never carried a year — the rule `externalIds` follows below.
        patch.birthYear = undefined;
      } else {
        assertBirthYear(args.birthYear);
        patch.birthYear = args.birthYear;
      }
    }

    /**
     * NEO-254 — the undated list this call will leave on the row.
     *
     * Seeded from the argument when one was sent, otherwise from what is
     * already stored, and then pruned by the `teamYears` branch below. Held as
     * one variable rather than two branches so the two exits from the list
     * (dismissed by hand, dated into a stint) cannot disagree about the
     * result when a single save does both.
     */
    let undated = normalizeUndatedCareerTeams(
      args.undatedCareerTeams ?? existing.undatedCareerTeams ?? [],
    );
    let undatedChanged = args.undatedCareerTeams !== undefined;

    if (args.name !== undefined) {
      const trimmed = args.name.trim();
      if (trimmed.length === 0) {
        throw new ConvexError("A player name is required.");
      }
      if (trimmed.length > MAX_PLAYER_NAME_LENGTH) {
        throw new ConvexError(
          `A player name is ${trimmed.length} characters; the limit is ${MAX_PLAYER_NAME_LENGTH}.`,
        );
      }
      const nameNormalized = normalizePlayerName(trimmed);

      // A rename onto an existing (normalized name, sport) key would create the
      // exact duplicate the whole normalization scheme exists to prevent, and
      // the two rows could then never be told apart by any lookup. Refuse, and
      // hand the page the OTHER row's id so it can offer "go to that player"
      // instead of leaving the operator to search for it.
      //
      // The message carries an id and the name the operator just typed —
      // nothing else. No PII beyond what they supplied, and specifically not
      // the other row's `createdByUserId`.
      const collision = await ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", nameNormalized).eq("sportId", existing.sportId),
        )
        .first();
      if (collision && collision._id !== args.id) {
        throw new ConvexError(`NAME_TAKEN:${collision._id}`);
      }

      patch.name = trimmed;
      patch.nameNormalized = nameNormalized;
    }

    if (args.isHallOfFame !== undefined) {
      patch.isHallOfFame = args.isHallOfFame;
    }

    if (args.wikidataId !== undefined) {
      const rest: { wikidataId?: string } = { ...(existing.externalIds ?? {}) };
      if (args.wikidataId === null) {
        delete rest.wikidataId;
      } else {
        const qid = args.wikidataId.trim();
        // Validated at the write, not just in the UI. A malformed id is worse
        // than a missing one: `enrichPlayer` treats ANY stored `wikidataId` as
        // "already enriched" and skips the row forever, so a typo here silently
        // opts a player out of enrichment.
        if (!isWikidataQid(qid)) {
          // The raw argument rather than `qid`: `isWikidataQid` is a type
          // guard, so inside this branch `qid` has narrowed to `never` and
          // cannot be interpolated. The operator recognises what they typed
          // more readily than its trimmed form in any case.
          throw new ConvexError(`Not a Wikidata entity id: ${args.wikidataId}`);
        }
        rest.wikidataId = qid;
      }
      // Drop the container entirely once it holds nothing, so a cleared row is
      // indistinguishable from one that never had an id.
      patch.externalIds = Object.keys(rest).length > 0 ? rest : undefined;
    }

    if (args.teamYears !== undefined) {
      // Bounded BEFORE the loop below, which does one `ctx.db.get` per entry.
      // Checking inside it would still have performed the reads.
      if (args.teamYears.length > MAX_PLAYER_TEAM_YEARS) {
        throw new ConvexError(
          `A player has ${args.teamYears.length} career stints; the limit is ${MAX_PLAYER_TEAM_YEARS}.`,
        );
      }

      const maxYear = maxCareerYear();
      const seen = new Set<string>();
      // NEO-254: the team names this save puts a stint against, on the key the
      // undated list dedupes on. Collected inside the loop below, which already
      // reads every team document, so pruning costs no extra reads.
      const datedTeamKeys = new Set<string>();

      for (const stint of args.teamYears) {
        const team = await ctx.db.get(stint.teamId);
        if (!team) {
          throw new ConvexError("A career stint points at a team that no longer exists.");
        }
        // A cross-sport stint is not a harmless oddity: `teams.list` and every
        // picker scope by sport, so the stint would render as a dangling id the
        // operator cannot see, let alone fix.
        if (team.sportId !== existing.sportId) {
          throw new ConvexError(
            `A career stint names a team from another sport: ${team.name}.`,
          );
        }

        if (!Number.isInteger(stint.fromYear) || stint.fromYear < MIN_CAREER_YEAR || stint.fromYear > maxYear) {
          throw new ConvexError(
            `A career start year must be a whole year between ${MIN_CAREER_YEAR} and ${maxYear}.`,
          );
        }
        if (stint.toYear !== undefined) {
          if (!Number.isInteger(stint.toYear) || stint.toYear < MIN_CAREER_YEAR || stint.toYear > maxYear) {
            throw new ConvexError(
              `A career end year must be a whole year between ${MIN_CAREER_YEAR} and ${maxYear}.`,
            );
          }
          if (stint.toYear < stint.fromYear) {
            throw new ConvexError("A career stint cannot end before it starts.");
          }
        }

        // Duplicate detection is on (teamId, fromYear), NOT on teamId: two
        // stints at one franchise are real history — traded away, re-signed
        // later — and collapsing them is data loss. Only a literal repeat of
        // the same stint is refused. See `sortTeamYears`.
        const key = `${stint.teamId}:${stint.fromYear}`;
        if (seen.has(key)) {
          throw new ConvexError(
            `${team.name} is listed twice starting in ${stint.fromYear}.`,
          );
        }
        seen.add(key);
        datedTeamKeys.add(normalizeEntityName(team.name));
      }

      patch.teamYears = sortTeamYears(args.teamYears);

      /**
       * NEO-254 — a dated team is no longer an undated one.
       *
       * The whole point of the undated list is that nobody has put years to
       * these names yet. The moment a stint exists for one, leaving it in the
       * list would show the operator a lead they have already chased, next to
       * the stint that closed it — the list would only ever grow, and it would
       * stop meaning anything.
       *
       * Derived from what was SAVED rather than driven by a separate flag, so
       * it works whichever route added the stint: the "Add years" affordance
       * next to the lead, or the operator simply using the career-history
       * editor and never noticing the list at all.
       */
      const kept = undated.filter(
        (name) => !datedTeamKeys.has(normalizeEntityName(name)),
      );
      if (kept.length !== undated.length) {
        undated = kept;
        undatedChanged = true;
      }
    }

    if (undatedChanged) {
      // Dropped entirely once empty, so a cleared row is indistinguishable
      // from one that never had a lead on it — the same rule `externalIds`
      // follows above, and what keeps the Players page from rendering an
      // empty "also on Wikidata" heading over nothing.
      patch.undatedCareerTeams = undated.length > 0 ? undated : undefined;
    }

    await ctx.db.patch(args.id, patch);
    return null;
  },
});
