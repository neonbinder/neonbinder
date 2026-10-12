import type { Id } from "../../convex/_generated/dataModel";
import { normalizeEntityName } from "../../convex/lib/entityNearMatch";
import { teamFullName } from "../../lib/teams/team-name";
// Browser-safe: pure feature derivations only, the same ones the insert runs.
import {
  assessNewCardListing,
  leftOutOfTitle,
  type TitleAttentionItem,
  type TitleContext,
} from "../../convex/features/listingInputs";
import {
  ASPECT_VALUE_MAX,
  LISTING_TITLE_MAX,
} from "../../convex/features/listingLimits";
import { MAX_CARD_TEAMS } from "../../convex/features/cardAttention";
import type { TeamAnswer } from "./teams-on-cards";

/**
 * NEO-335 — the wizard's "Card titles" step: which NEW cards will be born with
 * a title the attention walker would flag, what each title will say, and what
 * the operator answered.
 *
 * Pure: no Convex, no hooks. `CardTitlesStep` draws what this decides.
 *
 * ## Same rules as after save, by construction
 *
 * A card is on the step exactly when the row it is about to become would carry
 * `titleTruncated` or `aspectValueOverLimit`: `assessNewCardListing`
 * (convex/features/listingInputs.ts) runs the insert's own feature merge and
 * title generator, and `titleAttentionItems` is the function
 * `deriveCardAttention` calls on a stored row. What this module adds is only
 * what the browser knows that the server does not yet: the names the
 * operator decided in the wizard, and their team answers.
 *
 * ## New rows only
 *
 * A card that re-syncs a stored row keeps that row's title (NB content the
 * operator may already have edited), so it is never asked about here.
 *
 * ## Names: a data claim, never a guess
 *
 * A printed name is in the title only when it will be ON the card: it
 * resolved before the wizard (`titleContext`), or the operator created or
 * linked it in the wizard. A name that did neither — skipped, or ruled out on
 * an earlier sync — is not on the card and not in its title. The printed
 * spelling is never used as a stand-in for a canonical name it did not
 * resolve to.
 */

/** The preview-card fields this module reads (a structural subset of `FetchPreview`'s cards). */
export interface PreviewCardForTitles {
  cardNumber: string;
  cardName: string;
  team?: string;
  teams?: string[];
  players?: string[];
  attributes?: string[];
  isRookie?: boolean;
  isRelic?: boolean;
  printRun?: number;
  autographType?: string;
  cardVariation?: string;
}

/**
 * The operator's own edits on the step, positionally aligned with the preview
 * cards (undefined = untouched). RAW drafts, as typed: what reaches the commit
 * is decided by `titleAnswersForCommit`, which is where a blank or over-long
 * draft stops counting.
 */
export type TitleAnswer = {
  /** Their own title. */
  listingTitle?: string;
  /** Their trimmed variation, shared by every card printing the same one. */
  cardVariation?: string;
};

/** What one card's answer puts on its preview card for `commitCardChecklist`. */
export type TitleCommitFields = {
  listingTitle?: string;
  listingTitleKept?: true;
  cardVariation?: string;
  cardVariationAnswered?: true;
};

/** The subset of an `entityReviewQueue.getBatch` row this module reads. */
export interface TitleReviewRow {
  kind: "player" | "team" | "league";
  name: string;
  enrichment?: {
    existingCandidates?: Array<{ playerId: string; name: string }>;
  } | null;
  decision?:
    | { action: "create"; create?: { location?: string; name: string } }
    | { action: "link"; linkedPlayerId?: string; linkedTeamId?: string }
    | { action: "skip" }
    | null;
}

/** Where the names the operator decided in the wizard come from. All optional. */
export interface TitleNameSources {
  /** The review batch, every row decided. Absent = no wizard names (teams/titles only). */
  rows?: readonly TitleReviewRow[];
  /** Linked team id → full name, for a team the operator linked in the Names phase. */
  linkedTeamNameById?: ReadonlyMap<string, string>;
  /** Team id → full name, for the ids in a card's team answer (`teamIdNamesFromGroups`). */
  teamNameById?: ReadonlyMap<string, string>;
}

const norm = (raw: string): string => normalizeEntityName(raw.trim());

interface NameIndex {
  player: (printed: string) => string | null;
  team: (printed: string) => string | null;
  teamById: (id: string) => string | null;
}

