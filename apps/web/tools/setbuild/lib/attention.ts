/**
 * NEO-339 — the cards on a set that still need a person: the checklist
 * header's amber "N need you" pill and the "Tidy up this set" walker behind
 * it, as data the MCP and the CLI can list.
 *
 * What it mirrors, and from where:
 *
 *  - **The rule** is `deriveCardAttention` (`convex/features/cardAttention.ts`,
 *    through the SPA's `components/SetSelector/card-attention.ts` seam), run on
 *    the same `getCardChecklist` rows the pill counts. Nothing here decides
 *    what needs attention; it only reads the rule's answer.
 *  - **The order** is the walker's: missing players (NEO-339), then missing
 *    teams, then names not linked, then titles, by card number within each; a card is ASKED once, for its first
 *    item, and a card with a title kind and an unlinked name walks with the
 *    titles. `WALK_RANK`, the "still looking up teams" rule and the fixer's
 *    headings come from `components/SetSelector/attention-rules.ts`, the one
 *    React-free home the registry and MissingTeamFixer re-export from.
 *  - **The facts per card** are what each fixer puts on screen:
 *    `MissingPlayerFixer` (the card, and the teams it carries — the clue for
 *    "nobody on this card"), `MissingTeamFixer` (the players, the career chips with whose career they
 *    came from, the listing's team name as NB's rows era by era, what it would
 *    preselect), `UnreviewedNameFixer` (the typed names per side, the links the
 *    card already has), `TitleFixer` (the title, its length band, and what
 *    Regenerate would produce, from `previewListingTitle`, read-only).
 *
 * Invariant 8, on `missingTeam`: the listing's team name (`bscTeamName`) is
 * shown as `listingSays`, with the NB teams it could mean, and is NEVER an
 * answer. `suggested` is exactly what the fixer would preselect (set-year
 * career teams, and nothing at all when the listing names a different team);
 * it is a proposal for the operator to confirm, never applied unasked.
 *
 * Read-only: every call here is a public admin QUERY, so it runs on
 * `queryOnlyClient`. The answers live in `attention-answers.ts`.
 */

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import {
  ATTENTION_LABELS,
  MAX_CARD_TEAMS,
  deriveCardAttention,
  type AttentionCardRow,
  type AttentionItem,
  type AttentionKind,
} from "../../../components/SetSelector/card-attention";
import {
  WALK_UNRANKED,
  careerHeading,
  isAwaitingTeamLookup,
  marketplaceHeading,
  walkRankOfKind,
} from "../../../components/SetSelector/attention-rules";
import { ASPECT_VALUE_MAX, LISTING_TITLE_MAX, titleLengthState } from "../../../components/SetSelector/TitleLengthMeter";
import { titleSourceChips } from "../../../components/SetSelector/useTitlePreview";
import { variantTypeKind } from "../../../convex/variantRole";
import { compareCardNumbers } from "../../../lib/cards/card-number";
import { teamFullName } from "../../../lib/teams/team-name";
import type { NbClient } from "../client/convex-client";
import { ResolveError } from "../service";
import { childrenOf, pickExactlyOne, resolveTypeRowRef, type ResolvedSet, type RowId, type SelectorRow } from "../spec/resolve";
import { setBuilderUrlForPath } from "./set-builder-link";
import {
  AUTOGRAPH_CHOICE_LABEL,
  AUTOGRAPH_FORMATS,
  autographPromptCount,
  autographPromptLine,
  type AutographFormat,
} from "../../../components/SetSelector/autograph-prompt";

// ---------------------------------------------------------------------------
// Shapes (the contract builder B's service/MCP layer imports)
// ---------------------------------------------------------------------------

/** A `getCardChecklist` row, as the server returns it. */
export type ChecklistCard = FunctionReturnType<typeof api.selectorOptions.getCardChecklist>[number];

/**
 * Which checklist of the set a card sits on. Omitted (or `{}`) = the set's
 * Base. `type` is the variant type's title; `name` the row under a non-Base
 * type; `parallel` a parallel under that row. The listing prints the full ref
 * for every card, Base included (`{ type: "<its title>" }`).
 */
export interface CardRowRef {
  type?: string;
  name?: string;
  parallel?: string;
}

/** The question the walker would put to a card: the fixer for its first item. */
export type AskedQuestion = "missingPlayer" | "missingTeam" | "unreviewedName" | "title";

