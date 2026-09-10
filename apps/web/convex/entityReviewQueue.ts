import {
  mutation,
  query,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { RunResult } from "@convex-dev/workpool";
import { getCurrentUserId, requireAdmin } from "./auth";
import {
  buildExistingPlayerCandidates,
  isAmbiguousPlayerName,
  normalizePlayerName,
} from "./players";
// NEO-254: ONE floor, shared with `players.savePlayerFields` (the other route
// into the same `players.teamYears` column) and with the wizard's own year
// fields. The three used to be separate literals and two of them disagreed.
import { MIN_CAREER_YEAR } from "../lib/players/career-years";
import { normalizeTeamName } from "./teams";
// NEO-254 — the New League step collects everything League Management edits, so
// it validates against the SAME bounds. Imported rather than restated: two
// validators guarding one table must not be able to disagree about what it
// accepts (the lesson `lib/players/career-years.ts` records).
import { isWikidataQid } from "../lib/players/wikidata-id";
import type { LeagueLevel } from "./leagues";
import {
  findLeagueByName,
  findOrCreateLeague,
  leagueLevelValidator,
  MAX_LEAGUE_NAME_LENGTH,
  normalizeAliasList,
  normalizeLeagueName,
  requireValidLeagueAbbreviation,
  requireValidLeagueName,
  validateLeagueYears,
} from "./leagues";
// NEO-236: the ONE team lookup. Staging asks "do we already hold this career
// team?" and must ask it exactly the way every writer keys the table.
import { resolveTeamForSetYear } from "./lib/teamRow";
// NEO-254: the set's year, for labelling which same-name candidates were
// active in it. One ancestor walk per batch; see convex/lib/selectorAncestry.ts.
import { findSetYearForSelectorOption } from "./lib/selectorAncestry";

/**
 * NEO-92: backs the step-through "new players & teams" review wizard that
 * replaced the old single-screen UnknownEntitiesDialog checkbox list. See
 * the `entityReviewQueue` table doc comment in schema.ts for the full model.
 *
 * Lifecycle: fetchCardChecklist (an action — transitively admin-gated via
 * its own call to getAncestorChain, which requires admin) calls `startBatch`
 * for any unknown names it surfaces. The wizard subscribes to `getBatch` and
 * calls `recordDecision` once per row as the user reviews. `commitCardChecklist`
 * (admin-gated) reads the finished batch to resolve its decisions, then
 * schedules `cleanupBatch`. A decision is create, link, or — NEO-212 — skip
 * ("not a person / not a team"): a skipped row creates and links nothing, the
 * card keeps the raw name as free text, and commit records the name in
 * `entityReviewSkips` so it stays out of this set's wizard on later fetches.
 * `cancelBatch` is the wizard's Cancel action — it only ever touches these
 * throwaway rows, never `players`/`teams`/`cardChecklist`. Every public
 * function here is admin-gated (requireAdmin), matching every other function
 * in selectorOptions.ts — even though the blast radius of this table alone is
 * small, there's no reason a non-admin should be able to read/mutate it at all.
 */

const enrichmentValidator = v.object({
  wikidataId: v.optional(v.string()),
  careerTeams: v.optional(v.array(v.object({
    name: v.string(),
    fromYear: v.number(),
    toYear: v.optional(v.number()),
    // NEO-236: the team's own Wikidata QID — see schema.ts. Linkage only.
    wikidataId: v.optional(v.string()),
  }))),
  // NEO-235, player-only: Wikidata teams with no usable start year. Names
  // only — they cannot become `teamYears` entries (which require `fromYear`)
  // and are surfaced so the operator can see what was found. See schema.ts.
  undatedCareerTeams: v.optional(v.array(v.string())),
  isHallOfFame: v.optional(v.boolean()),
  // NEO-212: player-only disambiguation context from Wikidata. See the
  // entityReviewQueue.enrichment comment in schema.ts.
  description: v.optional(v.string()),
  birthYear: v.optional(v.number()),
  enwikiTitle: v.optional(v.string()),
  // NEO-254: league-only pre-fill from `adapters/wikidata.lookupLeague`. Kept
  // in step with schema.ts — see the note on `activeInSetYear` below for what
  // a field in one and not the other costs at runtime.
  abbreviation: v.optional(v.string()),
  // NEO-254, team-only — see schema.ts. Kept in step with it deliberately.
  leagueWikidataId: v.optional(v.string()),
  // NEO-254, player-only: the NB rows already filed under this name, present
  // only when there is MORE THAN ONE of them. See schema.ts, and
  // `players.buildExistingPlayerCandidates` for who fills it in.
  existingCandidates: v.optional(v.array(v.object({
    playerId: v.id("players"),
    name: v.string(),
    birthYear: v.optional(v.number()),
    careerSummary: v.string(),
    // NEO-254: the alias that answered, when it was not the primary name.
    // Kept in step with schema.ts — see the note below on what a field in one
    // and not the other costs at runtime.
    matchedAlias: v.optional(v.string()),
    // NEO-254: this candidate has a stint covering the SET'S year.
    //
    // This object is a hand-kept copy of the schema's, and a field added to
    // one and not the other is not a type error — it is a RUNTIME refusal on
    // every function that returns a row (`getBatch`, `entityReviewRowValidator`
    // below), which is the wizard failing to open at all. Anything added to
    // `entityReviewQueue.enrichment.existingCandidates` in schema.ts belongs
    // here in the same edit.
    activeInSetYear: v.optional(v.boolean()),
  }))),
  league: v.optional(v.string()),
  // NEO-236: the place part of the team name. Location, not city.
  location: v.optional(v.string()),
  yearsActive: v.optional(v.object({
    from: v.number(),
    to: v.optional(v.number()),
  })),
  colors: v.optional(v.object({
    primary: v.optional(v.string()),
    secondary: v.optional(v.string()),
  })),
  espnId: v.optional(v.string()),
});

// Manual career-team entries the admin can add for a player row in the
// wizard (see recordDecision). Kept as a standalone validator so both the
// stored `decision` shape and recordDecision's args validate identically.
const manualCareerTeamValidator = v.object({
  name: v.string(),
  fromYear: v.number(),
  toYear: v.optional(v.number()),
});

/**
 * NEO-236 — the operator's Location + Name for a team-kind create decision.
 *
 * The whole point is that neither half is the raw checklist string: the wizard
 * pre-fills them (splitting on the ESPN location when it is a whole-word
 * prefix) and the operator confirms or corrects. `teamRowFields` composes them
 * back into the stored name and its dedup key at commit.
 */
/**
 * NEO-254 — the three kinds a review row can be, in walk order.
 *
 * One constant rather than the union written out at each of the two row
 * validators: they describe the same column, and a kind added to one and not
 * the other is a runtime refusal on whichever function returns the row.
 */
const kindValidator = v.union(
  v.literal("player"),
  v.literal("team"),
  v.literal("league"),
);

/**
 * NEO-254 — the whole league record a New League step collects.
 *
 * Mirrors `convex/schema.ts`. Every field but `name` is optional and means
 * "not answered" when absent — `findOrCreateLeague` gap-fills, so an absent
 * field never clears an existing row's value.
 */
const leagueCreateValidator = v.object({
  name: v.string(),
  abbreviation: v.optional(v.string()),
  level: v.optional(leagueLevelValidator),
  yearsActive: v.optional(v.object({
    from: v.number(),
    to: v.optional(v.number()),
  })),
  aliases: v.optional(v.array(v.string())),
  wikidataId: v.optional(v.string()),
});

const teamCreateValidator = v.object({
  location: v.optional(v.string()),
  name: v.string(),
  /**
   * NEO-236 — the league the operator chose on the New Team step.
   *
   * `leagueId` is a UNION with null on purpose: an id is "this league", null is
   * "no league, deliberately", and ABSENT is "not answered" — which is the only
   * one of the three that lets the prelude fall back to the enrichment's P118
   * label and then to the sport default. Without the null case an operator
   * could not say that a team belongs to no league at all, and the sport
   * default would silently reassert itself.
   *
   * `leagueName` names a league we hold no row for, which the prelude creates
   * through `findOrCreateLeague`. See schema.ts for the long version.
   */
  leagueId: v.optional(v.union(v.id("leagues"), v.null())),
  leagueName: v.optional(v.string()),
  /**
   * ── NEO-254: the era the operator typed, and why it must travel ──────────
   *
   * A sport can hold two teams under one name — the 1972-1996 Winnipeg Jets
   * and the 2011- Jets — and the era is the only thing that tells them apart.
   * Without it on this payload the operator could type "Winnipeg Jets,
   * 1972-1996" into a 1985 set's New Team step, the prelude would see a create
   * with no dates, adopt the 2011 row it already held, and every 1985 card in
   * the set would bind to a franchise that did not exist yet.
   *
   * Optional, and stays optional: most teams are created without anybody
   * knowing or caring, and an undated row is a normal row. It matters exactly
   * when the name is already taken, which is when the form asks for it.
   */
  yearsActive: v.optional(v.object({
    from: v.number(),
    to: v.optional(v.number()),
  })),
});

/**
 * NEO-236 — the same, per accepted career team on a player-kind decision,
 * keyed by the label the wizard showed (`sourceName`).
 */
const careerTeamCreateValidator = v.object({
  sourceName: v.string(),
  location: v.optional(v.string()),
  name: v.string(),
});

const decisionValidator = v.union(
  v.object({
    action: v.literal("create"),
    manualCareerTeams: v.optional(v.array(manualCareerTeamValidator)),
    // NEO-212: Wikidata career-team labels the admin unchecked in the wizard.
    // Commit must not create team rows for these. See schema.ts.
    excludedCareerTeamNames: v.optional(v.array(v.string())),
    // NEO-236: team-kind only — the Location + Name a `teams` row is built
    // from. Without it the prelude creates nothing. See schema.ts.
    create: v.optional(teamCreateValidator),
    // NEO-236: player-kind only — Location + Name for each accepted career
    // team that matched no existing row. See schema.ts.
    createTeams: v.optional(v.array(careerTeamCreateValidator)),
    // NEO-254: league-kind only — the whole record. See schema.ts.
    createLeague: v.optional(leagueCreateValidator),
  }),
  v.object({
    action: v.literal("link"),
    linkedPlayerId: v.optional(v.id("players")),
    linkedTeamId: v.optional(v.id("teams")),
    // NEO-254: league-kind only. Every team naming this league then uses it.
    linkedLeagueId: v.optional(v.id("leagues")),
  }),
  // NEO-212: "not a person / not a team" — the card keeps the raw name, and
  // nothing is created or linked. See schema.ts.
  v.object({ action: v.literal("skip") }),
);


// Upper bound on how many career-team entries an admin can attach to a single
// player row in the wizard. Not a security boundary (this path is admin-gated)
// — a guard rail against an unbounded write reaching players.teamYears in
// commitCardChecklist. A real player's career spans a handful of teams; 64 is
// generous headroom.
const MAX_MANUAL_CAREER_TEAMS = 64;

// NEO-212: same guard rail, same reasoning, for the unchecked-Wikidata-team
// exclusion list. Bounded independently of MAX_MANUAL_CAREER_TEAMS because the
// two lists are populated from different places (hand-typed vs. Wikidata's
// careerTeams), even though the number happens to match.
const MAX_EXCLUDED_CAREER_TEAM_NAMES = 64;

/**
 * NEO-248 — a career-team name the OPERATOR typed is refused, not dropped.
 *
 * The staging loop skips an over-long name silently, and that is right for the
 * text it was written for: a Wikidata P54 label nobody on our side chose, where
 * one absurd label must not cost the player every other career-team step. It is
 * wrong for a name the operator typed into the entry form — there, a silent
 * drop is the same failure NEO-248 exists to remove, arriving through a
 * different door: the chip appears, the step never does, and nothing says why.
 *
 * So the two hand-typed boundaries (`stageCareerTeamRows.careerTeams` and
 * `recordDecision.manualCareerTeams`) check the bound themselves and throw
 * before the loop can swallow it.
 *
 * `ConvexError`, because only that survives Convex's error boundary with its
 * message intact — a plain `Error` reaches the browser as "Server Error". And
 * the message carries the LENGTH, never the name: it reaches Sentry and the
 * browser console, the same rule `requireTeamCreate` follows.
 */
function assertCareerTeamNameLength(name: string): void {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length <= MAX_TEAM_FULL_NAME_LENGTH) return;
  throw new ConvexError(
    `A team name is ${trimmed.length} characters; the limit is ${MAX_TEAM_FULL_NAME_LENGTH}.`,
  );
}

/**
 * The loose bounds a career stint's years have to sit inside, in the one place
 * both writers can reach.
 *
 * NEO-248 put a SECOND route into the same numbers — `stageCareerTeamRows` now
 * carries the operator's years so the wizard can rebuild the chip after the
 * team's own step, and years that reach `entityReviewQueue.source` must be
 * exactly as well-formed as the ones that reach `decision.manualCareerTeams`,
 * because the same pair ends up in `players.teamYears` either way. Two copies
 * of the rule is how one of them drifts.
 *
 * `forName` reproduces `recordDecision`'s existing message verbatim — those
 * strings are asserted — and is omitted by the staging path, where the caller
 * is answering for one entry at a time and the name adds nothing.
 */
function assertCareerStintYears(
  fromYear: number,
  toYear: number | undefined,
  maxYear: number,
  forName?: string,
): void {
  const suffix = forName === undefined ? "" : ` for "${forName}"`;
  if (
    !Number.isInteger(fromYear) ||
    fromYear < MIN_CAREER_YEAR ||
    fromYear > maxYear
  ) {
    throw new Error(
      `Invalid career-team fromYear ${fromYear}${suffix} (expected an integer in ${MIN_CAREER_YEAR}–${maxYear})`,
    );
  }
  if (toYear === undefined) return;
  if (!Number.isInteger(toYear) || toYear > maxYear || toYear < fromYear) {
    throw new Error(
      `Invalid career-team toYear ${toYear}${suffix} (expected an integer between fromYear ${fromYear} and ${maxYear})`,
    );
  }
}

/**
 * NEO-212: validate and normalize the Wikidata career-team labels an admin
 * unchecked for a "create" decision.
 *
 * Trims each entry and rejects a blank one — a blank label can never match an
 * `enrichment.careerTeams[].name`, so it is always operator/UI error rather
 * than a harmless no-op worth swallowing. Caps the array for the same reason
 * the manual entries are capped. Dedupes case-insensitively (keeping first
 * appearance, and the original casing) so commit compares against a clean set
 * and the stored decision stays readable as an audit record.
 */
function normalizeExcludedCareerTeamNames(
  names: ReadonlyArray<string>,
): string[] {
  if (names.length > MAX_EXCLUDED_CAREER_TEAM_NAMES) {
    throw new Error(
      `Too many excluded career-team names (${names.length}); the maximum is ${MAX_EXCLUDED_CAREER_TEAM_NAMES}`,
    );
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name.length === 0) {
      throw new Error("Excluded career-team name cannot be empty");
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(name);
  }
  return normalized;
}

/**
 * Mirrors `MAX_TEAM_NAME_LENGTH` in convex/teams.ts (120). Copied rather than
 * imported because `teams.ts` does not export it and this module has no other
 * reason to depend on it; the bound is applied to the COMPOSED full name, which
 * is what `teams.findOrCreate` bounds, so the two agree on what they measure.
 */
const MAX_TEAM_FULL_NAME_LENGTH = 120;

/**
 * Upper bound on per-career-team create entries carried on one decision. Same
 * shape of guard rail, and the same generosity, as MAX_MANUAL_CAREER_TEAMS —
 * this list can never be longer than the accepted career teams it answers.
 */
const MAX_CAREER_TEAM_CREATES = 64;

/**
 * NEO-254 — how many League steps one team row may raise.
 *
 * A team belongs to ONE league, so the real number is one; the headroom is
 * for a team whose enrichment names a league and whose operator then types a
 * different one before the first is answered. A guard rail on an unbounded
 * write, not a security boundary — the same job, and the same reasoning, as
 * `MAX_CAREER_TEAM_CREATES` above.
 */
const MAX_STAGED_LEAGUES_PER_TEAM = 4;


