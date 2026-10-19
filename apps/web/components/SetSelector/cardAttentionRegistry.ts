import { createContext, useContext, type ComponentType } from "react";
import type { Id } from "../../convex/_generated/dataModel";
import { WALK_UNRANKED, walkRankOfKind } from "./attention-rules";
import { attentionItemLabel, type AttentionItem } from "./card-attention";
import MissingPlayerFixer from "./MissingPlayerFixer";
import MissingTeamFixer from "./MissingTeamFixer";
import TitleFixer from "./TitleFixer";
import UnreviewedNameFixer from "./UnreviewedNameFixer";

/**
 * NEO-102 — the attention-fixer registry. **This shape is a locked contract**
 * (2026-09-02): the NEO-101 session codes against it.
 *
 * ## The extension contract
 *
 * To add a new kind of "this card needs a human", you touch exactly two
 * things:
 *
 *  1. append a member to `AttentionItem` in `card-attention.ts` (and teach
 *     `deriveCardAttention` when it applies),
 *  2. add a component here and one entry to `attentionFixers`.
 *
 * `CardAttentionWalker` needs no change for either beyond the kind's place in
 * `WALK_RANK` (attention-rules.ts) and `WALK_SUBTITLE` below, which are `Record`s so the compiler
 * asks. It owns the queue, the dialog chrome ("Tidy up this set", "Step x of
 * y"), Skip and Close; a fixer owns one card's
 * question, its own writes, and its own primary action. NEO-101 landed
 * `{ kind: "titleOverLimit"; length: number }`, `{ kind: "titleTruncated" }`
 * and `{ kind: "aspectValueOverLimit"; field: "cardVariation"; length: number }`
 * through exactly that route — two lines in `attentionFixers`, two fields on
 * `CardChecklistRow`, and no change to the walker.
 *
 * ## Fixer rules
 *
 * - A fixer is handed the FULL row and ALL of that card's attention items, and
 *   decides which of them it handles. It may legitimately fix more than one
 *   (a title fixer could clear both title kinds in one write).
 * - It calls `onSaved()` after a write it made has landed. It never advances
 *   the queue itself: the write changes the row, the row stops satisfying
 *   `deriveCardAttention`, and the walker's derived queue advances on its own.
 * - It calls `onSkip()` to defer. The walker also offers Skip in its footer in
 *   every state (including for a kind with no registered fixer), so a fixer
 *   only needs its own Skip control if deferring is part of its own answer.
 * - It never closes the dialog. Escape and Close belong to the walker.
 */

/**
 * A `getCardChecklist` row, structurally.
 *
 * Deliberately not the generated query type: this module is imported by
 * components that must typecheck while the backend half of the PR is still
 * landing. Every field beyond the identity trio is optional, so widening it
 * for a new fixer is additive and breaks no caller. Add fields here as fixers
 * need them rather than casting at a call site.
 */
