import type { Id } from "../../convex/_generated/dataModel";
import { normalizeEntityName } from "../../convex/lib/entityNearMatch";
// Browser-safe: `features/cardAttention.ts` has no server imports (it is
// already read by the attention walker in the browser).
import { MAX_CARD_TEAMS } from "../../convex/features/cardAttention";
// Browser-safe: `lib/teamFill.ts` is pure by contract (ids in, answer out).
// The career window rule lives there ONCE, for the server and for a player
// created in this wizard alike.
import {
  careerTeamVerdict,
  UNRANKED,
  type TeamPreferenceRank,
} from "../../convex/lib/teamFill";
import { teamFullName } from "../../lib/teams/team-name";

export { MAX_CARD_TEAMS };

/**
 * NEO-335 — the Teams step: which confirmed cards will save with no team,
 * what evidence says about each, and what the operator answered.
 *
 * Pure: no Convex, no hooks, no I/O. The entity review wizard's Teams step
 * (`TeamsOnCardsSection`) supplies the preview cards, the batch rows and the
 * server's evidence; everything it renders is decided here, so the whole
 * thing is testable as a function of its inputs — the same split
 * `entity-review-staging.ts` makes for the career-team typeahead.
 *
 * ## Who is in the section
 *
 * A confirmed card none of whose team strings will resolve at commit: no
 * strings at all (SportLots never sends one), or every string a name the
 * operator skipped as "not a team". A string with no review row resolved
 * before the wizard opened (`resolveChecklistEntities` only queues unknowns),
 * so it counts as a team. Membership is computed from the cards and the
 * Names-phase decisions ONLY — never from this section's own answers, so a
 * line does not vanish under the operator's cursor the moment they answer it.
 *
 * ## Evidence, first answer wins
 *
 *  (i) **batch** — other confirmed cards in this preview with the SAME player
 *      set whose team resolves. One distinct team set is the answer; two or
 *      more means the checklist disagrees with itself and the search stops,
 *      offering every team as an unselected choice.
 *  (ii)+(iii) **per player** — linked and already-known players from the
 *      server (`cardChecklist.teamSuggestionsForPreview`: stored rows, then
 *      the career window); players CREATED in this wizard from their own
 *      row's career (`enrichment.careerTeams`, minus what the operator
 *      unchecked, plus what they typed) through the SAME window rule
 *      (`careerTeamVerdict`). Every player answering → the union is
 *      pre-filled. Anyone not answering → every team any of them offered,
 *      unselected.
 *
 * The career window (NEO-335 Phase 2, C2): exactly one team covering
 * `[setYear - 1, setYear]`, or in a tie the one team the set's league
 * prefers (C2b). With nothing in the window, a legend's ONE-team career
 * pre-fills only when that team is in the set's own league; any other legend
 * gets his career unselected, longest stint first. Choices are ordered by
 * that preference rank, which never hides a team and never forces a pick.
 *
 * ## A listing's team claim holds the guess back (invariant 8)
 *
 * "A data claim holds back a guess; it never makes one." A card in the
 * section whose listing printed a team name NB could not resolve and the
 * operator has NOT ruled on, or whose team lookup FAILED (the listing may
 * name a team we never heard), gets NO pre-fill from any rule — batch,
 * stored rows, career, preference. The line comes up on "Leave for later";
 * the listed name is SHOWN (`listedNames`), the existing NB teams it names
 * are offered first as choices (`teamNameEvidence`), and the evidence's
 * teams follow as unselected choices. The listing's string itself is never
 * written as NB data: a chip is always an existing team (by id), a team
 * staged in this wizard, or one the operator found or created with
 * "Other team…".
 *
 * A name the operator ruled "not a team" (its step skipped) in this sitting
 * is no longer a claim (Jason, NEO-335 Phase 2): the operator has already
 * answered it, so it neither blocks the pre-fill nor is shown, and the line
 * falls back to the normal rules.
 *
 * Never a guess: a tie stays unselected, and a card number is never a key —
 * a card is identified by its POSITION in the preview, which is the only
 * identity it has until it is saved (product invariant 7).
 *
 * ## Choices
 *
 * One line per player set. A line whose card has several people on it (or
 * whose answer is several teams) is MULTI-select, up to `MAX_CARD_TEAMS`
 * (C4); every other line picks one. "Other team…" adds a team the evidence
 * did not offer, found or created through the team picker, as `extra` on the
 * choice so it survives the operator flipping to "No team" and back (C1). A
 * card inside a grouped line can take its own answer (C3), filed under
 * `cardChoiceKey`; `{ kind: "line" }` hands it back to the line.
 *
 * ## What an answer writes
 *
 * Onto the preview card, for the commit to read, and nowhere else (wizard
 * answers are never stored):
 *  - `teamIds` — existing NB teams, by id (server evidence, "Other team…");
 *  - `teams` — team STRINGS the commit already resolves the way it resolves
 *    every card's printed team: a team staged in this wizard (by its review
 *    row's name, which is the key the commit's decision map uses), or a
 *    sibling card's printed team (batch evidence);
 *  - `teamNone: true` — "No team on this card".
 */