/**
 * NEO-236: normalize one Location + Name, or answer "this is not usable".
 *
 * Trims both and drops an empty location — a blank Location is "this name
 * carries no place at all" ("Athletics", "Orix Buffaloes"), a real answer
 * rather than an unfinished form. A college side is NOT one of those: its
 * school is its location ("San Diego State" / "Aztecs").
 *
 * The length bound is on the COMPOSED name, because that is what lands
 * in `teams.name` + `teams.location` and what `teams.findOrCreate` measures.
 *
 * ## Why this returns null instead of throwing
 *
 * Security review, finding 3. Two callers feed this text the operator NEVER
 * TYPED: the bulk fast path pre-fills from `row.name`, which is a raw,
 * unbounded marketplace string, and the wizard defaults each career-team pair
 * to a raw Wikidata P54 label. A throw there aborted the whole action — one
 * 200-character checklist row turned "Add All Remaining as New" into a
 * redacted "Server Error" and decided nothing, with no way for the operator to
 * find or fix the offending row.
 *
 * So the shared rule is fail-soft, and each caller decides what an unusable
 * pair means for it. Dropping is safe because every path already handles the
 * absence: the commit prelude treats a missing `create` as "nothing inserted,
 * name reported unresolved", which is the attention walker's missing-team lane
 * — the operator still gets the row, just later and with a UI in front of it.
 * `requireTeamCreate` is the one place a refusal is still right.
 *
 * Deliberately does NOT normalize case or punctuation — that is the dedup
 * key's job (`teamRowFields`), and the operator's own spelling is what should
 * be stored.
 */
function toTeamCreate(input: TeamCreateInput): TeamCreate | null {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length === 0) return null;
  const location = input.location?.trim().replace(/\s+/g, " ") || undefined;
  const fullLength = location ? location.length + 1 + name.length : name.length;
  if (fullLength > MAX_TEAM_FULL_NAME_LENGTH) return null;
  return {
    name,
    ...(location ? { location } : {}),
    ...normalizeLeagueChoice(input),
    /*
     * NEO-254 — the era passes through, and it is what tells the 1972-1996
     * Winnipeg Jets from the 2011- ones.
     *
     * Validated rather than merely copied: these two numbers decide which of
     * two same-named franchises a whole set's cards bind to, and a decision is
     * a durable record the commit reads much later with no operator in front
     * of it. Refused, not dropped — the operator is standing at the form and
     * an era they cannot see stored is worse than one they are told about.
     */
    ...(input.yearsActive ? { yearsActive: requireTeamEra(input.yearsActive) } : {}),
  };
}

/**
 * NEO-254 — whole years, in range, ending no earlier than they start.
 *
 * The same shape and the same bounds `leagues.validateLeagueYears` applies to
 * a league's era; a team's era answers the same question about the same kind
 * of thing, and two rules for one idea is one more thing to look up.
 */
function requireTeamEra(era: { from: number; to?: number }): {
  from: number;
  to?: number;
} {
  const maxYear = new Date().getFullYear() + 1;
  if (!Number.isInteger(era.from) || era.from < MIN_CAREER_YEAR || era.from > maxYear) {
    throw new ConvexError(
      `A team start year must be a whole year between ${MIN_CAREER_YEAR} and ${maxYear}.`,
    );
  }
  if (era.to !== undefined) {
    if (!Number.isInteger(era.to) || era.to < MIN_CAREER_YEAR || era.to > maxYear) {
      throw new ConvexError(
        `A team end year must be a whole year between ${MIN_CAREER_YEAR} and ${maxYear}.`,
      );
    }
    if (era.to < era.from) {
      throw new ConvexError("A team cannot stop playing before it starts.");
    }
  }
  return { from: era.from, ...(era.to !== undefined ? { to: era.to } : {}) };
}

/**
 * NEO-236 — the league half of a team create decision, normalized.
 *
 * `leagueId` passes through untouched INCLUDING null, because null is an
 * answer ("no league") and dropping it would be read as "not answered", which
 * is the one state that lets the sport default back in.
 *
 * `leagueName` is only meaningful when no id was given — the two are answers to
 * the same question, and an id is the more specific one. It is trimmed, and an
 * over-long one is DROPPED rather than thrown on, for the same fail-soft reason
 * `toTeamCreate` drops an unusable name: the string is a Wikidata P118 label
 * the operator merely accepted, not something they typed, and losing the league
 * suggestion is a far smaller harm than losing the whole decision. The prelude
 * re-validates through `requireValidLeagueName` regardless.
 */
function normalizeLeagueChoice(input: {
  leagueId?: Id<"leagues"> | null;
  leagueName?: string;
}): { leagueId?: Id<"leagues"> | null; leagueName?: string } {
  if (input.leagueId !== undefined) return { leagueId: input.leagueId };
  const leagueName = input.leagueName?.trim().replace(/\s+/g, " ");
  if (!leagueName || leagueName.length > MAX_LEAGUE_NAME_LENGTH) return {};
  return { leagueName };
}

/** The Location + Name + League a team row is created from. */
type TeamCreate = {
  location?: string;
  name: string;
  leagueId?: Id<"leagues"> | null;
  leagueName?: string;
  /** NEO-254 — the era the operator typed. See `teamCreateValidator`. */
  yearsActive?: { from: number; to?: number };
};
type TeamCreateInput = TeamCreate;



/**
 * NEO-236: the same, where a refusal IS the right answer — the operator typed
 * these two fields into the wizard's Location and Team name inputs and pressed
 * a button that says it will create a team.
 *
 * Silently dropping here would be the worse failure: the wizard would report
 * the row decided, commit would create nothing, and the only trace would be a
 * name in `unresolvedTeamNames`. So it throws — as `ConvexError`, not a plain
 * `Error`, because only `ConvexError` survives Convex's error boundary with
 * its message intact; a plain `Error` reaches the browser redacted to "Server
 * Error" and tells the operator nothing about what to change.
 *
 * The message carries the LENGTH, never the name — the same rule
 * `teams.findOrCreate` follows, because this string reaches Sentry and the
 * browser console.
 */
function requireTeamCreate(input: TeamCreateInput): TeamCreate {
  const normalized = toTeamCreate(input);
  if (normalized) return normalized;
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length === 0) {
    throw new ConvexError("Enter a team name before adding it.");
  }
  const location = input.location?.trim().replace(/\s+/g, " ") || undefined;
  const fullLength = location ? location.length + 1 + name.length : name.length;
  throw new ConvexError(
    `A team name is ${fullLength} characters; the limit is ${MAX_TEAM_FULL_NAME_LENGTH}.`,
  );
}

/**
 * NEO-236: validate the per-career-team Location + Name list.
 *
 * Each entry names the proposal it answers (`sourceName`), which must be
 * non-empty for the same reason an excluded name must: a blank one can never
 * match a career-team label, so it would silently do nothing. Deduped by the
 * normalized `sourceName`, keeping the FIRST entry — commit looks the list up
 * by that key, so two entries for one label would make the outcome depend on
 * iteration order.
 */
function normalizeCareerTeamCreates(
  entries: ReadonlyArray<{ sourceName: string; location?: string; name: string }>,
): Array<{ sourceName: string; location?: string; name: string }> {
  if (entries.length > MAX_CAREER_TEAM_CREATES) {
    throw new Error(
      `Too many career-team create entries (${entries.length}); the maximum is ${MAX_CAREER_TEAM_CREATES}`,
    );
  }
  const seen = new Set<string>();
  const out: Array<{ sourceName: string; location?: string; name: string }> = [];
  for (const entry of entries) {
    const sourceName = entry.sourceName.trim();
    if (sourceName.length === 0) {
      throw new Error("Career-team source name cannot be empty");
    }
    const key = sourceName.toLowerCase();
    if (seen.has(key)) continue;
    // NEO-236 security review, finding 3: an unusable pair is DROPPED, not
    // thrown on. The wizard defaults each of these to a raw Wikidata P54
    // label, so an over-long label is text the operator never typed — and
    // throwing would abort the whole create decision (the player row, its
    // exclusions, its hand-typed stints) over one career team. Dropped, the
    // label falls back to link-or-leave: commit still links it if we hold the
    // team, and otherwise omits that one stint.
    //
    // `sourceName` still throws, and the asymmetry is deliberate: a blank
    // sourceName cannot come from typing at all (the wizard always supplies
    // the label it is answering), so it is a client bug worth failing loudly
    // on rather than a value to tolerate.
    const create = toTeamCreate(entry);
    if (!create) continue;
    seen.add(key);
    out.push({ sourceName, ...create });
  }
  return out;
}

/**
 * NEO-236 — a row the batch staged for itself rather than reading off the
 * checklist. See the `source` field in schema.ts for why these exist.
 */
const rowSourceValidator = v.union(
  v.object({
    kind: v.literal("careerTeamOf"),
    playerRowId: v.id("entityReviewQueue"),
    wikidataId: v.optional(v.string()),
    // NEO-248 — the years the operator typed alongside the name, on the step
    // that staged this one. Hand-typed entries only; see schema.ts.
    manualStint: v.optional(v.object({
      fromYear: v.number(),
      toYear: v.optional(v.number()),
    })),
  }),
  // NEO-254 — the same relationship one level up. A league has no
  // `manualStint`: NEO-248's field records the years typed for a career TEAM,
  // and a league's dates live on the record its own step collects. See
  // schema.ts.
  v.object({
    kind: v.literal("leagueOf"),
    teamRowId: v.id("entityReviewQueue"),
    wikidataId: v.optional(v.string()),
  }),
);

// `createdByUserId` is audit/scoping-only — see toPublicRow below. Mirrors
// the players.ts/teams.ts pattern: internalQuery reads the full row,
// public query strips this field before it reaches the client.
const rowValidator = v.object({
  _id: v.id("entityReviewQueue"),
  _creationTime: v.number(),
  selectorOptionId: v.id("selectorOptions"),
  batchId: v.string(),
  createdByUserId: v.string(),
  kind: kindValidator,
  name: v.string(),
  // NEO-236 — the dedup key staging reads through an index. See schema.ts.
  nameNormalized: v.optional(v.string()),
  // NEO-96: reference to the sport-level selectorOptions row.
  sportId: v.id("selectorOptions"),
  // NEO-236 — set only on a row this batch staged for itself.
  source: v.optional(rowSourceValidator),
  status: v.union(v.literal("pending"), v.literal("ready"), v.literal("error")),
  enrichment: v.optional(enrichmentValidator),
  decision: v.optional(decisionValidator),
  // NEO-221 — see schema.ts. Read only by `sweepAbandonedBatches`.
  lastTouchedAt: v.optional(v.number()),
});

const publicRowValidator = v.object({
  _id: v.id("entityReviewQueue"),
  _creationTime: v.number(),
  selectorOptionId: v.id("selectorOptions"),
  batchId: v.string(),
  kind: kindValidator,
  name: v.string(),
  nameNormalized: v.optional(v.string()),
  sportId: v.id("selectorOptions"),
  /**
   * NEO-236 — projected, not stripped. It carries no identity (a review-row id
   * the client already holds, and a Wikidata QID), and the wizard needs all of
   * it: `playerRowId` is how the New Team step names who needs the team and how
   * the player's step tells an answered chip from a waiting one.
   */
  source: v.optional(rowSourceValidator),
  // NEO-96: the sport row's display value, resolved server-side so the wizard
  // can render "(Player \u00b7 Baseball)" without a client-side join.
  sportValue: v.string(),
  status: v.union(v.literal("pending"), v.literal("ready"), v.literal("error")),
  enrichment: v.optional(enrichmentValidator),
  decision: v.optional(decisionValidator),
  // NEO-221. Projected rather than stripped: it is a timestamp of the
  // operator's own activity, not an identity, so there is nothing to withhold
  // — and `toPublicRow` only removes `createdByUserId`, so omitting it here
  // would make `getBatch`'s return validator reject its own rows.
  lastTouchedAt: v.optional(v.number()),
});

/**
 * NEO-96: resolve a sport row id to its display value. Used for human-facing
 * error text and for the `sportValue` the wizard renders. Falls back to the raw
 * id rather than throwing — a dangling reference should surface as an odd label
 * in one message, not break the whole review flow.
 */
async function sportLabel(
  ctx: { db: { get: (id: Id<"selectorOptions">) => Promise<Doc<"selectorOptions"> | null> } },
  sportId: Id<"selectorOptions">,
): Promise<string> {
  const row = await ctx.db.get(sportId);
  return row?.value ?? sportId;
}

/**
 * NEO-221 — defence in depth: an admin may only act on their OWN review batch.
 *
 * `requireAdmin` is the real gate and every function here already runs it; the
 * blast radius of this table is a handful of throwaway rows. This is the
 * second layer, and it exists because batches are deliberately scoped per user
 * (see `startBatch` and the schema note): two admin sessions — or, in Maestro
 * CI, two workers each authenticated as a distinct admin test account — hold
 * separate batches over the SAME set at the same time. A row id or a batchId
 * from the wrong session is far likelier to be a stale client than an attack,
 * and either way the right answer is to refuse rather than to silently
 * overwrite or delete a colleague's in-progress review.
 *
 * `createdByUserId` is written from `getCurrentUserId` at the fetch that
 * started the batch (selectorOptions.ts), and `requireAdmin` returns the same
 * `identity.subject` — the two are the same identity form, which is what makes
 * comparing them meaningful rather than accidentally always-false.
 */
function assertOwnsRow(
  row: { createdByUserId: string },
  callerId: string,
): void {
  if (row.createdByUserId !== callerId) {
    throw new Error("This review row belongs to a different review session");
  }
}

function toPublicRow<T extends { createdByUserId: string }>(
  row: T,
): Omit<T, "createdByUserId"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { createdByUserId: _omit, ...rest } = row;
  return rest;
}

/**
 * Start (or resume) a review batch for a selectorOption, scoped to the
 * calling user. Called from fetchCardChecklist's action via ctx.runMutation
 * — internal, no public surface needed since only that action calls it.
 *
 * If a batch already exists for this (selectorOptionId, createdByUserId)
 * pair, resume it (return its id, touch nothing) rather than deleting +
 * restarting: a batch only exists while mid-review (commit and cancel both
 * delete their batch's rows on completion), so finding one means this SAME
 * user's previous tab/click is still reviewing it — silently discarding
 * that progress would be a real bug. This holds even once every row is
 * decided but not yet committed (the wizard's final "All reviewed — save?"
 * screen) — a page refresh in that state should resume the same
 * fully-decided batch, not lose it.
 *
 * Scoping by user (not just selectorOptionId) is what makes this safe under
 * concurrent access to the same set: two different users (or, in Maestro
 * E2E, two different CI workers each authenticated as a distinct test
 * account) fetching the SAME real marketplace variant each get their own
 * private batch instead of sharing/colliding on one. This isn't only a test
 * concern — two admin sessions (or the same admin in two tabs) reviewing
 * the same set concurrently should behave the same way.
 *
 * Safe to key resumption purely on "any row exists for this user" (not "any
 * UNDECIDED row") because commitCardChecklist deletes a batch's rows
 * SYNCHRONOUSLY, in the same transaction as the commit itself — there is no
 * async window where a fully-decided batch could be observed here after
 * it's already been committed. See the delete site in commitCardChecklist
 * for why that matters (an earlier scheduled-delete version of this had
 * exactly that race).
 *
 * ## NEO-221 — resume RECONCILES rather than returning the batch untouched
 *
 * "Touch nothing" was right while the only way back into a resumed batch was
 * an identical re-fetch. It stopped being right once the wizard could hand the
 * operator back to card matching and return (NEO-220's "Back to matching"):
 * the second Confirm can legitimately carry a DIFFERENT name set — a pairing
 * the operator linked no longer contributes its unmatched name, a rename
 * introduces one — and a batch frozen at the first Confirm's names would ask
 * about names no card carries any more while never asking about the new ones.
 * Commit would then find no decision for a real name and leave the card
 * unlinked, which is precisely the failure this ticket exists to remove.
 *
 * So a resume reconciles the batch against the incoming names, keyed by
 * `kind` + the SAME normalizer the players/teams tables dedupe on
 * (`normalizePlayerName`/`normalizeTeamName`), so a re-spelling of one name is
 * a match rather than an add plus a drop:
 *
 *   - a key present on both sides keeps its row, and therefore its decision,
 *     its enrichment and its status — reconciliation never re-asks something
 *     the operator has already answered;
 *   - a key only in the incoming set gets a fresh `pending` row (same shape as
 *     a first-time insert) and a lookup scheduled for it — and ONLY for it, so
 *     resuming does not re-run the whole batch's Wikidata work;
 *   - a key only on the existing side is dropped ONLY IF the operator never
 *     ruled on it AND the row came from the incoming set in the first place
 *     (NEO-236: a staged career team never does — see the guard). An UNDECIDED row for a name no card carries any more is a
 *     question about nothing, and leaving it would block the wizard's
 *     "all reviewed" on it forever. A DECIDED row is kept, whatever the
 *     incoming set says.
 *
 * ## Why a decided row is never deleted here
 *
 * Reconciliation is ADDITIVE about the operator's work, in exactly the sense
 * the sync boundary is additive about NB's data. The incoming name list is
 * derived — from a marketplace payload, through a pairing session an operator
 * can still change their mind about — so "this name is not in the list any
 * more" is a statement about that derivation, not evidence that the human's
 * ruling was wrong. Deleting on it would let a re-pair silently discard a
 * decision, and the operator's only clue would be a name they have to rule on
 * twice. A kept-but-unused decision costs one throwaway row; the batch is
 * deleted wholesale at commit, cancel, or by the abandoned-batch sweep.
 *
 * Every surviving row is stamped `lastTouchedAt`: coming back to a batch is
 * proof of life, and a session an operator has just re-entered must not look
 * abandoned to the sweep.
 *
 * The `batchId` is preserved throughout, because the client is already holding
 * it and a new one would strand the open wizard.
 */