export type CardChecklistRow = {
  _id: Id<"cardChecklist">;
  cardNumber: string;
  cardName: string;
  playerIds?: Array<Id<"players">>;
  teamOnCardIds?: Array<Id<"teams">>;
  teamCheckDoneAt?: number;
  /**
   * NEO-345: why the background BSC team check finished, written with every
   * `teamCheckDoneAt` stamp — "answered" (BSC replied) or "gaveUp" (retries
   * ran out). Absent on a row stamped before the field existed. Read only by
   * the missing-team fixer's one-line account of the card's case.
   */
  teamCheckOutcome?: "answered" | "gaveUp";
  teamNoneConfirmedAt?: number;
  /**
   * NEO-236: the team name BSC returned that matched no `teams` row.
   *
   * A HINT for the operator, not a team. `deriveCardAttention` must never
   * read it: a card carrying one is still "missing team" — that is the whole
   * reason it is here rather than in `pendingTeamNames`, which the attention
   * rule counts as HAVING a team and which would take the card straight out
   * of the lane `MissingTeamFixer` works.
   */
  bscTeamName?: string;
  /**
   * NEO-102: team names an operator typed that no `teams` row exists for yet.
   * `deriveCardAttention` counts a non-empty list as HAVING a team — leave
   * this off the row and every card carrying a typed team gets badged "no
   * team" and walked.
   *
   * NEO-208: the quick-add form used to write these (it had a free-text Team
   * box) and now sends real `teamOnCardIds` instead, so this is legacy state
   * the product no longer creates — see the field note in
   * convex/features/cardAttention.ts.
   */
  pendingTeamNames?: string[];
  /**
   * NEO-221 (D12): player names the commit could not resolve, because their
   * entity-review rows were never decided. Same storage and same self-healing
   * route as `pendingTeamNames` above — the next sync's
   * `resolveUnknownsAndStartBatch` folds them into a fresh batch — but unlike
   * that field this one has no "counts as answered" clause: a typed player
   * name is not a player LINK, and nothing else on the row stands in for one.
   * `UnreviewedNameFixer` renders these, so leaving the field off the type
   * would hand the operator a fixer that shows no names.
   */
  pendingPlayerNames?: string[];
  /**
   * NEO-102: `deriveCardAttention` reads `bsc.ref`'s presence — a BSC-linked
   * card has an automatic team source still to come, so it is not badged until
   * `teamCheckDoneAt` says that lookup has been and gone. A card without one
   * (custom, or SportLots-only) has nothing to wait for. So this field is NOT
   * decoration on the type: leave it off and every fixer sees a card as though
   * it had no marketplace link.
   */
  platformData?: {
    bsc?: { ref: string; src?: string };
    sportlots?: { ref: string; src?: string };
  };
  /**
   * Stamped alongside `teamNoneConfirmedAt`. Declared so a whole stored row
   * assigns without a cast, and deliberately NEVER RENDERED — who answered is
   * an audit fact, not something to put on an operator's screen.
   */
  teamNoneConfirmedByUserId?: string;
  /**
   * NEO-339: the operator's "No player on this card". `deriveCardAttention`
   * reads it — leave it off the row and every card answered "nobody" is
   * walked again.
   */
  playerNoneConfirmedAt?: number;
  /** Stamped alongside it; audit only, NEVER RENDERED (as the team one). */
  playerNoneConfirmedByUserId?: string;
  attributes?: string[];
  cardVariation?: string;
  /**
   * NEO-101: the marketplace-agnostic listing title, authored once at creation
   * and edited by hand thereafter. `TitleFixer` pre-fills its input from this,
   * so leaving it off the row would hand the operator an EMPTY field for a
   * title that already exists — and Save would then blank it.
   */
  listingTitle?: string;
  /**
   * NEO-101: the auto-generated title did not fit and was cut at a word
   * boundary. Read only for the wording of the fixer's note; the attention item
   * itself comes from `deriveCardAttention`, and any write of `listingTitle`
   * clears this server-side.
   */
  listingTitleTruncated?: boolean;
  autographType?: string;
  printRun?: number;
};

export type AttentionFixerProps = {
  /** The full getCardChecklist row. */
  row: CardChecklistRow;
  /** Every attention item for that card. The fixer decides which it handles. */
  items: AttentionItem[];
  /** The fixer wrote its fix; the walker counts it and advances. */
  onSaved: () => void;
  /** Deferred; the walker advances and the item stays badged in the grid. */
  onSkip: () => void;
};

export type AttentionFixer = ComponentType<AttentionFixerProps>;

/**
 * The set-level facts a fixer cannot derive from its row.
 *
 * `AttentionFixerProps` is a LOCKED contract and carries only the row — but a
 * `getCardChecklist` row does not know its sport or its set (those are
 * properties of the checklist), and `TeamPicker` needs both: the sport to
 * filter its typeahead and tag a team it creates, and (NEO-331) the set's
 * selectorOptions row to order candidates by the set's league and year.
 * Passing them out-of-band through context keeps the locked props
 * byte-identical while still giving every fixer, present and future, access to
 * the set-level facts it cannot derive from a row.
 *
 * Either may be `undefined`: with no sport `TeamPicker` lists the whole teams
 * table and disables creating rather than writing a team with no sport; with
 * no context option it orders by name.
 */
export type AttentionSetContext = {
  /** NEO-96: the sport-level selectorOptions row id. */
  sportId?: Id<"selectorOptions">;
  /** NEO-331: the checklist's own selectorOptions row (the set worked on). */
  contextOptionId?: Id<"selectorOptions">;
};

export const AttentionSportContext = createContext<AttentionSetContext>({});

export function useAttentionSportId(): Id<"selectorOptions"> | undefined {
  return useContext(AttentionSportContext).sportId;
}

export function useAttentionContextOptionId(): Id<"selectorOptions"> | undefined {
  return useContext(AttentionSportContext).contextOptionId;
}