function nameIndex(context: TitleContext, sources: TitleNameSources | undefined): NameIndex {
  const ctxPlayers = new Map(context.players.map((p) => [p.printed, p.name]));
  const ctxTeams = new Map(context.teams.map((t) => [t.printed, t.name]));
  const playerRows = new Map<string, TitleReviewRow>();
  const teamRows = new Map<string, TitleReviewRow>();
  for (const row of sources?.rows ?? []) {
    const key = norm(row.name);
    if (!key) continue;
    const target = row.kind === "player" ? playerRows : row.kind === "team" ? teamRows : null;
    if (target && !target.has(key)) target.set(key, row);
  }
  return {
    player(raw) {
      const printed = raw.trim();
      if (!printed) return null;
      const row = playerRows.get(norm(printed));
      if (row) {
        const d = row.decision;
        if (d?.action === "create") return row.name.trim();
        if (d?.action === "link") {
          const candidate = row.enrichment?.existingCandidates?.find(
            (c) => c.playerId === d.linkedPlayerId,
          );
          return candidate?.name ?? ctxPlayers.get(printed) ?? row.name.trim();
        }
        return null; // skipped or undecided: not on the card
      }
      return ctxPlayers.get(printed) ?? null;
    },
    team(raw) {
      const printed = raw.trim();
      if (!printed) return null;
      const row = teamRows.get(norm(printed));
      if (row) {
        const d = row.decision;
        if (d?.action === "create") return d.create ? teamFullName(d.create) : null;
        if (d?.action === "link") {
          return (
            (d.linkedTeamId && sources?.linkedTeamNameById?.get(d.linkedTeamId)) ||
            ctxTeams.get(printed) ||
            row.name.trim()
          );
        }
        return null;
      }
      return ctxTeams.get(printed) ?? null;
    },
    teamById(id) {
      return sources?.teamNameById?.get(id) ?? null;
    },
  };
}

function printedTeams(card: PreviewCardForTitles): string[] {
  const named = (card.teams ?? []).map((t) => t.trim()).filter(Boolean);
  if (named.length === 0 && card.team?.trim()) named.push(card.team.trim());
  return named;
}

/**
 * The canonical names the card will carry, in the order the commit writes
 * them: the team answer's picks first, then its (or the card's printed) team
 * strings, capped; with no team at all, the set-level team (NEO-277).
 */
function cardNames(
  card: PreviewCardForTitles,
  teamAnswer: TeamAnswer | undefined,
  index: NameIndex,
  context: TitleContext,
): { playerNames: string[]; teamNames: string[] } {
  const playerNames: string[] = [];
  for (const p of card.players ?? []) {
    const name = index.player(p);
    if (name) playerNames.push(name);
  }
  const fromIds = (teamAnswer?.teamIds ?? [])
    .map((id) => index.teamById(id))
    .filter((n): n is string => !!n);
  const strings = teamAnswer?.teams?.length ? teamAnswer.teams : printedTeams(card);
  const fromStrings = strings.map((t) => index.team(t)).filter((n): n is string => !!n);
  let teamNames = [...fromIds, ...fromStrings];
  if (fromIds.length > 0 || teamAnswer?.teams?.length) {
    teamNames = Array.from(new Set(teamNames)).slice(0, MAX_CARD_TEAMS);
  }
  if (teamNames.length === 0) teamNames = [...context.setTeamNames];
  return { playerNames, teamNames };
}

/** The variation the card will be saved with: a valid trimmed answer, else its own. */
export function effectiveVariation(
  card: PreviewCardForTitles,
  answer: TitleAnswer | undefined,
): string | undefined {
  const valid = validVariationAnswer(card, answer);
  return valid ?? card.cardVariation;
}

/** A variation answer that counts: changed, not blank, within the aspect cap. */
function validVariationAnswer(
  card: PreviewCardForTitles,
  answer: TitleAnswer | undefined,
): string | undefined {
  const draft = answer?.cardVariation?.trim();
  if (!draft || draft.length > ASPECT_VALUE_MAX) return undefined;
  if (draft === card.cardVariation?.trim()) return undefined;
  return draft;
}

