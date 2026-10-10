import type { Id } from "../../convex/_generated/dataModel";
import { normalizeEntityName } from "../../convex/lib/entityNearMatch";
// Browser-safe: `features/cardAttention.ts` has no server imports (it is
// already read by the attention walker in the browser).
import { MAX_CARD_TEAMS } from "../../convex/features/cardAttention";
import { teamFullName } from "../../lib/teams/team-name";

/**
 * NEO-335 — "K cards have no team yet": which confirmed cards will save with
 * no team, what evidence says about each, and what the operator answered.
 *
 * Pure: no Convex, no hooks, no I/O. The entity review wizard's final step
 * (`TeamsOnCardsSection`) supplies the preview cards, the batch rows and the
 * server's per-player evidence; everything it renders is decided here, so
 * the whole thing is testable as a function of its inputs — the same split
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
 *      career); players CREATED in this wizard from their own row's career
 *      (`enrichment.careerTeams`, minus what the operator unchecked, plus what
 *      they typed). Every player answering → the union is pre-filled.
 *      Anyone not answering → every team any of them offered, unselected.
 *
 * Never a guess: a tie stays unselected, and a card number is never a key —
 * a card is identified by its POSITION in the preview, which is the only
 * identity it has until it is saved (product invariant 7).
 *
 * ## What an answer writes
 *
 * Onto the preview card, for the commit to read, and nowhere else (wizard
 * answers are never stored):
 *  - `teamIds` — existing NB teams, by id (server evidence);
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
        create?: { location?: string; name: string };
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

/** One team inside a choice. */
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
}

/** One selectable team choice: a single team, or a multi-player card's union. */
export interface TeamOption {
  key: string;
  refs: TeamRef[];
}

/** Cards that share a player set share evidence, so they share one line. */
export interface TeamsGroup {
  key: string;
  /** Display names, as printed on the first card of the group. */
  players: string[];
  /** Preview positions, ascending. */
  cards: Array<{ index: number; cardNumber: string; cardName: string }>;
  /** The pre-filled answer, when evidence gave exactly one. */
  suggestion: TeamOption | null;
  /** Every team choice the line offers; the suggestion first when there is one. */
  options: TeamOption[];
  /** Server evidence for at least one player has not arrived yet. */
  loading: boolean;
}

export type GroupChoice =
  | { kind: "team"; optionKey: string }
  | { kind: "none" }
  | { kind: "later" };

/** How many team choices one line may offer. */
export const TEAMS_SECTION_MAX_OPTIONS = 6;

/**
 * Players per server call. Mirrors `TEAM_SUGGESTION_MAX_PLAYERS` in
 * convex/cardChecklist.ts (the server refuses more); a convex test pins the
 * two together. A browser bundle cannot import that module.
 */
export const TEAMS_SECTION_PLAYERS_PER_REQUEST = 32;

/** How many server calls the section makes at most (×32 players). */
export const TEAMS_SECTION_MAX_REQUESTS = 8;

const norm = (raw: string): string => normalizeEntityName(raw.trim());

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

interface NamesView {
  teamRowByKey: Map<string, TeamsReviewRow>;
  playerRowByKey: Map<string, TeamsReviewRow>;
}

function namesView(rows: readonly TeamsReviewRow[]): NamesView {
  const teamRowByKey = new Map<string, TeamsReviewRow>();
  const playerRowByKey = new Map<string, TeamsReviewRow>();
  for (const row of rows) {
    const key = norm(row.name);
    if (!key) continue;
    const target =
      row.kind === "team" ? teamRowByKey : row.kind === "player" ? playerRowByKey : null;
    if (target && !target.has(key)) target.set(key, row);
  }
  return { teamRowByKey, playerRowByKey };
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

/** The people on a card, deduped; a name skipped as "not a person" is nobody. */
function cardPlayers(card: PreviewCardForTeams, view: NamesView): CardPlayer[] {
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
    // A row with no decision cannot reach the final step (every row is
    // decided there); a link with no id is malformed. Both are nobody.
  }
  return out;
}