/** The answer shapes a card accepts, by what it is flagged for. */
export type CardAnswerKind = "players" | "noPlayer" | "teams" | "noTeam" | "players+teams" | "title" | "title+variation";

/**
 * An NB team, named the way an answer names it. Never a listing's string:
 *  - `"San Diego Padres"` — the one team this sport holds under that full name;
 *  - `{ name, from }` — one era of a name held several times ("Philadelphia
 *    Athletics" from 1901); `{ name, id }` when eras cannot be told apart by
 *    their first year (the listing prints it);
 *  - `{ create: { location, name, league? } }` — the New Team dialog: Location
 *    and Name as separate fields ("Wisconsin" + "Badgers"), the league only
 *    when the operator names one (no default, NEO-331).
 */
export type TeamAnswer =
  | string
  | { name: string; from?: number; id?: string }
  | { create: { location?: string; name: string; league?: string } };

/**
 * An NB player: a name that matches exactly one player in the sport,
 * `{ link, birthYear }` for one of several same-name players, or
 * `{ create: "<name>", birthYear? }` (the picker's "+ Create").
 */
export type PlayerAnswer = string | { link: string; birthYear?: number } | { create: string; birthYear?: number };

/**
 * One card's answer, mirroring the fixer that asks it:
 *  - `{ players }` — MissingPlayerFixer's Save (1–20 players, NEO-339); on a
 *    card missing its team as well, `{ players, teams }` answers both in one
 *    write;
 *  - `{ noPlayer: true }` — "No player on this card" (a checklist, a team
 *    card, a logo or relic card with nobody on it);
 *  - `{ teams }` — MissingTeamFixer's Save (1–8 teams), or, on a card whose
 *    typed team name links to nothing, UnreviewedNameFixer with only the team
 *    side given;
 *  - `{ noTeam: true }` — "No team on this card";
 *  - `{ players?, teams? }` — UnreviewedNameFixer: each side given is the
 *    card's WHOLE list after the write (a full replacement, as the pickers
 *    are); a side left out keeps the links the card already has;
 *  - `{ title, variation? }` — TitleFixer: the title text as written, and the
 *    variation only on a card flagged for it.
 */
export type CardAnswer =
  | { noPlayer: true }
  | { noTeam: true }
  | { title: string; variation?: string }
  | { players?: PlayerAnswer[]; teams?: TeamAnswer[] };

/** One answer, addressed by row + card number (`cardId` breaks a tie, invariant 7). */
export interface CardFixAnswer {
  row?: CardRowRef;
  cardNumber: string;
  cardId?: string;
  answer: CardAnswer;
}

/** A team the fixer would offer as a chip: from a career, from the listing's name, or both. */
export interface TeamChoice {
  /** The team's full name ("San Diego Padres"). */
  team: string;
  /** What the chip shows: the full name, with the era where the sport holds the name more than once. */
  label: string;
  /** The answer that names exactly this team. */
  answer: TeamAnswer;
  teamId: string;
  /** Players on this card whose career names the team. Empty when none does. */
  playedHere: string[];
  /** A stint covering the set's year produced it: the only kind the fixer preselects. */
  inSetYear: boolean;
}

export interface CardTitleFacts {
  current: string;
  length: number;
  limit: typeof LISTING_TITLE_MAX;
  /** The meter's band: "mobile" from 55, "search" from 70, "over" past 80. */
  band: "ok" | "mobile" | "search" | "over";
  /** The stored "auto title was cut short" flag. */
  truncated: boolean;
  /** What Regenerate would write (`previewListingTitle`); absent when the preview could not be read. */
  generated?: {
    title: string;
    length: number;
    coreFits: boolean;
    /** "Left out to fit: …" */
    dropped: string[];
    /** "Title built from" chips, in title order. */
    builtFrom: Array<{ label: string; value: string }>;
  };
}