/** The preview card fields this module reads (a structural subset of `FetchPreview`'s cards). */
export interface PreviewCardForTeams {
  cardNumber: string;
  cardName: string;
  team?: string;
  teams?: string[];
  players?: string[];
  /**
   * How the fetch-time team lookup for this card ended. "failed" means the
   * listing's answer never arrived, so no rule may guess a team for it
   * (invariant 8): the operator picks.
   */
  teamLookup?: "answered" | "failed";
}

/** The operator's answer for one card, as the commit reads it. */
export type TeamAnswer = {
  teamIds?: Array<Id<"teams">>;
  teams?: string[];
  teamNone?: true;
};

type TeamColors = { primary?: string; secondary?: string };
type CareerStint = { name: string; fromYear: number; toYear?: number };

/** The subset of an `entityReviewQueue.getBatch` row this module reads. */
export interface TeamsReviewRow {
  _id: string;
  kind: "player" | "team" | "league";
  name: string;
  enrichment?: { careerTeams?: CareerStint[]; colors?: TeamColors } | null;
  decision?:
    | {
        action: "create";
        create?: { location?: string; name: string; leagueId?: string | null };
        manualCareerTeams?: CareerStint[];
        excludedCareerTeamNames?: string[];
      }
    | { action: "link"; linkedPlayerId?: string; linkedTeamId?: string }
    | { action: "skip" }
    | null;
}

/** One team as the server suggests it. */
export interface ServerTeam {
  teamId: Id<"teams">;
  name: string;
  colors?: TeamColors;
  /** C2b — 0 the set's league, 1 its level, 2 other. Absent = 2. */
  rank?: number;
}

/** One player's evidence from `teamSuggestionsForPreview`. */
export interface ServerPlayerEvidence {
  answer: { tier: string; teams: ServerTeam[] } | null;
  candidates: ServerTeam[];
}

/** A player the server is asked about. `key` is what its evidence is filed under. */
export interface EvidenceRequest {
  key: string;
  playerId?: Id<"players">;
  name?: string;
}

/** A team name the server is asked to resolve to existing NB teams. `key` = normalized name. */
export interface TeamNameRequest {
  key: string;
  name: string;
}

/** One team chip. */
export interface TeamRef {
  /** `id:<teamId>` or `name:<normalized>` — dedup identity. */
  key: string;
  /** What the chip says. */
  label: string;
  colors?: TeamColors;
  /** Set for an existing NB team → the answer's `teamIds`. */
  teamId?: Id<"teams">;
  /** Set for a team the commit resolves by string → the answer's `teams`. */
  name?: string;
  /** C2b preference, for ordering. Absent = 2. */
  rank?: number;
}

/** Cards that share a player set (and a listing claim) share evidence, so they share one line. */
export interface TeamsGroup {
  key: string;
  /** Display names, as printed on the first card of the group. */
  players: string[];
  /** Preview positions, ascending. */
  cards: Array<{ index: number; cardNumber: string; cardName: string }>;
  /** Several people on the card (or several teams in its answer): pick up to `MAX_CARD_TEAMS`. */
  multi: boolean;
  /** Every team chip the line offers: the pre-fill first, the listing's teams next, then by preference. */
  refs: TeamRef[];
  /** The pre-filled selection (ref keys), when evidence gave one and nothing held it back. */
  suggestion: string[] | null;
  /**
   * Invariant 8 — team names the listing printed that NB could not resolve
   * and the operator has not ruled "not a team". Shown, never written.
   */
  listedNames: string[];
  /** Invariant 8 — the listing's team lookup failed for these cards. */
  lookupFailed: boolean;
  /** Server evidence for at least one player (or listed name) has not arrived yet. */
  loading: boolean;
}

/** Team ids found with "Other team…", kept whatever the line is set to. */
type Extra = { extra?: Array<Id<"teams">> };

export type GroupChoice =
  | ({ kind: "teams"; refKeys: string[] } & Extra)
  | ({ kind: "none" } & Extra)
  | ({ kind: "later" } & Extra)
  /** Per-card only: follow the line again. */
  | { kind: "line" };

/** The one line every teamless card with no players shares. */
export const NO_PLAYERS_GROUP_KEY = "no-players";

/** How many team chips one line offers before "Other team…". */
export const TEAMS_SECTION_MAX_OPTIONS = 6;

/**
 * Players per server call. Mirrors `TEAM_SUGGESTION_MAX_PLAYERS` in
 * convex/cardChecklist.ts (the server refuses more); a convex test pins the
 * two together. A browser bundle cannot import that module.
 */
export const TEAMS_SECTION_PLAYERS_PER_REQUEST = 32;

/** Team names per server call. Mirrors `TEAM_SUGGESTION_MAX_TEAM_NAMES` (pinned by the same test). */
export const TEAMS_SECTION_NAMES_PER_REQUEST = 32;

/** How many player calls the section makes at most (×32 players). */
export const TEAMS_SECTION_MAX_REQUESTS = 8;

/** How many name calls the section makes at most (×32 names). */
export const TEAMS_SECTION_MAX_NAME_REQUESTS = 4;

const norm = (raw: string): string => normalizeEntityName(raw.trim());