/**
 * NEO-254 — the enrichment a review row is BORN with.
 *
 * ## Why ambiguity is attached here and not only when the lookup lands
 *
 * `applyLookupResult` computes `existingCandidates` too, and for a while that
 * was the only place it happened. That left the marker missing on every row
 * whose lookup never produced one:
 *
 *   - `backstopEntityReviewRowImpl` settles a stranded row to "error" without
 *     going near `players`;
 *   - `sweepStalePendingRows` does the same for a row the pool lost entirely;
 *   - and any row already sitting in the queue at deploy time never re-runs
 *     its lookup at all.
 *
 * A row in any of those states is indistinguishable, to every consumer, from
 * a name nobody has ever heard of — so the wizard would promote one of two
 * same-name players to its one-tap primary, and the bulk create would mint a
 * third. The ambiguity is knowable the moment the row is inserted, from
 * `players` alone, with no network anywhere in it. So it is written then, and
 * the lookup merely REFRESHES it.
 *
 * Returns `undefined` rather than an empty object for an unambiguous name, so
 * an ordinary row is stored byte-identical to how it was before this existed.
 */
async function initialEnrichmentFor(
  ctx: MutationCtx,
  kind: "player" | "team",
  name: string,
  sportId: Id<"selectorOptions">,
  /**
   * NEO-254 — the set's own year, so each candidate can be marked as active in
   * it. Resolved once by the caller and passed down: it is one ancestor walk
   * per BATCH, not one per name.
   */
  cardYear: number | undefined,
): Promise<{ existingCandidates: Awaited<ReturnType<typeof buildExistingPlayerCandidates>> } | undefined> {
  if (kind !== "player") return undefined;
  const existingCandidates = await buildExistingPlayerCandidates(ctx, name, sportId, {
    cardYear,
  });
  return existingCandidates.length > 0 ? { existingCandidates } : undefined;
}

export const startBatch = internalMutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    createdByUserId: v.string(),
    sportId: v.id("selectorOptions"),
    playerNames: v.array(v.string()),
    teamNames: v.array(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    // NEO-254 — the set's own year, walked ONCE per batch rather than once per
    // name. It only labels which same-name candidates were active that year;
    // an undefined year simply leaves every candidate unlabelled.
    const setYear = await findSetYearForSelectorOption(ctx, args.selectorOptionId);
    // Keyed the same way on both sides of the reconciliation below, and by
    // the same normalizers `players`/`teams` dedupe on, so "J.T. Realmuto"
    // and "JT Realmuto" are one name here exactly as they are one row there.
    /*
     * NEO-254 — a league key uses `normalizeLeagueName`, which does NOT
     * token-sort.
     *
     * `normalizeTeamName` sorts tokens so "San Diego Padres" and
     * ("San Diego", "Padres") land on one key. That is exactly wrong for a
     * league: "National League" and "League National" are not the same
     * competition, and `convex/leagues.ts` says so in its own normaliser. The
     * kind prefix keeps the two key spaces apart, so a league and a team of
     * the same name never collide here either.
     */
    const keyFor = (kind: "player" | "team" | "league", name: string) =>
      kind === "player"
        ? `player:${normalizePlayerName(name)}`
        : kind === "league"
          ? `league:${normalizeLeagueName(name)}`
          : `team:${normalizeTeamName(name)}`;

    const existing = await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_selector_option_and_user", (q) =>
        q
          .eq("selectorOptionId", args.selectorOptionId)
          .eq("createdByUserId", args.createdByUserId),
      )
      .first();

    if (existing) {
      const batchId = existing.batchId;
      // Scoped to the resumed batch itself, not to every row this user has for
      // this selectorOption: one user only ever holds one batch at a time (a
      // commit or a cancel deletes it), and reading through the batch index
      // keeps that assumption from silently deleting a stray row from another.
      const existingRows = await ctx.db
        .query("entityReviewQueue")
        .withIndex("by_selector_option_and_batch", (q) =>
          q.eq("selectorOptionId", args.selectorOptionId).eq("batchId", batchId),
        )
        .collect();

      // Incoming names, deduped by key so two spellings of one name cannot
      // insert two rows. First spelling wins, matching how
      // `resolveUnknownsAndStartBatch` picks the label it surfaces.
      const incoming = new Map<string, { kind: "player" | "team"; name: string }>();
      for (const name of args.playerNames) {
        const key = keyFor("player", name);
        if (!incoming.has(key)) incoming.set(key, { kind: "player", name });
      }
      for (const name of args.teamNames) {
        const key = keyFor("team", name);
        if (!incoming.has(key)) incoming.set(key, { kind: "team", name });
      }

      const now = Date.now();
      const existingKeys = new Set<string>();
      /*
       * NEO-236 security review, finding 4 — a staged step whose player is gone.
       *
       * The exemption below keeps every `careerTeamOf` row through
       * reconciliation, because its name is never in the incoming list. That is
       * right while the player it was staged for is still in the batch, and
       * wrong once the player has been reconciled away: the step then asks the
       * operator to create a team that nothing needs, and blocks "all reviewed"
       * on it forever. So an UNDECIDED orphan is dropped in the same pass. A
       * DECIDED one is kept, for the same reason every decided row is — the
       * operator ruled on it, and the prelude will still honour that ruling.
       */
      const survivingRowIds = new Set(
        existingRows
          .filter((row) => incoming.has(keyFor(row.kind, row.name)) || row.decision !== undefined)
          .map((row) => row._id as string),
      );
      /**
       * NEO-254 — does this row's whole chain still stand?
       *
       * A staged row is NEVER in `incoming` (no card carries its name), so it
       * cannot be judged against `survivingRowIds` directly — that set only
       * means something for a row that came off the checklist. A staged row is
       * judged by its PARENT, recursively: a league by its team, and that team
       * by the player it was staged for. Judging a league against
       * `survivingRowIds` would delete every league under a live staged team,
       * because that team is not in the set either.
       *
       * A DECIDED row survives on its own account at every level — the
       * operator ruled on it, and the prelude will still honour that ruling.
       *
       * Depth is two by construction; the `seen` guard makes a cycle terminate
       * rather than wedge the mutation.
       */
      const rowsById = new Map(existingRows.map((r) => [r._id as string, r]));
      const rowSurvives = (
        row: Doc<"entityReviewQueue">,
        seen: Set<string> = new Set(),
      ): boolean => {
        if (row.decision !== undefined) return true;
        const id = row._id as string;
        if (seen.has(id)) return false;
        seen.add(id);
        const parentId =
          row.source?.kind === "careerTeamOf"
            ? (row.source.playerRowId as string)
            : row.source?.kind === "leagueOf"
              ? (row.source.teamRowId as string)
              : null;
        // Came off the checklist: still incoming, or it goes.
        if (parentId === null) return survivingRowIds.has(id);
        const parent = rowsById.get(parentId);
        return parent ? rowSurvives(parent, seen) : false;
      };

      for (const row of existingRows) {
        const key = keyFor(row.kind, row.name);
        // Recorded BEFORE the drop test, so a decided row that is no longer
        // incoming still suppresses a re-insert of its own name.
        existingKeys.add(key);
        if (
          !incoming.has(key) &&
          row.decision === undefined &&
          // NEO-236 — a row the BATCH staged for itself is never in the
          // incoming set, and never can be.
          //
          // The incoming list is the checklist's own player and team names. A
          // career team pulled off a player's Wikidata history is not one of
          // them — no card carries "Sydney Blue Sox" — so the drop test above
          // reads it as "a question about a name nothing needs" and deletes it.
          // It is the opposite: it is a question the batch RAISED, about a team
          // one of its own players needs, and deleting it on a resume would
          // leave that player's chips reading "needs a team decision" with no
          // step left anywhere to answer. (Nothing re-stages it either: the
          // enrichment that staged it has already landed, and the wizard's
          // belt-and-braces pass fires once per row per session.)
          //
          // The rule the drop test encodes still holds, it just does not apply
          // here: reconciliation is about names DERIVED from the incoming set,
          // and `source` marks the rows that are not.
          row.source === undefined
        ) {
          // Gone from the incoming set and never ruled on — a question about
          // a name no card carries. A DECIDED row is kept; see the doc above.
          await ctx.db.delete(row._id);
          continue;
        }
        /*
         * NEO-236 security review, finding 4 / NEO-254 — a staged step is
         * exempt from the test above, but not from being orphaned.
         *
         * Its parent is judged by the SAME rule (still incoming, or decided),
         * so a step and the row that needs it are dropped together or kept
         * together. A league staged for a team that was reconciled away is the
         * league tier of the same defect: left behind, it is undecided, unowned
         * and blocks "all reviewed" forever.
         *
         * `survivingStagedRowIds` is TRANSITIVE, and that is load-bearing: a
         * staged row is never in `incoming` (no card carries its name), so a
         * naive `survivingRowIds` check would judge every league by a set its
         * live parent team is not in and delete the lot.
         */
        if (row.source !== undefined && !rowSurvives(row)) {
          await ctx.db.delete(row._id);
          continue;
        }
        // Re-entering the batch is operator activity. See the sweep.
        await ctx.db.patch(row._id, { lastTouchedAt: now });
      }

      const addedIds: Array<Id<"entityReviewQueue">> = [];
      for (const [key, { kind, name }] of incoming) {
        if (existingKeys.has(key)) continue;
        // NEO-254 — see `initialEnrichmentFor`. A row added by a resume is as
        // liable to be an ambiguous name as one from a fresh batch.
        const enrichment = await initialEnrichmentFor(
          ctx,
          kind,
          name,
          args.sportId,
          setYear,
        );
        addedIds.push(
          await ctx.db.insert("entityReviewQueue", {
            selectorOptionId: args.selectorOptionId,
            batchId,
            createdByUserId: args.createdByUserId,
            kind,
            name,
            // NEO-236: `key` IS that normalization — computed by `keyFor`
            // above with the kind prefix, which is stored as a separate
            // column. Slicing it keeps the two provably identical rather than
            // normalizing twice and hoping.
            nameNormalized: key.slice(kind.length + 1),
            sportId: args.sportId,
            status: "pending",
            ...(enrichment ? { enrichment } : {}),
          }),
        );
      }
      if (addedIds.length > 0) {
        // Only the ADDED rows. A resume must never re-enqueue a lookup that
        // already ran (or is running) — see the enqueue note on the fresh path
        // below, and NEO-99's creation-only enrichment contract.
        await ctx.scheduler.runAfter(
          0,
          internal.wikidataPool.enqueueEntityReviewLookups,
          { rowIds: addedIds },
        );
      }
      return batchId;
    }

    const batchId = crypto.randomUUID();
    const ids: Array<Id<"entityReviewQueue">> = [];
    for (const name of args.playerNames) {
      // NEO-254 — the row knows it is a choice before any lookup runs. See
      // `initialEnrichmentFor` for why that cannot wait for the lookup.
      const enrichment = await initialEnrichmentFor(
        ctx,
        "player",
        name,
        args.sportId,
        setYear,
      );
      ids.push(
        await ctx.db.insert("entityReviewQueue", {
          selectorOptionId: args.selectorOptionId,
          batchId,
          createdByUserId: args.createdByUserId,
          kind: "player",
          name,
          // NEO-236 — see the field's note in schema.ts.
          nameNormalized: normalizePlayerName(name),
          sportId: args.sportId,
          status: "pending",
          ...(enrichment ? { enrichment } : {}),
        }),
      );
    }
    for (const name of args.teamNames) {
      ids.push(
        await ctx.db.insert("entityReviewQueue", {
          selectorOptionId: args.selectorOptionId,
          batchId,
          createdByUserId: args.createdByUserId,
          kind: "team",
          name,
          nameNormalized: normalizeTeamName(name),
          sportId: args.sportId,
          status: "pending",
        }),
      );
    }
    if (ids.length > 0) {
      // NEO-99: hand the rows to the deployment-wide Wikidata pool
      // (convex/wikidataPool.ts) instead of a per-batch serial chain. Scheduled
      // rather than enqueued inline so THIS mutation — the one the user's fetch
      // is waiting on — stays a plain insert and never touches the pool
      // component; the scheduled `enqueueEntityReviewLookups` does the enqueuing
      // (chunked) in the background. Same start/enqueue split as
      // `startPlaceholderBatch` → `enqueueImageChunk`.
      await ctx.scheduler.runAfter(
        0,
        internal.wikidataPool.enqueueEntityReviewLookups,
        { rowIds: ids },
      );
    }
    return batchId;
  },
});

/**
 * NEO-254 — stage a New League step ahead of the TEAM row that needs it.
 *
 * ## The bug this closes
 *
 * Jason, preview test 2026-09-06: on a fresh deployment every hockey team row
 * offered `Create National Hockey League`. Nothing is written until commit, so
 * the 3rd team asked the same question as the 1st, and the 30th asked it
 * again — and whichever pill was finally pressed created a league carrying a
 * name and nothing else: no abbreviation, no level, no years, no aliases.
 * "The proper fix is pulling league up before team as we'll need to fill in
 * the rest of the year information too."
 *
 * So the league becomes a row of its own, walked BEFORE the team, asked ONCE
 * per batch, and answered with the whole record. This is `stageCareerTeamRows
 * Impl` one level up, and it is deliberately the same shape down to the
 * guard rails — a batch-wide index dedupe, a bound on the name, a cap counted
 * through `by_source_team` so re-entry cannot grow past it, and a hard refusal
 * to stage from a staged row (which is what keeps the chain two deep).
 *
 * ## What is NOT staged
 *
 *  - a league this sport already answers to, by name OR alias
 *    (`findLeagueByName`) — it exists, so there is nothing to ask;
 *  - a league already staged in this batch — the whole point;
 *  - a blank or unusable name.
 *
 * Returns the ids it inserted, so the caller can enqueue exactly those lookups
 * and nothing else.
 */