/** One card that needs a person, with what its fixer would show. */
export interface CardAttentionItem {
  row: CardRowRef;
  /** "Base", "Inserts › Future Stars", "Inserts › Future Stars › Gold". */
  rowLabel: string;
  cardNumber: string;
  cardName: string;
  /** NB's `cardChecklist` id, for an answer that must tell two same-number cards apart. */
  cardId: string;
  /** The Set Builder, opened on the card's row. */
  link: string;
  /** Every kind the rule raised, in the rule's order. */
  kinds: AttentionKind[];
  /** The question the walker asks first. */
  asked: AskedQuestion;
  /** `ATTENTION_LABELS` text for each kind. */
  reasons: string[];
  /** The answers this card takes now. */
  answers: CardAnswerKind[];
  /** Set when the card is listed here as a guest; the label of its home set. */
  crossListedFrom?: string;
  /** False when the per-card facts below were not read (summary detail past the limit, or a failed read). */
  enriched: boolean;

  // missingPlayer
  /**
   * The teams the card carries (full names; a typed team name as typed) — the
   * clue that a card with nobody on it is the team card. Empty when none.
   */
  teamsOnCard?: string[];

  // missingTeam
  /** The players linked on the card. */
  players?: string[];
  /** The listing's team name and the NB teams it could mean. Shown, never written. */
  listingSays?: { name: string; heading?: string; teams: TeamChoice[] };
  /** A set-year career team is not among the listing's teams, so nothing is suggested. */
  listingDisagrees?: boolean;
  career?: { heading: string; teams: TeamChoice[] };
  /** The set year no career stint covers, when the career is offered whole. */
  uncoveredSetYear?: number;
  /** Exactly what the fixer would preselect; `[]` when nothing. A proposal, never applied unasked. */
  suggested?: TeamAnswer[];

  // unreviewedName
  /** The names typed on the card that link to nothing, per side. */
  typed?: { players: string[]; teams: string[] };
  /** What the card already links to (a side given in an answer replaces it). */
  linked?: { players: string[]; teams: string[] };

  // title kinds
  title?: CardTitleFacts;
  variation?: { current: string; length: number; limit: typeof ASPECT_VALUE_MAX };
}

export interface CardAttentionTotals {
  /** Cards with at least one item: the pill's count, per set. */
  cards: number;
  /** Per kind; a card raising two kinds counts in both. */
  byKind: Record<AttentionKind, number>;
  /** Cards still waiting on the automatic team lookup; they may join later. */
  awaitingTeamLookup: number;
  /** NEO-345: rows whose checklist header asks "on card or sticker?" (`autographs`). */
  autographRows: number;
}

/**
 * NEO-345 — one row (Base, insert or parallel) whose checklist header asks
 * how its autographs are signed: no `features.autographFormat` on the row,
 * and cards carrying "AU" still marked not autographed. The rule, the count
 * and the line are the prompt's own (`components/SetSelector/autograph-prompt.ts`,
 * which `CardChecklist` gates the prompt on). Answered once for the row
 * (`nb_fix` `autographs`); the server then marks its autographed cards.
 *
 * No marketplace says which it is, so nothing here proposes an answer: the
 * operator gives it (an agent may research it and cite a source, but the
 * operator confirms before it is written).
 */
export interface AutographAttentionItem {
  row: CardRowRef;
  rowLabel: string;
  /** NB's `selectorOptions` id of the row. */
  rowId: string;
  /** The Set Builder, opened on the row. */
  link: string;
  /** Autographed cards still marked not autographed (the prompt's count). */
  cards: number;
  /** The prompt's own line, e.g. "3 autographed cards — on card or sticker?". */
  prompt: string;
  /** The two answers: the stored value, and the button's name. */
  answers: Array<{ format: AutographFormat; label: string }>;
}

export interface CardAttentionListing {
  cards: CardAttentionItem[];
  /** NEO-345: rows asking how their autographs are signed, in walk order. */
  autographs: AutographAttentionItem[];
  totals: CardAttentionTotals;
  /** How many items carry their fixer's facts, of how many listed. */
  enrichment: { enriched: number; of: number };
}

export interface ListCardAttentionOptions {
  /**
   * "summary" (default) reads the per-card facts for the first
   * `SUMMARY_ENRICH_LIMIT` cards only; "full" reads them for every card;
   * "totals" reads none (the checklist walk and the rule only, for the end of
   * an apply and `inspect --attention`): every card is still listed, with its
   * reasons and answers, `enriched: false`.
   */
  detail?: "summary" | "full" | "totals";
}

/**
 * The set the attention calls work on: the `ResolvedSet` (`resolveSetPath`),
 * or an object carrying it as `set` (the runner's resolved node).
 */
export type AttentionSetTarget = ResolvedSet | { set: ResolvedSet; path?: unknown };