/** Where one card's own answer is filed in the choices record (C3). */
export function cardChoiceKey(groupKey: string, index: number): string {
  return `${groupKey}#card:${index}`;
}

/** The ref key of an existing NB team. */
export function teamIdKey(teamId: Id<"teams">): string {
  return `id:${teamId}`;
}

/**
 * The team strings printed on a card — `teams[]`, else the legacy `team`.
 * Mirrors `cardTeamNames` in convex/selectorOptions.ts so the two agree on
 * what a card says.
 */
export function cardTeamStrings(card: PreviewCardForTeams): string[] {
  const named = (card.teams ?? []).map((t) => t.trim()).filter(Boolean);
  if (named.length === 0 && card.team?.trim()) named.push(card.team.trim());
  return Array.from(new Set(named));
}

/**
 * Who is on the cards, as the STORED data says it — the half the review rows
 * cannot say. Both are facts NB already holds (sets → cards → players, and
 * the set's skip records); nothing here is a stored wizard answer.
 *
 * The review rows only describe names that were UNKNOWN when this sitting
 * opened. A re-sync of a set whose names were settled in an earlier save has
 * none (the teams-only entry has no rows at all), so without these every
 * printed name — including the ones an operator ruled "not a person" — would
 * come back as a player line of its own.
 */
export interface StoredPeople {
  /**
   * Preview positions whose card re-syncs a stored row that the save keeps
   * with NO players (its players are not being replaced by an accepted
   * content change). The save writes nobody onto it, so it is a no-players
   * card whatever it prints.
   */
  playerless?: ReadonlySet<number>;
  /**
   * Player names this set's skip records rule "not a person" (normalized with
   * `normalizeEntityName`, as the records key them). Such a name never reaches
   * the review rows — the gate drops it before asking — so it is nobody here
   * too, exactly like a name skipped in this sitting.
   */
  skippedPlayerNames?: ReadonlySet<string>;
}

/**
 * The host's wire shapes (positions and RAW skipped names) as `StoredPeople`.
 * Undefined when there is nothing to say, so a caller with neither passes
 * exactly what it passed before.
 */
export function storedPeople(
  playerlessIndexes?: readonly number[],
  skippedPlayerNames?: readonly string[],
): StoredPeople | undefined {
  const playerless =
    playerlessIndexes && playerlessIndexes.length > 0 ? new Set(playerlessIndexes) : undefined;
  const skipped = new Set((skippedPlayerNames ?? []).map(norm).filter(Boolean));
  if (!playerless && skipped.size === 0) return undefined;
  return {
    ...(playerless ? { playerless } : {}),
    ...(skipped.size > 0 ? { skippedPlayerNames: skipped } : {}),
  };
}

interface NamesView {
  teamRowByKey: Map<string, TeamsReviewRow>;
  playerRowByKey: Map<string, TeamsReviewRow>;
  playerless: ReadonlySet<number>;
  skippedPlayerNames: ReadonlySet<string>;
}

const NOBODY: ReadonlySet<never> = new Set<never>();

function namesView(rows: readonly TeamsReviewRow[], people?: StoredPeople): NamesView {
  const teamRowByKey = new Map<string, TeamsReviewRow>();
  const playerRowByKey = new Map<string, TeamsReviewRow>();
  for (const row of rows) {
    const key = norm(row.name);
    if (!key) continue;
    const target =
      row.kind === "team" ? teamRowByKey : row.kind === "player" ? playerRowByKey : null;
    if (target && !target.has(key)) target.set(key, row);
  }
  return {
    teamRowByKey,
    playerRowByKey,
    playerless: people?.playerless ?? NOBODY,
    skippedPlayerNames: people?.skippedPlayerNames ?? NOBODY,
  };
}

/**
 * Invariant 8 — the printed team strings on a section card that still claim
 * a team: every one failed to resolve (that is how the card got here), minus
 * the ones the operator ruled "not a team". A skip is an answer to the
 * claim, so it no longer holds the guess back.
 */
function listedClaims(card: PreviewCardForTeams, view: NamesView): string[] {
  return cardTeamStrings(card).filter(
    (raw) => view.teamRowByKey.get(norm(raw))?.decision?.action !== "skip",
  );
}

/** Will this printed team string resolve to a team at commit? */
function teamStringResolves(raw: string, view: NamesView): boolean {
  const key = norm(raw);
  if (!key) return false;
  const row = view.teamRowByKey.get(key);
  if (!row) return true; // resolved before the wizard opened
  return row.decision?.action === "create" || row.decision?.action === "link";
}

type CardPlayer =
  | { kind: "created"; key: string; display: string; row: TeamsReviewRow }
  | { kind: "server"; key: string; display: string; request: EvidenceRequest };

/**
 * The people on a card (at preview position `index`), deduped. A name skipped
 * as "not a person" — in this sitting, or in an earlier save of this set — is
 * nobody, and a re-synced card the save keeps with no players has nobody on
 * it at all (`StoredPeople`).
 */