/** The preview positions that will save with no team. */
export function teamlessCardIndexes(
  cards: readonly PreviewCardForTeams[],
  rows: readonly TeamsReviewRow[],
): number[] {
  const view = namesView(rows);
  const out: number[] = [];
  cards.forEach((card, index) => {
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
): EvidenceRequest[] {
  const view = namesView(rows);
  const out = new Map<string, EvidenceRequest>();
  for (const index of teamlessCardIndexes(cards, rows)) {
    for (const player of cardPlayers(cards[index], view)) {
      if (player.kind === "server" && !out.has(player.request.key)) {
        out.set(player.request.key, player.request);
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
    key: `id:${team.teamId}`,
    label: team.name,
    ...(team.colors ? { colors: team.colors } : {}),
    teamId: team.teamId,
  };
}

function optionOf(refs: TeamRef[]): TeamOption {
  const unique = dedupeRefs(refs);
  return { key: unique.map((r) => r.key).sort().join("+"), refs: unique };
}

function dedupeRefs(refs: TeamRef[]): TeamRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
}

type PlayerVerdict = { answer: TeamRef[] | null; candidates: TeamRef[]; loading: boolean };

/** A created player's own career: one-team career, else one stint in the year. */
function createdPlayerVerdict(
  row: TeamsReviewRow,
  view: NamesView,
  linkedTeamNameById: ReadonlyMap<string, string>,
  setYear: number | undefined,
  currentYear: number,
): PlayerVerdict {
  const decision = row.decision?.action === "create" ? row.decision : undefined;
  const excluded = new Set((decision?.excludedCareerTeamNames ?? []).map(norm));
  const stints = [
    ...(row.enrichment?.careerTeams ?? []).filter((s) => !excluded.has(norm(s.name))),
    ...(decision?.manualCareerTeams ?? []),
  ];
  const refsFor = (list: CareerStint[]) =>
    dedupeRefs(
      list
        .map((s) => refFromString(s.name, view, linkedTeamNameById))
        .filter((r): r is TeamRef => r !== null),
    );
  const career = refsFor(stints);
  if (career.length === 1) return { answer: career, candidates: [], loading: false };
  const inYear =
    setYear === undefined
      ? []
      : refsFor(
          stints.filter((s) => s.fromYear <= setYear && setYear <= (s.toYear ?? currentYear)),
        );
  if (inYear.length === 1) return { answer: inYear, candidates: [], loading: false };
  return { answer: null, candidates: inYear.length > 0 ? inYear : career, loading: false };
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
 * Group the teamless cards by player set and decide each group's evidence.
 * Groups come back in the order of their first card.
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
}): TeamsGroup[] {
  const { cards, rows, serverEvidence, setYear, linkedTeamNameById, currentYear } = input;
  const view = namesView(rows);
  const members = new Set(teamlessCardIndexes(cards, rows));

  // Batch evidence: per player set, the distinct resolving team sets printed
  // on the cards that are NOT in the section.
  const playerSetKey = (players: CardPlayer[]) => players.map((p) => p.key).sort().join("|");
  const batchOptions = new Map<string, Map<string, TeamOption>>();
  cards.forEach((card, index) => {
    if (members.has(index)) return;
    const players = cardPlayers(card, view);
    if (players.length === 0) return;
    const refs = cardTeamStrings(card)
      .filter((t) => teamStringResolves(t, view))
      .map((t) => refFromString(t, view, linkedTeamNameById))
      .filter((r): r is TeamRef => r !== null);
    if (refs.length === 0) return;
    const pKey = playerSetKey(players);
    const options = batchOptions.get(pKey) ?? new Map<string, TeamOption>();
    const option = optionOf(refs);
    if (!options.has(option.key)) options.set(option.key, option);
    batchOptions.set(pKey, options);
  });

  const groups = new Map<string, TeamsGroup>();
  for (const index of [...members].sort((a, b) => a - b)) {
    const card = cards[index];
    const players = cardPlayers(card, view);
    // No people → no evidence and no sibling to share a line with.
    const groupKey = players.length > 0 ? `players:${playerSetKey(players)}` : `card:${index}`;
    const existing = groups.get(groupKey);
    const entry = { index, cardNumber: card.cardNumber, cardName: card.cardName };
    if (existing) {
      existing.cards.push(entry);
      continue;
    }

    let suggestion: TeamOption | null = null;
    let choices: TeamRef[] = [];
    let loading = false;

    const batch = players.length > 0 ? batchOptions.get(playerSetKey(players)) : undefined;
    if (batch && batch.size === 1) {
      suggestion = [...batch.values()][0];
    } else if (batch && batch.size > 1) {
      // The checklist disagrees with itself: the operator picks.
      choices = [...batch.values()].flatMap((o) => o.refs);
    } else if (players.length > 0) {
      const verdicts = players.map((p) =>
        p.kind === "created"
          ? createdPlayerVerdict(p.row, view, linkedTeamNameById, setYear, currentYear)
          : serverPlayerVerdict(serverEvidence.get(p.request.key)),
      );
      loading = verdicts.some((v) => v.loading);
      const union = dedupeRefs(verdicts.flatMap((v) => v.answer ?? []));
      if (verdicts.every((v) => v.answer !== null) && union.length <= MAX_CARD_TEAMS) {
        suggestion = optionOf(union);
      } else {
        choices = verdicts.flatMap((v) => [...(v.answer ?? []), ...v.candidates]);
      }
    }

    const options = suggestion
      ? [suggestion]
      : dedupeRefs(choices)
          .slice(0, TEAMS_SECTION_MAX_OPTIONS)
          .map((ref) => optionOf([ref]));

    groups.set(groupKey, {
      key: groupKey,
      players: players.map((p) => p.display),
      cards: [entry],
      suggestion,
      options,
      loading,
    });
  }
  return [...groups.values()];
}

/** The pre-fill when there is one, else "Leave for later". */
export function defaultChoice(group: TeamsGroup): GroupChoice {
  return group.suggestion ? { kind: "team", optionKey: group.suggestion.key } : { kind: "later" };
}

/**
 * What the line shows as chosen: the operator's own pick while it still names
 * an option the line offers, else the default.
 */
export function effectiveChoice(group: TeamsGroup, explicit: GroupChoice | undefined): GroupChoice {
  if (!explicit) return defaultChoice(group);
  if (explicit.kind === "team" && !group.options.some((o) => o.key === explicit.optionKey)) {
    return defaultChoice(group);
  }
  return explicit;
}

/** A choice as the commit reads it; undefined for "Leave for later". */
export function answerForChoice(group: TeamsGroup, choice: GroupChoice): TeamAnswer | undefined {
  if (choice.kind === "none") return { teamNone: true };
  if (choice.kind === "later") return undefined;
  const option = group.options.find((o) => o.key === choice.optionKey);
  if (!option) return undefined;
  const teamIds = option.refs.flatMap((r) => (r.teamId ? [r.teamId] : []));
  const teams = option.refs.flatMap((r) => (r.name !== undefined ? [r.name] : []));
  if (teamIds.length === 0 && teams.length === 0) return undefined;
  return {
    ...(teamIds.length > 0 ? { teamIds } : {}),
    ...(teams.length > 0 ? { teams } : {}),
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
): Array<TeamAnswer | undefined> {
  const out: Array<TeamAnswer | undefined> = new Array(cardCount).fill(undefined);
  for (const group of groups) {
    const answer = answerForChoice(group, effectiveChoice(group, choices[group.key]));
    if (!answer) continue;
    for (const card of group.cards) if (card.index < cardCount) out[card.index] = answer;
  }
  return out;
}

/** Two answer arrays say the same thing (so the parent is not re-rendered for nothing). */
export function sameTeamAnswers(
  a: ReadonlyArray<TeamAnswer | undefined>,
  b: ReadonlyArray<TeamAnswer | undefined>,
): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => JSON.stringify(x ?? null) === JSON.stringify(b[i] ?? null));
}

/** The label a choice's chip shows. */
export function optionLabel(option: TeamOption): string {
  return option.refs.map((r) => r.label).join(" + ");
}

/**
 * A preview card with its answer put on it, as the commit receives it. A card
 * with no answer comes back as the same object, so the unanswered path's wire
 * payload is byte-identical to what it was before this feature existed.
 *
 * `teams` REPLACES the card's printed team strings: every one of them failed
 * to resolve (that is how the card got into the section), and the commit
 * resolves the replacement exactly as it resolves any printed team.
 */
export function withTeamAnswer<T extends PreviewCardForTeams>(
  card: T,
  answer: TeamAnswer | undefined,
): T & TeamAnswer {
  if (!answer) return card;
  return {
    ...card,
    ...(answer.teamIds?.length ? { teamIds: answer.teamIds } : {}),
    ...(answer.teams?.length ? { teams: answer.teams } : {}),
    ...(answer.teamNone ? { teamNone: true as const } : {}),
  };
}