/** The `ResolvedSet` of either target shape. */
export function attentionSetOf(target: AttentionSetTarget): ResolvedSet {
  return "setId" in target ? target : target.set;
}

/** How many cards a summary listing reads the fixer's facts for. */
export const SUMMARY_ENRICH_LIMIT = 25;

/** How many reads run at once. */
const READ_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// The walker's order (WALK_RANK and the rest live in attention-rules.ts)
// ---------------------------------------------------------------------------

const ASKED: Record<AttentionKind, AskedQuestion> = {
  missingPlayer: "missingPlayer",
  missingTeam: "missingTeam",
  unreviewedName: "unreviewedName",
  titleOverLimit: "title",
  titleTruncated: "title",
  aspectValueOverLimit: "title",
};

/** The title-shaped kinds: one fixer, one question. */
export const TITLE_KINDS: ReadonlySet<AttentionKind> = new Set(["titleOverLimit", "titleTruncated", "aspectValueOverLimit"]);

/**
 * Where a card falls in the walk (the registry's `attentionWalkRank`): every
 * kind this bundle derives has a fixer, so its first item decides.
 */
export function walkRank(items: readonly AttentionItem[]): number {
  return items[0] ? walkRankOfKind(items[0].kind) : WALK_UNRANKED;
}

/** The question the walker asks a card first. */
export function askedQuestion(items: readonly AttentionItem[]): AskedQuestion {
  return ASKED[items[0].kind];
}

/** The answers a card takes, from every kind it carries. */
export function answersFor(kinds: readonly AttentionKind[]): CardAnswerKind[] {
  const out: CardAnswerKind[] = [];
  if (kinds.includes("missingPlayer")) out.push("players", "noPlayer");
  if (kinds.includes("missingTeam")) out.push("teams", "noTeam");
  if (kinds.includes("unreviewedName")) out.push("players+teams");
  if (kinds.some((k) => TITLE_KINDS.has(k))) out.push(kinds.includes("aspectValueOverLimit") ? "title+variation" : "title");
  return out;
}

// ---------------------------------------------------------------------------
// The set's checklists
// ---------------------------------------------------------------------------

/** One checklist of the set: where its cards live and how to name it. */
export interface AttentionRowNode {
  ref: CardRowRef;
  label: string;
  rowId: RowId;
  /** NB ids root first, for the Set Builder link. */
  drillIds: string[];
  /** NEO-345: the row's own `features.autographFormat`, as stored (absent when nobody has said). */
  autographFormat?: string;
}

/** The row's stored autograph format, for the node (`getSelectorOptions` returns `features`). */
const formatOf = (row: SelectorRow): { autographFormat?: string } => {
  const f = row.features?.autographFormat;
  return f !== undefined ? { autographFormat: f } : {};
};

function setDrillIds(set: ResolvedSet): string[] {
  return [set.sportId, set.yearId, set.manufacturerId, set.setId].map(String);
}

function isBaseType(row: SelectorRow): boolean {
  return variantTypeKind(row) === "base";
}

/**
 * Every checklist of the set, in the order `inspect` walks them: each variant
 * type in turn; Base holds its own cards; any other type's rows, each followed
 * by its parallels.
 */
export async function attentionRows(client: NbClient, set: ResolvedSet): Promise<AttentionRowNode[]> {
  const base = setDrillIds(set);
  const out: AttentionRowNode[] = [];
  for (const t of await childrenOf(client, "variantType", set.setId)) {
    const typeIds = [...base, String(t._id)];
    if (isBaseType(t)) {
      out.push({ ref: { type: t.value }, label: t.value, rowId: t._id, drillIds: typeIds, ...formatOf(t) });
      continue;
    }
    for (const r of await childrenOf(client, "insert", t._id)) {
      const rowIds = [...typeIds, String(r._id)];
      out.push({ ref: { type: t.value, name: r.value }, label: `${t.value} › ${r.value}`, rowId: r._id, drillIds: rowIds, ...formatOf(r) });
      for (const p of await childrenOf(client, "parallel", r._id)) {
        out.push({
          ref: { type: t.value, name: r.value, parallel: p.value },
          label: `${t.value} › ${r.value} › ${p.value}`,
          rowId: p._id,
          drillIds: [...rowIds, String(p._id)],
          ...formatOf(p),
        });
      }
    }
  }
  return out;
}