function cardPlayers(card: PreviewCardForTeams, index: number, view: NamesView): CardPlayer[] {
  if (view.playerless.has(index)) return [];
  const out: CardPlayer[] = [];
  const seen = new Set<string>();
  for (const raw of card.players ?? []) {
    const display = raw.trim();
    const key = norm(display);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const row = view.playerRowByKey.get(key);
    const action = row?.decision?.action;
    if (row && action === "skip") continue;
    if (!row && view.skippedPlayerNames.has(key)) continue;
    if (row && action === "create") {
      out.push({ kind: "created", key, display, row });
    } else if (row && row.decision?.action === "link" && row.decision.linkedPlayerId) {
      const playerId = row.decision.linkedPlayerId as Id<"players">;
      out.push({
        kind: "server",
        key,
        display,
        request: { key: `id:${playerId}`, playerId },
      });
    } else if (!row) {
      out.push({ kind: "server", key, display, request: { key: `name:${key}`, name: display } });
    }
    // A row with no decision cannot reach the Teams step (every row is
    // decided there); a link with no id is malformed. Both are nobody.
  }
  return out;
}

/**
 * The preview positions that will save with no team.
 *
 * `settled` names positions whose card re-syncs an EXISTING row that already
 * carries a team (or an operator's "no team"): the commit keeps a stored
 * row's team, so those cards will not save teamless whatever they print, and
 * asking about them again on every re-sync would be asking an answered
 * question.
 */
export function teamlessCardIndexes(
  cards: readonly PreviewCardForTeams[],
  rows: readonly TeamsReviewRow[],
  settled?: ReadonlySet<number>,
): number[] {
  const view = namesView(rows);
  const out: number[] = [];
  cards.forEach((card, index) => {
    if (settled?.has(index)) return;
    if (!cardTeamStrings(card).some((t) => teamStringResolves(t, view))) out.push(index);
  });
  return out;
}

/**
 * Every player the server should be asked about, across every teamless card,
 * deduped by request key, in first-seen order.
 */
export function evidenceRequests(
  cards: readonly PreviewCardForTeams[],
  rows: readonly TeamsReviewRow[],
  settled?: ReadonlySet<number>,
  people?: StoredPeople,
): EvidenceRequest[] {
  const view = namesView(rows, people);
  const out = new Map<string, EvidenceRequest>();
  for (const index of teamlessCardIndexes(cards, rows, settled)) {
    for (const player of cardPlayers(cards[index], index, view)) {
      if (player.kind === "server" && !out.has(player.request.key)) {
        out.set(player.request.key, player.request);
      }
    }
  }
  return [...out.values()];
}

/** A created player's career, minus what the operator unchecked, plus what they typed. */
function createdStints(row: TeamsReviewRow): CareerStint[] {
  const decision = row.decision?.action === "create" ? row.decision : undefined;
  const excluded = new Set((decision?.excludedCareerTeamNames ?? []).map(norm));
  return [
    ...(row.enrichment?.careerTeams ?? []).filter((s) => !excluded.has(norm(s.name))),
    ...(decision?.manualCareerTeams ?? []),
  ];
}

/**
 * Every team NAME the server should resolve to existing NB teams, deduped by
 * normalized name, in first-seen order:
 *  - a listing's printed team on a card in the section (invariant 8: its NB
 *    matches are offered as choices, never pre-filled);
 *  - a created player's career team that has no review row of its own, i.e.
 *    one that names a team NB already holds — so it can be ranked (C2b).
 */
export function teamNameRequests(
  cards: readonly PreviewCardForTeams[],
  rows: readonly TeamsReviewRow[],
  settled?: ReadonlySet<number>,
  people?: StoredPeople,
): TeamNameRequest[] {
  const view = namesView(rows, people);
  const out = new Map<string, TeamNameRequest>();
  const add = (raw: string) => {
    const key = norm(raw);
    if (key && !out.has(key)) out.set(key, { key, name: raw.trim() });
  };
  for (const index of teamlessCardIndexes(cards, rows, settled)) {
    const card = cards[index];
    for (const listed of listedClaims(card, view)) add(listed);
    for (const player of cardPlayers(card, index, view)) {
      if (player.kind !== "created") continue;
      for (const stint of createdStints(player.row)) {
        if (!view.teamRowByKey.has(norm(stint.name))) add(stint.name);
      }
    }
  }
  return [...out.values()];
}

/** A printed or career team STRING as a chip: staged teams show their composed name. */
function refFromString(
  raw: string,
  view: NamesView,
  linkedTeamNameById: ReadonlyMap<string, string>,
): TeamRef | null {
  const key = norm(raw);
  if (!key) return null;
  const row = view.teamRowByKey.get(key);
  if (!row) return { key: `name:${key}`, label: raw.trim(), name: raw.trim() };
  const decision = row.decision;
  if (decision?.action === "create") {
    return {
      key: `name:${key}`,
      label: decision.create ? teamFullName(decision.create) : row.name,
      ...(row.enrichment?.colors ? { colors: row.enrichment.colors } : {}),
      // The review row's own name: the key the commit's decision map is
      // built on, whatever the operator composed the team as.
      name: row.name,
    };
  }
  if (decision?.action === "link") {
    return {
      key: `name:${key}`,
      label:
        (decision.linkedTeamId && linkedTeamNameById.get(decision.linkedTeamId)) || row.name,
      name: row.name,
    };
  }
  return null; // skipped, or undecided: not a team
}