async function stageLeagueRowsImpl(
  ctx: MutationCtx,
  teamRow: Doc<"entityReviewQueue">,
  /**
   * League names the caller knows about that the row's own enrichment does
   * not — a name the operator typed into the team step's league field.
   */
  extraLeagueNames: ReadonlyArray<{ name: string; wikidataId?: string }> = [],
): Promise<Array<Id<"entityReviewQueue">>> {
  /*
   * Only a TEAM has a league.
   *
   * A team STAGED off a player's career list is included deliberately — a club
   * side pulled from a P54 statement needs its league asked about exactly as a
   * checklist team does, and that is the case Jason's hockey batch is made of.
   * The chain stops there: a league row stages nothing, so the depth is two by
   * construction rather than by this guard.
   */
  if (teamRow.kind !== "team") return [];

  const proposals: Array<{ name: string; wikidataId?: string }> = [
    ...(teamRow.enrichment?.league
      ? [
          {
            name: teamRow.enrichment.league,
            // NEO-254 — the P118 value's id, when the team's lookup got one.
            // The staged row's own lookup then READS that record rather than
            // searching for the label, which is the same argument NEO-236 made
            // for a career team's QID.
            ...(teamRow.enrichment.leagueWikidataId
              ? { wikidataId: teamRow.enrichment.leagueWikidataId }
              : {}),
          },
        ]
      : []),
    ...extraLeagueNames,
  ];
  if (proposals.length === 0) return [];

  /*
   * The cap is PER TEAM, not per call — the same finding NEO-236's security
   * review raised about career teams. Three callers can stage for one team
   * (the lookup landing, the wizard's belt-and-braces pass, and a hand-typed
   * league), so counting one invocation would let N calls mint N caps' worth.
   */
  const alreadyStagedForTeam = (
    await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_source_team", (q) => q.eq("source.teamRowId", teamRow._id))
      .collect()
  ).length;

  const added: Array<Id<"entityReviewQueue">> = [];
  const seen = new Set<string>();
  for (const proposal of proposals) {
    if (alreadyStagedForTeam + added.length >= MAX_STAGED_LEAGUES_PER_TEAM) break;
    const name = proposal.name.trim().replace(/\s+/g, " ");
    if (!name) continue;
    // `normalizeLeagueName`, NOT the team normaliser: it does not token-sort,
    // because "National League" and "League National" are different
    // competitions. See `convex/leagues.ts`.
    const nameNormalized = normalizeLeagueName(name);
    if (!nameNormalized || seen.has(nameNormalized)) continue;
    seen.add(nameNormalized);
    // Same reasoning as the team staging: a Wikidata label is text nobody on
    // our side vetted, and it reaches both `name` and the INDEX. Skipped
    // rather than thrown on — one absurd label must not cost the team its
    // step, and the team still resolves if we already hold the league.
    if (name.length > MAX_LEAGUE_NAME_LENGTH) continue;

    const alreadyInBatch = await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_batch_and_kind_and_name", (q) =>
        q
          .eq("selectorOptionId", teamRow.selectorOptionId)
          .eq("batchId", teamRow.batchId)
          .eq("kind", "league")
          .eq("nameNormalized", nameNormalized),
      )
      .first();
    if (alreadyInBatch) continue;
    /*
     * NEO-254 — and by QID, because one league has more than one name.
     *
     * ESPN calls it "NHL" and Wikidata calls it "National Hockey League", so
     * two teams in one batch routinely propose the same competition under
     * names that do not normalise to each other. Keyed only on the name, that
     * produced two steps and — worse — two `leagues` rows for one league,
     * which is precisely the duplication this feature exists to prevent.
     *
     * The QID is the identity Wikidata itself asserts, so a match on EITHER
     * key means the batch already holds this league. Read off the staged rows
     * for this batch rather than through an index (there is none on
     * `source.wikidataId`, and a batch's league rows are a handful).
     */
    if (proposal.wikidataId) {
      const sameQid = (
        await ctx.db
          .query("entityReviewQueue")
          .withIndex("by_selector_option_and_batch", (q) =>
            q
              .eq("selectorOptionId", teamRow.selectorOptionId)
              .eq("batchId", teamRow.batchId),
          )
          .collect()
      ).some(
        (r) =>
          r.kind === "league" &&
          r.source?.kind === "leagueOf" &&
          r.source.wikidataId === proposal.wikidataId,
      );
      if (sameQid) continue;
    }

    // Held already — including under an ALIAS, which is the case that makes
    // this worth a helper call rather than an index read: a sport that already
    // has "National Hockey League" with the alias "NHL" must not be asked to
    // create "NHL".
    if (await findLeagueByName(ctx, { name, sportId: teamRow.sportId })) continue;

    added.push(
      await ctx.db.insert("entityReviewQueue", {
        selectorOptionId: teamRow.selectorOptionId,
        batchId: teamRow.batchId,
        // The batch's owner, not the caller — `assertOwnsRow` compares against
        // this, and a row stamped with anyone else would be unanswerable by
        // the operator it was staged for.
        createdByUserId: teamRow.createdByUserId,
        kind: "league",
        name,
        nameNormalized,
        sportId: teamRow.sportId,
        source: {
          kind: "leagueOf",
          teamRowId: teamRow._id,
          ...(proposal.wikidataId ? { wikidataId: proposal.wikidataId } : {}),
        },
        /*
         * ── NEO-254: a league step is ANSWERABLE the moment it is staged ────
         *
         * `"ready"`, not `"pending"` — and this is a correctness point before
         * it is a speed one. `pending` means "we cannot present this row yet
         * because we do not know enough to ask the question". For a player or
         * a team that is true: the whole step is built out of the lookup. For
         * a league it is not. Everything the question needs is already
         * decided by the time this insert runs — the NAME came off the team's
         * P118 statement, and the two things that could make the step
         * unnecessary (the sport already holds this league, by name or by
         * alias; the batch already staged it) were both checked synchronously
         * above.
         *
         * The Wikidata lookup only fills in abbreviation, years and the QID.
         * It is a PREFILL, and it streams into the open form when it lands the
         * same way a team row's enrichment does — `applyLookupResult` has no
         * status guard, so it patches this row whether or not it was pending.
         *
         * Marking it pending made the whole chain wait on a network round trip
         * for nothing: `nextUndecided` only presents a settled row, so the
         * league was unpresentable, and `waitingOnStagedLeagues` held its team
         * behind it — one Wikidata call blocking two steps that were both
         * ready to be answered. On CI's 1024x629 drain that is an unbounded
         * stall per league; in the wizard it is an operator watching a form
         * they could already have filled in.
         *
         * Pool semantics are untouched: the enqueue below still happens, the
         * result still lands through `applyLookupResult`, and a lookup that
         * dies is simply a step with no prefill. `backstopEntityReviewRowImpl`
         * returns early on a non-pending row, which is exactly right here —
         * there is nothing to rescue a row from when it was never waiting.
         */
        status: "ready",
      }),
    );
  }

  if (added.length > 0) {
    // ONLY the rows just inserted — a re-entrant call must never re-enqueue a
    // lookup that already ran, which is NEO-99's creation-only contract.
    await ctx.scheduler.runAfter(
      0,
      internal.wikidataPool.enqueueEntityReviewLookups,
      { rowIds: added },
    );
  }
  return added;
}

/**
 * ── NEO-236: a career team the batch will have to create becomes its OWN step ─
 *
 * Jason, 2026-09-05, looking at the wizard on Travis Bazzana with three inline
 * Location/Name pairs under his career list: "How does this dialog know which
 * League the new team is in? I think we need to show a new team dialog instead
 * of that inline thing. So for this example I think we should show 3 modals in
 * the walker: 1. New Team: Sydney Blue Sox 2. New Team: Oregon State Beavers
 * 3. New Player Travis Bazzana which can now use the 2 new teams that were
 * created."
 *
 * That is what this does. Every accepted career team on a player row that
 * matches no existing `teams` row gets a `team` row of its own in the SAME
 * batch, `source.kind === "careerTeamOf"`, walked before the player (see
 * `getBatch`'s ordering) and answered with the same New Team step a checklist
 * team gets — Location, Name, and the League that used to have no way of being
 * asked about at all. The prelude then creates those rows first, and the
 * player's stints resolve onto them by name.
 *
 * ## What is NOT staged, and why each exclusion is load-bearing
 *
 *  - **A career team we already hold.** `findTeamByFullName` is asked first, by
 *    the composed full name and therefore by the same key every writer uses, so
 *    a stint at the San Diego Padres is a link and not a question. Asking the
 *    operator to re-create a team they already have is how the duplicate this
 *    ticket exists to prevent gets made.
 *  - **A name the batch already has a team row for.** Deduped through the
 *    `by_batch_and_kind_and_name` INDEX rather than a collect, and that is a
 *    correctness choice rather than a tuning one — see the field note on
 *    `nameNormalized` in schema.ts, and NEO-189 for what a wide read set inside
 *    a pool-driven mutation does to the commit that runs beside it. It covers
 *    both directions at once: a checklist team of the same name, and a career
 *    team another player already staged.
 *  - **A team the operator UNCHECKED.** An exclusion is the operator saying
 *    "he never played there", and staging a step for it would ask them again in
 *    a form they cannot decline.
 *
 * ## Idempotent, and it has to be
 *
 * Three callers reach this: the lookup landing on a player row, the wizard
 * staging a hand-typed career team, and the wizard's belt-and-braces call when
 * a player row comes up. Every one of them can fire more than once for one
 * player, so "already staged" is the ONLY thing keeping the batch from growing
 * a duplicate step per re-entry. Returns the rows it actually inserted, which
 * is what makes "and only those get a lookup scheduled" expressible.
 */
async function stageCareerTeamRowsImpl(
  ctx: MutationCtx,
  playerRow: Doc<"entityReviewQueue">,
  /**
   * Career teams the caller knows about that the row's own enrichment does not
   * — the wizard's hand-typed entries. Merged with the enrichment's proposals
   * rather than replacing them, because a player can have both.
   */
  extraCareerTeams: ReadonlyArray<{
    name: string;
    wikidataId?: string;
    /**
     * NEO-248 — the years typed beside the name, when this proposal came from
     * the wizard's manual entry form. Stored on the staged row so the chip can
     * be rebuilt after the team's own step; see schema.ts.
     */
    manualStint?: { fromYear: number; toYear?: number };
  }> = [],
): Promise<Array<Id<"entityReviewQueue">>> {
  // A team row has no career teams of its own, and a staged row must never
  // stage further rows — that is the recursion this guard forecloses.
  if (playerRow.kind !== "player") return [];

  type Proposal = {
    name: string;
    wikidataId?: string;
    manualStint?: { fromYear: number; toYear?: number };
    /**
     * NEO-254 — the year this stint STARTED, used only to decide which era of
     * a name we are talking about. Never stored.
     *
     * A club name can now belong to several team rows: a 1979 Winnipeg Jets
     * stint and a 2015 one are different franchises. The "we hold this already,
     * nothing to stage" check below therefore has to ask about a year, and the
     * stint's own start is a far better signal than the set's year — the card
     * this player appeared on says nothing about when they played for a club
     * they left a decade earlier.
     */
    stintYear?: number;
  };
  const proposals: Proposal[] = [
    // A Wikidata proposal deliberately carries NO `manualStint` even though it
    // has years: they already live on this player's `enrichment.careerTeams`,
    // and `manualStint` is how the wizard tells a chip it has to rebuild from
    // one it can read off the player row.
    ...(playerRow.enrichment?.careerTeams ?? []).map((ct) => ({
      name: ct.name,
      ...(ct.wikidataId ? { wikidataId: ct.wikidataId } : {}),
      // …but it DOES carry the year for the era check — see `stintYear`.
      ...(ct.fromYear !== undefined ? { stintYear: ct.fromYear } : {}),
    })),
    ...extraCareerTeams.map((extra) => ({
      ...extra,
      ...(extra.manualStint ? { stintYear: extra.manualStint.fromYear } : {}),
    })),
  ];
  if (proposals.length === 0) return [];

  /*
   * NEO-248 — collapse duplicate names BEFORE the loop, not inside it.
   *
   * The enrichment's proposals and the caller's extras can name the same club:
   * Wikidata knew the club but not the dates, and the operator typed them. The
   * loop's own per-call dedupe (`seen`) would drop whichever came second — and
   * that is always the hand-typed one, because the extras are appended last —
   * so the years would be discarded before anything looked at them.
   *
   * First occurrence keeps its position and its QID; a `manualStint` from ANY
   * occurrence is adopted, since only the operator's own entry carries one.
   */
  const mergedProposals: Proposal[] = [];
  const proposalByKey = new Map<string, Proposal>();
  for (const proposal of proposals) {
    const key = normalizeTeamName(proposal.name.trim().replace(/\s+/g, " "));
    if (!key) continue;
    const held = proposalByKey.get(key);
    if (!held) {
      const copy: Proposal = { ...proposal };
      proposalByKey.set(key, copy);
      mergedProposals.push(copy);
      continue;
    }
    if (proposal.manualStint && held.manualStint === undefined) {
      held.manualStint = proposal.manualStint;
    }
  }

  // The operator's unchecks, read off whatever decision the row carries. A row
  // being decided at all is not a reason to skip staging: the bulk create
  // decides a player before its career teams have been asked about, and those
  // teams still need their steps — the prelude resolves stints by NAME, so a
  // team row created after the player's decision still lands on the timeline.
  const excluded = new Set(
    (playerRow.decision?.action === "create"
      ? (playerRow.decision.excludedCareerTeamNames ?? [])
      : []
    ).map(normalizeTeamName),
  );

  /*
   * NEO-236 security review, finding 3 — the cap is PER PLAYER, not per call.
   *
   * `added.length` alone bounded one invocation, and three callers can stage
   * for the same player (the lookup landing, the wizard's belt-and-braces pass,
   * and every hand-typed career team), so N calls could mint 64N steps. Counted
   * through `by_source_player` rather than by collecting the batch: staging
   * runs inside `applyLookupResult`, which the pool calls five-wide while the
   * commit prelude may be reading the same rows — see NEO-189.
   */
  const alreadyStagedForPlayer = (
    await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_source_player", (q) =>
        q.eq("source.playerRowId", playerRow._id),
      )
      .collect()
  ).length;

  const added: Array<Id<"entityReviewQueue">> = [];
  const seen = new Set<string>();
  for (const proposal of mergedProposals) {
    const name = proposal.name.trim().replace(/\s+/g, " ");
    if (!name) continue;
    const nameNormalized = normalizeTeamName(name);
    if (!nameNormalized || seen.has(nameNormalized)) continue;
    seen.add(nameNormalized);
    if (excluded.has(nameNormalized)) continue;
    /*
     * NEO-236 security review, finding 2 — an unbounded name never reaches the
     * row or the index.
     *
     * Both sources are text nobody on our side vetted: a Wikidata P54 label,
     * and the `careerTeamNames` a client hands the public mutation. Without
     * this, an arbitrarily long string landed in `name` AND in the indexed
     * `nameNormalized`. SKIPPED rather than thrown on, exactly as
     * `normalizeCareerTeamCreates` drops an unusable pair: one absurd label
     * must not cost the player every other career-team step. The stint itself
     * still resolves if we already hold the team.
     */
    if (name.length > MAX_TEAM_FULL_NAME_LENGTH) continue;

    const alreadyInBatch = await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_batch_and_kind_and_name", (q) =>
        q
          .eq("selectorOptionId", playerRow.selectorOptionId)
          .eq("batchId", playerRow.batchId)
          .eq("kind", "team")
          .eq("nameNormalized", nameNormalized),
      )
      .first();
    if (alreadyInBatch) {
      /*
       * NEO-248 — the step exists, but it may not yet carry the years.
       *
       * Staging dedupes a career team across the whole batch, so the operator
       * can hand-type a stint for a club this player's OWN lookup already
       * staged (Wikidata knew the club, not the dates). Without this the years
       * would have nowhere to live and the chip could not be rebuilt.
       *
       * Narrow on purpose: only a step staged for THIS player, only when it
       * carries no stint yet, and only from a caller that actually supplied
       * one. So it never overwrites an earlier answer and never attributes one
       * player's dates to another's step — and the enrichment-driven callers,
       * which pass no `manualStint`, write nothing here at all.
       */
      if (
        proposal.manualStint &&
        alreadyInBatch.source?.kind === "careerTeamOf" &&
        alreadyInBatch.source.playerRowId === playerRow._id &&
        alreadyInBatch.source.manualStint === undefined
      ) {
        await ctx.db.patch(alreadyInBatch._id, {
          source: { ...alreadyInBatch.source, manualStint: proposal.manualStint },
        });
      }
      continue;
    }

    // Held already — a link, not a question. Composed-name keyed, so a split
    // row ("San Diego" + "Padres") answers to the Wikidata label "San Diego
    // Padres" and nothing is staged.
    //
    // NEO-254: "held already" now means held FOR THIS STINT'S ERA. A name that
    // resolves to several team rows is not held — it is a question, and it gets
    // a step so the operator picks the era. Without the year here, a 1979
    // Winnipeg Jets stint would be silently satisfied by the 2011 row simply
    // because it exists.
    const { teamId: heldTeamId } = await resolveTeamForSetYear(
      ctx,
      playerRow.sportId,
      name,
      proposal.stintYear,
    );
    if (heldTeamId) continue;

    /*
     * A guard rail on an unbounded write, not a security boundary — and it
     * counts the steps this player ALREADY has, so re-entry cannot grow past
     * it.
     *
     * ## NEO-248 — checked HERE, at the insert, and loud for a typed stint
     *
     * It used to sit at the top of the loop, which made it two wrong things at
     * once. It consumed the cap for proposals that need no row (a name the
     * batch already has a step for, a team we already hold) — and, because the
     * caller's extras are appended last, it broke out of the loop BEFORE ever
     * reaching a hand-typed stint whenever the enrichment's own proposals had
     * filled the quota. The mutation then returned 0, the wizard's `.catch` had
     * nothing to catch, and the operator's years were gone with no message.
     *
     * So: the cap bounds ROWS, and it is tested where a row would actually be
     * inserted. A proposal carrying a `manualStint` is the operator typing, and
     * a refusal they can read beats a silent drop — it throws, which rolls the
     * whole mutation back rather than half-staging. Every other caller
     * (`applyLookupResult`, the belt-and-braces pass, the bulk create) passes
     * no stint and still breaks quietly, exactly as before.
     *
     * The message carries the COUNT and never a name — this string reaches the
     * browser and Sentry.
     */
    if (alreadyStagedForPlayer + added.length >= MAX_CAREER_TEAM_CREATES) {
      if (proposal.manualStint) {
        throw new ConvexError(
          `This player already has ${MAX_CAREER_TEAM_CREATES} career-team steps, which is the maximum. Remove one before adding another.`,
        );
      }
      break;
    }

    added.push(
      await ctx.db.insert("entityReviewQueue", {
        selectorOptionId: playerRow.selectorOptionId,
        batchId: playerRow.batchId,
        // The batch's owner, not the caller: `assertOwnsRow` compares against
        // this, and a row stamped with anyone else would be unanswerable by the
        // very operator it was staged for.
        createdByUserId: playerRow.createdByUserId,
        kind: "team",
        name,
        nameNormalized,
        sportId: playerRow.sportId,
        source: {
          kind: "careerTeamOf",
          playerRowId: playerRow._id,
          ...(proposal.wikidataId ? { wikidataId: proposal.wikidataId } : {}),
          // NEO-248 — absent unless the operator typed the years themselves.
          ...(proposal.manualStint ? { manualStint: proposal.manualStint } : {}),
        },
        status: "pending",
      }),
    );
  }

  if (added.length > 0) {
    // ONLY the rows just inserted, for the same reason `startBatch`'s resume
    // path enqueues only its additions: a re-entry must never re-run a lookup
    // that already ran. The staged row's lookup is what supplies the League
    // suggestion and the ESPN location its New Team step pre-fills from.
    await ctx.scheduler.runAfter(
      0,
      internal.wikidataPool.enqueueEntityReviewLookups,
      { rowIds: added },
    );
  }
  return added;
}