/**
 * The one checklist a `CardRowRef` names, exactly-one at every level. Omitted
 * = the set's Base; a Base ref takes no `name`, any other type needs one.
 */
export async function resolveAttentionRow(
  client: NbClient,
  set: ResolvedSet,
  ref: CardRowRef | undefined,
  at: string,
): Promise<AttentionRowNode> {
  const base = setDrillIds(set);
  const types = await childrenOf(client, "variantType", set.setId);
  const r = ref ?? {};
  if (r.type === undefined) {
    if (r.name !== undefined || r.parallel !== undefined) {
      throw new ResolveError({
        kind: "variant type",
        query: r.name ?? r.parallel ?? "",
        at: `${at}.row`,
        candidates: types.map((t) => ({ id: String(t._id), name: t.value })),
        message: `${at}.row names a row but not its variant type; add "type".`,
      });
    }
    const bases = types.filter(isBaseType);
    if (bases.length !== 1) {
      throw new ResolveError({
        kind: "variant type",
        query: "Base",
        at: `${at}.row`,
        candidates: bases.map((t) => ({ id: String(t._id), name: t.value })),
        message: bases.length === 0 ? "This set has no Base variant type." : `This set has ${bases.length} Base variant types; name one with "type".`,
      });
    }
    const t = bases[0];
    return { ref: { type: t.value }, label: t.value, rowId: t._id, drillIds: [...base, String(t._id)], ...formatOf(t) };
  }
  const t = pickExactlyOne(types, r.type, "variant type", `${at}.row.type`);
  const typeIds = [...base, String(t._id)];
  if (isBaseType(t)) {
    if (r.name !== undefined || r.parallel !== undefined) {
      throw new ResolveError({
        kind: "row",
        query: r.name ?? r.parallel ?? "",
        at: `${at}.row`,
        candidates: [],
        message: `"${t.value}" holds its cards itself; drop "name" and "parallel" from ${at}.row.`,
      });
    }
    return { ref: { type: t.value }, label: t.value, rowId: t._id, drillIds: typeIds, ...formatOf(t) };
  }
  if (r.name === undefined) {
    const rows = await childrenOf(client, "insert", t._id);
    throw new ResolveError({
      kind: "row",
      query: "",
      at: `${at}.row.name`,
      candidates: rows.map((x) => ({ id: String(x._id), name: x.value })),
      message: `${at}.row names "${t.value}" but not the row under it; add "name".`,
    });
  }
  // The tool's one row resolution: top-level first, then a grouped row by its
  // own name (its parent becomes `name`, it the `parallel`).
  const { row, parent } = await resolveTypeRowRef(
    client,
    t._id,
    { name: r.name, ...(r.parallel !== undefined ? { parallel: r.parallel } : {}) },
    { name: `${at}.row.name`, parallel: `${at}.row.parallel` },
  );
  if (!parent) {
    return { ref: { type: t.value, name: row.value }, label: `${t.value} › ${row.value}`, rowId: row._id, drillIds: [...typeIds, String(row._id)], ...formatOf(row) };
  }
  return {
    ref: { type: t.value, name: parent.value, parallel: row.value },
    label: `${t.value} › ${parent.value} › ${row.value}`,
    rowId: row._id,
    drillIds: [...typeIds, String(parent._id), String(row._id)],
    ...formatOf(row),
  };
}

/** One checklist's cards. */
export async function readChecklist(client: NbClient, rowId: RowId): Promise<ChecklistCard[]> {
  return client.query(api.selectorOptions.getCardChecklist, { selectorOptionId: rowId });
}

// ---------------------------------------------------------------------------
// Team choices (MissingTeamFixer's chips)
// ---------------------------------------------------------------------------

type EraRow = FunctionReturnType<typeof api.teams.erasByNameAndSport>[number];

/**
 * The answer that names exactly `teamId` among the rows the sport holds under
 * its full name: the bare name when it is the only one, `{ name, from }` when
 * its first year tells it apart, `{ name, id }` otherwise.
 */
export function answerForEra(fullName: string, teamId: string, eras: readonly EraRow[]): TeamAnswer {
  if (eras.length <= 1) return fullName;
  const mine = eras.find((e) => String(e._id) === teamId);
  const from = mine?.yearsActive?.from;
  if (from !== undefined && eras.filter((e) => e.yearsActive?.from === from).length === 1) return { name: fullName, from };
  return { name: fullName, id: teamId };
}