function refFromServer(team: ServerTeam): TeamRef {
  return {
    key: teamIdKey(team.teamId),
    label: team.name,
    ...(team.colors ? { colors: team.colors } : {}),
    teamId: team.teamId,
    ...(team.rank !== undefined ? { rank: team.rank } : {}),
  };
}

function dedupeRefs(refs: TeamRef[]): TeamRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
}

/** Stable: preference rank first, the evidence's own order within a rank. */
function byRank(refs: TeamRef[]): TeamRef[] {
  return refs
    .map((ref, i) => ({ ref, i }))
    .sort((a, b) => (a.ref.rank ?? UNRANKED) - (b.ref.rank ?? UNRANKED) || a.i - b.i)
    .map(({ ref }) => ref);
}

type PlayerVerdict = { answer: TeamRef[] | null; candidates: TeamRef[]; loading: boolean };

interface RankContext {
  view: NamesView;
  /** By normalized name; absent map = names are not being resolved (nothing pending). */
  teamNameEvidence: ReadonlyMap<string, ServerTeam[]> | undefined;
  setLeagueId: string | null | undefined;
}

/**
 * A career STRING's preference rank, and whether it is still waiting on the
 * server. A team staged in this wizard is in the set's league when the
 * operator filed it there; an existing team is ranked by the server
 * (`teamNames`). Anything unknown is "other".
 */
function stringRank(raw: string, ctx: RankContext): { rank: TeamPreferenceRank; pending: boolean } {
  const key = norm(raw);
  const row = ctx.view.teamRowByKey.get(key);
  if (row) {
    const leagueId = row.decision?.action === "create" ? row.decision.create?.leagueId : undefined;
    return {
      rank: leagueId && ctx.setLeagueId && leagueId === ctx.setLeagueId ? 0 : UNRANKED,
      pending: false,
    };
  }
  if (!ctx.teamNameEvidence) return { rank: UNRANKED, pending: false };
  const evidence = ctx.teamNameEvidence.get(key);
  if (!evidence) return { rank: UNRANKED, pending: true };
  const best = Math.min(UNRANKED, ...evidence.map((t) => t.rank ?? UNRANKED));
  return { rank: best as TeamPreferenceRank, pending: false };
}

/** A created player's own career, through the shared window rule. */
function createdPlayerVerdict(
  row: TeamsReviewRow,
  linkedTeamNameById: ReadonlyMap<string, string>,
  setYear: number | undefined,
  currentYear: number,
  ctx: RankContext,
): PlayerVerdict {
  const refByKey = new Map<string, TeamRef>();
  const stints: Array<{ key: string; fromYear: number; toYear?: number }> = [];
  let loading = false;
  for (const stint of createdStints(row)) {
    const ref = refFromString(stint.name, ctx.view, linkedTeamNameById);
    if (!ref) continue;
    if (!refByKey.has(ref.key)) {
      const { rank, pending } = stringRank(stint.name, ctx);
      if (pending) loading = true;
      refByKey.set(ref.key, rank === UNRANKED ? ref : { ...ref, rank });
    }
    stints.push({
      key: ref.key,
      fromYear: stint.fromYear,
      ...(stint.toYear !== undefined ? { toYear: stint.toYear } : {}),
    });
  }
  // A rank still on its way could change a tie-break: hold the line until
  // it lands rather than pre-fill and then move the pick under the cursor.
  if (loading) return { answer: null, candidates: [], loading: true };
  const verdict = careerTeamVerdict({
    stints,
    year: setYear,
    currentYear,
    rankOf: (key) => (refByKey.get(key)?.rank ?? UNRANKED) as TeamPreferenceRank,
  });
  return {
    answer: verdict.answer ? [refByKey.get(verdict.answer.key)!] : null,
    candidates: verdict.candidates.map((key) => refByKey.get(key)!),
    loading: false,
  };
}

function serverPlayerVerdict(evidence: ServerPlayerEvidence | undefined): PlayerVerdict {
  if (!evidence) return { answer: null, candidates: [], loading: true };
  return {
    answer: evidence.answer ? evidence.answer.teams.map(refFromServer) : null,
    candidates: evidence.candidates.map(refFromServer),
    loading: false,
  };
}

/**
 * Group the teamless cards by player set (and listing claim) and decide each
 * group's evidence. Groups come back in the order of their first card.
 */