/** One card, assessed the way the insert will assess it. */
export interface CardTitleAssessment {
  index: number;
  cardNumber: string;
  cardName: string;
  /** The generated title — what "keep it" keeps. */
  title: string;
  coreFits: boolean;
  /** "Left out to fit: …", in the generator's priority order. */
  leftOut: string[];
  /**
   * The part of `leftOut` that names this card's OWN players or teams. Read
   * apart from the rest because it differs card to card: grouping on it would
   * give every card of a long-named set a line of its own.
   */
  ownLeftOut: string[];
  /** The rest — what the trim cost every card it shares a line with. */
  sharedLeftOut: string[];
  /** The kinds the row would be born with, read with the card's ORIGINAL variation. */
  items: TitleAttentionItem[];
}

/** Options shared by every entry point. */
export interface TitleReviewOptions {
  names?: TitleNameSources;
  /** Preview positions that re-sync a stored row — never asked about. */
  existingIndexes?: Iterable<number>;
  /** The operator's edits; only a variation answer changes what is generated. */
  answers?: ReadonlyArray<TitleAnswer | undefined>;
}

function assessAll(
  cards: readonly PreviewCardForTitles[],
  context: TitleContext,
  teamAnswers: ReadonlyArray<TeamAnswer | undefined> | undefined,
  options: TitleReviewOptions | undefined,
): CardTitleAssessment[] {
  const index = nameIndex(context, options?.names);
  const existing = new Set(options?.existingIndexes ?? []);
  const out: CardTitleAssessment[] = [];
  cards.forEach((card, i) => {
    if (existing.has(i)) return;
    const names = cardNames(card, teamAnswers?.[i], index, context);
    const facts = {
      cardNumber: card.cardNumber,
      isRookie: card.isRookie,
      isRelic: card.isRelic,
      autographType: card.autographType,
      attributes: card.attributes,
      printRun: card.printRun,
    };
    // Membership is read with the card's OWN variation, so trimming it on
    // the step never takes the card off the step under the operator's cursor.
    const own = assessNewCardListing({ ...facts, cardVariation: card.cardVariation }, context, names);
    if (own.items.length === 0) return;
    const variation = effectiveVariation(card, options?.answers?.[i]);
    const shown =
      variation === card.cardVariation
        ? own
        : assessNewCardListing({ ...facts, cardVariation: variation }, context, names);
    // A variation over the aspect cap has its own field on the step; the
    // title list does not repeat it as a loss as well.
    const overCapVariation = own.items.some((it) => it.kind === "aspectValueOverLimit")
      ? variation?.trim()
      : undefined;
    const leftOut = leftOutOfTitle(shown.inputs, shown.assessment).filter(
      (entry) => entry !== overCapVariation,
    );
    const ownWords = new Set(
      [...names.playerNames, ...names.teamNames].flatMap((n) => n.toLowerCase().split(/\s+/)),
    );
    const isOwn = (entry: string) =>
      entry
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every((w) => ownWords.has(w));
    out.push({
      index: i,
      cardNumber: card.cardNumber,
      cardName: card.cardName,
      title: shown.assessment.title,
      coreFits: shown.assessment.coreFits,
      leftOut,
      ownLeftOut: leftOut.filter(isOwn),
      sharedLeftOut: leftOut.filter((e) => !isOwn(e)),
      items: own.items,
    });
  });
  return out;
}

/**
 * The preview positions the "Card titles" step asks about, ascending: NEW
 * cards whose row would be born flagged `titleTruncated` or
 * `aspectValueOverLimit`. Empty → no step. Recomputed from the team answers
 * (the team is part of the title); never from the step's own answers.
 */
export function cardsNeedingTitleReview(
  cards: readonly PreviewCardForTitles[],
  titleContext: TitleContext,
  teamAnswers?: ReadonlyArray<TeamAnswer | undefined>,
  options?: Omit<TitleReviewOptions, "answers">,
): number[] {
  return assessAll(cards, titleContext, teamAnswers, options).map((a) => a.index);
}

/** Cards that print the same over-long variation share one field. */
export interface VariationGroup {
  key: string;
  /** The variation as printed (trimmed). */
  variation: string;
  cards: Array<{ index: number; cardNumber: string; cardName: string }>;
}

/**
 * Cards whose titles left out the same words share one line. "The same" is
 * read without each card's own player and team names (`sharedLeftOut`), which
 * the row states for itself.
 */
export interface TitleGroup {
  key: string;
  /** What every card on the line lost. May be empty. */
  leftOut: string[];
  cards: CardTitleAssessment[];
}