/** Memoised `erasByNameAndSport`, per listing. */
function erasReader(client: NbClient, sportId: Id<"selectorOptions">) {
  const cache = new Map<string, Promise<EraRow[]>>();
  return (fullName: string): Promise<EraRow[]> => {
    let hit = cache.get(fullName);
    if (!hit) {
      hit = client.query(api.teams.erasByNameAndSport, { name: fullName, sportId });
      cache.set(fullName, hit);
    }
    return hit;
  };
}

type Suggestion = FunctionReturnType<typeof api.cardChecklist.suggestedTeamsForCard>[number];

/**
 * MissingTeamFixer's chips, folded the way it folds them: one chip per team
 * (a team two players share names both), the listing's rows first and taking
 * a career's provenance with them, the career's other teams after; what it
 * would preselect (set-year teams, none when the listing disagrees, at most
 * eight); and the two headings.
 */
export async function missingTeamFacts(
  card: ChecklistCard,
  suggestions: readonly Suggestion[],
  listingEras: readonly EraRow[] | null,
  eras: (fullName: string) => Promise<EraRow[]>,
): Promise<
  Pick<CardAttentionItem, "listingSays" | "listingDisagrees" | "career" | "uncoveredSetYear" | "suggested">
> {
  const careerByTeam = new Map<string, { name: string; label: string; playerNames: string[]; inSetYear: boolean }>();
  for (const s of suggestions) {
    const id = String(s.teamId);
    const existing = careerByTeam.get(id);
    if (existing) {
      if (!existing.playerNames.includes(s.playerName)) existing.playerNames.push(s.playerName);
      existing.inSetYear = existing.inSetYear || s.inSetYear;
    } else {
      careerByTeam.set(id, { name: s.name, label: s.label, playerNames: [s.playerName], inSetYear: s.inSetYear });
    }
  }
  const uncoveredSetYear = suggestions.find((s) => s.uncoveredSetYear !== undefined)?.uncoveredSetYear;

  const listingName = card.bscTeamName?.trim() ?? "";
  const listingRows = listingName !== "" ? (listingEras ?? []) : [];
  const listingIds = new Set(listingRows.map((e) => String(e._id)));

  const listingChoices: TeamChoice[] = listingRows.map((era) => {
    const career = careerByTeam.get(String(era._id));
    const full = teamFullName(era);
    return {
      team: full,
      label: era.label,
      answer: answerForEra(full, String(era._id), listingRows),
      teamId: String(era._id),
      playedHere: career?.playerNames ?? [],
      inSetYear: career?.inSetYear ?? false,
    };
  });

  const careerChoices: TeamChoice[] = [];
  for (const [teamId, c] of careerByTeam) {
    if (listingIds.has(teamId)) continue;
    // The label carries an era only when the sport holds the name more than
    // once (`teamOptionLabel`), so only then is the name alone not an answer.
    const answer = c.label === c.name ? c.name : answerForEra(c.name, teamId, await eras(c.name));
    careerChoices.push({ team: c.name, label: c.label, answer, teamId, playedHere: [...c.playerNames], inSetYear: c.inSetYear });
  }

  const setYearIds = [...careerByTeam.entries()].filter(([, c]) => c.inSetYear).map(([id]) => id);
  const listingDisagrees = listingName !== "" && setYearIds.some((id) => !listingIds.has(id));
  const preselect = listingDisagrees ? [] : setYearIds.slice(0, MAX_CARD_TEAMS);
  const choiceById = new Map([...listingChoices, ...careerChoices].map((c) => [c.teamId, c]));

  const out: Pick<CardAttentionItem, "listingSays" | "listingDisagrees" | "career" | "uncoveredSetYear" | "suggested"> = {
    suggested: preselect.map((id) => choiceById.get(id)!.answer),
  };
  if (listingName !== "") {
    out.listingSays = {
      name: listingName,
      ...(listingChoices.length > 0
        ? { heading: marketplaceHeading(listingName, listingChoices.length, listingChoices.some((c) => preselect.includes(c.teamId))) }
        : {}),
      teams: listingChoices,
    };
    out.listingDisagrees = listingDisagrees;
  }
  if (careerChoices.length > 0) {
    out.career = {
      heading: careerHeading(careerChoices.some((c) => c.inSetYear), listingDisagrees, uncoveredSetYear),
      teams: careerChoices,
    };
  }
  if (uncoveredSetYear !== undefined) out.uncoveredSetYear = uncoveredSetYear;
  return out;
}