export function buildTeamsGroups(input: {
  cards: readonly PreviewCardForTeams[];
  rows: readonly TeamsReviewRow[];
  /** Server evidence by `EvidenceRequest.key`; absent = not arrived yet. */
  serverEvidence: ReadonlyMap<string, ServerPlayerEvidence>;
  setYear: number | undefined;
  /** Linked team id → its full name, for a link decision's chip. */
  linkedTeamNameById: ReadonlyMap<string, string>;
  currentYear: number;
  /** Positions whose stored row already has a team — see `teamlessCardIndexes`. */
  settled?: ReadonlySet<number>;
  /**
   * `TeamNameRequest.key` → the existing NB teams that name resolves to;
   * a key absent from the map = not arrived yet. Omit the whole map and
   * names are not resolved at all (nothing waits on them).
   */
  teamNameEvidence?: ReadonlyMap<string, ServerTeam[]>;
  /** The set's preferred league (C2b), for a team staged in this wizard. */
  setLeagueId?: string | null;
  /** Who the stored data says is on the cards — see `StoredPeople`. */
  people?: StoredPeople;
}): TeamsGroup[] {
  const { cards, rows, serverEvidence, setYear, linkedTeamNameById, currentYear, settled } =
    input;
  const view = namesView(rows, input.people);
  const rankCtx: RankContext = {
    view,
    teamNameEvidence: input.teamNameEvidence,
    setLeagueId: input.setLeagueId,
  };
  const members = new Set(teamlessCardIndexes(cards, rows, settled));

  // Batch evidence: per player set, the distinct resolving team sets printed
  // on the cards that are NOT in the section.
  const playerSetKey = (players: CardPlayer[]) => players.map((p) => p.key).sort().join("|");
  const batchSets = new Map<string, Map<string, TeamRef[]>>();
  cards.forEach((card, index) => {
    if (members.has(index)) return;
    const players = cardPlayers(card, index, view);
    if (players.length === 0) return;
    const refs = dedupeRefs(
      cardTeamStrings(card)
        .filter((t) => teamStringResolves(t, view))
        .map((t) => refFromString(t, view, linkedTeamNameById))
        .filter((r): r is TeamRef => r !== null),
    );
    if (refs.length === 0) return;
    const pKey = playerSetKey(players);
    const sets = batchSets.get(pKey) ?? new Map<string, TeamRef[]>();
    const setKey = refs.map((r) => r.key).sort().join("+");
    if (!sets.has(setKey)) sets.set(setKey, refs);
    batchSets.set(pKey, sets);
  });

  const groups = new Map<string, TeamsGroup>();
  for (const index of [...members].sort((a, b) => a - b)) {
    const card = cards[index];
    const players = cardPlayers(card, index, view);
    // A printed string on a member card failed to resolve — that is how it
    // got here — so unless the operator ruled it "not a team", it is a
    // listing's team claim (invariant 8).
    const listedNames = listedClaims(card, view);
    const lookupFailed = card.teamLookup === "failed";
    const claimKey =
      (listedNames.length > 0 ? `|listed:${listedNames.map(norm).sort().join("|")}` : "") +
      (lookupFailed ? "|lookup-failed" : "");
    // No people → no player evidence at all, so every such card (a
    // checklist, a league leaders card, a highlight) shares ONE line, keyed
    // on having no players — never on a card's name. Its listing claims are
    // pooled: nothing on it is pre-filled anyway, and each card can still
    // take its own answer (C3).
    const groupKey =
      players.length > 0 ? `players:${playerSetKey(players)}${claimKey}` : NO_PLAYERS_GROUP_KEY;
    const existing = groups.get(groupKey);
    const entry = { index, cardNumber: card.cardNumber, cardName: card.cardName };
    if (existing) {
      existing.cards.push(entry);
      if (groupKey === NO_PLAYERS_GROUP_KEY) {
        existing.lookupFailed ||= lookupFailed;
        for (const name of listedNames) {
          if (existing.listedNames.some((n) => norm(n) === norm(name))) continue;
          existing.listedNames.push(name);
          const found = input.teamNameEvidence?.get(norm(name));
          if (input.teamNameEvidence && !found) existing.loading = true;
          existing.refs = dedupeRefs([
            ...existing.refs,
            ...(found ?? []).map(refFromServer),
          ]).slice(0, TEAMS_SECTION_MAX_OPTIONS);
        }
      }
      continue;
    }

    let suggestion: TeamRef[] | null = null;
    let choices: TeamRef[] = [];
    let loading = false;

    const batch = players.length > 0 ? batchSets.get(playerSetKey(players)) : undefined;
    if (batch && batch.size === 1) {
      suggestion = [...batch.values()][0];
    } else if (batch && batch.size > 1) {
      // The checklist disagrees with itself: the operator picks.
      choices = [...batch.values()].flat();
    } else if (players.length > 0) {
      const verdicts = players.map((p) =>
        p.kind === "created"
          ? createdPlayerVerdict(p.row, linkedTeamNameById, setYear, currentYear, rankCtx)
          : serverPlayerVerdict(serverEvidence.get(p.request.key)),
      );
      loading = verdicts.some((v) => v.loading);
      const union = dedupeRefs(verdicts.flatMap((v) => v.answer ?? []));
      if (verdicts.every((v) => v.answer !== null) && union.length <= MAX_CARD_TEAMS) {
        suggestion = union;
        // A tie-break never hides the teams it ranked below.
        choices = verdicts.flatMap((v) => v.candidates);
      } else {
        choices = verdicts.flatMap((v) => [...(v.answer ?? []), ...v.candidates]);
      }
    }

    // Invariant 8: the listing's own teams, as NB holds them, first.
    const listedRefs: TeamRef[] = [];
    if (input.teamNameEvidence) {
      for (const name of listedNames) {
        const found = input.teamNameEvidence.get(norm(name));
        if (!found) loading = true;
        else listedRefs.push(...found.map(refFromServer));
      }
    }
    if (listedNames.length > 0 || lookupFailed) {
      // A data claim holds the guess back: nothing is pre-selected, and the
      // would-be pre-fill becomes one more choice.
      choices = [...(suggestion ?? []), ...choices];
      suggestion = null;
    }

    const lead = suggestion ?? [];
    const refs = dedupeRefs([...lead, ...listedRefs, ...byRank(choices)]).slice(
      0,
      Math.max(TEAMS_SECTION_MAX_OPTIONS, lead.length),
    );

    groups.set(groupKey, {
      key: groupKey,
      players: players.map((p) => p.display),
      cards: [entry],
      multi: players.length > 1 || lead.length > 1,
      refs,
      suggestion: suggestion && suggestion.length > 0 ? suggestion.map((r) => r.key) : null,
      listedNames: [...listedNames],
      lookupFailed,
      loading,
    });
  }
  return [...groups.values()];
}