/**
 * NEO-236 — stage this player row's career teams as their own review steps.
 *
 * Public because two of the three staging moments are the wizard's: a career
 * team typed by hand into the entry form (which no longer collects a Location —
 * that question belongs on the New Team step, where the League is asked too),
 * and the belt-and-braces call as a player row comes up, which covers a batch
 * whose lookups landed before this shipped.
 *
 * Idempotent by construction (see `stageCareerTeamRowsImpl`), so the client may
 * call it as often as it likes; it returns how many rows THIS call added, which
 * is what lets a caller tell "nothing to do" from "did nothing".
 *
 * Admin-gated and ownership-checked exactly as `recordDecision` is: same table,
 * same batch, and staging into someone else's review session would put steps in
 * front of them that they never asked for.
 */
export const stageCareerTeamRows = mutation({
  args: {
    reviewRowId: v.id("entityReviewQueue"),
    /**
     * Hand-typed career teams the row's enrichment does not know about. Names
     * only — the split into Location + Name is what the staged step asks for,
     * which is the whole point of the change.
     */
    careerTeamNames: v.optional(v.array(v.string())),
    /**
     * NEO-248 — the same thing, with the years the operator typed beside the
     * name.
     *
     * A separate arg rather than a widened `careerTeamNames`: "Decide team" on
     * a Wikidata chip stages a NAME and nothing else (its years are already on
     * the player row), while the manual entry form stages a whole stint. Two
     * shapes, two arguments, and the name-only callers are untouched.
     *
     * The years are stored on the staged row's `source.manualStint` so the
     * wizard can rebuild the chip after walking the team's own New Team step —
     * before this they lived only in per-row React state and were dropped on
     * the way there.
     */
    careerTeams: v.optional(v.array(v.object({
      name: v.string(),
      fromYear: v.number(),
      toYear: v.optional(v.number()),
    }))),
  },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    const callerId = await requireAdmin(ctx);
    const row = await ctx.db.get(args.reviewRowId);
    if (!row) throw new Error("Review row not found");
    assertOwnsRow(row, callerId);
    // Defense in depth, exactly as `recordDecision` does it: these years reach
    // `players.teamYears` by way of the chip the wizard rebuilds from them, so
    // nonsense is refused at the boundary rather than stored.
    const maxYear = new Date().getFullYear() + 1;
    const extra = [
      ...(args.careerTeamNames ?? [])
        .slice(0, MAX_CAREER_TEAM_CREATES)
        .map((name) => ({ name })),
      ...(args.careerTeams ?? [])
        .slice(0, MAX_CAREER_TEAM_CREATES)
        .map((ct) => {
          assertCareerTeamNameLength(ct.name);
          assertCareerStintYears(ct.fromYear, ct.toYear, maxYear);
          return {
            name: ct.name,
            manualStint: {
              fromYear: ct.fromYear,
              ...(ct.toYear !== undefined ? { toYear: ct.toYear } : {}),
            },
          };
        }),
    ];
    const added = await stageCareerTeamRowsImpl(ctx, row, extra);
    return added.length;
  },
});

/**
 * NEO-254 — stage a New League step for a league the operator TYPED on a team
 * step.
 *
 * ## Why the typed name needs a step of its own
 *
 * `NewTeamForm`'s league row offers `Create <name>` for a league the sport
 * does not answer to, and that pill records `create.leagueName`. Without this
 * mutation the commit resolved that name through a bare
 * `findOrCreateLeague(name)` — which is the name-only league this whole
 * feature exists to stop: no abbreviation, no level, no years, no aliases.
 * Staging a step instead means a typed league gets asked the same questions a
 * suggested one does.
 *
 * The step lands BEFORE THE NEXT team rather than before this one: this team's
 * step is already open and being answered, and `walkOrder` places a staged row
 * at its parent's position — which the operator has just passed. That is the
 * same behaviour a hand-typed career team gets (`stageCareerTeamRows`), and it
 * is why the team's pill can read `<name> (new)` immediately: the answer is
 * recorded on the team, and the step that fills in the rest of the record is
 * waiting a moment later in the same batch.
 *
 * Idempotent by construction (see `stageLeagueRowsImpl`), so the client may
 * call it as often as it likes; it returns how many rows THIS call added.
 *
 * Admin-gated and ownership-checked exactly as `recordDecision` is: same
 * table, same batch, and staging into someone else's review session would put
 * steps in front of them they never asked for.
 */
export const stageLeagueRows = mutation({
  args: {
    reviewRowId: v.id("entityReviewQueue"),
    /** The league name the operator typed on the team step. */
    leagueName: v.string(),
  },
  /**
   * NEO-254 — the OUTCOME, not a count.
   *
   * The three answers read differently to the operator standing in front of
   * the team step, and only the server can tell them apart: a step was raised,
   * the sport already answers to that name (by name OR by an alias, which is
   * why the client cannot decide this), or this team has raised as many league
   * steps as it may. A bare number left the wizard unable to say which.
   */
  returns: v.object({
    outcome: v.union(
      v.literal("staged"),
      v.literal("existing"),
      v.literal("over-cap"),
    ),
    /** Set only on `existing` — the league to pick instead of staging one. */
    leagueId: v.optional(v.id("leagues")),
    /** The name as it will be used: the operator's, or the existing row's. */
    name: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    outcome: "staged" | "existing" | "over-cap";
    leagueId?: Id<"leagues">;
    name: string;
  }> => {
    const callerId = await requireAdmin(ctx);
    const row = await ctx.db.get(args.reviewRowId);
    if (!row) throw new Error("Review row not found");
    assertOwnsRow(row, callerId);
    const name = requireValidLeagueName(args.leagueName);

    // Held already — including under an ALIAS, which is the case the client
    // cannot decide for itself. No second row for one league.
    const existing = await findLeagueByName(ctx, { name, sportId: row.sportId });
    if (existing) {
      return { outcome: "existing", leagueId: existing._id, name: existing.name };
    }

    const added = await stageLeagueRowsImpl(ctx, row, [{ name }]);
    // Nothing added and nothing held means the per-team cap refused it — the
    // batch already carries this name is the only other reason, and that is
    // itself a "staged" answer as far as the team is concerned.
    if (added.length === 0) {
      const alreadyStaged = await ctx.db
        .query("entityReviewQueue")
        .withIndex("by_batch_and_kind_and_name", (q) =>
          q
            .eq("selectorOptionId", row.selectorOptionId)
            .eq("batchId", row.batchId)
            .eq("kind", "league")
            .eq("nameNormalized", normalizeLeagueName(name)),
        )
        .first();
      return alreadyStaged
        ? { outcome: "staged", name: alreadyStaged.name }
        : { outcome: "over-cap", name };
    }
    return { outcome: "staged", name };
  },
});

/**
 * NEO-248 — the operator removed a hand-typed chip; forget its years.
 *
 * ## Why removal needs a mutation at all
 *
 * The wizard's chip list is keyed by review row, which survives navigation but
 * not UNMOUNT — `CardChecklist` renders the wizard conditionally, so closing
 * and reopening it drops the map. The rebuild path then reads the years back
 * off the staged step and the chip the operator deleted comes back, taking its
 * stint into `players.teamYears` at commit. A removal has to be as durable as
 * the thing it removes.
 *
 * ## What it does NOT do
 *
 * It clears `source.manualStint` and leaves the New Team step standing. The
 * step is a question about a TEAM — often one another player in the batch also
 * needs, and one whose own lookup has already run — and deleting it because a
 * stint was withdrawn would take an answer away from rows that never asked.
 * "I did not mean to date that club" is not "that club is not in this set".
 *
 * Guarded exactly as the staging patch it undoes: admin, both rows owned by the
 * caller, and the step must actually have been staged for THIS player. Without
 * that last check an operator could strip the years off another player's step
 * by naming it, which is the same cross-attribution the patch path refuses.
 */
export const clearCareerTeamStint = mutation({
  args: {
    /** The PLAYER row whose chip was removed. */
    reviewRowId: v.id("entityReviewQueue"),
    /** The `careerTeamOf` step that chip's years are stored on. */
    teamRowId: v.id("entityReviewQueue"),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const callerId = await requireAdmin(ctx);
    const playerRow = await ctx.db.get(args.reviewRowId);
    if (!playerRow) throw new Error("Review row not found");
    assertOwnsRow(playerRow, callerId);
    const teamRow = await ctx.db.get(args.teamRowId);
    if (!teamRow) throw new Error("Review row not found");
    assertOwnsRow(teamRow, callerId);

    const source = teamRow.source;
    if (
      source?.kind !== "careerTeamOf" ||
      source.playerRowId !== playerRow._id
    ) {
      throw new Error("That step was not staged for this row");
    }
    // Already clear — idempotent, so a double click or a retry is a no-op
    // rather than a second write.
    if (source.manualStint === undefined) return null;

    // Rebuilt without the key rather than set to undefined: `source` is a
    // whole-object patch, and nothing downstream should have to tell "no
    // stint" from "a stint that is undefined".
    const { manualStint: _cleared, ...rest } = source;
    await ctx.db.patch(args.teamRowId, { source: rest });
    return null;
  },
});

/**
 * NEO-236 — the batch in the order the wizard should WALK it.
 *
 * Insertion order is what `getBatch` used to return and what
 * `entity-review-nav`'s "earliest inserted that is settled" rule reads, and a
 * staged career team is inserted LATER than the player who needs it — its
 * player's lookup is what created it. Walked in that order, the operator would
 * meet Travis Bazzana before either of the two clubs his card needs, which is
 * the opposite of what was asked for.
 *
 * So the order is composed here rather than stored. Each `careerTeamOf` row is
 * emitted immediately BEFORE the player row it belongs to, in the order they
 * were staged; everything else keeps its insertion position. A staged row whose
 * player has since gone (a resume reconciled the name away) falls back to its
 * own insertion position rather than disappearing — it is still a real question
 * about a real team, and the prelude will still consume its answer.
 *
 * A stored `order` column was the alternative and is worse: it would have to be
 * rewritten every time a row is staged, from inside the same pool-driven
 * mutation NEO-189 taught us to keep narrow, and it would encode as data
 * something that is purely a rule about presentation.
 */
/**
 * NEO-236/NEO-254 — the order the wizard walks a batch: LEAGUE, then TEAM,
 * then the PLAYER that needs them.
 *
 * Jason asked for "New Team: Sydney Blue Sox, New Team: Oregon State Beavers,
 * then New Player: Travis Bazzana which can now use the 2 new teams" — and
 * then, one level up, for the league to come before the team, because a team
 * step cannot answer "which league" until the league exists and because a
 * league minted from a team step arrives with nothing but a name.
 *
 * So this is one rule applied twice, not two rules: a row is emitted after
 * every row staged FOR it, recursively. A staged row is skipped where it sits
 * and emitted at its parent's position instead, and only while that parent is
 * still in the batch — otherwise its own position is where it belongs, which
 * is what keeps an orphan reachable rather than silently unwalkable.
 *
 * Depth is two by construction (a league is staged for a team, a team for a
 * player, and `stage*RowsImpl` refuses to stage from a staged row), but the
 * walk is written as a recursion over `stagedByParent` rather than as two
 * hard-coded passes so a third level would not need this function rewritten.
 * `emitted` guards against a cycle a corrupt row could otherwise create.
 */
function walkOrder<
  T extends {
    _id: Id<"entityReviewQueue">;
    source?:
      | { kind: "careerTeamOf"; playerRowId: Id<"entityReviewQueue"> }
      | { kind: "leagueOf"; teamRowId: Id<"entityReviewQueue"> }
      | undefined;
  },
>(rows: readonly T[]): T[] {
  /** The row a staged row was staged FOR, or null when it stands alone. */
  const parentOf = (row: T): string | null => {
    if (row.source?.kind === "careerTeamOf") return row.source.playerRowId as string;
    if (row.source?.kind === "leagueOf") return row.source.teamRowId as string;
    return null;
  };

  const stagedByParent = new Map<string, T[]>();
  for (const row of rows) {
    const parent = parentOf(row);
    if (parent === null) continue;
    const list = stagedByParent.get(parent);
    if (list) list.push(row);
    else stagedByParent.set(parent, [row]);
  }
  if (stagedByParent.size === 0) return [...rows];

  const present = new Set(rows.map((r) => r._id as string));
  const emitted = new Set<string>();
  const ordered: T[] = [];

  const emit = (row: T): void => {
    const id = row._id as string;
    if (emitted.has(id)) return;
    emitted.add(id);
    // Everything staged for this row comes first — and each of those may have
    // rows staged for IT, which is the league-before-team-before-player chain.
    for (const child of stagedByParent.get(id) ?? []) emit(child);
    ordered.push(row);
  };

  for (const row of rows) {
    // Emitted with its parent below — unless that parent is gone, in which
    // case this IS its position.
    const parent = parentOf(row);
    if (parent !== null && present.has(parent)) continue;
    emit(row);
  }
  // Anything a cycle kept out of the walk still has to be reachable.
  for (const row of rows) emit(row);
  return ordered;
}

/**
 * What the wizard subscribes to. Fully reactive — a row's `status` flips
 * live as the Wikidata pool (convex/wikidataPool.ts) drains its work items 5
 * at a time, so the client sees each lookup complete and streams the rows in
 * without polling. Because the pool runs 5-wide rather than one serial chain,
 * completion order is no longer strictly insertion order; the wizard handles
 * that by presenting the earliest-inserted row that is no longer "pending"
 * (see EntityReviewWizard.tsx's `current`).
 */
export const getBatch = query({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    batchId: v.string(),
  },
  returns: v.array(publicRowValidator),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const rows = await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_selector_option_and_batch", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId).eq("batchId", args.batchId),
      )
      .collect();
    // NEO-96: resolve the sport label server-side. Every row in a batch shares
    // one sportId, so this is a single extra read regardless of batch size —
    // worth doing here rather than making the wizard join per row.
    const labelCache = new Map<Id<"selectorOptions">, string>();
    const resolved = [];
    // NEO-236: staged career teams come out ahead of the player who needs
    // them. See `walkOrder` — the wizard's "next undecided" rule reads array
    // order, so this is where the step sequence is decided.
    for (const row of walkOrder(rows)) {
      let sportValue = labelCache.get(row.sportId);
      if (sportValue === undefined) {
        sportValue = await sportLabel(ctx, row.sportId);
        labelCache.set(row.sportId, sportValue);
      }
      resolved.push({ ...toPublicRow(row), sportValue });
    }
    return resolved;
  },
});

/**
 * NEO-254 — validate and normalise the league record a New League step sends.
 *
 * Every bound comes from `convex/leagues.ts` rather than being restated here.
 * That module is the one place that decides what the `leagues` table accepts,
 * and this is a second door into the same table: `saveLeagueFields` and this
 * step must not be able to disagree about a 121-character name or a 33rd
 * alias. `findOrCreateLeague` itself validates NOTHING, so if this helper is
 * ever bypassed the bounds are simply gone.
 *
 * Throws, and each message is the one League Management already shows for the
 * same mistake — an operator who hits a limit in two places should not have to
 * learn two vocabularies for it. Values are never echoed back, only lengths
 * and counts, matching that module's own rule.
 */