// ---------------------------------------------------------------------------
// The listing
// ---------------------------------------------------------------------------

/** Run `fn` over `items`, at most `limit` at a time, results in order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function emptyByKind(): Record<AttentionKind, number> {
  return { missingPlayer: 0, missingTeam: 0, unreviewedName: 0, titleOverLimit: 0, titleTruncated: 0, aspectValueOverLimit: 0 };
}

/** The row's autograph prompt as an item, or undefined when the header does not ask. */
export function autographItem(node: AttentionRowNode, cards: readonly ChecklistCard[], appOrigin?: string): AutographAttentionItem | undefined {
  const count = autographPromptCount(node.autographFormat, cards);
  if (count === 0) return undefined;
  return {
    row: node.ref,
    rowLabel: node.label,
    rowId: String(node.rowId),
    link: setBuilderUrlForPath(node.drillIds, appOrigin),
    cards: count,
    prompt: autographPromptLine(count),
    answers: AUTOGRAPH_FORMATS.map((format) => ({ format, label: AUTOGRAPH_CHOICE_LABEL[format] })),
  };
}

/** The item for one flagged card, before the per-card facts are read. */
export function baseItem(node: AttentionRowNode, card: ChecklistCard, items: readonly AttentionItem[], appOrigin?: string): CardAttentionItem {
  const kinds = items.map((i) => i.kind);
  const item: CardAttentionItem = {
    row: node.ref,
    rowLabel: node.label,
    cardNumber: card.cardNumber,
    cardName: card.cardName,
    cardId: String(card._id),
    link: setBuilderUrlForPath(node.drillIds, appOrigin),
    kinds,
    asked: askedQuestion(items),
    reasons: kinds.map((k) => ATTENTION_LABELS[k]),
    answers: answersFor(kinds),
    enriched: false,
  };
  if (card.isCrossListed && card.homeSetLabel) item.crossListedFrom = card.homeSetLabel;
  if (kinds.includes("unreviewedName")) {
    item.typed = {
      players: (card.playerIds?.length ?? 0) === 0 ? [...(card.pendingPlayerNames ?? [])] : [],
      teams: (card.teamOnCardIds?.length ?? 0) === 0 ? [...(card.pendingTeamNames ?? [])] : [],
    };
  }
  if (kinds.some((k) => TITLE_KINDS.has(k))) {
    const current = card.listingTitle ?? "";
    item.title = {
      current,
      length: current.length,
      limit: LISTING_TITLE_MAX,
      band: titleLengthState(current.length, LISTING_TITLE_MAX, true).tone,
      truncated: card.listingTitleTruncated === true,
    };
  }
  if (kinds.includes("aspectValueOverLimit")) {
    const current = card.cardVariation ?? "";
    item.variation = { current, length: current.trim().length, limit: ASPECT_VALUE_MAX };
  }
  return item;
}

/**
 * What the card's fixer would show, read. All or nothing: the caller attaches
 * it only when every read landed, so a card is never half-described.
 */