/**
 * kind → fixer.
 *
 * `Partial` on purpose: a kind with no fixer yet is a real state during
 * NEO-101's rollout, and for any row written by a deploy newer than this
 * bundle. The walker degrades instead of crashing on it.
 */
export const attentionFixers: Partial<Record<AttentionItem["kind"], AttentionFixer>> = {
  // NEO-339 — a card linked to no player: link one, or record nobody.
  missingPlayer: MissingPlayerFixer,
  missingTeam: MissingTeamFixer,
  // All three title-shaped kinds map to ONE component on purpose: they are the
  // same field with different reasons, and a card flagged for two of them must
  // be asked once, not twice. `TitleFixer` reads the whole `items` list and
  // clears whichever apply in a single write.
  titleOverLimit: TitleFixer,
  titleTruncated: TitleFixer,
  aspectValueOverLimit: TitleFixer,
  // NEO-221 (D12) — names the commit wrote onto the card because their review
  // rows were never decided. One component covers both halves (player names
  // and team names): a card can carry either or both, and both are answered
  // by the same single `updateCard` write.
  unreviewedName: UnreviewedNameFixer,
};

/**
 * The fixer for a card: the FIRST of its items whose kind is registered.
 *
 * Returns the matched item alongside the component so the walker can report
 * which question went unanswered when nothing matches — a card flagged only
 * for kinds this bundle does not know about is exactly the case that must not
 * throw.
 */
export function pickAttentionFixer(items: AttentionItem[]): {
  item: AttentionItem | undefined;
  Fixer: AttentionFixer | undefined;
} {
  for (const item of items) {
    const Fixer = attentionFixers[item.kind];
    if (Fixer) return { item, Fixer };
  }
  return { item: items[0], Fixer: undefined };
}

// NEO-339: `WALK_RANK` (the order the walker asks in: missing players, then
// missing teams, then names not yet linked, then titles) lives in the pure `attention-rules.ts`,
// so the set-build tool walks in the same order without importing the fixers.

/** Where a card with these attention items falls in the walk. Lower walks first. */
export function attentionWalkRank(items: AttentionItem[]): number {
  const { item, Fixer } = pickAttentionFixer(items);
  if (!item || !Fixer) return WALK_UNRANKED;
  return walkRankOfKind(item.kind);
}

/**
 * NEO-335 Phase 2 — the walker's subtitle: the screen type under "Tidy up this
 * set", one per QUESTION rather than one per kind, so the three title kinds
 * share "Card titles" the way they share a fixer and a rank. The same words as
 * the entity review wizard's screens of the same type.
 *
 * A `Record` over every kind for the same reason as `WALK_RANK`: a new kind
 * must decide what its screen is called.
 */
const WALK_SUBTITLE: Record<AttentionItem["kind"], string> = {
  missingPlayer: "Cards with no player",
  missingTeam: "Cards with no team",
  unreviewedName: "Names not yet linked",
  titleOverLimit: "Card titles",
  titleTruncated: "Card titles",
  aspectValueOverLimit: "Card titles",
};

/** A card flagged only for kinds this bundle has no fixer for. */
export const UNFIXABLE_WALK_SUBTITLE = "Needs a look";

/**
 * The subtitle for the card on screen, read off the item the walker will
 * actually ask about (`pickAttentionFixer`) — the same item `attentionWalkRank`
 * files the card under, so a card is never walked with one group and labelled
 * as another.
 */
export function attentionWalkSubtitle(items: AttentionItem[]): string {
  const { item, Fixer } = pickAttentionFixer(items);
  if (!item || !Fixer) return UNFIXABLE_WALK_SUBTITLE;
  return WALK_SUBTITLE[item.kind as AttentionItem["kind"]] ?? UNFIXABLE_WALK_SUBTITLE;
}

// NEO-339: `isAwaitingTeamLookup` lives in the pure `attention-rules.ts`
// (shared with the set-build tool); re-exported for existing importers.
export { isAwaitingTeamLookup } from "./attention-rules";

/** Reason text for a card whose kinds this bundle has no fixer for. */
export function unfixableReason(item: { kind: string } | undefined): string {
  if (!item) return "Nothing to fix on this card.";
  return `This card ${attentionItemLabel(item)}, but this version of NeonBinder has no fixer for it. Skip it and update the app.`;
}