function requireLeagueCreate(input: {
  name: string;
  abbreviation?: string;
  level?: LeagueLevel;
  yearsActive?: { from: number; to?: number };
  aliases?: string[];
  wikidataId?: string;
}): {
  name: string;
  abbreviation?: string;
  level?: LeagueLevel;
  yearsActive?: { from: number; to?: number };
  aliases?: string[];
  wikidataId?: string;
} {
  const name = requireValidLeagueName(input.name);
  const abbreviation = requireValidLeagueAbbreviation(input.abbreviation);
  if (input.yearsActive) validateLeagueYears(input.yearsActive);
  // `normalizeAliasList` drops an alias equal to the row's own name, dedupes
  // on the normalised form and caps the list — the same treatment the edit
  // form's aliases get, so the two produce identical rows.
  const aliases = input.aliases ? normalizeAliasList(input.aliases, name) : [];
  // A malformed QID is DROPPED, not thrown on — the same call `players.
  // applyEnrichmentInternal` makes, and for the same reason: the value comes
  // from a Wikidata pre-fill on a path with no operator intent behind it, and
  // a stored bad id would be interpolated into an outbound link.
  const wikidataId =
    input.wikidataId && isWikidataQid(input.wikidataId.trim())
      ? input.wikidataId.trim()
      : undefined;
  return {
    name,
    ...(abbreviation ? { abbreviation } : {}),
    ...(input.level ? { level: input.level } : {}),
    ...(input.yearsActive ? { yearsActive: input.yearsActive } : {}),
    ...(aliases.length ? { aliases } : {}),
    ...(wikidataId ? { wikidataId } : {}),
  };
}

/**
 * Record the user's decision for one reviewed row. Patched immediately
 * (not batched client-side) so wizard progress survives a page refresh —
 * the whole point of persisting decisions server-side rather than only in
 * React state.
 *
 * Three actions:
 *   - "create" — mint a new player/team at commit time, optionally carrying
 *     hand-typed `manualCareerTeams` and (NEO-212) `excludedCareerTeamNames`,
 *     the Wikidata career teams the admin unchecked.
 *   - "link" — point the card at an existing player/team.
 *   - "skip" (NEO-212) — the name is not a person / not a team. Commit leaves
 *     the card's raw name alone and creates/links nothing.
 *
 * A "link" decision is validated against the row before being trusted —
 * commitCardChecklist later uses `linkedPlayerId`/`linkedTeamId` verbatim to
 * populate a real card's playerIds/teamOnCardIds, so this is the boundary
 * that must reject a mismatched or missing id rather than silently
 * dropping the name later at commit time.
 *
 * A "skip" decision carries no payload, so nothing else on the args is
 * meaningful — a `linkedPlayerId`/`linkedTeamId`/`manualCareerTeams` sent
 * alongside it is IGNORED rather than rejected. The wizard drives all three
 * actions through one call site, so those fields are leftovers from a
 * previously-selected action, not a caller mistake; throwing would turn a
 * harmless UI artifact into a dead end for the operator, and there is nothing
 * to protect — the skip decision never stores them, so they cannot reach
 * commit.
 *
 * Re-deciding a row that already carries a decision OVERWRITES it, for every
 * action — the wizard lets an operator go back and change a call.
 */
export const recordDecision = mutation({
  args: {
    reviewRowId: v.id("entityReviewQueue"),
    action: v.union(
      v.literal("create"),
      v.literal("link"),
      // NEO-212: "not a person / not a team".
      v.literal("skip"),
    ),
    linkedPlayerId: v.optional(v.id("players")),
    linkedTeamId: v.optional(v.id("teams")),
    // Only meaningful for a player-row "create" decision — extra career-team
    // history the admin typed by hand in the wizard (Wikidata found nothing,
    // or missed a team). Validated below before it's trusted.
    manualCareerTeams: v.optional(v.array(manualCareerTeamValidator)),
    // NEO-212, also "create"-only: the Wikidata career-team labels the admin
    // UNCHECKED in the wizard, so commit doesn't create team rows for them.
    // Validated/normalized below before it's trusted.
    excludedCareerTeamNames: v.optional(v.array(v.string())),
    // NEO-236, "create"-only and team-kind-only: the Location + Name the
    // operator confirmed in the wizard. The ONLY thing commit will build a
    // `teams` row from — see the schema comment.
    create: v.optional(teamCreateValidator),
    // NEO-236, "create"-only and player-kind-only: Location + Name per
    // accepted career team that matched nothing.
    createTeams: v.optional(v.array(careerTeamCreateValidator)),
    // NEO-254, "create"-only and league-kind-only: the whole league record the
    // New League step collects. Validated below against the SAME bounds
    // `convex/leagues.ts` enforces — see `requireLeagueCreate`.
    createLeague: v.optional(leagueCreateValidator),
    // NEO-254, "link"-only and league-kind-only.
    linkedLeagueId: v.optional(v.id("leagues")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const callerId = await requireAdmin(ctx);

    const row = await ctx.db.get(args.reviewRowId);
    if (!row) throw new Error("Review row not found");
    assertOwnsRow(row, callerId);

    // NEO-212: "not a person / not a team". Nothing else on the args applies —
    // see the doc comment for why leftovers are ignored rather than rejected.
    if (args.action === "skip") {
      await ctx.db.patch(args.reviewRowId, {
        decision: { action: "skip" },
        // NEO-221: proof of life for the abandoned-batch sweep.
        lastTouchedAt: Date.now(),
      });
      return null;
    }

    if (args.action === "create") {
      // Defense in depth: this is admin-gated, but still validate the shape
      // so a malformed year can never reach the players.teamYears write in
      // commitCardChecklist. Loose bounds — reject nonsense, not history.
      const maxYear = new Date().getFullYear() + 1;
      const manualCareerTeams = args.manualCareerTeams ?? [];
      // Cap the array length so an admin (or a compromised admin session)
      // can't attach an unbounded number of career-team rows to a single
      // player — a real player has a handful, 64 is generous headroom.
      if (manualCareerTeams.length > MAX_MANUAL_CAREER_TEAMS) {
        throw new Error(
          `Too many manual career-team entries (${manualCareerTeams.length}); the maximum is ${MAX_MANUAL_CAREER_TEAMS}`,
        );
      }
      for (const ct of manualCareerTeams) {
        // Reject an empty/whitespace-only team name before it can reach the
        // get-or-create team resolution in commitCardChecklist (which would
        // otherwise mint a blank-named team). Mirrors how card-name
        // collection elsewhere trims and filters empties.
        if (ct.name.trim().length === 0) {
          throw new Error("Career-team name cannot be empty");
        }
        // NEO-248: hand-typed, so an over-long name is refused rather than
        // carried to a commit that would drop the stint on the floor.
        assertCareerTeamNameLength(ct.name);
        // NEO-248: the same bounds the staging path applies, from one place.
        assertCareerStintYears(ct.fromYear, ct.toYear, maxYear, ct.name);
      }
      // NEO-212: the Wikidata career teams the admin unchecked. Validated on
      // the same boundary and for the same reason as the manual entries above
      // — commit consumes this list verbatim.
      const excludedCareerTeamNames = normalizeExcludedCareerTeamNames(
        args.excludedCareerTeamNames ?? [],
      );
      // NEO-236: the Location + Name a team row will be built from, and the
      // per-career-team equivalents. Each is meaningful for exactly one row
      // kind, so the other is dropped rather than stored — an unused `create`
      // on a player row is dead weight in an audit record, and a `createTeams`
      // on a team row would suggest commit consults it there (it does not).
      const create =
        row.kind === "team" && args.create
          ? requireTeamCreate(args.create)
          : undefined;
      /*
       * NEO-236 security review, finding 1 — the league is CHECKED here, and
       * refused rather than dropped.
       *
       * `normalizeLeagueChoice` passes `leagueId` through untouched: the
       * validator proves it is an id in `leagues`, not that the row still
       * exists or that it belongs to this team's sport. `teams.findOrCreate`
       * already refuses both through `resolveOperatorLeagueId`, so without this
       * the SAME operator answer was accepted on one path and rejected on the
       * other.
       *
       * A throw is right here and only here: the operator is standing in front
       * of the wizard, they picked this league off a list moments ago, and the
       * two ways it can be wrong — the row was deleted under them, or a stale
       * client offered another sport's league — are both things they need to be
       * told about rather than have silently corrected. The commit prelude has
       * no operator, so it drops instead (see `reviewedTeamFields`).
       *
       * `ConvexError`, not `Error`: only its `data` survives Convex's error
       * boundary intact, and the wizard renders that string. Mirrors the
       * `linkedTeamId` sport check below.
       */
      if (create?.leagueId) {
        const league = await ctx.db.get(create.leagueId);
        if (!league) {
          throw new ConvexError("That league no longer exists.");
        }
        if (league.sportId !== row.sportId) {
          // The league's own name is safe to name: it is reference data the
          // operator just picked off a list, not typed content.
          throw new ConvexError(
            `${league.name} is a league in ${await sportLabel(ctx, league.sportId)}, not ${await sportLabel(ctx, row.sportId)}.`,
          );
        }
      }
      const createTeams =
        row.kind === "player" && args.createTeams
          ? normalizeCareerTeamCreates(args.createTeams)
          : [];
      /*
       * NEO-254 — the league record, validated HERE and nowhere else upstream.
       *
       * `findOrCreateLeague` enforces nothing at all: it trims the name and
       * writes. Every bound lives in `convex/leagues.ts`'s own entry points,
       * so a caller that skips them writes unbounded strings straight into a
       * globally shared row. This is that caller, and it is fed by an operator
       * form, so it applies the same four helpers League Management does —
       * imported rather than restated, because two validators guarding one
       * table must not be able to disagree about what it accepts.
       *
       * Throws rather than dropping: the operator is standing in front of the
       * step and can fix a 130-character name. Commit is where dropping is
       * right, because there is nobody there to tell.
       */
      const createLeague =
        row.kind === "league" && args.createLeague
          ? requireLeagueCreate(args.createLeague)
          : undefined;
      await ctx.db.patch(args.reviewRowId, {
        decision: {
          action: "create",
          // Omit the key entirely when empty, matching how `enrichment` is
          // treated optionally elsewhere in this file.
          ...(manualCareerTeams.length ? { manualCareerTeams } : {}),
          ...(excludedCareerTeamNames.length ? { excludedCareerTeamNames } : {}),
          ...(create ? { create } : {}),
          ...(createTeams.length ? { createTeams } : {}),
          ...(createLeague ? { createLeague } : {}),
        },
        lastTouchedAt: Date.now(),
      });
      return null;
    }

    if (row.kind === "player") {
      if (!args.linkedPlayerId) {
        throw new Error("linkedPlayerId is required to link a player");
      }
      const linked = await ctx.db.get(args.linkedPlayerId);
      if (!linked) throw new Error("Linked player not found");
      if (linked.sportId !== row.sportId) {
        // NEO-96: compare ids, but report DISPLAY names — an operator reading
        // "sport (abc123) doesn't match xyz789" learns nothing.
        throw new Error(
          `Linked player's sport (${await sportLabel(ctx, linked.sportId)}) ` +
            `doesn't match ${await sportLabel(ctx, row.sportId)}`,
        );
      }
      await ctx.db.patch(args.reviewRowId, {
        decision: { action: "link", linkedPlayerId: args.linkedPlayerId },
        lastTouchedAt: Date.now(),
      });
    } else if (row.kind === "league") {
      // NEO-254 — link a staged league step to a league we already hold. Same
      // two checks the team arm makes, and for the same reasons: a row deleted
      // under the operator, and a stale client offering another sport's league.
      if (!args.linkedLeagueId) {
        throw new Error("linkedLeagueId is required to link a league");
      }
      const linked = await ctx.db.get(args.linkedLeagueId);
      if (!linked) throw new Error("Linked league not found");
      if (linked.sportId !== row.sportId) {
        throw new Error(
          `Linked league's sport (${await sportLabel(ctx, linked.sportId)}) ` +
            `doesn't match ${await sportLabel(ctx, row.sportId)}`,
        );
      }
      await ctx.db.patch(args.reviewRowId, {
        decision: { action: "link", linkedLeagueId: args.linkedLeagueId },
        lastTouchedAt: Date.now(),
      });
    } else {
      if (!args.linkedTeamId) {
        throw new Error("linkedTeamId is required to link a team");
      }
      const linked = await ctx.db.get(args.linkedTeamId);
      if (!linked) throw new Error("Linked team not found");
      if (linked.sportId !== row.sportId) {
        throw new Error(
          `Linked team's sport (${await sportLabel(ctx, linked.sportId)}) ` +
            `doesn't match ${await sportLabel(ctx, row.sportId)}`,
        );
      }
      await ctx.db.patch(args.reviewRowId, {
        decision: { action: "link", linkedTeamId: args.linkedTeamId },
        lastTouchedAt: Date.now(),
      });
    }
    return null;
  },
});

/**
 * NEO-221 — un-decide one row, so the operator can go back and change a call.
 *
 * `recordDecision` already OVERWRITES a decision, which covers "I meant link,
 * not create". This covers the other half: putting a row back into the queue
 * as an open question, which is what the wizard's Back / decided-list "Change
 * decision" needs — the review UI presents an undecided row, so a row has to
 * be able to become undecided again before it can be re-presented.
 *
 * Patching `decision: undefined` is how Convex removes a field, so the row is
 * left byte-identical to one that was never decided. `enrichment` and `status`
 * are deliberately untouched: a settled lookup stays settled, and re-deciding
 * a row must not cost a second Wikidata round-trip.
 *
 * ## Why a still-`pending` row re-schedules a lookup
 *
 * `applyLookupResult` and `backstopEntityReviewRowImpl` both SKIP a decided row
 * (NEO-189 — writing to a row the commit prelude is reading is what made a
 * seed job lose an optimistic-concurrency race on every retry). So a row that
 * was decided while its lookup was still in flight has had its result dropped
 * on the floor: it is `pending`, it will never leave `pending` on its own, and
 * un-deciding it would hand the operator a row stuck on "Looking up…" forever.
 * Re-scheduling the pool enqueue is what makes the row answerable again.
 *
 * This is a LOOKUP, not entity enrichment. The creation-only rule on
 * `wikidataPool.enqueueEnrichment` is about enriching a `players`/`teams` row
 * in the database; nothing here touches those tables. An `entityReviewQueue`
 * row is a throwaway question awaiting an answer, and this is the same enqueue
 * `startBatch` performs when the question is first asked.
 *
 * The two are easy to confuse and NEO-254 made the distinction load-bearing:
 * teams are no longer enriched automatically at creation at all, so for a TEAM
 * this lookup is the only source of league, era, colours and ids a created row
 * will ever have without an operator pressing Discover. Deciding a team row
 * before its lookup lands mints a permanently bare team — which is exactly why
 * a team row is staged `pending`, and why `recordAllRemainingAsCreate` refuses
 * to decide a pending row.
 *
 * Bounded by operator clicks — one enqueue per "Change decision" tap on a row
 * that never resolved, which is a rare shape to begin with.
 *
 * Admin-gated exactly as `recordDecision` is: same table, same blast radius,
 * and the two are two halves of one operator gesture.
 */
export const clearDecision = mutation({
  args: { reviewRowId: v.id("entityReviewQueue") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const callerId = await requireAdmin(ctx);

    const row = await ctx.db.get(args.reviewRowId);
    if (!row) throw new Error("Review row not found");
    assertOwnsRow(row, callerId);

    await ctx.db.patch(args.reviewRowId, {
      decision: undefined,
      // NEO-221: un-deciding is operator activity like any other — a session
      // spent walking back through decisions must not look abandoned.
      lastTouchedAt: Date.now(),
    });

    if (row.status === "pending") {
      await ctx.scheduler.runAfter(
        0,
        internal.wikidataPool.enqueueEntityReviewLookups,
        { rowIds: [args.reviewRowId] },
      );
    }
    return null;
  },
});

/**
 * Shared body of the two bulk fast-paths below: walk one batch and decide
 * every row that carries NO decision yet, leaving already-decided rows exactly
 * as the operator left them, and return how many this call decided.
 *
 * Factored out so `recordAllRemainingAsCreate` and `recordAllRemainingAsSkip`
 * cannot drift on batch scoping, on the already-decided rule, or on what the
 * returned count means — the only difference between them is the decision they
 * write, and (NEO-221) whether a row whose lookup is still in flight is in
 * scope. Private, and assumes its caller has already run `requireAdmin`.
 *
 * ## NEO-221 — `includePending` is not a preference, it is the difference
 * between the two fast paths
 *
 * A `pending` row is one whose Wikidata lookup has not come back. What that
 * means depends entirely on what is about to be written to it:
 *
 *   - CREATE consumes the lookup. `enrichment` is what seeds the new
 *     player/team's Wikidata id, career teams, league, city and colours, so
 *     deciding a pending row "create" mints a permanently bare row for a
 *     player Wikidata knows perfectly well — silently, and with no later path
 *     back to the enrichment (`enqueueEnrichment` is creation-only for
 *     players, and NEO-254 removed the automatic TEAM leg altogether, so a
 *     team decided while pending has no later automatic path at all). The
 *     operator asked for "everything else is new", not "everything else is new
 *     and unenriched". So create passes `false` and the caller re-arms as
 *     lookups land.
 *   - SKIP consumes nothing. Nothing is created, nothing is linked, and no
 *     enrichment is ever read — so waiting on the lookup buys the operator
 *     precisely nothing, and making them wait to say "none of this is an
 *     entity" would be a worse wizard, not a safer one. Skip passes `true`.
 *
 * ## NEO-254 — and create also skips a row that is a CHOICE
 *
 * The same argument, one step further. A row carrying
 * `enrichment.existingCandidates` is one where two or more NB players are
 * already filed under this name, and the wizard is about to put them in front
 * of the operator to pick from. "Everything else is new" is a statement about
 * names nobody has heard of; it is not an answer to "which of these two Bob
 * Allens is on the card", and treating it as one mints a third Bob Allen
 * silently — the exact failure NEO-254 exists to remove, arriving through a
 * different door.
 *
 * So create leaves those rows undecided and the operator rules on each one
 * individually. They are `ready`, not `pending`, so they do not re-arm the
 * client's auto-add loop; they simply stay in the walk until answered.
 * Skip is unaffected for the same reason as above: it creates nothing, so
 * there is no wrong row to create.
 *
 * The test is `players.isAmbiguousPlayerName` — the LIVE index — and NOT the
 * stored `enrichment.existingCandidates` marker, even though the marker is now
 * written at enqueue time. The marker records what was true when the row was
 * written; a preload run, a colleague's commit or a merge between then and
 * this click can turn an ordinary name into an ambiguous one, and this is the
 * one caller that turns "not ambiguous" straight into an INSERT. It reads at
 * most one index lookup per undecided player row in the batch, which is the
 * same order as the loop it sits in.
 */
async function decideAllRemaining(
  ctx: MutationCtx,
  args: { selectorOptionId: Id<"selectorOptions">; batchId: string },
  decision: { action: "create" } | { action: "skip" },
  includePending: boolean,
  callerId: string,
): Promise<number> {
  const rows = await ctx.db
    .query("entityReviewQueue")
    .withIndex("by_selector_option_and_batch", (q) =>
      q.eq("selectorOptionId", args.selectorOptionId).eq("batchId", args.batchId),
    )
    .collect();
  // NEO-221 — same second layer as `recordDecision` and `cancelBatch`, and it
  // matters MORE here than on either of them: one call rules on every open row
  // in the batch, so a stale batchId from another session would decide a
  // colleague's whole review in a single mutation. Checked over every row
  // before the first patch, so a refusal writes nothing at all.
  for (const row of rows) assertOwnsRow(row, callerId);
  const now = Date.now();
  let count = 0;
  for (const row of rows) {
    if (row.decision) continue;
    // NEO-221: a row whose lookup has not landed is skipped on the CREATE
    // path (see the note above) and included on SKIP.
    if (!includePending && row.status === "pending") continue;
    // NEO-254 — a player name TWO OR MORE NB rows already carry is never
    // decided in bulk: a human picks which "Bob Allen" the card means, and
    // "create all remaining" would mint a third one behind their back. Asked
    // of the LIVE index rather than the row's stored marker — see the doc
    // above for why that distinction is the point.
    //
    // `includePending` is reused as the create-versus-skip discriminator
    // deliberately: both exclusions exist for the same reason (create consumes
    // something the operator has not looked at yet) and splitting them into two
    // flags would let a future caller turn one off without the other.
    if (
      !includePending &&
      row.kind === "player" &&
      (await isAmbiguousPlayerName(ctx, row.name, row.sportId))
    ) {
      continue;
    }
    // Each row is patched with its OWN fresh object literal, never a shared
    // reference to `decision`.
    //
    // NEO-221: one timestamp for the whole call — this IS one operator action,
    // and stamping each row a millisecond apart would only make the sweep's
    // arithmetic harder to read.
    //
    // Branched rather than spread-with-a-conditional-key so a `create` payload
    // cannot even be expressed on the "skip" arm, which does not carry one.
    if (decision.action === "create") {
      /*
       * ── NEO-236: the bulk create decides PLAYERS ONLY ────────────────────
       *
       * Jason, 2026-09-05, verbatim: "add all remaining as new should still
       * process teams, it should only apply to players."
       *
       * A team row is left UNDECIDED here, whichever kind it is — a name off
       * the checklist or a career team this batch staged. Both get their own
       * New Team step, because both need the one question this path cannot
       * answer: which LEAGUE. The old behaviour pre-filled that from the
       * enrichment's suggestion, so a club side pulled off a player's career
       * list could be filed under a league no human ever looked at — which is
       * the whole defect this ticket exists to close, re-entering through the
       * one door that was still open.
       *
       * Nothing is lost by deciding the player first. Its stints resolve by
       * NAME in the commit prelude, against teams the staged steps create
       * ahead of it, so a player decided now and a team answered in a moment
       * still land on each other. And the batch cannot commit early: the
       * wizard's Confirm & Save appears only once EVERY row is decided, staged
       * team rows included.
       *
       * Staging still runs, and has to: it is what puts those steps in the
       * batch to be answered. Idempotent, so on the common path (the lookup
       * already staged them) it reads a few index ranges and inserts nothing.
       */
      if (row.kind !== "player") continue;
      await stageCareerTeamRowsImpl(ctx, row);
      /*
       * ── NEO-248: the bulk carries this player's hand-typed stints ─────────
       *
       * The decision used to be a bare `{action:"create"}`, which is a claim
       * that a player row holds nothing worth recording. Since NEO-248 it can:
       * a stint the operator typed lives on the step it staged
       * (`source.manualStint`), and only `decision.manualCareerTeams` gets it
       * into `players.teamYears` at commit.
       *
       * That matters here more than it looks, because this path is not only
       * the "Add All Remaining as New" button. The wizard re-arms it on a
       * TIMER as lookups land, so a player row the operator has typed years on
       * can be decided by a mutation nobody pressed — and before this, decided
       * as though those years had never been typed.
       *
       * Read through `by_source_player` rather than off the batch: the same
       * narrow index the staging pass uses, for the same NEO-189 reason, and
       * it is already warm from the call above.
       */
      const stagedSteps = await ctx.db
        .query("entityReviewQueue")
        .withIndex("by_source_player", (q) => q.eq("source.playerRowId", row._id))
        .collect();
      const manualCareerTeams: Array<{
        name: string;
        fromYear: number;
        toYear?: number;
      }> = [];
      for (const step of stagedSteps) {
        // NEO-254: `source` is a union now, and only the career-team arm
        // carries a stint — a league step has no years of its own. Narrowed
        // rather than optional-chained so a third arm cannot silently fall
        // through this loop.
        if (step.source?.kind !== "careerTeamOf") continue;
        const stint = step.source.manualStint;
        if (!stint) continue;
        manualCareerTeams.push({
          name: step.name,
          fromYear: stint.fromYear,
          ...(stint.toYear !== undefined ? { toYear: stint.toYear } : {}),
        });
      }
      await ctx.db.patch(row._id, {
        decision: {
          action: "create",
          // Absent when there are none, so an ordinary bulk decision is stored
          // byte-identical to how it was before this existed.
          ...(manualCareerTeams.length > 0 ? { manualCareerTeams } : {}),
        },
        lastTouchedAt: now,
      });
    } else {
      await ctx.db.patch(row._id, {
        decision: { action: "skip" },
        lastTouchedAt: now,
      });
    }
    count++;
  }
  return count;
}


/**
 * Bulk fast-path: mark every not-yet-decided PLAYER row in this batch as
 * "create", in one mutation. A first-time real-set sync can surface
 * hundreds of genuinely-new names (the common case, not the exception —
 * e.g. every rookie in a brand-new set) where reviewing one at a time has
 * real value ONLY when something looks wrong; when everything's fine, the
 * user needs a fast path instead of hundreds of individual taps.
 *
 * NEO-221: rows still "pending" — their Wikidata lookup has not come back —
 * are now EXCLUDED, where they used to be swept up with the rest. Deciding one
 * "create" mints a permanently bare player/team for a name Wikidata could have
 * enriched, with no later path back (enrichment is creation-only); see
 * `decideAllRemaining` for the full argument. The wizard re-calls this as
 * lookups land, so the operator still taps once — the count just fills in
 * over a few seconds instead of all at once.
 *
 * The return value is what makes that loop safe to drive from the client: it
 * is how many rows THIS call decided, so a re-call that finds nothing settled
 * yet returns 0 rather than looking like a failure.
 *
 * ## NEO-236 — teams are NOT decided here, and the count says players
 *
 * Jason, 2026-09-05: "add all remaining as new should still process teams, it
 * should only apply to players." Every team row — a checklist name or a career
 * team this batch staged — is left undecided for its own New Team step,
 * because that step asks which LEAGUE and this path can only guess. So the
 * returned count is a count of PLAYERS, and the button that calls this says so.
 */
export const recordAllRemainingAsCreate = mutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    batchId: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    const callerId = await requireAdmin(ctx);
    return await decideAllRemaining(ctx, args, { action: "create" }, false, callerId);
  },
});