/** The pre-fill when there is one, else "Leave for later". */
export function defaultChoice(group: TeamsGroup): GroupChoice {
  return group.suggestion ? { kind: "teams", refKeys: [...group.suggestion] } : { kind: "later" };
}

function extraOf(choice: GroupChoice | undefined): Array<Id<"teams">> | undefined {
  return choice && choice.kind !== "line" ? choice.extra : undefined;
}

function withExtra<T extends GroupChoice>(choice: T, extra: Array<Id<"teams">> | undefined): T {
  if (choice.kind === "line" || !extra || extra.length === 0) return choice;
  return { ...choice, extra };
}

/** The keys a line can select: its own chips plus the teams found with "Other team…". */
function offeredKeys(group: TeamsGroup, extra: ReadonlyArray<Id<"teams">> | undefined): Set<string> {
  return new Set([...group.refs.map((r) => r.key), ...(extra ?? []).map(teamIdKey)]);
}

/**
 * What the line shows as chosen: the operator's own pick while it still names
 * chips the line offers, else the default. `{ kind: "line" }` is the default
 * too — it only means something on a card's own key.
 */
export function effectiveChoice(group: TeamsGroup, explicit: GroupChoice | undefined): GroupChoice {
  if (!explicit || explicit.kind === "line") return defaultChoice(group);
  if (explicit.kind !== "teams") return explicit;
  const offered = offeredKeys(group, explicit.extra);
  const keys = [...new Set(explicit.refKeys)].filter((k) => offered.has(k));
  const capped = keys.slice(0, group.multi ? MAX_CARD_TEAMS : 1);
  if (capped.length === 0) return withExtra(defaultChoice(group), explicit.extra);
  return withExtra({ kind: "teams", refKeys: capped }, explicit.extra);
}

/** One card's choice: its own (C3) when it has one, else its line's. */
export function effectiveCardChoice(
  group: TeamsGroup,
  choices: Readonly<Record<string, GroupChoice>>,
  index: number,
): GroupChoice {
  const own = choices[cardChoiceKey(group.key, index)];
  if (own && own.kind !== "line") return effectiveChoice(group, own);
  return effectiveChoice(group, choices[group.key]);
}

/** Does this card carry its own answer, apart from its line? */
export function hasCardOverride(
  group: TeamsGroup,
  choices: Readonly<Record<string, GroupChoice>>,
  index: number,
): boolean {
  const own = choices[cardChoiceKey(group.key, index)];
  return own !== undefined && own.kind !== "line";
}

/**
 * The choice after pressing a team chip. One-pick lines replace; multi lines
 * toggle, and refuse a team past `MAX_CARD_TEAMS` (the choice comes back
 * unchanged). Unticking the last team leaves the line for later.
 */
export function toggleTeam(group: TeamsGroup, current: GroupChoice, refKey: string): GroupChoice {
  const extra = extraOf(current);
  if (!group.multi) return withExtra({ kind: "teams", refKeys: [refKey] }, extra);
  const keys = current.kind === "teams" ? current.refKeys : [];
  if (keys.includes(refKey)) {
    const rest = keys.filter((k) => k !== refKey);
    return rest.length > 0
      ? withExtra({ kind: "teams", refKeys: rest }, extra)
      : withExtra({ kind: "later" }, extra);
  }
  if (keys.length >= MAX_CARD_TEAMS) return current;
  return withExtra({ kind: "teams", refKeys: [...keys, refKey] }, extra);
}

/** "No team on this card" / "Leave for later", keeping any team found with "Other team…". */
export function chooseKind(current: GroupChoice, kind: "none" | "later"): GroupChoice {
  return withExtra({ kind }, extraOf(current));
}

/**
 * A team the operator found (or created) with "Other team…" (C1): offered on
 * the line from now on, and selected — added to a multi line's picks (unless
 * that would pass the cap, when it is only offered), the pick on a one-team
 * line. A team the line already offers is simply selected.
 */