/** The step's two lists, each in the order of its first card. */
export function buildTitleGroups(
  cards: readonly PreviewCardForTitles[],
  titleContext: TitleContext,
  teamAnswers?: ReadonlyArray<TeamAnswer | undefined>,
  options?: TitleReviewOptions,
): { variationGroups: VariationGroup[]; titleGroups: TitleGroup[] } {
  const variationGroups = new Map<string, VariationGroup>();
  const titleGroups = new Map<string, TitleGroup>();
  for (const a of assessAll(cards, titleContext, teamAnswers, options)) {
    if (a.items.some((i) => i.kind === "aspectValueOverLimit")) {
      const variation = (cards[a.index].cardVariation ?? "").trim();
      const group = variationGroups.get(variation) ?? {
        key: `variation:${variation}`,
        variation,
        cards: [],
      };
      group.cards.push({ index: a.index, cardNumber: a.cardNumber, cardName: a.cardName });
      variationGroups.set(variation, group);
    }
    if (a.items.some((i) => i.kind === "titleTruncated")) {
      const key = `left:${a.sharedLeftOut.join("\u0000")}`;
      const group = titleGroups.get(key) ?? { key, leftOut: a.sharedLeftOut, cards: [] };
      group.cards.push(a);
      titleGroups.set(key, group);
    }
  }
  return {
    variationGroups: [...variationGroups.values()],
    titleGroups: [...titleGroups.values()],
  };
}

/** Where an operator's title draft stands against the generated title. */
export type TitleDraftState =
  | { kind: "kept" }
  | { kind: "own"; title: string }
  | { kind: "over"; length: number };

export function titleDraftState(draft: string | undefined, generated: string): TitleDraftState {
  const value = draft?.trim();
  if (!value || value === generated) return { kind: "kept" };
  if (value.length > LISTING_TITLE_MAX) return { kind: "over", length: value.length };
  return { kind: "own", title: value };
}

/**
 * What each card sends to the commit, positionally aligned with `cards`
 * (undefined = nothing; the card commits exactly as it did before the step).
 *
 *  - A card on the step for its TITLE sends its own title when the operator
 *    wrote one that fits, else `listingTitleKept` — the step showed it, so
 *    keeping is the answer and the walker does not ask again after save. A
 *    draft over the cap sends neither: the server titles the card itself and
 *    flags it, and the walker picks it up (the step never blocks a save).
 *  - A card on the step for its VARIATION sends the trimmed variation when it
 *    fits the aspect cap; otherwise nothing, and the warn-only item stays.
 */
export function titleAnswersForCommit(
  cards: readonly PreviewCardForTitles[],
  titleContext: TitleContext,
  teamAnswers?: ReadonlyArray<TeamAnswer | undefined>,
  options?: TitleReviewOptions,
): Array<TitleCommitFields | undefined> {
  const out: Array<TitleCommitFields | undefined> = new Array(cards.length).fill(undefined);
  for (const a of assessAll(cards, titleContext, teamAnswers, options)) {
    const answer = options?.answers?.[a.index];
    const fields: TitleCommitFields = {};
    if (a.items.some((i) => i.kind === "titleTruncated")) {
      const state = titleDraftState(answer?.listingTitle, a.title);
      if (state.kind === "own") fields.listingTitle = state.title;
      else if (state.kind === "kept") fields.listingTitleKept = true;
    }
    if (a.items.some((i) => i.kind === "aspectValueOverLimit")) {
      const variation = validVariationAnswer(cards[a.index], answer);
      if (variation) {
        fields.cardVariation = variation;
        fields.cardVariationAnswered = true;
      }
    }
    if (Object.keys(fields).length > 0) out[a.index] = fields;
  }
  return out;
}

/**
 * A preview card with its title answer put on it, as the commit receives it.
 * No answer → the same object, so the unanswered wire payload is unchanged.
 * `cardVariation` REPLACES the printed one; `cardVariationAnswered` tells the
 * commit it is the operator's and holds it to the aspect cap.
 */
export function withTitleAnswer<T extends PreviewCardForTitles>(
  card: T,
  fields: TitleCommitFields | undefined,
): T & TitleCommitFields {
  if (!fields) return card;
  return { ...card, ...fields };
}

/**
 * Team id → name for every team a Teams-step line offers, so a card's team
 * answer (ids) can be titled. Pass the step's groups' option refs.
 */
export function teamIdNamesFromRefs(
  refs: Iterable<{ teamId?: Id<"teams"> | string; label: string }>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const ref of refs) if (ref.teamId && !out.has(ref.teamId)) out.set(ref.teamId, ref.label);
  return out;
}