/**
 * NEO-212 counterpart to `recordAllRemainingAsCreate`: mark every
 * not-yet-decided row in this batch as "skip". The case it exists for is the
 * mirror image — a set whose surfaced "new names" are mostly not entities at
 * all (subset/parallel labels, checklist headers, a team name that landed in a
 * player column), where the operator wants the whole remainder left alone
 * rather than minting a row for each.
 *
 * Same admin gate, same batch scoping, same already-decided rule and same
 * return (how many rows THIS call decided) as the create variant; both run
 * through `decideAllRemaining` so the two cannot drift.
 *
 * Unlike its create twin, this one still rules on EVERY kind of row, teams
 * included (NEO-236 narrowed only the create path). "None of this is an entity"
 * is a statement about names, not about players specifically, and a skip
 * creates nothing that could be filed under the wrong league.
 *
 * NEO-221 answered the question this comment used to leave open, and answered
 * it DIFFERENTLY for the two paths: skip still includes rows whose lookup is
 * in flight, while create no longer does. That is not an inconsistency — a
 * skip creates nothing and therefore never reads `enrichment`, so waiting on
 * the lookup would cost the operator time and buy them nothing, whereas a
 * create consumes the enrichment and deciding early throws it away. Skip is
 * also the operator's explicit "none of this is an entity", which is exactly
 * the case where blocking on a lookup would be perverse.
 */
export const recordAllRemainingAsSkip = mutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    batchId: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    const callerId = await requireAdmin(ctx);
    return await decideAllRemaining(ctx, args, { action: "skip" }, true, callerId);
  },
});

/**
 * NEO-221 — delete every row of one batch, and return how many were deleted.
 *
 * The single deletion body behind `cancelBatch` (the operator said no),
 * `cleanupBatch` (an operator tool for a batch nobody will finish) and
 * `sweepAbandonedBatches` (the cron that finds those on its own). Three
 * callers with three different reasons and exactly one definition of what
 * "delete a batch" means — before this, two of them carried their own copy of
 * the same loop, which is one drift away from a sweep that half-cleans.
 *
 * Deliberately reads through `by_selector_option_and_batch` rather than taking
 * the rows a caller already has: the sweep decides on a sampled window, and
 * deleting from a stale list would leave a batch partly alive.
 *
 * Private, and assumes its caller has already gated itself.
 */
async function deleteBatchRows(
  ctx: MutationCtx,
  selectorOptionId: Id<"selectorOptions">,
  batchId: string,
): Promise<number> {
  const rows = await ctx.db
    .query("entityReviewQueue")
    .withIndex("by_selector_option_and_batch", (q) =>
      q.eq("selectorOptionId", selectorOptionId).eq("batchId", batchId),
    )
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

/**
 * Wizard Cancel. Only ever deletes these throwaway rows — players, teams,
 * and cardChecklist are never touched during review, so cancelling has
 * exactly the same all-or-nothing semantics as today's dialog.
 */
export const cancelBatch = mutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    batchId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const callerId = await requireAdmin(ctx);
    // NEO-221 — refuse to cancel someone else's session. Checked BEFORE the
    // delete, on the batch's own rows: cancelling is the one irreversible
    // thing an operator can do to a review, so a stale batchId from another
    // tab must not be able to throw away a colleague's work. An empty batch
    // (already committed or cancelled) has no owner to disagree with and is a
    // no-op, exactly as it was.
    const rows = await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_selector_option_and_batch", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId).eq("batchId", args.batchId),
      )
      .collect();
    for (const row of rows) assertOwnsRow(row, callerId);
    await deleteBatchRows(ctx, args.selectorOptionId, args.batchId);
    return null;
  },
});

/**
 * NEO-221 — the batchId of this (selectorOptionId, user) pair's open review
 * batch, or null.
 *
 * Exists for one caller and one shape: `resolveUnknownsAndStartBatch` needs to
 * know whether a batch is already open BEFORE it decides whether to call
 * `startBatch`. It cannot just call `startBatch` unconditionally — with no
 * batch open and no unknown names that would mint an empty batch and hand the
 * client a batchId for a wizard with nothing in it. And it cannot skip the
 * call when there are no unknowns either, because an OPEN batch full of
 * undecided rows then survives a re-Confirm that resolved everything, and
 * nothing ever consumes or deletes it. So the caller asks first.
 *
 * Reads `by_selector_option_and_user`'s first row, which is exactly the read
 * `startBatch` itself does to decide resume-versus-create — deliberately the
 * same index and the same question, so the two cannot disagree about whether
 * a batch exists.
 */
export const findOpenBatch = internalQuery({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    createdByUserId: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_selector_option_and_user", (q) =>
        q
          .eq("selectorOptionId", args.selectorOptionId)
          .eq("createdByUserId", args.createdByUserId),
      )
      .first();
    return existing?.batchId ?? null;
  },
});

/** Internal — read one row for the pool's lookup work item (runEntityReviewLookup). */
export const getInternal = internalQuery({
  args: { id: v.id("entityReviewQueue") },
  returns: v.union(rowValidator, v.null()),
  handler: async (ctx, args) => await ctx.db.get(args.id),
});

/**
 * Internal — the pool's lookup work item patches status/enrichment as each
 * lookup completes.
 *
 * ## Why this reads before it writes (NEO-189)
 *
 * A row that already carries a `decision` is LEFT ALONE. This used to patch
 * unconditionally, and that is what turned a seed job red: the operator's
 * "mark everything as create" fast path (`recordAllRemainingAsCreate`)
 * deliberately decides rows whose lookup is still `pending`, the operator hits
 * Confirm, and `commitCardChecklist`'s prelude then reads the whole batch
 * through `by_selector_option_and_batch`. Every straggler lookup landing here
 * during that read invalidated the prelude's read set, and with a lookup storm
 * in flight (CI hit an ESPN 403 retry loop) it lost on Convex's every internal
 * retry too:
 *
 *   Documents read from or written to the "entityReviewQueue" table changed
 *   while this mutation was being run and on every subsequent retry. A call to
 *   "entityReviewQueue.js:applyLookupResult" changed the document…
 *
 * The write was pointless as well as harmful. `enrichment` has exactly two
 * consumers: the commit prelude, which reads it to seed a newly created
 * player/team, and the review wizard's detail panel — and the wizard only ever
 * renders a row that is NOT decided (`EntityReviewWizard`'s `current` filters
 * on `!r.decision`). So once a decision exists, nothing will ever read the
 * enrichment this patch would store: commit has either already read the row or
 * is about to, and either way it finishes by deleting the batch.
 *
 * This does NOT weaken the "a row is never stranded on pending" invariant —
 * see `backstopEntityReviewRowImpl`, which carries the same guard and the
 * argument for why.
 */