async function readFixerFacts(
  client: NbClient,
  item: CardAttentionItem,
  card: ChecklistCard,
  eras: (fullName: string) => Promise<EraRow[]>,
): Promise<Partial<CardAttentionItem>> {
  const facts: Partial<CardAttentionItem> = {};
  const playerIds = card.playerIds ?? [];
  const playerNames = async () =>
    playerIds.length > 0 ? (await client.query(api.players.getManyByIds, { ids: playerIds })).map((p) => p.name) : [];

  if (item.kinds.includes("missingPlayer")) {
    // MissingPlayerFixer's team line: the linked teams, else a typed name as
    // typed, else none.
    const teamIds = card.teamOnCardIds ?? [];
    facts.teamsOnCard =
      teamIds.length > 0
        ? (await client.query(api.teams.getManyByIds, { ids: teamIds })).map((t) => teamFullName(t))
        : [...(card.pendingTeamNames ?? [])];
  }
  if (item.kinds.includes("missingTeam")) {
    const listingName = card.bscTeamName?.trim() ?? "";
    const [suggestions, names, listingEras] = await Promise.all([
      client.query(api.cardChecklist.suggestedTeamsForCard, { cardId: card._id }),
      playerNames(),
      listingName !== "" ? eras(listingName) : Promise.resolve(null),
    ]);
    // The fixer falls back to the names the suggestions carry, so a card whose
    // player rows did not load does not read as having no players.
    facts.players = names.length > 0 ? names : [...new Set(suggestions.map((s) => s.playerName))];
    Object.assign(facts, await missingTeamFacts(card, suggestions, listingEras, eras));
  }
  if (item.kinds.includes("unreviewedName")) {
    const teamIds = card.teamOnCardIds ?? [];
    const [players, teams] = await Promise.all([
      playerNames(),
      teamIds.length > 0 ? client.query(api.teams.getManyByIds, { ids: teamIds }) : Promise.resolve([]),
    ]);
    facts.linked = { players, teams: teams.map((t) => teamFullName(t)) };
  }
  if (item.title) {
    const preview = await client.query(api.selectorOptions.previewListingTitle, { cardId: card._id });
    facts.title = {
      ...item.title,
      generated: {
        title: preview.title,
        length: preview.title.length,
        coreFits: preview.coreFits,
        dropped: [...preview.dropped],
        builtFrom: titleSourceChips(preview.inputs),
      },
    };
  }
  return facts;
}

/**
 * Everything on the set's checklists that still needs a person, in the
 * walker's order (checklist by checklist, then missing players → teams → names → titles
 * by card number), with the totals the pill and the walker's done line read.
 *
 * Every flagged card is listed; `detail: "summary"` reads the per-card facts
 * (players, chips, the regenerated title) for the first
 * `SUMMARY_ENRICH_LIMIT` only, `"totals"` for none, and `enrichment` says how
 * many it read. A card
 * listed on two of the set's checklists (a guest) is listed once.
 */
export async function listCardAttention(
  client: NbClient,
  target: AttentionSetTarget,
  opts: ListCardAttentionOptions = {},
): Promise<CardAttentionListing> {
  const set = attentionSetOf(target);
  const nodes = await attentionRows(client, set);
  const checklists = await mapLimit(nodes, READ_CONCURRENCY, (n) => readChecklist(client, n.rowId));

  const seen = new Set<string>();
  const totals: CardAttentionTotals = { cards: 0, byKind: emptyByKind(), awaitingTeamLookup: 0, autographRows: 0 };
  const flagged: Array<{ item: CardAttentionItem; card: ChecklistCard }> = [];
  // NEO-345: the header's autograph prompt, per row, over the row's whole
  // list as the header counts it (guests included).
  const autographs: AutographAttentionItem[] = [];
  nodes.forEach((node, i) => {
    const item = autographItem(node, checklists[i], client.target.appOrigin);
    if (item) autographs.push(item);
  });
  totals.autographRows = autographs.length;
  nodes.forEach((node, i) => {
    const ranked = checklists[i]
      .filter((card) => {
        const id = String(card._id);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map((card) => {
        if (isAwaitingTeamLookup(card)) totals.awaitingTeamLookup += 1;
        return { card, items: deriveCardAttention(card) };
      })
      .filter(({ items }) => items.length > 0)
      .map(({ card, items }) => ({ card, items, rank: walkRank(items) }))
      .sort((a, b) => a.rank - b.rank || compareCardNumbers(a.card.cardNumber, b.card.cardNumber));
    for (const { card, items } of ranked) {
      totals.cards += 1;
      for (const it of items) totals.byKind[it.kind] += 1;
      flagged.push({ item: baseItem(node, card, items, client.target.appOrigin), card });
    }
  });

  const limit =
    opts.detail === "full" ? flagged.length : opts.detail === "totals" ? 0 : Math.min(SUMMARY_ENRICH_LIMIT, flagged.length);
  const eras = erasReader(client, set.sportId);
  await mapLimit(flagged.slice(0, limit), READ_CONCURRENCY, async ({ item, card }) => {
    try {
      Object.assign(item, await readFixerFacts(client, item, card, eras), { enriched: true });
    } catch {
      // A card whose facts cannot be read is still listed, with its reasons
      // and answers; `enriched: false` says the rest is missing.
    }
  });

  return {
    cards: flagged.map((f) => f.item),
    autographs,
    totals,
    enrichment: { enriched: flagged.filter((f) => f.item.enriched).length, of: flagged.length },
  };
}