export function addOtherTeam(
  group: TeamsGroup,
  current: GroupChoice,
  teamId: Id<"teams">,
): GroupChoice {
  const key = teamIdKey(teamId);
  const before = extraOf(current) ?? [];
  const extra =
    group.refs.some((r) => r.key === key) || before.includes(teamId) ? before : [...before, teamId];
  const extraOrNone = extra.length > 0 ? extra : undefined;
  if (!group.multi) return withExtra({ kind: "teams", refKeys: [key] }, extraOrNone);
  const keys = current.kind === "teams" ? current.refKeys : [];
  if (keys.includes(key)) return withExtra({ kind: "teams", refKeys: keys }, extraOrNone);
  if (keys.length >= MAX_CARD_TEAMS) {
    return current.kind === "line" ? current : withExtra(current, extraOrNone);
  }
  return withExtra({ kind: "teams", refKeys: [...keys, key] }, extraOrNone);
}

/**
 * A choice as the commit reads it; undefined for "Leave for later".
 * `blockedTeamIds` are "Other team…" picks that cannot be saved (another
 * sport's team — the commit would refuse the whole save).
 */
export function answerForChoice(
  group: TeamsGroup,
  choice: GroupChoice,
  blockedTeamIds?: ReadonlySet<string>,
): TeamAnswer | undefined {
  if (choice.kind === "none") return { teamNone: true };
  if (choice.kind !== "teams") return undefined;
  const teamIds: Array<Id<"teams">> = [];
  const teams: string[] = [];
  const extra = new Set<string>(choice.extra ?? []);
  for (const key of choice.refKeys) {
    const ref = group.refs.find((r) => r.key === key);
    if (ref) {
      if (ref.teamId) teamIds.push(ref.teamId);
      if (ref.name !== undefined) teams.push(ref.name);
      continue;
    }
    const id = key.startsWith("id:") ? key.slice(3) : null;
    if (id && extra.has(id) && !blockedTeamIds?.has(id)) teamIds.push(id as Id<"teams">);
  }
  if (teamIds.length === 0 && teams.length === 0) return undefined;
  return {
    ...(teamIds.length > 0 ? { teamIds: [...new Set(teamIds)] } : {}),
    ...(teams.length > 0 ? { teams: [...new Set(teams)] } : {}),
  };
}

/**
 * Every card's answer, positionally aligned with the preview's cards.
 * Cards outside the section, and cards left for later, are undefined.
 */
export function teamAnswersByCard(
  groups: readonly TeamsGroup[],
  choices: Readonly<Record<string, GroupChoice>>,
  cardCount: number,
  blockedTeamIds?: ReadonlySet<string>,
): Array<TeamAnswer | undefined> {
  const out: Array<TeamAnswer | undefined> = new Array(cardCount).fill(undefined);
  for (const group of groups) {
    for (const card of group.cards) {
      if (card.index >= cardCount) continue;
      out[card.index] = answerForChoice(
        group,
        effectiveCardChoice(group, choices, card.index),
        blockedTeamIds,
      );
    }
  }
  return out;
}

/**
 * The card numbers a grouped line covers, for the line itself: up to four
 * in full ("#5 · #407"), past that the first three and a count
 * ("#5, #407, #512 +3"). Display only — a number is never a key here.
 */
export function cardNumbersSummary(cards: ReadonlyArray<{ cardNumber: string }>): string {
  const numbers = cards.map((c) => `#${c.cardNumber}`);
  if (numbers.length <= 4) return numbers.join(" · ");
  return `${numbers.slice(0, 3).join(", ")} +${numbers.length - 3}`;
}

/** Every team id found with "Other team…" across the section (for one label read). */
export function extraTeamIds(choices: Readonly<Record<string, GroupChoice>>): Array<Id<"teams">> {
  const out = new Set<Id<"teams">>();
  for (const choice of Object.values(choices)) {
    for (const id of extraOf(choice) ?? []) out.add(id);
  }
  return [...out];
}

/** Two answer arrays say the same thing (so the parent is not re-rendered for nothing). */
export function sameTeamAnswers(
  a: ReadonlyArray<TeamAnswer | undefined>,
  b: ReadonlyArray<TeamAnswer | undefined>,
): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => JSON.stringify(x ?? null) === JSON.stringify(b[i] ?? null));
}

/**
 * A preview card with its answer put on it, as the commit receives it. A card
 * with no answer comes back as the same object, so the unanswered path's wire
 * payload is byte-identical to what it was before this feature existed.
 *
 * `teams` REPLACES the card's printed team strings: every one of them failed
 * to resolve (that is how the card got into the section), and the commit
 * resolves the replacement exactly as it resolves any printed team.
 *
 * `teamsAnswered` marks that replacement as the OPERATOR's answer rather than
 * what the card printed. The commit needs to know: a printed team string on
 * a re-synced, already-stored row is marketplace content and is written only
 * through the content review (`applyFields`), while an answered one fills
 * that row's empty team the way a picked `teamIds` does.
 */
export function withTeamAnswer<T extends PreviewCardForTeams>(
  card: T,
  answer: TeamAnswer | undefined,
): T & TeamAnswer & { teamsAnswered?: true } {
  if (!answer) return card;
  return {
    ...card,
    ...(answer.teamIds?.length ? { teamIds: answer.teamIds } : {}),
    ...(answer.teams?.length ? { teams: answer.teams, teamsAnswered: true as const } : {}),
    ...(answer.teamNone ? { teamNone: true as const } : {}),
  };
}
