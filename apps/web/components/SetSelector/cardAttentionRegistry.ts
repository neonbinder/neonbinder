import { createContext, useContext, type ComponentType } from "react";
import type { Id } from "../../convex/_generated/dataModel";
import { attentionItemLabel, type AttentionItem } from "./card-attention";
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
 * `CardAttentionWalker` needs no change for either. It owns the queue, the
 * dialog chrome, the progress line, Skip and Close; a fixer owns one card's
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
  teamNoneConfirmedAt?: number;
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
  isCustom?: boolean;
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
 * The set's sport, for fixers that need it.
 *
 * `AttentionFixerProps` is a LOCKED contract and carries only the row — but a
 * `getCardChecklist` row does not know its sport (that is a property of the
 * set), and `TeamPicker` needs it both to filter its typeahead and to tag a
 * team it creates. Passing it out-of-band through context keeps the locked
 * props byte-identical while still giving every fixer, present and future,
 * access to the set-level facts it cannot derive from a row.
 *
 * `undefined` is a legal value: `TeamPicker` then lists the whole teams table
 * and disables creating rather than writing a team with no sport.
 */
export const AttentionSportContext = createContext<Id<"selectorOptions"> | undefined>(
  undefined,
);

export function useAttentionSportId(): Id<"selectorOptions"> | undefined {
  return useContext(AttentionSportContext);
}

/**
 * kind → fixer.
 *
 * `Partial` on purpose: a kind with no fixer yet is a real state during
 * NEO-101's rollout, and for any row written by a deploy newer than this
 * bundle. The walker degrades instead of crashing on it.
 */
export const attentionFixers: Partial<Record<AttentionItem["kind"], AttentionFixer>> = {
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

/** Reason text for a card whose kinds this bundle has no fixer for. */
export function unfixableReason(item: { kind: string } | undefined): string {
  if (!item) return "Nothing to fix on this card.";
  return `This card ${attentionItemLabel(item)}, but this version of NeonBinder has no fixer for it. Skip it and update the app.`;
}