export const applyLookupResult = internalMutation({
  args: {
    id: v.id("entityReviewQueue"),
    status: v.union(v.literal("ready"), v.literal("error")),
    enrichment: v.optional(enrichmentValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    // Gone — a Cancel or a completed commit deleted the batch while this item
    // was still draining. Nothing to resolve.
    if (!row) return null;
    // Decided: the operator has ruled and commit is imminent or done. Writing
    // here would only contend with the commit's read of this same row.
    if (row.decision) return null;

    /**
     * NEO-254 — attach NB's OWN answer to the same question the lookup asked.
     *
     * A row reaches the wizard for one of two reasons now: nothing in
     * `players` matches the name, or SEVERAL things do (see
     * `players.resolveNameForReview`). In the second case the operator's first
     * question is not "what does Wikidata say", it is "which of the people we
     * already have is this?", and until now the wizard had no way to answer
     * it: `nearMatches` gave bare names with no birth year and no career, and
     * only one of them at that.
     *
     * Computed HERE rather than in the action that calls this, for two
     * reasons. It is a `players` read, and this mutation already holds the
     * transaction; and it must happen on BOTH branches — a name Wikidata has
     * never heard of is exactly as ambiguous as one it knows, and the error
     * branch sends no enrichment at all, so a client-side merge would have
     * shown candidates only for the lucky half.
     *
     * `buildExistingPlayerCandidates` returns [] unless there are two or more,
     * so an ordinary new name stores nothing extra and the wizard renders
     * exactly what it did before.
     */
    const existingCandidates =
      row.kind === "player"
        ? await buildExistingPlayerCandidates(ctx, row.name, row.sportId, {
            // NEO-254: re-derived live rather than read off the row, for the
            // same reason the candidates themselves are — the set's year is
            // cheap to walk to and a row can outlive the shape it was written
            // with.
            cardYear: await findSetYearForSelectorOption(ctx, row.selectorOptionId),
          })
        : [];

    // The enrichment object is only MINTED for candidates when the lookup
    // itself found nothing; a `status: "error"` row with candidates on it is
    // still an error row, and the wizard keys its "No Wikidata match found."
    // on `status`, not on the presence of this object.
    const enrichment =
      existingCandidates.length > 0
        ? { ...(args.enrichment ?? {}), existingCandidates }
        : args.enrichment;

    await ctx.db.patch(args.id, {
      status: args.status,
      enrichment,
    });
    /*
     * NEO-236 — THIS is where a player's career teams become their own steps.
     *
     * The moment the enrichment lands is the earliest one at which the career
     * list exists, and it is before the row can be walked to: `nextUndecided`
     * only ever presents a SETTLED row, and this mutation is what settles it.
     * Staging here is therefore what makes Jason's sequence fall out of the
     * ordinary walk — the two club steps are already in the batch, ahead of the
     * player, by the time anything is presented at all.
     *
     * Deliberately reads through an INDEX rather than collecting the batch (see
     * `stageCareerTeamRowsImpl`): this mutation runs once per row, five at a
     * time under the pool, alongside a commit that may be reading the same
     * batch. NEO-189 is the record of what a wide read set does here.
     *
     * `row` is the PRE-patch document, so the enrichment is passed explicitly
     * rather than re-read — a second `ctx.db.get` would only widen the read set
     * for a value already in hand.
     */
    if (row.kind === "player" && (args.enrichment?.careerTeams?.length ?? 0) > 0) {
      await stageCareerTeamRowsImpl(ctx, { ...row, enrichment: args.enrichment });
    }
    /*
     * NEO-254 — and the same, one level up.
     *
     * A team row's lookup is what produces `enrichment.league` (Wikidata P118,
     * or ESPN's league name), so this is the first moment the batch knows a
     * league might have to be created. Staging here puts the New League step
     * in the batch BEFORE the team can be walked to, for exactly the reason
     * the career-team staging runs here: `nextUndecided` only ever presents a
     * settled row, and this mutation is what settles it.
     */
    if (row.kind === "team" && args.enrichment?.league) {
      await stageLeagueRowsImpl(ctx, { ...row, enrichment: args.enrichment });
    }
    return null;
  },
});

/**
 * The workpool completion backstop (NEO-99), as a plain exported function so
 * the tests can drive it via `t.run` without mounting the workpool component —
 * the same reason `recordImageOutcomeImpl` is a function rather than a
 * registered mutation. `onEntityReviewLookupComplete` in wikidataPool.ts is the
 * one-line delegation the pool actually calls.
 *
 * The invariant it guarantees: a review row can never be stranded on `pending`.
 * `runEntityReviewLookup` resolves the row on its own happy and caught-error
 * paths, so this normally finds the row already "ready"/"error" and no-ops. It
 * exists for the residue that path cannot reach from within itself — an uncaught
 * throw, an action-level timeout, or a pool cancellation, in each of which the
 * action never ran its patch. In all of those the row is still `pending` when
 * the work item finally completes, and this ages it to "error" ("No Wikidata
 * match found"), which is the honest end state for a lookup that produced
 * nothing usable.
 *
 * `result.kind` is not branched on: whatever terminal shape the work item ended
 * in, a still-`pending` row means "no result landed", and "error" is the
 * resolution for every one of them. An already-resolved row is left exactly as
 * the action set it (a real "ready" with enrichment is never downgraded).
 * `decision` is never touched, so a row bulk-decided while its lookup was in
 * flight keeps its decision.
 *
 * ## NEO-189: a DECIDED row is skipped, and that does not weaken the invariant
 *
 * Same guard, same reason as `applyLookupResult` above — a write here on a row
 * the commit prelude is reading is what made the seed job's commit lose an
 * optimistic-concurrency race on every retry.
 *
 * The invariant this function exists for is about rows the operator has NOT
 * ruled on: those are the ones the wizard blocks on, and they still get aged
 * exactly as before. A DECIDED row left sitting on `pending` is inert — the
 * wizard's `current` skips decided rows entirely, its "N of M" counts
 * decisions rather than statuses, so nothing blocks on the status — and it does
 * not survive: `commitCardChecklist` deletes the whole batch when it finishes,
 * `cancelBatch` deletes it on Cancel, and `sweepStalePendingRows` ages whatever
 * an abandoned wizard leaves behind after ENTITY_REVIEW_STALE_MS.
 */
export async function backstopEntityReviewRowImpl(
  ctx: MutationCtx,
  rowId: Id<"entityReviewQueue">,
  result: RunResult,
): Promise<null> {
  const row = await ctx.db.get(rowId);
  // Gone (a Cancel deleted the batch while this item drained) — nothing to age.
  if (!row) return null;
  // Already resolved by the action itself — the common path. Leave it be.
  if (row.status !== "pending") return null;
  // NEO-189: decided by the operator — commit is imminent or done, and this
  // write would only contend with the commit's read of this row. See above.
  if (row.decision) return null;

  // rowId is an opaque document id, never PII (see the no-PII rule in
  // observability.ts). `result.kind` tells triage HOW the work item ended
  // without the row having been resolved — the fingerprint of the residue this
  // backstop exists for.
  console.warn(
    JSON.stringify({
      msg: "entity_review_row_backstopped",
      rowId,
      resultKind: result.kind,
    }),
  );
  await ctx.db.patch(rowId, { status: "error" });
  return null;
}

/**
 * How long a review row may sit `pending` before the cron sweep ages it to
 * "error" (crons.ts → sweepStalePendingRows).
 *
 * This is the LAST line of defense, behind both the pool's `onComplete` and the
 * fetch timeout — it only matters if a work item is lost so completely that its
 * completion callback never fires at all. 30 minutes is deliberately generous:
 * under the 5-wide pool a healthy row resolves within seconds, and even a
 * pathological all-timeout drain of a many-hundred-entity batch finishes well
 * inside this window, so a false positive (aging a row that was still going to
 * resolve) is nearly impossible — and if every lookup really is timing out for
 * half an hour, Wikidata is down and "error" is the correct outcome anyway.
 * Erring long mirrors the placeholder wedge watchdog's exact philosophy: a
 * safety net must never fire on healthy work.
 */
export const ENTITY_REVIEW_STALE_MS = 30 * 60 * 1000;

/** Rows aged per sweep invocation before self-scheduling the rest — bounds the
 *  transaction the way the placeholder watchdog's take does. */
export const ENTITY_REVIEW_SWEEP_CHUNK = 100;

/**
 * Cron target (crons.ts): age review rows that have been `pending` past
 * ENTITY_REVIEW_STALE_MS to "error", so a lookup whose work item died mid-flight
 * — in a way even the pool's completion backstop never observed — cannot leave
 * the wizard hung on "Looking up…" forever.
 *
 * Reads through `by_status`, which orders `pending` rows oldest-first (every
 * index ends in `_creationTime` ascending), so the oldest — and therefore the
 * only candidates that can be stale — come first. The scan STOPS at the first
 * row younger than the cutoff: everything after it is younger still. In steady
 * state that first row is a few seconds old, so the common run reads the oldest
 * handful, ages none, and returns — cheap enough to run often.
 *
 * Bounded per invocation and self-scheduling for the remainder, mirroring
 * sweepWedgedBatches: a mass strand after an incident drains across several
 * runs rather than one giant transaction.
 */
export const sweepStalePendingRows = internalMutation({
  args: {},
  returns: v.object({ aged: v.number(), done: v.boolean() }),
  handler: async (ctx) => {
    const cutoff = Date.now() - ENTITY_REVIEW_STALE_MS;
    const oldest = await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(ENTITY_REVIEW_SWEEP_CHUNK);

    let aged = 0;
    for (const row of oldest) {
      // Ordered oldest-first: the first row at-or-after the cutoff means every
      // remaining row is younger too, so there is nothing left to age.
      if (row._creationTime >= cutoff) break;
      await ctx.db.patch(row._id, { status: "error" });
      aged += 1;
    }

    if (aged > 0) {
      console.warn(
        JSON.stringify({ msg: "entity_review_stale_rows_aged", aged }),
      );
    }

    // Self-schedule only if the whole chunk was stale — then more may remain
    // (the aged rows have left the `pending` index, so the next run resumes at
    // the next-oldest and the set strictly shrinks). A partial chunk means the
    // scan hit a fresh row and there is nothing further to do.
    const done = aged < oldest.length || oldest.length < ENTITY_REVIEW_SWEEP_CHUNK;
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.entityReviewQueue.sweepStalePendingRows, {});
    }
    return { aged, done };
  },
});

/**
 * Internal — deletes a batch's rows. NOT called by commitCardChecklist
 * (which deletes its batch's rows synchronously, inline, using the rows it
 * already read to resolve decisions — see the delete site there for why a
 * scheduled/async cleanup was replaced: it left a race where a re-fetch of
 * the same selectorOptionId could observe and wrongly resume an
 * already-committed batch). Kept as a standalone utility for clearing a
 * genuinely abandoned batch (e.g. the user closed the tab mid-review,
 * never confirmed or cancelled) — nothing currently calls it in the
 * commit/cancel path, both of which clean up their own rows directly.
 */
export const cleanupBatch = internalMutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    batchId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await deleteBatchRows(ctx, args.selectorOptionId, args.batchId);
    return null;
  },
});

/**
 * NEO-221 — how long a review batch may sit with NO operator activity before
 * the hourly cron deletes it.
 *
 * Distinct from ENTITY_REVIEW_STALE_MS above, which is about a single row's
 * LOOKUP hanging (30 minutes, ages `pending` → `error`, deletes nothing). This
 * one is about the SESSION: a wizard the operator closed the tab on, whose
 * rows are perfectly healthy and will simply sit there forever, quietly
 * resuming themselves into the next fetch of that set (see `startBatch`).
 *
 * A day, because deleting a batch throws away real operator work — every
 * decision recorded in it — and the only cost of erring long is some rows in a
 * throwaway table. An operator who reviews 200 names across a working day,
 * leaves it overnight and comes back is doing something entirely reasonable;
 * `lastTouchedAt` keeps their session alive for as long as they keep touching
 * it, and 24 hours of complete silence is the honest read of "nobody is coming
 * back".
 */
export const ENTITY_REVIEW_ABANDONED_MS = 24 * 60 * 60 * 1000;

/**
 * Rows examined per sweep invocation. Bounds the transaction the way
 * ENTITY_REVIEW_SWEEP_CHUNK does — a table PAGE, not an index range, because
 * abandonment is a property of a whole (selectorOptionId, batchId) group and
 * no index groups by that.
 */
export const ENTITY_REVIEW_ABANDONED_SCAN = 500;

/**
 * Cron target (crons.ts): delete review batches nobody is coming back to.
 *
 * ## What it is for
 *
 * `commitCardChecklist` and `cancelBatch` each clean up after themselves, so
 * the only batches that survive are the ones whose session simply ENDED —
 * closed tab, crashed browser, an operator who walked away. Those are not
 * inert: `startBatch` resumes any batch it finds for the same
 * (selectorOptionId, user), so an abandoned one silently becomes the next
 * fetch's starting point, complete with decisions made against a card list
 * that may be weeks old. Deleting it is what makes the next fetch a fresh
 * question.
 *
 * ## The abandonment test
 *
 * A batch is abandoned when EVERY row in it has been silent past the cutoff,
 * where a row's last sign of life is `max(_creationTime, lastTouchedAt ?? 0)`.
 * Every row, not any row and not the newest: a batch is one session, and one
 * decision recorded ten minutes ago is proof the whole session is alive even
 * if two hundred of its rows were inserted yesterday and never touched again.
 * `lastTouchedAt` absent means "never touched", which is exactly what a row
 * written before this field existed is.
 *
 * ## Why the page only NOMINATES, and the batch is then re-read in full
 *
 * The page is a window over the table ordered by `_creationTime`, and a batch
 * is routinely bigger than it — a first-time sync of a real set surfaces
 * hundreds of names. Judging a batch on the rows that happened to fall inside
 * the window would delete a live session whose recent activity sat just
 * outside it, which is the operator-work-destroying failure this whole ticket
 * is about. So a page can only nominate a (selectorOptionId, batchId) as a
 * candidate; the decision is taken over the batch's FULL row set, re-read
 * through `by_selector_option_and_batch` in this same transaction.
 *
 * ## Why it paginates with a cursor rather than restarting
 *
 * `sweepStalePendingRows` can restart from the top each run because the rows
 * it fixes LEAVE the index it reads (`status` stops being `pending`). This one
 * reads the whole table, and the rows it does not delete — every live batch —
 * stay exactly where they are. Without a cursor, a deployment whose oldest 500
 * rows are one long-running review would re-examine that same review forever
 * and never reach the abandoned batch behind it. So the cursor is carried
 * forward and the sweep self-schedules until the table is exhausted, the same
 * bounded-work-then-continue shape as `sweepWedgedBatches`.
 */
export const sweepAbandonedBatches = internalMutation({
  args: {
    // Continuation of THIS sweep's walk over the table. Absent on the cron's
    // own invocation, which always starts from the beginning.
    cursor: v.optional(v.string()),
  },
  returns: v.object({
    batches: v.number(),
    rows: v.number(),
    done: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const cutoff = Date.now() - ENTITY_REVIEW_ABANDONED_MS;
    const lastTouched = (row: Doc<"entityReviewQueue">) =>
      Math.max(row._creationTime, row.lastTouchedAt ?? 0);

    const page = await ctx.db
      .query("entityReviewQueue")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: ENTITY_REVIEW_ABANDONED_SCAN,
      });

    // Group by (selectorOptionId, batchId). `\u0000` cannot appear in either
    // component, so the composite key is unambiguous. A batch straddling the
    // page boundary is nominated by whichever page holds a stale row of it and
    // then re-read in full below, so the split costs correctness nothing.
    const candidates = new Map<
      string,
      { selectorOptionId: Id<"selectorOptions">; batchId: string }
    >();
    for (const row of page.page) {
      if (lastTouched(row) >= cutoff) continue;
      const key = `${row.selectorOptionId}\u0000${row.batchId}`;
      if (!candidates.has(key)) {
        candidates.set(key, {
          selectorOptionId: row.selectorOptionId,
          batchId: row.batchId,
        });
      }
    }

    let batches = 0;
    let rows = 0;
    for (const { selectorOptionId, batchId } of candidates.values()) {
      // The decision, taken over the WHOLE batch. One live row anywhere in it
      // means the session is not over — see the note above.
      const all = await ctx.db
        .query("entityReviewQueue")
        .withIndex("by_selector_option_and_batch", (q) =>
          q.eq("selectorOptionId", selectorOptionId).eq("batchId", batchId),
        )
        .collect();
      if (all.length === 0) continue;
      if (all.some((row) => lastTouched(row) >= cutoff)) continue;
      rows += await deleteBatchRows(ctx, selectorOptionId, batchId);
      batches += 1;
    }

    if (batches > 0) {
      // Ids and counts only — never a name. See the no-PII rule in
      // observability.ts.
      console.warn(
        JSON.stringify({ msg: "entity_review_batches_reaped", batches, rows }),
      );
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.entityReviewQueue.sweepAbandonedBatches,
        { cursor: page.continueCursor },
      );
    }
    return { batches, rows, done: page.isDone };
  },
});
