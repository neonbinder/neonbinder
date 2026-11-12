import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import NeonButton from "../modules/NeonButton";
import { ConfirmDialog } from "../modules/confirm-dialog";
import { Input } from "../primitives/Input";
import { countPairingEdits } from "./pairing-session-edits";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";
import { compareCardNumbers } from "@/lib/cards/card-number";
import { keyboardAwareCollision } from "@/lib/dnd/keyboard-aware-collision";
// NEO-199: the wrong-player check is SHARED with the server. `fetchCardChecklist`
// runs this exact function over an auto-matched pair before it discards the
// losing name, so an auto-matched disagreement and a hand-linked one are
// definitionally the same thing. See lib/cards/card-name.ts.
// NEO-251: the roster half of the same question, shared the same way — and
// `playersKey` is what decides whether a list the operator TYPED is really one
// of the two marketplace answers.
import {
  conflictingNames,
  conflictingPlayers,
  playersKey,
  type NameDisagreement,
  type PlayersDisagreement,
} from "@/lib/cards/card-name";
import { isEditableTarget } from "../../lib/dom/is-editable-target";
// NEO-251 security review — the two bounds the server enforces on every path a
// player name can take, applied here as well so the operator finds out while
// the field is still in front of them rather than at the end of a 900-card
// commit. `MAX_CARD_PLAYERS` comes through the same `card-attention` seam the
// rest of this screen's shared card rules do.
import { MAX_CARD_PLAYERS } from "./card-attention";
import { MAX_PLAYER_NAME_LENGTH } from "../../lib/players/name-limits";
import type { ChecklistConflict, TeamLookupOutcome } from "./checklist-conflict";
// NEO-490 — the publisher's checklist as a third source: the name pairing the
// server uses (so a suggestion here is the server's own rule), the merge of
// the server's per-link answers, and the dialog's one-line row text.
import { isNoNumber } from "@/lib/checklists/match-published-checklist";
import {
  applyChecklistAnswers,
  buildChecklistPairRequests,
  committable,
  pairedRowCard,
  pairedRowOf,
  revertServerChecklistPair,
  unlinkableServerPair,
  UNLINKED_ROW_ID_PREFIX,
  type ChecklistLinkRow,
  type ChecklistPairAnswer,
  type ChecklistPairRequest,
  type ServerPairedRow,
  type ServerPairRevert,
} from "./checklist-match-apply";
import { checklistRowLine } from "./PublishedChecklistDialog";

/**
 * NEO-344 — the SPELLING of a typed card name, with only the invisible
 * differences taken out: Unicode normalisation form (NFD "José" vs NFC
 * "José") and runs of whitespace of any kind (a doubled space, an NBSP)
 * collapsed to one ordinary space, then trimmed.
 *
 * Why it exists: the conflict pills are bare names, so a typed name that
 * differs from a marketplace name only in one of those ways would render as a
 * third pill that looks and reads aloud exactly like the marketplace one —
 * a radiogroup offering a choice between two identical options.
 *
 * Deliberately NOT `nameKey`: case and accents are visible, meaningful
 * corrections ("José" over "Jose" is the operator fixing the card), so both
 * survive here. Only what neither the eye nor a screen reader can tell apart
 * is folded.
 */
function canonicalTypedName(name: string): string {
  return name.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * NEO-137 — card-level pairing, before any NB card exists.
 *
 * Deliberately the same three-bucket screen the operator already knows from
 * set reconciliation (ReconciliationModal): matched pairs, unmatched-BSC,
 * unmatched-SL, plus a keep shelf for a card that legitimately lives on only
 * one marketplace. The vocabulary is identical because the problem is:
 * "these two lists describe the same things, tell me which line up".
 *
 * Why this exists at all: when two NB rows share one SportLots set — 1996
 * Score's Dugout Collection Artist's Proofs Series 1 and 2 both mapping to the
 * single SL "Dugout Collection Artists Proofs" — the sibling row's cards come
 * back in this row's SL fetch. Materialising them would invent bogus cards
 * under this row. Here they simply sit in unmatched-SL and are dropped unless
 * the operator deliberately keeps one, which is the same rule set
 * reconciliation already uses for marketplace noise.
 *
 * Nothing is written until Confirm. Cards are generated from confirmed pairs
 * plus kept singles, and only then do the player/team/Wikidata syncs run.
 *
 * Keyboard model (matches ReconciliationModal):
 *   Tab    — cycles filters, rows, footer buttons
 *   Enter  — confirm when focus is on Confirm
 *   Escape — cancel
 */

export type PairingCard = {
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
  /**
   * NEO-189 — this card is a second version of another card in the set.
   *
   * It was missing here, and that silently broke variations end to end: the
   * adapters set it, `previewCardValidator` carries it, and
   * `commitCardChecklist` resolves the parent link from it — but the modal sits
   * between them and dropped it, so every variation committed as a standalone
   * card. The commit tests passed because they built cards directly and never
   * went through this type.
   */
  isVariation?: boolean;
  /**
   * NEO-199 — WIRE-ONLY. Both marketplaces' names for this card, sent by
   * `fetchCardChecklist` when they disagree about who is on it.
   *
   * It exists because the auto-matched merge happens server-side, before this
   * modal is mounted: `cardName: bsc.cardName || sl?.cardName` picks a winner
   * and the loser is gone, so the screen could not flag what it was never sent.
   * That is the COMMON path — most of a 660-row set auto-matches, and manual
   * linking is the leftovers.
   *
   * It is lifted off the card and onto the PAIR by `seedMatched` the moment it
   * arrives, and never reaches `onConfirm`: `MatchedPair.nameConflict` is where
   * this screen reasons about a disagreement, from either path. Do not read it
   * anywhere else.
   */
  nameConflict?: NameDisagreement;
  /**
   * NEO-251 — WIRE-ONLY, on exactly the same terms as `nameConflict` above:
   * both marketplaces' PLAYER LISTS for this card, sent by `fetchCardChecklist`
   * when they disagree about who is on it.
   *
   * A separate field rather than part of `nameConflict` because the two fail
   * independently. The title and the roster are different fields on different
   * shapes — BSC sends a structured `players[]`, SportLots one subject string
   * the adapter splits — so a card whose two sides carry the same title can
   * still carry a different roster, and `players: bsc.players ?? sl.players`
   * threw the loser away in silence. Those names become `playerIds`, which the
   * listing title is generated from, so the disagreement surfaced to a buyer
   * rather than to the operator.
   *
   * `preferred` is the server's evidence that an operator settled this same
   * disagreement on an earlier sync: the committed NB row already carries
   * SportLots' roster. It is rendered as a HINT — "NeonBinder currently
   * stores: …" — and deliberately does NOT pre-select the radio. Two reasons,
   * and the second is the one that matters: NB owns the answer and a hint is
   * evidence rather than a decision; and `countPairingEdits` reads a players
   * conflict as settled once `chosen` has moved off `"bsc"`, so a seeded
   * non-default would make an untouched row read as operator work in the
   * discard confirm.
   *
   * Lifted onto the PAIR by `seedMatched` the moment it arrives, and never
   * reaches `onConfirm`. Do not read it anywhere else.
   */
  playersConflict?: PlayersDisagreement & {
    preferred?: "bsc" | "sportlots";
  };
  platformData: {
    bsc?: { ref: string; setId?: string };
    sportlots?: { ref: string; setId?: string };
  };
  unmatched?: "bsc" | "sl";
  /**
   * NEO-335 — how the fetch-time BSC team lookup for this card ended
   * (`pairing-cards.ts`'s `TeamLookup`). Rides through the dialog untouched;
   * the commit stamps an answered teamless card as checked.
   */
  teamLookup?: TeamLookupOutcome;
  /**
   * NEO-478 — the operator's published checklist and the marketplace
   * disagree about this card's players or teams. Rides through the dialog
   * untouched (it is not a cross-marketplace question): the wizard's
   * "Checklist says otherwise" step settles it before the commit, which
   * refuses a card that still carries one.
   */
  checklistConflict?: ChecklistConflict;
  /**
   * NEO-335 — BSC's team value for this card exactly as its fetch-time lookup
   * returned it, unsplit (`checklistCandidates.rawTeamName`). Present only
   * where `teams` does not already say it. Rides through the dialog
   * untouched; the commit stores it as the "Listed as:" hint on an answered
   * card that saves with no team. A listing claim, never a team.
   */
  rawTeamName?: string;
  /**
   * NEO-496 — WIRE-ONLY: the server paired this card with a publisher
   * checklist row (`checklistCandidates.checklistLink`). Drives the
   * "On checklist" chip: `confidence` (a near-name pair) shows as a %, and
   * `checklistNumber` (a name pair whose numbers differ) is the row's number,
   * shown beside the card's own. Never a conflict. Stripped at Confirm
   * (`committable`): the commit's validators are strict.
   */
  checklistLink?: {
    via: "number" | "caseFolded" | "prefixStripped" | "player" | "playerName" | "playerFuzzy";
    confidence?: number;
    checklistNumber?: string;
    /**
     * The row the server paired (`checklistPairedRowValidator`) and the card
     * as it was before the row touched it (`checklistPairRevertValidator`).
     * Both present → the pair can be undone here (Unlink); a pair from before
     * they existed carries neither and offers no Unlink.
     */
    row?: ServerPairedRow;
    revert?: ServerPairRevert;
  };
  /**
   * NEO-496 — WIRE-ONLY: the streamed candidate's id on a checklist-only row
   * (a publisher checklist row no marketplace card paired). It has no
   * marketplace ref, so this is how `ABSORB` tells a re-delivered row from a
   * new one. Stripped at Confirm.
   */
  checklistRowId?: string;
};

/**
 * NEO-251 — what one card's two marketplaces disagreed about, as the sync
 * review needs to hear it.
 *
 * The DISAGREEMENT only: no `chosen`, no `custom`, no `preferred`. Those are
 * this screen's own state and the operator has already spent them; what the
 * diff needs is the pair of answers that were on offer, so it can tell "the
 * operator settled this last sync" apart from "upstream changed it".
 */
export type PairingConflicts = {
  nameConflict?: NameDisagreement;
  playersConflict?: PlayersDisagreement;
};

/**
 * What Confirm hands back.
 *
 * `cards` is exactly what it always was: a card here is a COMMITTABLE card,
 * carrying no open question. That invariant is load-bearing in two places —
 * `commitCardChecklist` throws on a card still carrying `playersConflict`, and
 * the byte-identical-payload test pins it — so the disagreements travel
 * BESIDE the cards rather than on them.
 *
 * Keyed by index into `cards`, which is the vocabulary the sync review already
 * speaks (`applyFieldsByIndex`, `baseVersionByIndex`, `heldBackIndices` all
 * address the same array the same way). A parallel array would have to be
 * filtered in step with `heldBackIndices`; a record simply misses.
 *
 * Only matched pairs can appear: a kept single has one marketplace and nothing
 * to disagree with. And only UNSETTLED ones — a row the operator decided in
 * this session is withheld, because the entry's whole meaning to the diff is
 * "nobody has answered this yet" (see `MatchedPair.touched`).
 */
export type PairingResult = {
  cards: PairingCard[];
  conflictsByIndex: Record<number, PairingConflicts>;
};

/**
 * NEO-189 — the two marketplaces disagree about WHO IS ON the card.
 *
 * Found in live 2021 Topps data: SportLots has "Mike Yastrzemski|Carl
 * Yastrzemski · SSSP" where BSC has a bare "#227c Mike Yastrzemski". The card
 * is Carl — a "Legend" short print whose variation pictures a different player
 * than the base card, which is a standard modern convention (2021 Topps #52 is
 * Archie Bradley; 52b/c/d are Mickey Mantle). Merging those rows used to hand
 * the pair BSC's less-informative name and drop the fact that it is Carl, and
 * the first anyone hears of it is a returned listing.
 *
 * We do not guess which name is right — that is the rule this whole feature
 * runs on (`resolveVariationParents` reports `unresolvedStems` rather than
 * picking a parent; `suggestVariationPairings` leaves un-confident pairs
 * alone). So both names are kept, the row says so, and the operator decides.
 *
 * The two names plus WHICH ONE IS WINNING. The pair of names is the wire type
 * (`NameDisagreement`); `chosen` is this screen's own state and is never sent
 * or received — the server reports the disagreement, an operator settles it.
 *
 * This lives on the PAIR, not on the card. `PairingCard` is what `onConfirm`
 * hands on to `resolveEntities` and `commitCardChecklist`, and a card that has
 * reached that point has one name, not a choice still open — so the choice is
 * kept off it deliberately rather than incidentally.
 */
type NameConflict = NameDisagreement & {
  /** Whose name the merged card is carrying right now. */
  chosen: "bsc" | "sportlots" | "custom";
  /**
   * A name the OPERATOR typed, when neither marketplace had it right.
   *
   * Both marketplaces getting a card wrong is not hypothetical — that is the
   * same class of error the whole conflict control exists for, one step
   * further along, and the operator is the only party on this screen who can
   * see the card. So `RENAME` on a conflicted row does not simply overwrite
   * `card.cardName` and leave a radiogroup claiming BSC's name is winning: it
   * becomes a THIRD option in the same group, checked, with the two
   * marketplace names still one click away.
   *
   * Defined only once the operator has typed something that is neither
   * marketplace's name, and `custom !== undefined` is exactly the condition
   * under which the third radio renders. That keeps the group's invariant —
   * every option is reachable, exactly one is checked — a property of the
   * data rather than of the render.
   *
   * It is deliberately NOT cleared when the operator switches back to BSC or
   * SportLots: their typed name stays on offer, so the choice is as reversible
   * as the original two-way one already was.
   */
  custom?: string;
};

/**
 * NEO-251 — the roster equivalent of `NameConflict`, and deliberately its
 * mirror image rather than a variation on it.
 *
 * Same three options (BSC, SportLots, a list the operator typed), same
 * `chosen`-lives-on-the-pair rule, same reversibility right up to Confirm. The
 * one difference is the shape of the value: a LIST rather than a string, which
 * is why `custom` is `string[]` and why "did the operator just retype one of
 * the marketplace answers?" is decided by `playersKey` rather than by string
 * equality — two sides listing the same two players in a different order are
 * the same answer, and treating the reordering as a third option would put an
 * unreachable-by-meaning choice in the group.
 *
 * That fold is a KNOWN divergence from `RENAME`, which matches on the exact
 * trimmed string precisely so that a typed "José Ramírez" is not swallowed as
 * "you picked BSC's Jose Ramirez". `playersKey` folds diacritics, so the same
 * correction typed into the roster field IS swallowed. It is the contract this
 * screen was specified against (order-insensitivity is the dominant case for a
 * list); flagged here so the trade is visible rather than discovered.
 */
type PlayersConflict = PlayersDisagreement & {
  /** Whose roster the merged card is carrying right now. */
  chosen: "bsc" | "sportlots" | "custom";
  /** A roster the OPERATOR typed, when neither marketplace had it right. */
  custom?: string[];
  /**
   * NEO-251 — the side the NB row this card matches ALREADY carries, i.e.
   * how this same disagreement was settled on an earlier sync.
   *
   * Displayed, never applied. See `PairingCard.playersConflict`.
   */
  preferred?: "bsc" | "sportlots";
};

/**
 * A pair as it ARRIVES — off the streamed `checklistCandidates` query, which
 * is the only wire the cards travel now that `fetchCardChecklist` returns just
 * a count and a message.
 *
 * Distinct from `MatchedPair` on purpose: an incoming pair has no `chosen`,
 * because nobody has chosen yet. `seedMatched` turns one into the other.
 */
type IncomingPair = { card: PairingCard; confidence: number };

/**
 * The candidates snapshot this dialog opens on, and keeps receiving.
 *
 * Named rather than inlined on the props so `seedState` — the reducer's lazy
 * initializer, which lives outside the component — can take it by type.
 */
type PairingInitialData = {
  /**
   * Pairs the server already merged. Typed as INCOMING — no `chosen`, because
   * nobody has chosen yet; `seedMatched` derives that here (NEO-199).
   */
  autoMatched: IncomingPair[];
  unmatchedBsc: PairingCard[];
  unmatchedSl: PairingCard[];
  /**
   * NEO-496 — publisher checklist rows no marketplace card paired
   * (`checklistOnly` candidates). Optional: a fetch with no checklist has none.
   */
  checklistOnly?: PairingCard[];
};

type MatchedPair = {
  card: PairingCard;
  confidence: number;
  /**
   * Set on ANY merged pair whose two sides name the card differently —
   * hand-linked here by `LINK`, or auto-matched server-side and carried over on
   * `PairingCard.nameConflict` (NEO-199).
   *
   * Both paths run the same `conflictingNames`, so "these two marketplaces
   * disagree" means one thing on this screen regardless of who did the merging.
   * That matters more for the auto path than the manual one: most of a 660-row
   * set auto-matches, so a guard that only covered the leftovers would have
   * been a screen that looks like it is protecting you and mostly is not.
   */
  nameConflict?: NameConflict;
  /**
   * NEO-251 — set on ANY merged pair whose two sides list different PLAYERS,
   * from either path, under the same rule as `nameConflict` above.
   *
   * Both can be set on one row: the marketplaces can disagree about the title
   * AND about the roster, and they are two decisions, so the row shows two
   * controls.
   */
  playersConflict?: PlayersConflict;
  /**
   * NEO-251 — has the operator made a DECISION about this row in this session?
   *
   * Set by any of the four settle actions (`CHOOSE_NAME`, `CHOOSE_PLAYERS`,
   * `RENAME`, `EDIT_PLAYERS`), and it is the reason the row's conflict is
   * withheld from `conflictsByIndex` at Confirm — see `PairingResult`.
   *
   * ## Why `chosen` cannot answer this
   *
   * The obvious test — "`chosen` has moved off its `"bsc"` default" — is wrong
   * in the one direction that costs data. An operator whose NB row already
   * carries SportLots' roster (they settled it on a previous sync) can open
   * this screen and deliberately pick BSC. That is a real decision, and it
   * leaves `chosen === "bsc"`: identical, from the outside, to a row nobody
   * looked at. Treated as untouched, the diff suppresses the field and their
   * re-pick is discarded in silence.
   *
   * So this is a record of the GESTURE, not of the value it produced. It is
   * therefore also set when the operator clicks the pill that is already
   * checked — that dispatch is otherwise a no-op, and it is exactly the shape
   * the re-pick takes.
   *
   * Deliberately NOT set by a refused or empty edit. A blank field, an
   * over-length name and a re-typed identical value all return the same state
   * object; nothing was decided, so nothing is recorded.
   *
   * `countPairingEdits` is intentionally left reading `chosen`/`custom`
   * instead: it answers "how much work would a discard throw away", and a bare
   * re-pick of the default changes nothing that a re-open would not reproduce.
   */
  touched?: boolean;
};

type State = {
  matched: MatchedPair[];
  unmatchedBsc: PairingCard[];
  unmatchedSl: PairingCard[];
  keptBsc: PairingCard[];
  keptSl: PairingCard[];
  /**
   * NEO-220 — `candidateKey` of every pair that ARRIVED matched: the seed plus
   * everything `ABSORB` has folded in since. Never pruned.
   *
   * It exists so the discard confirm can count an auto-pair the operator took
   * apart, which nothing else in this state can see: after `UNLINK` both halves
   * sit in the unmatched columns looking exactly like cards that never matched.
   * A discard count blind to that would read 0 on a session whose entire work
   * was correcting the server's matches, and a confirm that says "nothing to
   * lose" while there is is worse than no confirm at all.
   *
   * Carried on the state rather than in a ref beside it because `ordered` and
   * every reducer case already thread the state through; a parallel ref would
   * be one more thing to keep in sync with `ABSORB`.
   */
  seedMatchedKeys: Set<string>;
  /**
   * NEO-341 — has an `ABSORB` carried the parent's word that this fetch's
   * whole batch, with every team lookup landed, has reached the client?
   *
   * Latched (once true it stays true for this instance, which is one per
   * fetch) and carried HERE rather than read off the prop at click time, so it
   * can only turn true in the same dispatch that folds in the teams it vouches
   * for: Confirm can never read a state that has the flag but not the last
   * chunk's teams.
   */
  streamSettled: boolean;
  /**
   * NEO-490 / NEO-496 — the publisher's checklist rows no card paired, as the
   * dialog lists them: one per `checklistOnly` candidate, in arrival order
   * (append-only, so a row index never moves). Null while the checklist is not
   * a source of this fetch. `[]` when it is, and every row found its card.
   */
  checklistRows: ChecklistLinkRow[] | null;
  /**
   * NEO-496 — the candidate behind each row, index for index with
   * `checklistRows`. A kept row is committed as this card (number, players and
   * teams from the row, no marketplace link).
   */
  checklistCards: PairingCard[];
  /** Every row index, ascending: the rows the server paired with no card. */
  checklistUnused: number[];
  /**
   * NEO-496 — rows the operator kept as cards of their own (Keep / Keep all),
   * in keep order. A kept row cannot be linked; Remove puts it back.
   */
  checklistKept: number[];
  /**
   * The operator's links: card `candidateKey` → row index. A linked card is
   * always saved (matched, or on a keep shelf): linking an unmatched card
   * keeps it, and Remove drops the link.
   */
  checklistLinks: Map<string, number>;
  /**
   * NEO-496 — how many server pairings the operator undid on a card that
   * stayed where it was (a BSC + SportLots pair, a card on a keep shelf or
   * in a column). Those leave no other trace for the discard count; a
   * one-marketplace card that leaves Matched for the keep shelf is already
   * counted by `countPairingEdits`.
   */
  checklistServerUnlinks: number;
};

type Action =
  // Keyed on candidateKey (the marketplace ref), NOT the card number:
  // SportLots files "#1 [ Sliding ]" and "#1 [ In Dugout ]" under the same
  // number, so a number-keyed link silently picks whichever came first.
  | { type: "LINK"; bscKey: string; slKey: string }
  | { type: "UNLINK"; index: number }
  // NEO-189: which marketplace's name the merged card keeps. Indexes
  // `state.matched` exactly as UNLINK does — that array is what the list
  // renders, and `ordered` sorts state rather than a rendered copy.
  //
  // `custom` is the operator's own name, and is only a legal side once
  // `nameConflict.custom` exists — the reducer guards it rather than trusting
  // the render, since the render is not the only caller (the radiogroup's
  // arrow-key handler dispatches this too).
  | { type: "CHOOSE_NAME"; index: number; side: "bsc" | "sportlots" | "custom" }
  /**
   * NEO-189 follow-up — the operator retypes a card's name.
   *
   * Marketplaces get names wrong, and both can be wrong at once; the operator
   * holding the card is the only one who can settle it, and after Confirm the
   * name is a committed NB card. So the name is editable HERE, before anything
   * is written, rather than in CardDetailPanel one commit later.
   *
   * No backend change: this rewrites `card.cardName`, the same field
   * CHOOSE_NAME already rewrites, and that field already flows through
   * `onConfirm` into `commitCardChecklist`.
   *
   * Indexes `state.matched` exactly as UNLINK and CHOOSE_NAME do. Note what it
   * must NOT touch: `cardNumber`, `cardVariation` and `platformData` are what
   * `candidateKey`, `domKey` and `compareCards` are derived from, so a rename
   * cannot move a row, break a React key, or invalidate the `data-` handles
   * the focus helpers re-query after a dispatch.
   */
  | { type: "RENAME"; index: number; cardName: string }
  /**
   * NEO-251 — which marketplace's PLAYER LIST the merged card keeps.
   *
   * The exact shape of `CHOOSE_NAME` one field over, including the `"custom"`
   * guard: the reducer refuses a side whose value does not exist, so the
   * radiogroup's "every rendered option is reachable and exactly one is
   * checked" invariant is a property of the data rather than of three call
   * sites agreeing.
   */
  | {
      type: "CHOOSE_PLAYERS";
      index: number;
      side: "bsc" | "sportlots" | "custom";
    }
  /**
   * NEO-251 — the operator types the card's real roster.
   *
   * The list arrives already split (the input splits on `|` or ` / `), so this
   * action never parses. Same three outcomes as `RENAME`, with one deliberate
   * difference: a typed list is matched against each marketplace side with
   * `playersKey` rather than by exact string, because two lists naming the same
   * players in a different order are the same answer and a third "Custom"
   * option spelling one of the first two is a choice with no meaning. The cost
   * of that fold is recorded on `PlayersConflict`.
   */
  | { type: "EDIT_PLAYERS"; index: number; players: string[] }
  // Keyed on candidateKey for exactly the same reason LINK is: two SportLots
  // rows filed under one number are two different cards, and a number-keyed
  // lookup moves whichever of them sorted first. The operator watches the row
  // they clicked leave the column while a DIFFERENT card is what actually
  // reaches the keep shelf and, from there, the committed checklist.
  | { type: "KEEP"; side: "bsc" | "sl"; key: string }
  | { type: "KEEP_ALL"; side: "bsc" | "sl" }
  | { type: "UNKEEP"; side: "bsc" | "sl"; key: string }
  // NEO-195: more candidates arrived while the operator is already working.
  | {
      type: "ABSORB";
      autoMatched: MatchedPair[]; // already through `seedMatched`
      unmatchedBsc: PairingCard[];
      unmatchedSl: PairingCard[];
      /** NEO-496 — publisher checklist rows no card paired (`checklistOnly`). */
      checklistOnly: PairingCard[];
      /** NEO-341 — the parent has seen this fetch end; see `State.streamSettled`. */
      settled: boolean;
    }
  /**
   * NEO-496 — the checklist is a source of this fetch. Idempotent: lists the
   * (possibly empty) checklist column if it is not listed yet.
   */
  | { type: "CHECKLIST_SOURCE" }
  /** NEO-496 — keep one checklist row as a card of its own. */
  | { type: "KEEP_CHECKLIST"; rowIndex: number }
  /** NEO-496 — keep every row still listed (not linked, not kept). */
  | { type: "KEEP_ALL_CHECKLIST" }
  /** NEO-496 — a kept row goes back to the list; unkept rows are dropped. */
  | { type: "UNKEEP_CHECKLIST"; rowIndex: number }
  /** NEO-490 — link a checklist row to a card; an unmatched card is kept. */
  | { type: "LINK_CHECKLIST"; rowIndex: number; cardKey: string }
  /** NEO-490 — drop a card's checklist link; the row is listed again. */
  | { type: "UNLINK_CHECKLIST"; cardKey: string }
  /**
   * NEO-496 — undo the SERVER's pairing of a card with a checklist row: the
   * card gets back what it had before the row, and the row is listed again.
   */
  | { type: "UNLINK_SERVER_CHECKLIST"; cardKey: string };

/**
 * NEO-195 — stable identity for a candidate across streamed updates.
 *
 * The marketplace ref is the real identity; SportLots in particular reuses a
 * card NUMBER across a card and its variations, so keying on the number would
 * make three rows look like one and absorb would drop two of them.
 */
function candidateKey(c: PairingCard): string {
  return (
    c.platformData.bsc?.ref ??
    c.platformData.sportlots?.ref ??
    `#${c.cardNumber}`
  );
}

/**
 * `candidateKey` reduced to characters that are legal in a DOM id.
 *
 * The name-conflict row needs a per-row handle for two things — the `id` its
 * `aria-describedby` points at, and the `[data-name-conflict=…]` selector
 * `refocusSelectedRadio` re-queries after a dispatch. Both were keyed on the
 * card NUMBER, which is not unique here for the same reason it is not unique
 * anywhere else on this screen: a card and its variation share one. Two
 * conflicting pairs on the same number therefore emitted a duplicate `id`
 * (invalid HTML — `aria-describedby` resolves to whichever came first) and
 * sent the arrow-key focus into the FIRST row's radiogroup no matter which row
 * the operator was working in.
 *
 * A ref can contain spaces and `#` (SportLots refs are whole card titles), and
 * an id containing a space is not addressable by `aria-describedby` at all,
 * hence the fold to `[A-Za-z0-9_-]`.
 */
function domKey(c: PairingCard): string {
  return candidateKey(c).replace(/[^A-Za-z0-9_-]+/g, "-");
}

/**
 * NEO-189 operator feedback — the two unmatched columns are drag-and-drop.
 *
 * Click-to-select-then-click was the only way to link a BSC-only card to a
 * SportLots-only one, and nothing on screen said so: a row highlighted cyan
 * with no other affordance, in an app that uses drag-and-drop for exactly this
 * "these two lists describe the same thing" gesture everywhere else
 * (ReconciliationModal pairs marketplace SETS by drag; ParallelGroupingModal
 * groups parallels by drag). This column pair is the same gesture one level
 * down, so it now behaves the same way.
 *
 * The click path is NOT replaced. It is the keyboard/assistive-tech path —
 * dnd-kit's pointer drag has no keyboard equivalent that survives this
 * dialog's focus trap — and it is what the Maestro flow drives. Drag is an
 * addition on top of it.
 */
type DragSide = "bsc" | "sl";

/**
 * A drag id is `side:candidateKey`. The SIDE has to travel with the key
 * because a drop is only a link when the two ends are on OPPOSITE sides, and
 * `candidateKey` alone cannot say which column a row came from — a SportLots
 * ref is a whole card title and a BSC ref is an opaque id, with no shared
 * shape to test.
 *
 * Split on the FIRST colon only: a SportLots ref can contain one
 * ("#227 Carl Yastrzemski [ VAR: SSSP ]"), the two side prefixes cannot.
 */
function dragId(side: DragSide, key: string): string {
  return `${side}:${key}`;
}

function parseDragId(
  id: string,
): { side: DragSide; key: string } | undefined {
  const i = id.indexOf(":");
  if (i < 0) return undefined;
  const side = id.slice(0, i);
  if (side !== "bsc" && side !== "sl") return undefined;
  return { side, key: id.slice(i + 1) };
}

/**
 * NEO-490 — a checklist row is dragged as `ck:<rowIndex>`. The prefix is not a
 * `DragSide`, so `parseDragId` reads it as "not a BSC/SportLots row" and the
 * card-to-card link path never sees it.
 */
function checklistDragId(rowIndex: number): string {
  return `ck:${rowIndex}`;
}

function parseChecklistDragId(id: string): number | undefined {
  if (!id.startsWith("ck:")) return undefined;
  const n = Number(id.slice(3));
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** The card key a checklist row may be dropped on: a column row. */
function checklistDropKey(id: string): string | undefined {
  return parseDragId(id)?.key;
}

/** "1 pairing" / "2 pairings". */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * One unmatched row: draggable, and a drop target for the other column.
 *
 * Both hooks share one id and one node, which is what makes linking work in
 * either direction for the price of one component — a BSC row dropped on a
 * SportLots row and a SportLots row dropped on a BSC row are the same link,
 * and `handleDragEnd` sorts out which end is which.
 *
 * `attributes` from `useDraggable` are deliberately NOT spread. They carry
 * `role="button"` and `tabIndex=0`, and this row is an <li> that already
 * contains two real <button>s:
 *   - `role="button"` on the wrapper makes those children presentational to
 *     assistive tech (ARIA hides nested widgets inside a widget), which would
 *     take the select/link/keep controls off the AT path entirely — the exact
 *     path this change is supposed to leave untouched.
 *   - `tabIndex=0` would add one dead tab stop per row to the dialog's focus
 *     trap (its Tab handler queries `[tabindex]:not([tabindex="-1"])`), so a
 *     900-row set would grow 900 stops that do nothing when activated.
 * The listeners alone are what the mouse and touch sensors need; the accessible
 * affordance for the same action is the click path, which is untouched.
 *
 * Plain clicks on the inner buttons still work because a drag needs 5px of
 * mouse movement or a 180ms touch hold, so it never starts from a plain press
 * (same reasoning as ParallelGroupingModal).
 *
 * NEO-300 — the <li> is also the drag's ACTIVATOR node. Without one, dnd-kit's
 * KeyboardSensor takes a Space or Enter bubbling up from ANY child as "lift
 * this row": it preventDefaults the key, so the Select / Link / Keep button
 * never fires, and a drag starts instead. That broke the keyboard path this
 * row's comment above calls the accessible one. With the <li> as the
 * activator, only a key pressed on the <li> itself lifts it — and the <li>
 * is deliberately not focusable, so keyboard users link by Select + Link,
 * exactly as before.
 */
function PairableRow({
  side,
  cardKey,
  acceptsChecklist = false,
  children,
}: {
  side: DragSide;
  cardKey: string;
  /** NEO-490 — a checklist row may be dropped here (the card is a leftover). */
  acceptsChecklist?: boolean;
  children: React.ReactNode;
}) {
  const id = dragId(side, cardKey);
  const {
    listeners,
    setNodeRef: setDragRef,
    setActivatorNodeRef,
    isDragging,
  } = useDraggable({ id });
  const { setNodeRef: setDropRef, isOver, active } = useDroppable({ id });
  const setRef = useCallback(
    (node: HTMLLIElement | null) => {
      setDragRef(node);
      setDropRef(node);
      setActivatorNodeRef(node);
    },
    [setDragRef, setDropRef, setActivatorNodeRef],
  );
  // Highlight only for a drop that would actually DO something. A row is its
  // own droppable, and same-column drops are no-ops, so an unconditional
  // `isOver` would promise a link that `handleDragEnd` then declines to make.
  // NEO-490: a checklist row dragged over is a link only onto a leftover.
  const activeId = typeof active?.id === "string" ? active.id : undefined;
  const isLinkTarget =
    isOver &&
    activeId !== undefined &&
    (parseChecklistDragId(activeId) !== undefined
      ? acceptsChecklist
      : parseDragId(activeId)?.side !== side);

  return (
    <li
      ref={setRef}
      // A-N3: the handle a Keep re-queries to move focus to the next row.
      data-pair-row={`${side}:${cardKey}`}
      {...listeners}
      className={`flex items-center gap-2 rounded cursor-grab active:cursor-grabbing ${
        isDragging ? "opacity-40" : ""
      } ${isLinkTarget ? "ring-2 ring-selection bg-pick-blue" : ""}`}
    >
      {children}
    </li>
  );
}

/**
 * NEO-490 — one checklist row: draggable onto its card while unlinked.
 *
 * Same rules as `PairableRow`: the <li> is the activator and is not
 * focusable, the draggable's own attributes are not spread (they would hide
 * the row's buttons from assistive tech), and the button path — select the
 * row, then Link on the card — is the keyboard way to do the same thing.
 * `data-checklist-row` is the handle focus is re-queried by after a link or
 * an unlink swaps the row's controls.
 */
function ChecklistRowItem({
  rowIndex,
  linked,
  children,
}: {
  rowIndex: number;
  linked: boolean;
  children: React.ReactNode;
}) {
  const { listeners, setNodeRef, setActivatorNodeRef, isDragging } =
    useDraggable({ id: checklistDragId(rowIndex), disabled: linked });
  const setRef = useCallback(
    (node: HTMLLIElement | null) => {
      setNodeRef(node);
      setActivatorNodeRef(node);
    },
    [setNodeRef, setActivatorNodeRef],
  );
  return (
    <li
      ref={setRef}
      data-checklist-row={rowIndex}
      {...(linked ? {} : listeners)}
      className={`flex items-center gap-2 rounded ${
        linked ? "" : "cursor-grab active:cursor-grabbing"
      } ${isDragging ? "opacity-40" : ""}`}
    >
      {children}
    </li>
  );
}

/**
 * NEO-201 — total, arrival-order-independent ordering for one column.
 *
 * `compareCardNumbers` alone is not a total order on this screen, and that is
 * the whole point of this branch: SportLots files a card and its variations
 * under ONE number ("#1 [ Sliding ]", "#1 [ In Dugout ]"), so same-numbered
 * rows tie and `Array.prototype.sort` falls back to the order they happened to
 * be in. During a streamed fetch that is ARRIVAL order, and `ABSORB` appends —
 * so a card and its variation can trade places between renders while the
 * operator is part-way through reviewing 900 of them.
 *
 * Not a correctness bug since `65d8352`: nothing on this screen is selected,
 * kept or linked by position any more. It is a legibility one, and ordering
 * instability on this screen has already been reported once.
 *
 * The tiebreak is chosen to be USEFUL, not merely deterministic:
 *
 *  1. A parent sorts before its own variations. That is how a checklist is
 *     printed and how the operator reads one — the base card, then the things
 *     that vary from it.
 *  2. Then the printed variation description, so a card's variations read in a
 *     fixed, nameable order rather than an opaque one.
 *  3. Then `candidateKey` — the marketplace ref — purely to make the order
 *     TOTAL. Two rows can only reach here by sharing a number, a variation
 *     flag and a variation description, and the ref is the one thing that is
 *     guaranteed to differ (it is what makes them two rows at all).
 *
 * `cardName` is deliberately NOT a key anywhere in here. It is the one field
 * `CHOOSE_NAME` rewrites, so sorting on it would make a matched row jump to a
 * different position the moment the operator resolved a name conflict on it —
 * reintroducing the exact instability this function exists to remove, at the
 * worst possible moment.
 */
function compareCards(a: PairingCard, b: PairingCard): number {
  const byNumber = compareCardNumbers(a.cardNumber, b.cardNumber);
  if (byNumber !== 0) return byNumber;
  const aIsVariation = a.isVariation ? 1 : 0;
  const bIsVariation = b.isVariation ? 1 : 0;
  if (aIsVariation !== bIsVariation) return aIsVariation - bIsVariation;
  const byVariation = (a.cardVariation ?? "").localeCompare(
    b.cardVariation ?? "",
  );
  if (byVariation !== 0) return byVariation;
  return candidateKey(a).localeCompare(candidateKey(b));
}

/**
 * NEO-195 — keep every column in natural card-number order.
 *
 * The fetch streams, and candidates are released as their stems resolve rather
 * than in numeric order, so ABSORB appends #351 next to #40. The operator reads
 * a checklist by number; a list in arrival order is not a checklist.
 *
 * Applied to EVERY transition rather than at each render site, so a card moved
 * by LINK, UNLINK, KEEP or UNKEEP lands in its right place too — a card
 * unlinked back into a column would otherwise reappear at the bottom.
 *
 * Sorting state rather than a rendered copy also keeps `UNLINK`'s index valid:
 * it indexes `state.matched`, which is exactly what the list renders.
 *
 * The comparator is `compareCards`, not the bare card-number compare: a number
 * is not unique here, and a tie left to `sort` is a tie left to arrival order.
 */
function ordered(state: State): State {
  return {
    ...state,
    matched: [...state.matched].sort((a, b) => compareCards(a.card, b.card)),
    unmatchedBsc: [...state.unmatchedBsc].sort(compareCards),
    unmatchedSl: [...state.unmatchedSl].sort(compareCards),
    keptBsc: [...state.keptBsc].sort(compareCards),
    keptSl: [...state.keptSl].sort(compareCards),
  };
}

function reducer(state: State, action: Action): State {
  const next = baseReducer(state, action);
  // A no-op action returns the same reference; do not churn the list for it.
  return next === state ? state : ordered(next);
}

/**
 * Do these two candidates disagree about the card's name?
 *
 * The comparison itself is `conflictingNames` in lib/cards/card-name.ts, shared
 * verbatim with `fetchCardChecklist` — an auto-matched conflict and a
 * hand-linked one must be the same predicate or the screen is telling the
 * operator two different stories. All this adds is the default choice.
 */
function nameConflictOf(
  bsc: PairingCard,
  sl: PairingCard,
): NameConflict | undefined {
  const conflict = conflictingNames(bsc.cardName, sl.cardName);
  // `chosen` starts on BSC because that is what `mergePair` produces when both
  // sides have a name — and what the server's merge produces on the auto path,
  // for the same reason. It is a DEFAULT, not a decision, which is the whole
  // reason the row has to say so out loud.
  return conflict ? { ...conflict, chosen: "bsc" } : undefined;
}

/**
 * NEO-251 — do these two candidates disagree about WHO IS ON the card?
 *
 * `nameConflictOf`'s sibling, sharing `conflictingPlayers` with the server for
 * the same reason: an auto-matched roster disagreement and a hand-linked one
 * have to be the same fact, because the operator cannot tell which path put the
 * row in front of them.
 *
 * `chosen` starts on BSC because `mergePair` takes `bsc.players ?? sl.players`
 * and a conflict requires both sides to be non-empty — so the default is a
 * truthful statement about what the card is carrying, not a decision.
 */
function playersConflictOf(
  bsc: PairingCard,
  sl: PairingCard,
): PlayersConflict | undefined {
  const conflict = conflictingPlayers(bsc.players, sl.players);
  return conflict ? { ...conflict, chosen: "bsc" } : undefined;
}

/** How a roster reads inside a pill: "Alec Bohm / Spencer Howard". */
function joinPlayers(players: string[]): string {
  return players.join(" / ");
}

/**
 * How a roster reads inside the EDIT field: "Alec Bohm | Spencer Howard".
 *
 * Deliberately not `joinPlayers`. The field's own label names `|` as the
 * separator, and a field pre-filled with a separator its label does not
 * mention teaches the operator the wrong thing about what they may type. The
 * pills keep ` / ` because they are prose, not input.
 */
function joinCustomPlayers(players: string[]): string {
  return players.join(" | ");
}

/**
 * The custom-roster field's own separator, and the one its label names.
 *
 * ` / ` is accepted too because it is what the pills show, and an operator
 * copying a pill's text into the field should not be punished for it. Split on
 * a SPACED slash only: "Ken Griffey Jr./Sr." is one name, and an unspaced
 * slash inside a name is not a separator.
 */
function splitPlayers(text: string): string[] {
  return text
    .split(/\||\s+\/\s+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * NEO-199 — turn pairs as they ARRIVE into pairs this screen can reason about.
 *
 * Two jobs, and the second is the one that matters:
 *
 *  1. LIFT. A server-merged pair carries the disagreement on the card
 *     (`PairingCard.nameConflict`); this screen wants it on the PAIR, next to
 *     `chosen`, exactly where `LINK` puts a hand-made one. After this, every
 *     downstream reader — the render, the header count, `CHOOSE_NAME`,
 *     `UNLINK` — is path-agnostic and needed no change at all.
 *  2. STRIP. The field comes off the card, so the object handed to `onConfirm`
 *     is byte-identical to what it was before this field existed. Widening
 *     `previewCardValidator` made carrying it legal, not mandatory, and a card
 *     on its way to `commitCardChecklist` has one name rather than an open
 *     question.
 *
 * The comparison is RE-RUN rather than trusted. It is the same function the
 * server used, so on a healthy payload it is a no-op — but it costs a string
 * compare on the fraction of rows that are flagged at all, and it means a
 * degenerate pair (two spellings of one name, an empty side) cannot render a
 * radiogroup asking the operator to choose between two identical options.
 *
 * An agreeing pair is returned BY REFERENCE. This runs on every `ABSORB`, which
 * on a streamed 908-card set is every tick of the candidates subscription; the
 * common row must not allocate.
 */
function seedMatched(incoming: IncomingPair[]): MatchedPair[] {
  return incoming.map((pair) => {
    const wireName = pair.card.nameConflict;
    // NEO-251: the roster disagreement travels the same wire and is lifted and
    // stripped on the same terms. Checked together so the common row — neither
    // field present — still returns BY REFERENCE and allocates nothing; this
    // runs on every `ABSORB`, i.e. every tick of a 908-card subscription.
    const wirePlayers = pair.card.playersConflict;
    if (!wireName && !wirePlayers) return pair;
    const card: PairingCard = { ...pair.card };
    delete card.nameConflict;
    delete card.playersConflict;
    // Both comparisons are RE-RUN rather than trusted, for the reason above:
    // it is the same function the server used, so on a healthy payload it is a
    // no-op — and it means a degenerate pair cannot render a radiogroup asking
    // the operator to choose between two identical options.
    const nameConflict = wireName
      ? conflictingNames(wireName.bsc, wireName.sportlots)
      : undefined;
    const playersConflict = wirePlayers
      ? conflictingPlayers(wirePlayers.bsc, wirePlayers.sportlots)
      : undefined;
    return {
      card,
      confidence: pair.confidence,
      // BSC by default on BOTH: the server's merge took `bsc.cardName ||
      // sl.cardName` and `bsc.players ?? sl.players`, and a conflict requires
      // both sides to be non-empty, so the card is necessarily carrying BSC's
      // answer. Same invariant `nameConflictOf` / `playersConflictOf` rely on.
      ...(nameConflict
        ? { nameConflict: { ...nameConflict, chosen: "bsc" as const } }
        : {}),
      ...(playersConflict
        ? {
            playersConflict: {
              ...playersConflict,
              chosen: "bsc" as const,
              // Evidence only — see `PairingCard.playersConflict`. Carried
              // across so the row can SAY what NB already stores; it never
              // moves `chosen`.
              ...(wirePlayers?.preferred
                ? { preferred: wirePlayers.preferred }
                : {}),
            },
          }
        : {}),
    };
  });
}

/**
 * The reducer's opening state, built once from the first snapshot of the
 * candidates stream.
 *
 * Lazy (passed as `useReducer`'s initializer rather than its value) because it
 * now allocates a Set alongside the sort, and because `seedMatched` runs here
 * exactly once — it used to run on every render only to be thrown away.
 */
function seedState({
  initialData,
  checklistSource,
}: {
  initialData: PairingInitialData;
  /** NEO-496 — the checklist is a source of this fetch (`sources`). */
  checklistSource: boolean;
}): State {
  // NEO-199: `seedMatched`, not the raw array — an auto-matched pair the
  // marketplaces name differently has to arrive already flagged, on the very
  // first paint. That is the common path; waiting for the operator to
  // hand-link something before the guard exists is the defect.
  // NEO-496: a one-marketplace card the server paired with a checklist row is
  // on two sources, so it is matched too.
  const bscSplit = splitChecklistMatched(initialData.unmatchedBsc);
  const slSplit = splitChecklistMatched(initialData.unmatchedSl);
  const matched = [
    ...seedMatched(initialData.autoMatched),
    ...bscSplit.matched,
    ...slSplit.matched,
  ];
  const checklistCards = initialData.checklistOnly ?? [];
  const checklistInPlay =
    checklistSource ||
    checklistCards.length > 0 ||
    matched.some((m) => m.card.checklistLink !== undefined);
  // NEO-195: `ordered` on the seed too — the first paint is otherwise in
  // whatever order the fetch produced, which for a streamed batch is arrival
  // order, not card order.
  return ordered({
    matched,
    unmatchedBsc: bscSplit.unmatched,
    unmatchedSl: slSplit.unmatched,
    keptBsc: [],
    keptSl: [],
    seedMatchedKeys: new Set(matched.map((m) => candidateKey(m.card))),
    // NEO-341: only an ABSORB may say so — see `State.streamSettled`.
    streamSettled: false,
    checklistRows: checklistInPlay ? checklistCards.map(checklistRowOf) : null,
    checklistCards,
    checklistUnused: checklistCards.map((_, i) => i),
    checklistKept: [],
    checklistLinks: new Map(),
    checklistServerUnlinks: 0,
  });
}

/**
 * NEO-496 — one-marketplace cards the server paired with a publisher
 * checklist row are MATCHED (the card is on two sources, as a BSC + SportLots
 * pair is), not singles waiting on a Keep. They join the Matched list with
 * full confidence; the "On checklist" chip carries the name match's %.
 */
function splitChecklistMatched(cards: readonly PairingCard[]): {
  matched: MatchedPair[];
  unmatched: PairingCard[];
} {
  const matched: MatchedPair[] = [];
  const unmatched: PairingCard[] = [];
  for (const c of cards) {
    if (c.checklistLink) matched.push({ card: c, confidence: 1 });
    else unmatched.push(c);
  }
  return { matched, unmatched };
}

/**
 * NEO-496 — a `checklistOnly` candidate as the checklist row it came from:
 * the row's number as printed, its players, and its teams (already resolved
 * by the server). A blank or "NNO" number is a no-number row; a row whose
 * team the checklist answered with nothing is its "No Team" claim (NEO-489).
 */
export function checklistRowOf(card: PairingCard): ChecklistLinkRow {
  const teams = card.teams ?? [];
  return {
    number: card.cardNumber,
    players: card.players ?? [],
    teams,
    ...(isNoNumber(card.cardNumber) ? { noNumber: true as const } : {}),
    ...(card.teamLookup === "checklist" && teams.length === 0
      ? { noTeam: true as const }
      : {}),
  };
}

/**
 * NEO-496 — how a re-delivered checklist row is recognised: the candidate's
 * id, else (a caller that does not send one) its number and name.
 */
function checklistRowKey(card: PairingCard): string {
  return card.checklistRowId ?? `#${card.cardNumber}\u0000${card.cardName}`;
}

/**
 * NEO-490 — the marketplace refs a card answers to as a checklist link
 * target: its BSC ref and its SportLots ref.
 *
 * Refs only. `candidateKey`'s `#number` fallback is NOT a target, because a
 * card number is not unique (product invariant 7) and "#17" could name two
 * cards at once.
 */
function cardRefs(c: PairingCard): string[] {
  const refs: string[] = [];
  if (c.platformData.bsc?.ref) refs.push(c.platformData.bsc.ref);
  if (c.platformData.sportlots?.ref) refs.push(c.platformData.sportlots.ref);
  return refs;
}

/**
 * NEO-490 / NEO-496 — may a checklist row be linked to this card? A
 * marketplace card the server paired with no row: one with a ref and no
 * `checklistLink` of its own.
 */
function isChecklistTarget(state: State, c: PairingCard): boolean {
  if (!state.checklistRows) return false;
  return cardRefs(c).length > 0 && c.checklistLink === undefined;
}

/**
 * NEO-496 — a matched row that holds BOTH marketplace halves. Anything else
 * in the Matched list is one marketplace's card the server paired with a
 * checklist row.
 */
function isMarketplacePair(c: PairingCard): boolean {
  return !!c.platformData.bsc && !!c.platformData.sportlots;
}

/** NEO-490 — the rows linked to a card. */
function linkedRowSet(state: State): Set<number> {
  return new Set(state.checklistLinks.values());
}

/**
 * NEO-496 — the rows still listed for a decision: neither linked to a card
 * nor kept. What Keep all keeps, and what the column heading counts.
 */
function openChecklistRows(state: State): number[] {
  const linked = linkedRowSet(state);
  const kept = new Set(state.checklistKept);
  return state.checklistUnused.filter((i) => !linked.has(i) && !kept.has(i));
}

/**
 * NEO-490 — one link, applied. Returns `state` when the link is not possible
 * (unknown row or card, row already linked or kept, card not a target).
 *
 * An unmatched card is moved onto its side's keep shelf: a linked card is a
 * card the operator has said is real, so it is always saved.
 */
function linkChecklist(state: State, rowIndex: number, cardKey: string): State {
  if (!state.checklistRows) return state;
  if (!state.checklistUnused.includes(rowIndex)) return state;
  if (state.checklistKept.includes(rowIndex)) return state;
  for (const row of state.checklistLinks.values()) {
    // A row links to one card. Moving it means unlinking it first.
    if (row === rowIndex) return state;
  }
  const holders: PairingCard[] = [
    ...state.matched.map((m) => m.card),
    ...state.keptBsc,
    ...state.keptSl,
  ];
  const held = holders.find((c) => candidateKey(c) === cardKey);
  const bi = held ? -1 : state.unmatchedBsc.findIndex((c) => candidateKey(c) === cardKey);
  const si =
    held || bi !== -1
      ? -1
      : state.unmatchedSl.findIndex((c) => candidateKey(c) === cardKey);
  const card =
    held ??
    (bi !== -1 ? state.unmatchedBsc[bi] : si !== -1 ? state.unmatchedSl[si] : undefined);
  if (!card || !isChecklistTarget(state, card)) return state;
  const checklistLinks = new Map(state.checklistLinks);
  checklistLinks.set(cardKey, rowIndex);
  return {
    ...state,
    checklistLinks,
    ...(bi !== -1
      ? {
          unmatchedBsc: state.unmatchedBsc.filter((_, i) => i !== bi),
          keptBsc: [...state.keptBsc, card],
        }
      : {}),
    ...(si !== -1
      ? {
          unmatchedSl: state.unmatchedSl.filter((_, i) => i !== si),
          keptSl: [...state.keptSl, card],
        }
      : {}),
  };
}

/**
 * NEO-490 / NEO-496 — how many checklist decisions a discard would throw
 * away: every link and every kept row is the operator's own.
 */
function checklistEdits(state: State): number {
  return (
    state.checklistLinks.size + state.checklistKept.length + state.checklistServerUnlinks
  );
}

/**
 * NEO-496 — undo the server's pairing of one card with a checklist row.
 * Returns `state` when there is nothing to undo (unknown card, no pairing,
 * or a pairing stored before it carried its row and revert).
 *
 * The card gets back what it had before the row (`revertServerChecklistPair`)
 * and the row joins the checklist column as the card it would have been on
 * its own, so it can be kept, or linked to this card or another. Where the
 * card goes:
 *
 *  - a BSC + SportLots pair stays matched: the two marketplaces still pair.
 *    The players are left alone when the marketplaces disagree about them:
 *    the row never touched a roster that existed, and the operator may have
 *    picked one already.
 *  - a one-marketplace card was matched only because of the row. It moves to
 *    its side's keep shelf, still saved: an Unlink says the row is wrong, not
 *    that the card is (the shelf's Remove drops it).
 *  - a card already on a shelf or in a column stays there.
 */
function unlinkServerChecklist(state: State, cardKey: string): State {
  if (!state.checklistRows) return state;
  const rowIndex = state.checklistCards.length;
  const listRow = (card: PairingCard) => {
    if (!unlinkableServerPair(card)) return null;
    const row = card.checklistLink.row;
    return {
      checklistCards: [
        ...state.checklistCards,
        pairedRowCard(row, `${UNLINKED_ROW_ID_PREFIX}${cardKey}`),
      ],
      checklistRows: [...(state.checklistRows ?? []), pairedRowOf(row)],
      checklistUnused: [...state.checklistUnused, rowIndex],
    };
  };

  const mi = state.matched.findIndex((m) => candidateKey(m.card) === cardKey);
  if (mi !== -1) {
    const pair = state.matched[mi];
    const reverted = revertServerChecklistPair(pair.card);
    const rows = listRow(pair.card);
    if (!reverted || !rows) return state;
    if (isMarketplacePair(pair.card)) {
      const card: PairingCard = pair.playersConflict
        ? { ...reverted, ...(pair.card.players ? { players: pair.card.players } : {}) }
        : reverted;
      return {
        ...state,
        ...rows,
        matched: state.matched.map((m, i) => (i === mi ? { ...m, card } : m)),
        checklistServerUnlinks: state.checklistServerUnlinks + 1,
      };
    }
    const toBsc = !!pair.card.platformData.bsc;
    return {
      ...state,
      ...rows,
      matched: state.matched.filter((_, i) => i !== mi),
      ...(toBsc
        ? { keptBsc: [...state.keptBsc, reverted] }
        : { keptSl: [...state.keptSl, reverted] }),
    };
  }

  const lists = ["keptBsc", "keptSl", "unmatchedBsc", "unmatchedSl"] as const;
  for (const name of lists) {
    const list = state[name];
    const i = list.findIndex((c) => candidateKey(c) === cardKey);
    if (i === -1) continue;
    const reverted = revertServerChecklistPair(list[i]);
    const rows = listRow(list[i]);
    if (!reverted || !rows) return state;
    return {
      ...state,
      ...rows,
      [name]: list.map((c, j) => (j === i ? reverted : c)),
      checklistServerUnlinks: state.checklistServerUnlinks + 1,
    };
  }
  return state;
}

/** Merge a BSC-side and SL-side candidate into the single NB card they describe. */
function mergePair(bsc: PairingCard, sl: PairingCard): PairingCard {
  const attributes = Array.from(
    new Set([...(bsc.attributes ?? []), ...(sl.attributes ?? [])]),
  );
  return {
    // The NB card number follows BSC, which is the side that splits series and
    // therefore the side whose numbering the operator is reconciling against.
    cardNumber: bsc.cardNumber,
    cardName: bsc.cardName || sl.cardName,
    team: bsc.team ?? sl.team,
    teams: bsc.teams ?? sl.teams,
    // NEO-251: an EMPTY roster is an absent one. `??` only falls through on
    // null/undefined, so a BSC row carrying a literal `[]` used to beat a real
    // SportLots roster and drop it silently — with no conflict raised either,
    // because one empty side is genuinely not a disagreement. Both adapters
    // send an absent key today, so this changes nothing in practice; it is
    // here because SportLots supplies rosters now, which is what makes the
    // difference between "absent" and "empty" worth being right about.
    players: bsc.players?.length ? bsc.players : sl.players,
    attributes: attributes.length ? attributes : undefined,
    isRookie: attributes.includes("RC") || undefined,
    isRelic: attributes.includes("RELIC") || undefined,
    printRun: bsc.printRun ?? sl.printRun,
    autographType: bsc.autographType ?? sl.autographType,
    cardVariation: bsc.cardVariation ?? sl.cardVariation,
    // Either side recognising a variation makes it one. BSC suffixes the
    // number, SportLots brackets the description, and one may have catalogued
    // a variation the other has not.
    isVariation: bsc.isVariation || sl.isVariation || undefined,
    // NEO-335: the lookup is BSC's — only the BSC side ever runs one — so a
    // hand-linked pair carries the BSC card's outcome. Dropping it would fall
    // back to queueing the card for a lookup that already answered.
    ...(bsc.teamLookup ? { teamLookup: bsc.teamLookup } : {}),
    // NEO-335: and BSC's raw team value with it, from the BSC side only — it
    // is what BSC listed, and SportLots never runs that lookup.
    ...(bsc.rawTeamName ? { rawTeamName: bsc.rawTeamName } : {}),
    // NEO-478: a checklist disagreement is about the CARD, not about either
    // marketplace's half, so a hand-linked pair keeps whichever side carried
    // one. Dropping it would commit a card the operator was never asked
    // about (the commit refuses it, but only after the wizard has closed).
    ...((bsc.checklistConflict ?? sl.checklistConflict)
      ? { checklistConflict: bsc.checklistConflict ?? sl.checklistConflict }
      : {}),
    // NEO-496: the server's checklist pairing is about the card too, and
    // rides on the half that carried it (the BSC half, after an Unlink).
    ...((bsc.checklistLink ?? sl.checklistLink)
      ? { checklistLink: bsc.checklistLink ?? sl.checklistLink }
      : {}),
    platformData: {
      ...(bsc.platformData.bsc ? { bsc: bsc.platformData.bsc } : {}),
      ...(sl.platformData.sportlots
        ? { sportlots: sl.platformData.sportlots }
        : {}),
    },
  };
}

/**
 * NEO-251 — record that the operator decided something about one row, without
 * changing anything else about it.
 *
 * Only reached from the two `CHOOSE_*` cases when the side asked for is already
 * the side that is chosen. That dispatch used to be a pure no-op, and had to
 * stop being one: re-picking the checked pill is how an operator confirms BSC
 * over a stored SportLots answer, and it is the case `chosen` alone cannot see
 * (see `MatchedPair.touched`).
 *
 * Returns the SAME state object once the row is already touched, so a second
 * click on the same pill costs no render and no re-sort.
 */
function markTouched(state: State, index: number): State {
  const pair = state.matched[index];
  if (!pair || pair.touched) return state;
  return {
    ...state,
    matched: state.matched.map((m, i) =>
      i === index ? { ...m, touched: true } : m,
    ),
  };
}

function baseReducer(state: State, action: Action): State {
  switch (action.type) {
    /**
     * NEO-195 — fold newly-ready candidates into a session already in progress.
     *
     * The fetch streams, so the modal opens on the first candidates and keeps
     * receiving more. Two different things arrive on that stream and they are
     * handled differently:
     *
     *  NEW ROWS are APPENDED. Whatever the operator has already linked,
     *  unlinked or kept stays exactly as they left it. A card is new if no
     *  bucket — including the kept shelves — already holds its ref.
     *
     *  ENRICHMENT of rows already here is MERGED, field by field, and today
     *  that is exactly one field: `teams`. A checklist fetch publishes every
     *  candidate at ~6s and then spends ~74s resolving one team per card
     *  against BSC, patching them onto the streamed rows as they land. Those
     *  patches arrive long after the row itself.
     *
     * The merge is not cosmetic — the modal never displays a team. `teams` is
     * carried on `PairingCard` through `onConfirm` into
     * `resolveChecklistEntities` (which surfaces the new ones in the review
     * wizard) and `commitCardChecklist` (which resolves them to
     * `teamOnCardIds`). Append-only, this reducer dropped every team that
     * resolved after the dialog opened — which is nearly all of them — so the
     * enrichment was silently discarded and the operator was never asked to
     * confirm those teams. It went unnoticed because the background
     * `processBscTeamEnrichmentQueue` re-resolves the same cards after the
     * commit, one 300ms HTTP call at a time: the data eventually appears,
     * having been fetched twice and reviewed never.
     *
     * ONLY `teams` is merged. `cardName` in particular must not be: it is what
     * `CHOOSE_NAME` rewrites when an operator settles a name conflict, and a
     * later stream update would silently undo their choice.
     */
    case "ABSORB": {
      const seen = new Set<string>([
        ...state.matched.flatMap((m) => [
          m.card.platformData.bsc?.ref,
          m.card.platformData.sportlots?.ref,
        ]),
        ...state.unmatchedBsc.map(candidateKey),
        ...state.unmatchedSl.map(candidateKey),
        ...state.keptBsc.map(candidateKey),
        ...state.keptSl.map(candidateKey),
      ].filter(Boolean) as string[]);

      const isNew = (c: PairingCard) => {
        const bsc = c.platformData.bsc?.ref;
        const sl = c.platformData.sportlots?.ref;
        if (bsc && seen.has(bsc)) return false;
        if (sl && seen.has(sl)) return false;
        return !seen.has(candidateKey(c));
      };

      // NEO-496: a single the server paired with a checklist row is matched
      // (see `splitChecklistMatched`).
      const bscSplit = splitChecklistMatched(action.unmatchedBsc.filter(isNew));
      const slSplit = splitChecklistMatched(action.unmatchedSl.filter(isNew));
      const newMatched = [
        ...action.autoMatched.filter((m) => isNew(m.card)),
        ...bscSplit.matched,
        ...slSplit.matched,
      ];
      const newBsc = bscSplit.unmatched;
      const newSl = slSplit.unmatched;
      // NEO-496: checklist rows have no ref; a re-delivered one is known by
      // its candidate id.
      const seenRows = new Set(state.checklistCards.map(checklistRowKey));
      const newRows = action.checklistOnly.filter(
        (c) => !seenRows.has(checklistRowKey(c)),
      );

      // Every incoming row, reachable by either of its refs — a pair the
      // operator linked by hand carries both, and the enrichment that resolved
      // its team came in on the BSC side alone.
      const incomingByRef = new Map<string, PairingCard>();
      for (const c of [
        ...action.autoMatched.map((m) => m.card),
        ...action.unmatchedBsc,
        ...action.unmatchedSl,
      ]) {
        const bsc = c.platformData.bsc?.ref;
        const sl = c.platformData.sportlots?.ref;
        if (bsc) incomingByRef.set(bsc, c);
        if (sl) incomingByRef.set(sl, c);
      }

      let enriched = false;
      /** Adopt a team that resolved after this row was absorbed. Nothing else. */
      const enrich = (c: PairingCard): PairingCard => {
        if (c.teams?.length) return c;
        const bscRef = c.platformData.bsc?.ref;
        const slRef = c.platformData.sportlots?.ref;
        const fresh =
          (bscRef ? incomingByRef.get(bscRef) : undefined) ??
          (slRef ? incomingByRef.get(slRef) : undefined);
        if (!fresh?.teams?.length) return c;
        // NEO-496: the stream still carries the server's checklist pairing,
        // so a card the operator unlinked would take the row's team straight
        // back. That team is the row's, not a lookup's: never adopted.
        if (fresh.teamLookup === "checklist" && !c.checklistLink) return c;
        enriched = true;
        return { ...c, teams: fresh.teams };
      };

      const matched = state.matched.map((m) => {
        const card = enrich(m.card);
        return card === m.card ? m : { ...m, card };
      });
      const unmatchedBsc = state.unmatchedBsc.map(enrich);
      const unmatchedSl = state.unmatchedSl.map(enrich);
      const keptBsc = state.keptBsc.map(enrich);
      const keptSl = state.keptSl.map(enrich);

      const streamSettled = state.streamSettled || action.settled;

      // Nothing arrived and nothing changed — return the SAME state object so
      // the render this dispatch would otherwise cause does not happen. The
      // stream fires this on every reactive update of a 900-row batch.
      if (
        !newMatched.length &&
        !newBsc.length &&
        !newSl.length &&
        !newRows.length &&
        !enriched &&
        streamSettled === state.streamSettled
      ) {
        return state;
      }

      const checklistCards = newRows.length
        ? [...state.checklistCards, ...newRows]
        : state.checklistCards;
      const checklistInPlay =
        state.checklistRows !== null ||
        newRows.length > 0 ||
        newMatched.some((m) => m.card.checklistLink !== undefined);
      return {
        ...state,
        streamSettled,
        matched: [...matched, ...newMatched],
        unmatchedBsc: [...unmatchedBsc, ...newBsc],
        unmatchedSl: [...unmatchedSl, ...newSl],
        keptBsc,
        keptSl,
        checklistCards,
        checklistRows: checklistInPlay
          ? [...(state.checklistRows ?? []), ...newRows.map(checklistRowOf)]
          : null,
        checklistUnused: newRows.length
          ? checklistCards.map((_, i) => i)
          : state.checklistUnused,
        // NEO-220: a pair that streams in already matched is as much "the
        // server's work" as one in the seed, so unlinking it later is as much
        // an edit. Only the genuinely NEW rows are added — a pair the operator
        // has already taken apart is not `isNew` (both its refs are in `seen`),
        // so a re-delivery cannot resurrect the key it was counted by.
        seedMatchedKeys: newMatched.length
          ? new Set([
              ...state.seedMatchedKeys,
              ...newMatched.map((m) => candidateKey(m.card)),
            ])
          : state.seedMatchedKeys,
      };
    }
    case "LINK": {
      const bi = state.unmatchedBsc.findIndex(
        (c) => candidateKey(c) === action.bscKey,
      );
      const si = state.unmatchedSl.findIndex(
        (c) => candidateKey(c) === action.slKey,
      );
      if (bi === -1 || si === -1) return state;
      const bscSide = state.unmatchedBsc[bi];
      const slSide = state.unmatchedSl[si];
      // NEO-189: recorded BEFORE the merge throws one of the two names away.
      const nameConflict = nameConflictOf(bscSide, slSide);
      // NEO-251: likewise, before `mergePair` drops one of the two rosters.
      const playersConflict = playersConflictOf(bscSide, slSide);
      return {
        ...state,
        matched: [
          ...state.matched,
          {
            card: mergePair(bscSide, slSide),
            // Operator-made pairing: shown as manual rather than scored, so a
            // hand-linked row is never mistaken for a high-confidence guess.
            confidence: 0,
            ...(nameConflict ? { nameConflict } : {}),
            ...(playersConflict ? { playersConflict } : {}),
          },
        ],
        unmatchedBsc: state.unmatchedBsc.filter((_, i) => i !== bi),
        unmatchedSl: state.unmatchedSl.filter((_, i) => i !== si),
      };
    }
    case "UNLINK": {
      const pair = state.matched[action.index];
      if (!pair) return state;
      // NEO-496: a card on one marketplace and the checklist has no second
      // marketplace half to split off (the dialog offers no marketplace
      // Unlink); its checklist chip's own Unlink undoes the row instead
      // (`UNLINK_SERVER_CHECKLIST`).
      if (!isMarketplacePair(pair.card)) return state;
      // Split the merged card back into its two sides so either can be
      // re-paired or kept independently.
      const bscSide: PairingCard = {
        ...pair.card,
        // NEO-189: give each half its OWN name back. The merged row carries
        // one side's name, so spreading it onto both would stamp BSC's "Mike
        // Yastrzemski" over SportLots' "Mike Yastrzemski|Carl Yastrzemski" —
        // an unlink that does not undo the merge, and a conflict that could
        // never be detected again on a re-link because both rows now agree.
        //
        // This reads the CONFLICT, not `card.cardName`, so it is already right
        // for a row the operator renamed: a typed name belongs to the merged
        // card, not to either marketplace's row, and stamping it onto both
        // halves would destroy the disagreement the operator was correcting.
        cardName: pair.nameConflict?.bsc ?? pair.card.cardName,
        // NEO-251: and its own ROSTER back, for exactly the same reason. The
        // merged row carries one side's players, so spreading it onto both
        // halves would stamp BSC's single subject over SportLots' pair — an
        // unlink that does not undo the merge, and a disagreement that could
        // never be detected again on a re-link because both rows now agree.
        // Reads the CONFLICT, not `card.players`, so a roster the operator
        // typed stays on the merged card rather than being stamped onto two
        // marketplace rows that never claimed it.
        players: pair.playersConflict?.bsc ?? pair.card.players,
        platformData: pair.card.platformData.bsc
          ? { bsc: pair.card.platformData.bsc }
          : {},
        unmatched: "sl",
      };
      // NEO-496: the server's checklist pairing stays on the BSC half (below),
      // so the SportLots half must not keep what the row put on the card: it
      // gets the card as it was before the row, when the link says what that
      // was (a pair stored before it did keeps the old behaviour).
      const slBase =
        pair.card.checklistLink && revertServerChecklistPair(pair.card);
      const slPlayers =
        pair.playersConflict?.sportlots ?? (slBase ? slBase.players : pair.card.players);
      const slSide: PairingCard = {
        ...(slBase || pair.card),
        cardName: pair.nameConflict?.sportlots ?? pair.card.cardName,
        players: slPlayers,
        platformData: pair.card.platformData.sportlots
          ? { sportlots: pair.card.platformData.sportlots }
          : {},
        unmatched: "bsc",
      };
      if (slBase && slSide.players === undefined) delete slSide.players;
      // NEO-490: a checklist link on the pair stays on the half it is keyed
      // by — the pair's `candidateKey`, which is its BSC ref — and that half
      // is KEPT, because a linked card is always saved. The SportLots half
      // goes back to its column as before.
      // NEO-496: the server's own checklist pairing does the same: it stays
      // on the BSC half, which is kept, and leaves the SportLots half.
      const pairKey = candidateKey(pair.card);
      const hasBsc = !!pair.card.platformData.bsc;
      const hasSl = !!pair.card.platformData.sportlots;
      const linkStays =
        hasBsc &&
        ((state.checklistLinks.has(pairKey) && candidateKey(bscSide) === pairKey) ||
          pair.card.checklistLink !== undefined);
      if (pair.card.checklistLink) delete slSide.checklistLink;
      return {
        ...state,
        matched: state.matched.filter((_, i) => i !== action.index),
        unmatchedBsc:
          hasBsc && !linkStays ? [...state.unmatchedBsc, bscSide] : state.unmatchedBsc,
        keptBsc: hasBsc && linkStays ? [...state.keptBsc, bscSide] : state.keptBsc,
        unmatchedSl: hasSl ? [...state.unmatchedSl, slSide] : state.unmatchedSl,
        ...(state.checklistLinks.has(pairKey) && !linkStays
          ? {
              checklistLinks: new Map(
                [...state.checklistLinks].filter(([k]) => k !== pairKey),
              ),
            }
          : {}),
      };
    }
    /**
     * NEO-189 — the operator settles a name disagreement.
     *
     * Both names are retained on the pair either way, so this is reversible
     * right up to Confirm, and after Confirm the name is editable in
     * CardDetailPanel. Nothing here blocks Confirm: a conflict is recoverable,
     * and blocking would mean one flagged row in a streamed 660-card set holds
     * the entire commit hostage.
     */
    case "CHOOSE_NAME": {
      const pair = state.matched[action.index];
      if (!pair?.nameConflict) return state;
      // NEO-251: re-picking the side that is ALREADY chosen is still a
      // decision, and on a row whose NB value came from the other side it is
      // the whole decision. Recorded rather than dropped — see
      // `MatchedPair.touched`.
      if (pair.nameConflict.chosen === action.side) {
        return markTouched(state, action.index);
      }
      const conflict = pair.nameConflict;
      const cardName =
        action.side === "bsc"
          ? conflict.bsc
          : action.side === "sportlots"
            ? conflict.sportlots
            : conflict.custom;
      // "custom" is only selectable once the operator has typed one. Guarded
      // here rather than at the call sites so the radiogroup's invariant —
      // exactly one of the rendered options is checked — cannot be broken by a
      // dispatch for an option that is not on screen.
      if (cardName === undefined) return state;
      return {
        ...state,
        matched: state.matched.map((m, i) =>
          i === action.index
            ? {
                ...pair,
                card: { ...pair.card, cardName },
                nameConflict: { ...conflict, chosen: action.side },
                touched: true,
              }
            : m,
        ),
      };
    }
    /**
     * NEO-189 follow-up — the operator types the card's real name.
     *
     * Three outcomes, and the interesting one is the third:
     *
     *  1. On an ordinary row: `card.cardName` is rewritten and that is all.
     *  2. On a CONFLICTED row where the typed name is exactly one of the two
     *     marketplace names: this is indistinguishable from having clicked
     *     that pill, so it IS that — same `chosen`, same result. Anything else
     *     would leave the radiogroup showing the operator's copy of BSC's name
     *     checked alongside an unchecked, identical BSC pill, which is a
     *     control asking the operator to choose between two spellings of the
     *     same decision. Matched on `canonicalTypedName` (Unicode form and
     *     whitespace only) rather than `nameKey`, deliberately: `nameKey`
     *     folds accents and punctuation, so "José Ramírez" typed over BSC's
     *     "Jose Ramirez" would be swallowed as "you picked BSC" and the
     *     operator's correction silently discarded. Case and accents stay
     *     significant; a doubled space or an NFD accent does not (NEO-344:
     *     the pills are bare names, so those would read as twins). On a match
     *     the card carries the marketplace's own spelling, not the typed one.
     *  3. On a conflicted row where it matches neither: it becomes a third
     *     option in the same radiogroup, checked. See `NameConflict.custom`.
     *
     * A no-op — blank, or the name the row already carries — returns the same
     * state object, so it does not re-render or re-sort the list. That is what
     * makes "commit on blur" safe to wire up: leaving the field without typing
     * anything is genuinely nothing, not a rename to the same value.
     */
    case "RENAME": {
      const pair = state.matched[action.index];
      if (!pair) return state;
      // NEO-344: canonicalised once, here, so every comparison below and the
      // stored `custom` value are the same form — a later re-type with a
      // doubled space compares equal to what is stored.
      const cardName = canonicalTypedName(action.cardName);
      if (!cardName) return state;
      // NEO-251 security review — this name reaches `players.findOrCreate`
      // through the entity wizard, which refuses over-length names at the
      // write path. Refusing here too means the operator finds out while the
      // field is still in front of them rather than at the end of a 900-card
      // commit. Refused, never trimmed, for the reason `players.ts` gives:
      // silently storing something other than what was typed is how a mangled
      // name becomes canonical.
      if (cardName.length > MAX_PLAYER_NAME_LENGTH) return state;
      const conflict = pair.nameConflict;
      if (!conflict) {
        // Canonicalised on both sides: tabbing through the field of a card
        // whose marketplace name carries a doubled space must stay a no-op,
        // not a silent rename to the single-spaced form.
        if (cardName === canonicalTypedName(pair.card.cardName)) return state;
        return {
          ...state,
          matched: state.matched.map((m, i) =>
            i === action.index
              ? { ...pair, card: { ...pair.card, cardName }, touched: true }
              : m,
          ),
        };
      }
      const chosen: NameConflict["chosen"] =
        cardName === canonicalTypedName(conflict.bsc)
          ? "bsc"
          : cardName === canonicalTypedName(conflict.sportlots)
            ? "sportlots"
            : "custom";
      const nameConflict: NameConflict =
        chosen === "custom"
          ? { ...conflict, chosen, custom: cardName }
          : { ...conflict, chosen };
      // A typed match IS a click on that pill, so the card carries that
      // marketplace's own spelling — exactly what `CHOOSE_NAME` would set.
      const nextCardName =
        chosen === "bsc"
          ? conflict.bsc
          : chosen === "sportlots"
            ? conflict.sportlots
            : cardName;
      if (
        nextCardName === pair.card.cardName &&
        conflict.chosen === nameConflict.chosen &&
        conflict.custom === nameConflict.custom
      ) {
        return state;
      }
      return {
        ...state,
        matched: state.matched.map((m, i) =>
          i === action.index
            ? {
                ...pair,
                card: { ...pair.card, cardName: nextCardName },
                nameConflict,
                touched: true,
              }
            : m,
        ),
      };
    }
    /**
     * NEO-251 — the operator settles a roster disagreement.
     *
     * `CHOOSE_NAME`'s shape exactly, one field over, and nothing here blocks
     * Confirm for the same reason: a conflict is recoverable, and blocking
     * would let one flagged row in a streamed 660-card set hold the whole
     * commit hostage.
     */
    case "CHOOSE_PLAYERS": {
      const pair = state.matched[action.index];
      if (!pair?.playersConflict) return state;
      // Same as `CHOOSE_NAME` above: the re-pick is the decision.
      if (pair.playersConflict.chosen === action.side) {
        return markTouched(state, action.index);
      }
      const conflict = pair.playersConflict;
      const players =
        action.side === "bsc"
          ? conflict.bsc
          : action.side === "sportlots"
            ? conflict.sportlots
            : conflict.custom;
      // "custom" is only selectable once the operator has typed one — guarded
      // here rather than at the call sites, so the radiogroup's invariant
      // cannot be broken by a dispatch for an option that is not on screen.
      if (players === undefined) return state;
      return {
        ...state,
        matched: state.matched.map((m, i) =>
          i === action.index
            ? {
                ...pair,
                card: { ...pair.card, players },
                playersConflict: { ...conflict, chosen: action.side },
                touched: true,
              }
            : m,
        ),
      };
    }
    /**
     * NEO-251 — the operator types the card's real roster.
     *
     * Only meaningful on a CONFLICTED row: unlike `cardName`, the player list
     * is not shown on an ordinary row here, and the field that edits it is
     * rendered as part of the conflict control. An unconflicted row therefore
     * has no way to reach this and the reducer says so rather than inventing a
     * second roster editor.
     *
     * A blank list is a no-op returning the SAME state object, which is what
     * makes commit-on-blur safe: tabbing through the field without typing is
     * genuinely nothing, not a rewrite to the same value.
     */
    case "EDIT_PLAYERS": {
      const pair = state.matched[action.index];
      const conflict = pair?.playersConflict;
      if (!pair || !conflict) return state;
      const players = action.players
        .map((name) => name.trim())
        .filter(Boolean);
      if (players.length === 0) return state;
      // NEO-251 security review — the same two bounds the server enforces on
      // every write path, applied at the point the operator's own text becomes
      // a roster. Refused rather than trimmed: a truncated roster is a wrong
      // roster that looks right, and this list becomes `playerIds`, which the
      // listing title is generated from. Reported by LENGTH, never by echoing
      // the text back (players.ts convention).
      if (players.length > MAX_CARD_PLAYERS) return state;
      if (players.some((name) => name.length > MAX_PLAYER_NAME_LENGTH)) {
        return state;
      }
      const typed = playersKey(players);
      const chosen: PlayersConflict["chosen"] =
        typed === playersKey(conflict.bsc)
          ? "bsc"
          : typed === playersKey(conflict.sportlots)
            ? "sportlots"
            : "custom";
      const playersConflict: PlayersConflict =
        chosen === "custom"
          ? { ...conflict, chosen, custom: players }
          : { ...conflict, chosen };
      // Retyping one of the two marketplace answers means "I pick that one",
      // so the card carries THAT side's spelling rather than the operator's
      // re-keying of it — the same rule `RENAME` follows.
      const next =
        chosen === "bsc"
          ? conflict.bsc
          : chosen === "sportlots"
            ? conflict.sportlots
            : players;
      if (
        conflict.chosen === chosen &&
        playersKey(pair.card.players ?? []) === playersKey(next)
      ) {
        return state;
      }
      return {
        ...state,
        matched: state.matched.map((m, i) =>
          i === action.index
            ? {
                ...pair,
                card: { ...pair.card, players: next },
                playersConflict,
                touched: true,
              }
            : m,
        ),
      };
    }
    case "KEEP": {
      const from = action.side === "bsc" ? state.unmatchedBsc : state.unmatchedSl;
      const idx = from.findIndex((c) => candidateKey(c) === action.key);
      if (idx === -1) return state;
      const card = from[idx];
      if (action.side === "bsc") {
        return {
          ...state,
          unmatchedBsc: state.unmatchedBsc.filter((_, i) => i !== idx),
          keptBsc: [...state.keptBsc, card],
        };
      }
      return {
        ...state,
        unmatchedSl: state.unmatchedSl.filter((_, i) => i !== idx),
        keptSl: [...state.keptSl, card],
      };
    }
    case "KEEP_ALL": {
      // A set that simply is not on the other marketplace produces an entire
      // column of legitimate unmatched cards — hundreds, for a parallel set.
      // Keeping those one tap at a time is not a workflow anyone would use,
      // and without this the discard-by-default rule would quietly cost real
      // catalog data on an ordinary single-marketplace sync.
      if (action.side === "bsc") {
        if (state.unmatchedBsc.length === 0) return state;
        return {
          ...state,
          unmatchedBsc: [],
          keptBsc: [...state.keptBsc, ...state.unmatchedBsc],
        };
      }
      if (state.unmatchedSl.length === 0) return state;
      return {
        ...state,
        unmatchedSl: [],
        keptSl: [...state.keptSl, ...state.unmatchedSl],
      };
    }
    case "UNKEEP": {
      const from = action.side === "bsc" ? state.keptBsc : state.keptSl;
      const idx = from.findIndex((c) => candidateKey(c) === action.key);
      if (idx === -1) return state;
      const card = from[idx];
      // NEO-490: a card that goes back to its column is no longer saved, so
      // its checklist link goes with it and the row is listed again.
      const checklist = state.checklistLinks.has(action.key)
        ? {
            checklistLinks: new Map(
              [...state.checklistLinks].filter(([k]) => k !== action.key),
            ),
          }
        : {};
      if (action.side === "bsc") {
        return {
          ...state,
          keptBsc: state.keptBsc.filter((_, i) => i !== idx),
          unmatchedBsc: [...state.unmatchedBsc, card],
          ...checklist,
        };
      }
      return {
        ...state,
        keptSl: state.keptSl.filter((_, i) => i !== idx),
        unmatchedSl: [...state.unmatchedSl, card],
        ...checklist,
      };
    }
    case "CHECKLIST_SOURCE":
      if (state.checklistRows) return state;
      return {
        ...state,
        checklistRows: state.checklistCards.map(checklistRowOf),
      };
    case "LINK_CHECKLIST":
      return linkChecklist(state, action.rowIndex, action.cardKey);
    case "KEEP_CHECKLIST": {
      if (!openChecklistRows(state).includes(action.rowIndex)) return state;
      return { ...state, checklistKept: [...state.checklistKept, action.rowIndex] };
    }
    case "KEEP_ALL_CHECKLIST": {
      const open = openChecklistRows(state);
      if (open.length === 0) return state;
      return { ...state, checklistKept: [...state.checklistKept, ...open] };
    }
    case "UNKEEP_CHECKLIST": {
      if (!state.checklistKept.includes(action.rowIndex)) return state;
      return {
        ...state,
        checklistKept: state.checklistKept.filter((i) => i !== action.rowIndex),
      };
    }
    case "UNLINK_CHECKLIST": {
      if (!state.checklistLinks.has(action.cardKey)) return state;
      return {
        ...state,
        checklistLinks: new Map(
          [...state.checklistLinks].filter(([k]) => k !== action.cardKey),
        ),
      };
    }
    case "UNLINK_SERVER_CHECKLIST":
      return unlinkServerChecklist(state, action.cardKey);
    default:
      return state;
  }
}

/**
 * NEO-189 — a variation's NAME is part of its label, not decoration.
 *
 * Without it a set's variations are indistinguishable in this list: 2021 Topps
 * shows "#1b Fernando Tatis Jr." and "#1c Fernando Tatis Jr.", and three
 * "#13x Mookie Betts" rows, with nothing to tell them apart. An operator
 * pairing by hand has to pick the right one and cannot.
 *
 * The name is already on the card — BSC's "Sliding" / "In Dugout", SportLots'
 * bracketed equivalent — it just was not being shown. Folding it into `label`
 * rather than a badge means it reaches the aria-labels and the Maestro targets
 * too, which is where the ambiguity would bite hardest.
 */
function label(card: PairingCard): string {
  const base = `#${card.cardNumber} ${card.cardName}`.trim();
  return card.cardVariation ? `${base} · ${card.cardVariation}` : base;
}

/**
 * NEO-201 — what to call a name-conflict row out loud, when the card number
 * cannot do the job on its own.
 *
 * The conflict region and its radiogroup were named `#227c` alone. Two
 * conflicting pairs on one number therefore announced two identically-named
 * regions and two identically-named radiogroups — precisely the ambiguity
 * `label()` exists to kill in the unmatched columns, left standing in the one
 * place on this screen where the operator is being asked to make a decision.
 *
 * The obvious fix — reuse `label()` — is wrong. `label()` reads `cardName`,
 * and `cardName` is the exact thing this control CHANGES: the region would
 * rename itself under the operator the instant they picked the other name. A
 * region whose accessible name mutates while you are using it is worse than
 * one that is merely ambiguous, because a screen reader re-announces it and
 * the thing you were just in appears to have become something else.
 *
 * So the disambiguator has to be stable across the choice, which rules out
 * every name-derived candidate. What is left:
 *
 *  - `cardVariation` — stable, and the only candidate that MEANS anything
 *    ("#227 · Sliding" / "#227 · In Dugout" is how the two rows differ on the
 *    printed card). Not always available: the row that motivated this had BSC
 *    filing #227c with an empty variation description, and two rows can also
 *    share one.
 *  - an ordinal — always available, stable now that `compareCards` gives the
 *    list a total order, but says nothing about WHICH card.
 *  - the marketplace ref — unique and stable, and unusable: SportLots refs are
 *    whole card titles ("#227 Carl Yastrzemski [ VAR SSSP ]"), so it reads as
 *    machine noise and re-announces the name that is under dispute.
 *
 * Hence: prefer the variation, fall back to an ordinal. The fallback is
 * decided PER NUMBER, not per row, so a group never mixes "· Sliding" with
 * "(2 of 2)" — a half-meaningful naming scheme is harder to follow than a
 * uniformly dull one, and "#227" versus "#227 · Sliding" distinguishes the two
 * rows only by an absence, which is not something you can hear.
 *
 * A number with a single conflict on it is not ambiguous and gets NO suffix:
 * "(1 of 1)" is noise on every ordinary row, and leaving the common case
 * byte-identical is also what keeps the existing Maestro selectors valid.
 *
 * Returned keyed by `candidateKey` because that is the row's identity;
 * `state.matched` is re-sorted after every dispatch, so an index would not
 * survive the trip to the render.
 */
function conflictScopeLabels(matched: MatchedPair[]): Map<string, string> {
  const byNumber = new Map<string, MatchedPair[]>();
  for (const m of matched) {
    // NEO-251: EITHER conflict puts the row in the naming scheme. The scope is
    // a property of the ROW, not of which field is disputed — two rows on one
    // number need telling apart whichever control they are carrying, and the
    // two controls on a single row must agree about what that row is called.
    if (!m.nameConflict && !m.playersConflict) continue;
    const rows = byNumber.get(m.card.cardNumber);
    if (rows) rows.push(m);
    else byNumber.set(m.card.cardNumber, [m]);
  }

  const labels = new Map<string, string>();
  for (const [cardNumber, rows] of byNumber) {
    if (rows.length === 1) {
      labels.set(candidateKey(rows[0].card), `#${cardNumber}`);
      continue;
    }
    const variations = rows.map((m) => (m.card.cardVariation ?? "").trim());
    // Usable only if it actually separates every row in the group — an empty
    // one, or two rows sharing a description, and the whole group falls back.
    const useVariation =
      variations.every((v) => v.length > 0) &&
      new Set(variations).size === rows.length;
    rows.forEach((m, i) => {
      labels.set(
        candidateKey(m.card),
        useVariation
          ? `#${cardNumber} · ${variations[i]}`
          : `#${cardNumber} (${i + 1} of ${rows.length})`,
      );
    });
  }
  return labels;
}

/**
 * NEO-251 — ONE "the two marketplaces disagree, pick one" control.
 *
 * Extracted verbatim from the name-conflict block NEO-189 built, and then used
 * for the roster conflict too. The extraction is the point: the two controls
 * are the same decision about different fields, and a second hand-written copy
 * is how a screen ends up with two radiogroups that behave differently under
 * the arrow keys, announce themselves differently, and drift apart the first
 * time either is fixed. The name-conflict markup is byte-for-byte what it was
 * — same classes, same aria, same DOM order — because the Maestro flow and
 * roughly forty unit assertions address it by its rendered text.
 *
 * `handleAttr` is a data attribute rather than an id because the focus helper
 * re-queries this subtree AFTER a dispatch: `ordered()` re-sorts
 * `state.matched` on every action, so an index or an element ref captured
 * beforehand cannot be trusted to still mean the same row.
 *
 * Deliberately NOT parameterised: the accent. Both conflicts use the same pink
 * rail and the same ⚠. A second alert colour on one row would make the two
 * controls compete for the operator's eye and dilute what pink means on this
 * screen — the words and the accessible names are what say which decision is
 * which.
 */
type ConflictSide = "bsc" | "sportlots" | "custom";

function ConflictRadioGroup({
  handleAttr,
  handleKey,
  groupLabel,
  warningId,
  warning,
  radioGroupLabel,
  options,
  chosen,
  onChoose,
  children,
}: {
  /** e.g. `data-name-conflict` — the row handle the focus helper re-queries. */
  handleAttr: string;
  handleKey: string;
  /** Names the region: "Name conflict on #227c". */
  groupLabel: string;
  warningId: string;
  /** The sentence explaining why there is a choice at all. */
  warning: string;
  /** Names the radiogroup: "Name for #227c". */
  radioGroupLabel: string;
  options: Array<{ side: ConflictSide; label: string; ariaLabel: string }>;
  chosen: ConflictSide;
  /**
   * `viaKeyboard` exists because the two ways of choosing need different
   * follow-through: an arrow key moves focus WITH selection (the APG pattern),
   * so the caller has to re-focus the newly-checked radio after the render; a
   * click already left focus on the right element.
   */
  onChoose: (side: ConflictSide, viaKeyboard: boolean) => void;
  /** Extra controls under the pills — the roster conflict's own text field. */
  children?: React.ReactNode;
}) {
  return (
    <div
      role="group"
      // Named by the row's SCOPE, not by `label(m.card)`: see
      // `conflictScopeLabels`. The name has to hold still while the operator
      // uses the control it names.
      aria-label={groupLabel}
      // COLUMN, not a wrapping row. As `flex flex-wrap` the warning sentence
      // and the pills sat side by side when they happened to fit and dropped
      // below when they did not, so the same control was laid out differently
      // on adjacent rows purely as a function of how long the two values were
      // — the operator has to re-find the pills on every row. The sentence is
      // the explanation and the pills are the decision; they read
      // top-to-bottom, always. (The pills themselves still wrap — see the
      // radiogroup's own `flex flex-wrap` below.)
      className="flex flex-col items-start gap-1.5 border-l-2 border-neon-pink-text pl-2 py-1"
      {...{ [handleAttr]: handleKey }}
    >
      {/* The sentence is ink, not pink: these groups sit on the Matched
          row's tile, and pink text misses 4.5:1 on a dark tile (3.2:1). The
          pink rail beside it (3.2:1 there, 5.9:1 on light's white tile, past
          the 3:1 a mark needs) still says "decide this". */}
      <span id={warningId} className="text-xs text-ink">
        {/* Decorative — the sentence itself carries the meaning, so AT
            shouldn't also be made to announce "warning sign" first. */}
        <span aria-hidden="true">⚠</span> {warning}
      </span>
      {/*
        a11y (NEO-189 audit) — this is a mutually exclusive,
        always-exactly-one-chosen set, i.e. exactly the case the WAI-ARIA APG
        radio-group pattern is for, not independent aria-pressed toggles (which
        carry no guarantee, semantic or enforced, that they're mutually
        exclusive, and give a keyboard user no arrow-key way to move between
        them as a set). Kept visually as pill buttons per the design — only the
        semantics and keyboard handling changed.
      */}
      <div
        role="radiogroup"
        aria-label={radioGroupLabel}
        aria-describedby={warningId}
        className="flex flex-wrap items-center gap-2"
        onKeyDown={(e) => {
          if (
            !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
          ) {
            return;
          }
          // The APG pattern moves focus WITH selection on a single-select
          // radio group, and wraps at both ends. This used to be a toggle,
          // which was only correct while there were exactly two options — an
          // operator-typed value makes a third, and a toggle would have made
          // it unreachable by keyboard while leaving it clickable by mouse.
          // The order matches the rendered order, so "next" means the pill to
          // the right.
          e.preventDefault();
          const at = options.findIndex((o) => o.side === chosen);
          const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
          const next =
            options[(at + step + options.length) % options.length];
          onChoose(next.side, true);
        }}
      >
        {options.map((option) => (
          <button
            key={option.side}
            type="button"
            role="radio"
            aria-checked={chosen === option.side}
            // Roving tabindex: only the checked radio is a Tab stop, matching
            // native radio-group behaviour and the APG pattern.
            tabIndex={chosen === option.side ? 0 : -1}
            // The accessible name STARTS WITH the visible label so it
            // satisfies WCAG 2.5.3 Label in Name — a speech-input user saying
            // "click <value>" has to match what is actually announced.
            aria-label={option.ariaLabel}
            onClick={() => onChoose(option.side, false)}
            // The committed-selection pattern (DESIGN.md, Lists and
            // pickers): the cards columns' own blue pick plus
            // `selection-edge`. At rest a pill is `chip-strong`, the step for
            // "a tag sitting on a row tile": plain `chip` equals the Matched
            // row's own fill in dark and would vanish into it.
            className={`text-xs rounded border px-2 py-1.5 ${
              chosen === option.side
                ? "bg-pick-blue border-pick-blue-rule text-pick-blue-ink selection-edge"
                : "bg-chip-strong border-row-rule text-ink-2"
            }`}
          >
            {/* 1.4.1 Use of Color — the blue/grey fill pair differs by hue
                more than lightness, indistinguishable to a colour-blind
                operator deciding which value wins. The checkmark is the
                non-colour cue in both modes, and light adds the
                `selection-edge` line. */}
            {chosen === option.side && <span aria-hidden="true">✓ </span>}
            {option.label}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}

/**
 * NEO-195 / NEO-330 a11y — the visible streaming sentence. Static text, NOT a
 * live region: it ticks "(7 of 20 done)" on every card, and a live region
 * re-reading the whole sentence per tick drowns the operator. The coarse
 * announcements below speak for it instead. Exported for the test.
 */
export function pairingStreamingSentence(progress?: { ready: number; total: number }): string {
  const count =
    progress && progress.total > 0 ? ` (${progress.ready} of ${progress.total} done)` : "";
  return `Pair away — teams are still resolving in the background${count}. Confirm unlocks when the fetch finishes.`;
}

/** Said at each quarter of the way through: "Teams resolving — 10 of 20 done." */
export function pairingStreamProgressAnnouncement(ready: number, total: number): string {
  return `Teams resolving — ${ready} of ${total} done.`;
}

/** Said once when the stream ends with the dialog open, then cleared. */
export const PAIRING_STREAM_DONE_ANNOUNCEMENT = "Teams are in. Confirm is ready.";

/** Said instead of the done announcement when some teams missed the wait. */
export function pairingStreamLateAnnouncement(teamsLateNotice: string): string {
  return `Confirm is ready. ${teamsLateNotice}`;
}

/** NEO-490 — Confirm could not get the server's answer for the checklist links. */
export const CHECKLIST_LINKS_FAILED =
  "Whoa, your checklist links didn't stick. Nothing's saved yet — hit Confirm to try again.";

/** Where `CHECKLIST_LINKS_FAILED` shows; Confirm is described by it. */
const CHECKLIST_ERROR_ID = "pairing-checklist-error";

/** NEO-490 / NEO-496 — added under the usual subtitle when the checklist is a source. */
export const CHECKLIST_COLUMN_SUBTITLE =
  "Your checklist's in the mix too. Link a leftover row to its card, or keep it as a card of its own. Rows left in the list don't get saved.";

/** NEO-496 — the usual subtitle, when a checklist row can be kept too. */
export const CHECKLIST_SOURCES_SUBTITLE =
  "No cards save until you confirm. Anything left below gets tossed. Keep it to save it.";

/** NEO-496 — every card lined up across the sources, the checklist among them. */
export const CHECKLIST_ALL_LINED_UP =
  "Every card lines up across your sources. Review and confirm — no cards are saved until you do.";

/** NEO-490 — the checklist's own gesture, said on screen like the card one. */
export const CHECKLIST_LINK_HINT =
  "Pick a checklist row, then hit Link on its card (or drag the row onto it).";

/**
 * NEO-496 — the checklist column's heading, in the same words as
 * "BSC only (N)": the rows on the checklist alone, still waiting on a link
 * or a Keep.
 */
export function checklistColumnHeading(open: number): string {
  return `Checklist only (${open.toLocaleString("en-US")})`;
}

/** NEO-496 — the checklist column when every row found its card. */
export const CHECKLIST_ALL_FOUND = "Every checklist row found its card.";

/**
 * NEO-496 — the server's checklist pairing, as a card's chip: "On checklist"
 * for a number match, "Checklist: #FS-3" when the card paired by name and the
 * row prints another number (the card keeps its own; this is not a
 * conflict), and the % for a near-name pair, like a fuzzy BSC/SportLots link.
 */
export function serverChecklistChipText(link: NonNullable<PairingCard["checklistLink"]>): {
  label: string;
  percent: string | null;
} {
  const number = link.checklistNumber?.trim();
  return {
    label: number ? `Checklist: #${number}` : "On checklist",
    percent:
      link.confidence !== undefined && link.confidence < 1
        ? `${Math.round(link.confidence * 100)}%`
        : null,
  };
}

/**
 * N2 — a checklist chip's tooltip: the number the checklist prints for the
 * card, or (no number) that the card is on the checklist.
 */
export function checklistNumberTitle(printed: string | undefined): string {
  return printed
    ? `Your checklist prints this card as #${printed}`
    : "This card is on your checklist";
}

/**
 * Keep and Keep all, on every column: NeonButton's green outline, the same
 * button Reconcile's "Keep all" is (green: a kept card goes on to be saved).
 * 28px keeps a row one line on a desk; 44px on a phone.
 */
const KEEP_BUTTON = "min-h-[28px] shrink-0 whitespace-nowrap max-sm:min-h-11";

/**
 * The Unlink inside a checklist chip. A solid underline: the dotted one is
 * reserved for a name you can edit (the Matched rows' name choice).
 */
const CHIP_UNLINK =
  "min-h-6 rounded-r border-l border-pick-teal-rule px-1.5 font-semibold underline underline-offset-2 hover:text-ink focus-outline";

/**
 * A pick radio's own mark: a ring, filled when picked. The picked fill and
 * `selection-edge` alone are colour (and in dark the edge is clear), so the
 * mark says "picked" by shape too (WCAG 1.4.1). Drawn in the button's own
 * ink; the state itself is `aria-checked`.
 */
function RadioMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="mr-2 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-current align-middle"
    >
      {checked && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
    </span>
  );
}

/**
 * The chip, with (NEO-496) the same Unlink inside it a hand link's chip has
 * when the server's pair can be undone (`unlink`).
 */
function serverChecklistChip(
  link: NonNullable<PairingCard["checklistLink"]>,
  unlinkButton?: React.ReactNode,
) {
  const { label: text, percent } = serverChecklistChipText(link);
  return (
    <span className="inline-flex shrink-0 items-stretch rounded border border-pick-teal-rule bg-pick-teal text-xs text-pick-teal-ink">
      <span
        className="flex items-center px-1.5 py-0.5"
        title={checklistNumberTitle(link.checklistNumber?.trim() || undefined)}
      >
        {text}
      </span>
      {percent && (
        // A3: the percent alone says nothing to a screen reader; the hidden
        // words say what it measures. `relative` keeps the sr-only text
        // inside the chip.
        <span
          className="relative flex items-center border-l border-pick-teal-rule px-1.5 py-0.5 font-semibold"
          title="How close the names are"
        >
          <span className="sr-only">Name match </span>
          {percent}
        </span>
      )}
      {unlinkButton}
    </span>
  );
}

/**
 * NEO-490 a11y — what the checklist status region says. Kept as plain
 * functions so the words are one place for the dialog and its tests.
 */
export function checklistSelectedAnnouncement(rowNumber: string): string {
  return `Checklist row ${rowNumber} selected. Press Link on a card.`;
}
export const CHECKLIST_SELECTION_CLEARED = "Selection cleared.";
export function checklistLinkedAnnouncement(
  rowNumber: string,
  cardLabel: string,
  rowsLeft: number,
): string {
  const left =
    rowsLeft === 0
      ? "Every checklist row is linked or kept."
      : `${plural(rowsLeft, "row")} left to link.`;
  return `Linked checklist row ${rowNumber} to ${cardLabel}. ${left}`;
}
export const CHECKLIST_UNLINKED = "Unlinked.";
/**
 * A-N1 — said when the operator's own Unlink drops a checklist link: which
 * card it left, and that the row can be picked again.
 */
export function checklistUnlinkedAnnouncement(cardLabel: string | undefined): string {
  return cardLabel
    ? `Unlinked from ${cardLabel}. Checklist row's back on the list.`
    : `${CHECKLIST_UNLINKED} Checklist row's back on the list.`;
}

/** A-N3 — the card after `card` in `list`, else the one before; by key. */
function neighbourOf(list: readonly PairingCard[], card: PairingCard): PairingCard | undefined {
  const key = candidateKey(card);
  const at = list.findIndex((c) => candidateKey(c) === key);
  if (at < 0) return undefined;
  return list[at + 1] ?? list[at - 1];
}

/**
 * A-N4 — where an arrow, Home or End moves a roving radio group of `count`
 * radios from index `at` (-1: none focused), wrapping at both ends; null for
 * any other key.
 */
export function radioStep(key: string, at: number, count: number): number | null {
  if (count === 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown" || key === "ArrowRight") return at < 0 ? 0 : (at + 1) % count;
  if (key === "ArrowUp" || key === "ArrowLeft") {
    return at < 0 ? count - 1 : (at - 1 + count) % count;
  }
  return null;
}

/** A marketplace Unlink or Remove took a checklist link with it. */
export function checklistLinkDroppedAnnouncement(rowNumber: string): string {
  return `Checklist row ${rowNumber} unlinked too.`;
}

/** How long the done announcement stays in the region before it is cleared. */
export const PAIRING_STREAM_DONE_CLEAR_MS = 5000;

/**
 * Delay before the opening announcement, so the region (mounted with the
 * dialog) is in the accessibility tree before its text changes — text present
 * at insertion is not reliably announced.
 */
const PAIRING_STREAM_START_DELAY_MS = 150;

export default function CardPairingModal({
  isOpen,
  onClose,
  onConfirm,
  setLabel,
  initialData,
  isStreaming,
  streamSettled,
  streamProgress,
  teamsLateNotice,
  restoreFocusRef,
  waitingSlot,
  sources,
  resolveChecklistPairs,
}: {
  /**
   * NEO-496 — the sources this fetch draws cards from (`fetchCardChecklist`'s
   * `sources`, or the caller's prediction until it returns). A marketplace
   * column shows when its side is a source (or holds a card); the checklist
   * column shows when the checklist is one. Omitted: both marketplace
   * columns, and a checklist column only once checklist rows arrive.
   */
  sources?: readonly ("bsc" | "sportlots" | "checklist")[];
  /**
   * NEO-490 — asks the server what each link means for its card (teams,
   * conflicts, filled players). Called at Confirm when any link exists; the
   * dialog itself stays Convex-free.
   */
  resolveChecklistPairs?: (
    pairs: ChecklistPairRequest[],
  ) => Promise<ChecklistPairAnswer[]>;
  /**
   * NEO-487 — the host's "Waiting on BuySportsCards…" line for this fetch,
   * shown under the streaming sentence. The dialog covers the page's own
   * copy while it is open, so it carries the host's here.
   */
  waitingSlot?: React.ReactNode;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (result: PairingResult) => Promise<void>;
  /** e.g. "Dugout Collection Artist's Proofs Series 1" — for the heading. */
  setLabel?: string;
  initialData: PairingInitialData;
  /**
   * NEO-195 — the fetch is still running and more candidates are coming.
   *
   * Review may begin, but Confirm is BLOCKED while this is true: committing
   * mid-stream would save a partial checklist and silently discard every card
   * that had not arrived yet. Early review is the point; early commit is a bug.
   */
  isStreaming?: boolean;
  /**
   * NEO-341 — the parent has SEEN this fetch's whole batch with every team
   * lookup landed (`streamedBatchSettled`). Confirm stays blocked until it
   * has, even after `isStreaming` goes false: the fetch action's promise
   * resolves before the client necessarily has its last team writes, and a
   * card confirmed without its team skips the entity-review wizard.
   *
   * Omitted means "nothing to wait for" — a caller that does not stream.
   */
  streamSettled?: boolean;
  /** Progress for the streaming banner: cards released / cards found so far. */
  streamProgress?: { ready: number; total: number };
  /**
   * NEO-330 — what to say when the wait has ENDED with some teams still
   * out (`streamProgress.ready < total` once Confirm is no longer blocked —
   * `isStreaming` false and, NEO-341, `streamSettled` latched: exactly the
   * owner's "teams late" condition). The owner passes its
   * `TEAMS_LATE_NOTICE`, so the sync banner behind this modal and the line in
   * its footer say one sentence from one source. The line shows only while it
   * is true — a team that lands afterwards takes it away, the same rule the
   * owner's Confirm wrapper applies.
   */
  teamsLateNotice?: string;
  /**
   * a11y (NEO-221) — where to send keyboard focus when this dialog closes,
   * PREFERRED over this component's own `document.activeElement`-at-mount
   * capture.
   *
   * That capture is correct the FIRST time this opens (a plain click, nothing
   * unmounts in between). It is not reliable when `CardChecklist` reopens this
   * same modal via the entity wizard's "Back to matching": that click unmounts
   * the wizard (removing whatever had focus — the "Back to matching" button
   * itself) in the same state update that flips `isOpen` back to true, so by
   * the time this component's mount effect runs, the browser has already
   * blurred to `<body>` — capturing that "restores" focus to nowhere. Mirrors
   * `SyncReviewModal`'s own `restoreFocusRef` for the identical reason.
   * Optional and additive: omitting it keeps the original capture-on-mount
   * behavior for every existing caller/test.
   */
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [state, dispatch] = useReducer(
    reducer,
    { initialData, checklistSource: sources?.includes("checklist") === true },
    seedState,
  );
  const [selectedBsc, setSelectedBsc] = useState<string | null>(null);
  /** NEO-490 — the checklist row picked for the button path, by row index. */
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [checklistFilter, setChecklistFilter] = useState("");
  /** NEO-490 — the server could not answer for the links at Confirm. */
  const [checklistError, setChecklistError] = useState<string | null>(null);
  /**
   * NEO-490 a11y — Confirm is waiting on `resolveChecklistPairs`. Confirm
   * stays FOCUSABLE meanwhile (`aria-disabled`, the house pattern), so focus
   * is never dropped to <body> while the links are asked about, and a failure
   * can hand it straight back to the button the alert describes.
   */
  const [resolvingChecklist, setResolvingChecklist] = useState(false);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
  const checklistFilterRef = useRef<HTMLInputElement | null>(null);
  /**
   * NEO-490 a11y — the checklist's own always-mounted `role="status"` region.
   * Separate from `liveRegionRef` on purpose: that one is the stream's, and
   * clears its "done" line on a timer that must not eat a link announcement.
   */
  const checklistAnnouncerRef = useRef<HTMLDivElement | null>(null);
  const announceChecklist = useCallback((text: string) => {
    const el = checklistAnnouncerRef.current;
    if (!el) return;
    // The same words twice running would not be read again; a trailing
    // no-break space makes the second one a change.
    el.textContent = el.textContent === text ? `${text}\u00A0` : text;
  }, []);
  /** The card whose checklist link the operator's own Unlink is dropping. */
  const explicitUnlinkRef = useRef<string | null>(null);
  /**
   * NEO-189 follow-up — which matched row's title is open for editing, keyed
   * on `candidateKey`.
   *
   * NOT the array index, for the reason `LINK`, `KEEP` and `refocusSelectedRadio`
   * all avoid indexes: `ordered()` re-sorts `state.matched` after every
   * dispatch, and `ABSORB` inserts rows into it while the operator works. A
   * held index would silently come to mean a DIFFERENT row — so an `UNLINK`
   * or a streamed arrival elsewhere in the list would leave an open text field
   * sitting on someone else's card, which is the same class of bug as
   * number-keyed KEEP moving the wrong row to the shelf.
   *
   * A key that no longer matches any row (its row was unlinked out of
   * `matched`) simply matches nothing and no editor renders — the state is
   * self-cancelling rather than dangling.
   */
  const [editingKey, setEditingKey] = useState<string | null>(null);
  /** The in-progress text. Only meaningful while `editingKey` is set. */
  const [editDraft, setEditDraft] = useState("");
  /**
   * NEO-251 — the in-progress text of ONE roster field, keyed on
   * `candidateKey` for the same reason `editingKey` is: `ordered()` re-sorts
   * `state.matched` after every dispatch and `ABSORB` inserts rows into it, so
   * a held index would come to mean a different row and leave a half-typed
   * roster sitting on somebody else's card.
   *
   * One draft at a time rather than a map: only one field can have focus, and
   * a map would keep stale text alive for rows the operator has moved on from.
   * With no draft the field simply renders the row's current roster, so
   * `CHOOSE_PLAYERS` is reflected in it immediately.
   *
   * Unlike the title editor this field is always mounted, so Escape does not
   * unmount it and there is no removal-blur to race — hence no
   * `editSessionDoneRef` equivalent.
   */
  const [playersDraft, setPlayersDraft] = useState<{
    key: string;
    text: string;
  } | null>(null);
  /**
   * a11y (accessibility audit, NEO-251) — WCAG 3.3.1 Error Identification for
   * the two silent-refusal paths `RENAME` and `EDIT_PLAYERS` added over an
   * unbounded field: an over-length name or an over-count roster used to be
   * discarded with the input simply reverting to its old value and NOTHING
   * announced, sighted or not. These hold the message to show (and, for the
   * roster field, block the draft-clearing that was erasing what the operator
   * typed) until they correct it or move on. Keyed like `editingKey` /
   * `playersDraft` for the same reason: only one field can be in error at a
   * time, and a stale key must not paint an error on a row the operator has
   * moved off of.
   */
  const [nameError, setNameError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [playersError, setPlayersError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  /**
   * Has the OPEN edit session already been settled?
   *
   * `finishEdit` has two triggers that a real browser fires as a PAIR, not as
   * alternatives: a browser dispatches `blur` when the focused element is
   * removed from the DOM, and settling an edit removes the field. So Escape
   * produces keydown → unmount → blur, and the blur arrives at a handler that
   * commits — resurrecting the draft the operator just cancelled. Enter has
   * the same shape; it is merely harmless there because both calls commit the
   * same text.
   *
   * A ref rather than state on purpose: it has to be readable and writable
   * synchronously WITHIN one browser event sequence, before React has
   * re-rendered anything. A state flag would still be stale when the blur
   * lands, which is exactly the window this closes.
   *
   * Reset when a new edit opens, not when one closes, so the flag's meaning is
   * "this session is spoken for" rather than "no edit is open" — the stray
   * blur arrives after `editingKey` is already null, so the latter could not
   * distinguish it from anything else.
   *
   * jsdom does not model removal-blur, so this is pinned by a test that
   * dispatches the two events explicitly inside one `act()`.
   */
  const editSessionDoneRef = useRef(false);
  const [bscFilter, setBscFilter] = useState("");
  const [slFilter, setSlFilter] = useState("");
  // Collapsed by default ONLY when there is unmatched work to do — the point
  // of collapsing is to put the operator's attention on the columns below.
  // With nothing unmatched there are no columns, and a collapsed dialog shows
  // three empty sections and a "▶ Matched (220)" the operator has to expand to
  // see anything at all.
  // NEO-496: read from the seeded state, not `initialData` — a card the
  // checklist paired is in Matched, not a leftover. Leftover checklist rows
  // do not collapse it: the matched pairs are the rows' link targets.
  const [matchedCollapsed, setMatchedCollapsed] = useState(
    () => state.unmatchedBsc.length > 0 || state.unmatchedSl.length > 0,
  );
  const [confirming, setConfirming] = useState(false);
  /**
   * NEO-220 — is the "throw this session away?" confirm on screen?
   *
   * Distinct from `confirming`, which means "the commit is in flight". They are
   * mutually exclusive in practice (Cancel is not reachable mid-save) but they
   * are opposite questions, and one flag for both would make Escape during a
   * save open a discard dialog.
   */
  const [discardOpen, setDiscardOpen] = useState(false);

  // NEO-195: fold in candidates that became ready after the modal opened.
  // Append-only (see the ABSORB case), so nothing the operator has already
  // decided is disturbed.
  useEffect(() => {
    dispatch({
      type: "ABSORB",
      // Same normalisation as the seed — a conflict on a card that streamed in
      // late is no less a conflict (NEO-199).
      autoMatched: seedMatched(initialData.autoMatched),
      unmatchedBsc: initialData.unmatchedBsc,
      unmatchedSl: initialData.unmatchedSl,
      checklistOnly: initialData.checklistOnly ?? [],
      settled: streamSettled === true,
    });
  }, [initialData, streamSettled]);
  // NEO-496: the checklist column joins when the fetch says the checklist is
  // a source, which may be after the dialog opened (the caller learns it
  // from the fetch's own `sources`).
  const checklistIsSource = sources?.includes("checklist") === true;
  useEffect(() => {
    if (checklistIsSource) dispatch({ type: "CHECKLIST_SOURCE" });
  }, [checklistIsSource]);
  /**
   * NEO-195 / NEO-341 — Confirm is blocked while the fetch runs AND until the
   * reducer holds the end of its team lookups. Everything that used to read
   * `isStreaming` for the gate reads this.
   */
  const confirmBlocked =
    isStreaming === true ||
    (streamSettled !== undefined && !state.streamSettled);
  /**
   * NEO-490 a11y (S1) — say what happened to a checklist link, read off the
   * reducer's own answer rather than the click, so a refused drop says
   * nothing and a link taken away by something else is still heard:
   *
   *   added    — "Linked checklist row 17 to #SIG-ML Mike Lowell. 11 rows
   *              left to link."
   *   removed  — "Unlinked." for the row's own Unlink; "Checklist row 17
   *              unlinked too." when a marketplace Unlink or Remove took it
   */
  const prevLinksRef = useRef(state.checklistLinks);
  useEffect(() => {
    const prev = prevLinksRef.current;
    const next = state.checklistLinks;
    prevLinksRef.current = next;
    const rows = state.checklistRows;
    if (prev === next || !rows) return;
    const messages: string[] = [];
    const left = openChecklistRows(state).length;
    const cards = [
      ...state.matched.map((m) => m.card),
      ...state.keptBsc,
      ...state.keptSl,
    ];
    for (const [key, rowIndex] of next) {
      if (prev.get(key) === rowIndex) continue;
      const card = cards.find((c) => candidateKey(c) === key);
      const row = rows[rowIndex];
      if (!card || !row) continue;
      messages.push(checklistLinkedAnnouncement(row.number, label(card), left));
    }
    for (const [key, rowIndex] of prev) {
      if (next.has(key)) continue;
      if (explicitUnlinkRef.current === key) {
        explicitUnlinkRef.current = null;
        const card = cards.find((c) => candidateKey(c) === key);
        messages.push(checklistUnlinkedAnnouncement(card ? label(card) : undefined));
        continue;
      }
      const row = rows[rowIndex];
      if (row) messages.push(checklistLinkDroppedAnnouncement(row.number));
    }
    if (messages.length > 0) announceChecklist(messages.join(" "));
  }, [state, announceChecklist]);
  // Everything paired and nothing set aside: the columns and keep shelf have
  // nothing to show and only add noise. Derived from CURRENT state, not the
  // initial snapshot, so unlinking a pair brings the columns straight back.
  // NEO-496: a checklist row, listed or kept, is something to look at too.
  const nothingToReconcile =
    state.unmatchedBsc.length === 0 &&
    state.unmatchedSl.length === 0 &&
    state.keptBsc.length === 0 &&
    state.keptSl.length === 0 &&
    state.checklistCards.length === 0;
  // NEO-189: how many merged rows the marketplaces disagree about the name on.
  // Surfaced on the section header too, because the Matched list is COLLAPSED
  // by default whenever there is unmatched work — which is exactly the state
  // manual pairing happens in — and a warning inside a closed section is not a
  // warning.
  const nameConflictCount = state.matched.filter((m) => m.nameConflict).length;
  // NEO-251: counted SEPARATELY rather than folded into one "conflicts" total.
  // They are two different decisions on two different fields, and a single
  // number would tell the operator how much work there is without telling them
  // what kind — which is the half that decides whether to expand the section.
  const playersConflictCount = state.matched.filter(
    (m) => m.playersConflict,
  ).length;
  // NEO-201: how each conflict row is named to assistive tech. Derived from
  // the WHOLE matched list rather than per row, because whether a row needs a
  // disambiguator at all is a property of its number's group, not of the row.
  const conflictScopes = useMemo(
    () => conflictScopeLabels(state.matched),
    [state.matched],
  );
  const bscFieldClass = useFieldTestClass();
  const slFieldClass = useFieldTestClass();

  // A11y — the dialog asserts role="dialog" + aria-modal, so it has to behave
  // like one. Without this, Escape only worked once focus happened to be
  // inside, and a keyboard user had to Tab through the whole page behind the
  // dialog to reach it (WCAG 2.4.3 / 4.1.2).
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);
  const bscFilterRef = useRef<HTMLInputElement | null>(null);
  const slFilterRef = useRef<HTMLInputElement | null>(null);
  const matchedToggleRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    // Remember what opened us so focus can go back there on close, rather
    // than falling to <body>. Prefers the caller's durable trigger (see
    // restoreFocusRef's own doc comment) — falls back to the original
    // document.activeElement capture when the prop is absent.
    const restoreTarget = restoreFocusRef?.current;
    triggerRef.current = restoreTarget ?? (document.activeElement as HTMLElement | null);
    const id = requestAnimationFrame(() => cancelBtnRef.current?.focus());
    return () => {
      cancelAnimationFrame(id);
      triggerRef.current?.focus?.();
    };
  }, [isOpen, restoreFocusRef]);

  /**
   * Every action below removes the very <li> holding the button that was
   * clicked, so React unmounts it and focus silently falls to <body>. Move
   * focus to a stable neighbour instead — the column the item moved to or
   * from, which is where the operator's attention already is.
   */
  const refocus = useCallback((el: HTMLElement | null) => {
    requestAnimationFrame(() => el?.focus());
  }, []);

  /**
   * NEO-189/a11y — focus the now-checked radio in a conflict radiogroup, by
   * `domKey` rather than by array index.
   *
   * NEO-251 generalised it over the row HANDLE (`data-name-conflict` /
   * `data-players-conflict`) rather than hard-coding the name one: a row can
   * now carry two conflict controls, and sending an arrow key in the roster
   * group to the title group's radio would move the operator's focus to a
   * different decision than the one they were making.
   *
   * Keyed by `domKey` rather than by array index because: the
   * radiogroup's own arrow-key handler dispatches CHOOSE_NAME first, and by
   * the time this runs the DOM has to be re-queried anyway (the CHOSEN radio
   * — the one that must end up focused — only exists post-render), and
   * `state.matched` is re-sorted by `ordered()` after every dispatch, so a
   * captured index or element ref from before the dispatch cannot be trusted
   * to still point at the same row afterward.
   */
  const refocusSelectedRadio = useCallback(
    (handleAttr: string, key: string) => {
      requestAnimationFrame(() => {
        dialogRef.current
          ?.querySelector<HTMLElement>(
            `[${handleAttr}="${key}"] [role="radio"][tabindex="0"]`,
          )
          ?.focus();
      });
    },
    [],
  );

  /**
   * NEO-189 follow-up — put focus back on the title button a rename just
   * closed.
   *
   * Same shape and same reasoning as `refocusSelectedRadio`: the button the
   * operator activated to open the editor does not exist while the editor is
   * open, so there is no element ref to keep — it has to be re-queried after
   * the render that swaps the input back out. Keyed by `domKey`, which a
   * rename cannot change (it is derived from the marketplace ref), so the
   * lookup still finds the row it was called for.
   *
   * Without it, committing or cancelling an edit drops focus to <body>, which
   * for a keyboard operator part-way down a 220-row list means losing their
   * place entirely.
   */
  const refocusCardTitle = useCallback((key: string) => {
    requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>(`[data-card-title="${key}"]`)
        ?.focus();
    });
  }, []);

  /**
   * Settle the open roster edit, if it belongs to this row.
   *
   * The reducer decides whether the typed list is actually a change (see
   * `EDIT_PLAYERS`): blank, over-length and unchanged all return the same state
   * object, so committing a field the operator only tabbed through is genuinely
   * nothing rather than a rewrite to the same value. That is what makes
   * commit-on-blur safe to wire up.
   */
  const commitPlayersDraft = (index: number, key: string) => {
    if (!playersDraft || playersDraft.key !== key) return;
    const { text } = playersDraft;
    const players = splitPlayers(text);
    // a11y (accessibility audit, NEO-251) — mirror `EDIT_PLAYERS`'s own two
    // bounds BEFORE dispatching. The reducer already refuses these silently
    // (by design — see its comment), but until now this caller cleared
    // `playersDraft` unconditionally right above, so a refusal erased the
    // operator's typed roster with no error shown, sighted or not (WCAG
    // 3.3.1). On a refusal here the draft is left in place — the field keeps
    // showing exactly what was typed — and a `role="alert"` message is
    // rendered next to it (see the field's `aria-describedby` below).
    if (players.length > 0) {
      if (players.length > MAX_CARD_PLAYERS) {
        setPlayersError({
          key,
          message: `A card can carry at most ${MAX_CARD_PLAYERS} players — remove some to save.`,
        });
        return;
      }
      const overLong = players.find(
        (name) => name.length > MAX_PLAYER_NAME_LENGTH,
      );
      if (overLong) {
        setPlayersError({
          key,
          message: `Player names are limited to ${MAX_PLAYER_NAME_LENGTH} characters — shorten it to save.`,
        });
        return;
      }
    }
    setPlayersError(null);
    setPlayersDraft(null);
    dispatch({ type: "EDIT_PLAYERS", index, players });
  };

  const visibleBsc = useMemo(
    () =>
      state.unmatchedBsc.filter((c) =>
        label(c).toLowerCase().includes(bscFilter.toLowerCase()),
      ),
    [state.unmatchedBsc, bscFilter],
  );
  const visibleSl = useMemo(
    () =>
      state.unmatchedSl.filter((c) =>
        label(c).toLowerCase().includes(slFilter.toLowerCase()),
      ),
    [state.unmatchedSl, slFilter],
  );

  /**
   * Link one BSC-only card to one SportLots-only card.
   *
   * Extracted so the two ways an operator can ask for a link — click-to-select
   * then click, and drag one row onto the other — are the SAME operation
   * rather than two implementations that can drift. The conflict handling in
   * particular is not incidental: NEO-189's rule is that a link whose two
   * sides name the card differently must be visible the moment it is made, and
   * manual pairing always happens with the Matched section collapsed, so the
   * auto-expand is what makes the warning a warning. A drag path that dropped
   * it would silently reintroduce the defect that feature exists to fix.
   *
   * `slSide` is looked up rather than passed because the drag path has only a
   * key; the click path's `c` is the same object out of the same array.
   */
  const performLink = useCallback(
    (bscKey: string, slKey: string) => {
      const bscSide = state.unmatchedBsc.find(
        (x) => candidateKey(x) === bscKey,
      );
      const slSide = state.unmatchedSl.find((x) => candidateKey(x) === slKey);
      const nameConflict = !!(
        bscSide &&
        slSide &&
        nameConflictOf(bscSide, slSide)
      );
      // NEO-251: a roster disagreement is as much a reason to open the section
      // as a title one. Manual pairing always happens with Matched collapsed,
      // so the auto-expand is what makes the warning a warning — a path that
      // raised only one of the two would silently reintroduce the defect for
      // the other.
      const playersConflict = !!(
        bscSide &&
        slSide &&
        playersConflictOf(bscSide, slSide)
      );
      const createsConflict = nameConflict || playersConflict;
      // Only ever opens — never closes a section the operator deliberately
      // expanded.
      if (createsConflict) {
        setMatchedCollapsed(false);
      }
      dispatch({ type: "LINK", bscKey, slKey });
      setSelectedBsc(null);
      // a11y (NEO-189 audit) — the <li> holding the control that was just
      // activated is about to unmount: it moved from a column into matched.
      // Left alone that drops focus to <body> at the exact moment a brand-new
      // decision (which name to keep) appears for the operator to make.
      if (createsConflict && bscSide) {
        // The TITLE group when there is one: it is the first control in the
        // row and the one whose value names the card. A roster-only conflict
        // sends focus to its own group instead.
        refocusSelectedRadio(
          nameConflict ? "data-name-conflict" : "data-players-conflict",
          domKey(bscSide),
        );
      }
    },
    [state.unmatchedBsc, state.unmatchedSl, refocusSelectedRadio],
  );

  /**
   * NEO-490 — link a checklist row to a card, by button or by drop.
   *
   * The row's own <li> stays (it swaps its select button for the linked line
   * and an Unlink), so focus goes to that Unlink: the operator's next move is
   * either the next row or undoing this one.
   */
  const focusChecklistRow = useCallback((rowIndex: number) => {
    requestAnimationFrame(() => {
      const target = dialogRef.current?.querySelector<HTMLElement>(
        `[data-checklist-row="${rowIndex}"] button`,
      );
      // N5: the row can be gone (the filter hides it now). Focus must land
      // somewhere in the column rather than fall to <body>.
      (target ?? checklistFilterRef.current)?.focus();
    });
  }, []);
  /**
   * A-N2 — an Unlink puts a row back on the list; a filter that would hide
   * it is cleared first, so focus (`focusChecklistRow`) lands on the row the
   * operator just freed rather than on the filter.
   */
  const revealChecklistRow = useCallback(
    (line: string) => {
      if (checklistFilter !== "" && !line.toLowerCase().includes(checklistFilter.toLowerCase())) {
        setChecklistFilter("");
      }
    },
    [checklistFilter],
  );
  /**
   * A-N3 — after a Keep takes a row out of its column, focus the next row's
   * primary control (its Select, or the first enabled control when that one
   * is disabled), else the previous row's, else the column's filter. `rowAttr`
   * is the row handle (`data-pair-row`, `data-checklist-row`) and `neighbour`
   * its value, re-queried after the render.
   */
  /** A-N4 — focus the radio `key` names inside its group, now. */
  const focusPickRadio = useCallback((group: HTMLElement, key: string) => {
    Array.from(group.querySelectorAll<HTMLElement>("[data-pick-radio]"))
      .find((el) => el.getAttribute("data-pick-radio") === key)
      ?.focus();
  }, []);
  const focusRowAfterRemoval = useCallback(
    (rowAttr: string, neighbour: string | null, fallback: HTMLElement | null) => {
      requestAnimationFrame(() => {
        const row =
          neighbour === null
            ? undefined
            : Array.from(
                dialogRef.current?.querySelectorAll<HTMLElement>(`[${rowAttr}]`) ?? [],
              ).find((el) => el.getAttribute(rowAttr) === neighbour);
        const target =
          row?.querySelector<HTMLElement>("[data-row-primary]:not(:disabled)") ??
          row?.querySelector<HTMLElement>("button:not(:disabled)");
        (target ?? fallback)?.focus();
      });
    },
    [],
  );
  const performChecklistLink = useCallback(
    (rowIndex: number, cardKey: string) => {
      dispatch({ type: "LINK_CHECKLIST", rowIndex, cardKey });
      setSelectedRow(null);
      setChecklistError(null);
      focusChecklistRow(rowIndex);
    },
    [focusChecklistRow],
  );

  // ── Drag-and-drop linking ────────────────────────────────────────────────
  // The activation constraints are load-bearing, not cosmetic: without them a
  // stationary press on a row's inner <button> starts a drag and the button's
  // onClick never fires, which would break the click-to-select path (and the
  // Maestro flow that drives it) the moment the listeners went on.
  // Mouse and touch, not PointerSensor: a touch drag starts on a 180ms hold,
  // so a swipe still scrolls the list and a tap still clicks. PointerSensor
  // lost every touch drag to the browser's own scroll (no `touch-action`).
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
      const { active, over } = event;
      if (!over) return;
      // NEO-490: a checklist row dropped on a card links them. The reducer
      // refuses a card that is not a leftover.
      const rowIndex = parseChecklistDragId(String(active.id));
      if (rowIndex !== undefined) {
        const cardKey = checklistDropKey(String(over.id));
        if (cardKey !== undefined) performChecklistLink(rowIndex, cardKey);
        return;
      }
      const from = parseDragId(String(active.id));
      const to = parseDragId(String(over.id));
      if (!from || !to) return;
      // A row is its own drop target, and two rows in the same column are not
      // a pair — only a cross-column drop is a link.
      if (from.side === to.side) return;
      const bscKey = from.side === "bsc" ? from.key : to.key;
      const slKey = from.side === "sl" ? from.key : to.key;
      performLink(bscKey, slKey);
    },
    [performLink, performChecklistLink],
  );

  const handleDragCancel = useCallback(() => setActiveDragId(null), []);

  /** What the drag overlay shows: the dragged card's own row label. */
  const activeDragLabel = useMemo(() => {
    if (!activeDragId) return null;
    const rowIndex = parseChecklistDragId(activeDragId);
    if (rowIndex !== undefined) {
      const row = state.checklistRows?.[rowIndex];
      return row ? checklistRowLine(row) : null;
    }
    const parsed = parseDragId(activeDragId);
    if (!parsed) return null;
    const pool =
      parsed.side === "bsc" ? state.unmatchedBsc : state.unmatchedSl;
    const card = pool.find((c) => candidateKey(c) === parsed.key);
    return card ? label(card) : null;
  }, [activeDragId, state.unmatchedBsc, state.unmatchedSl, state.checklistRows]);

  const handleConfirm = useCallback(async () => {
    if (confirming) return;
    // NEO-195: never commit a partial checklist. The button is disabled while
    // streaming; this is the guard for a keyboard or programmatic path.
    // NEO-341: nor one whose last team lookups have not reached us yet.
    if (confirmBlocked) return;
    setConfirming(true);
    try {
      // Only confirmed pairs and deliberately-kept singles become NB cards.
      // Everything still sitting in an unmatched column is discarded — that
      // is what keeps a shared SL set's sibling-owned cards from being
      // invented under this row.
      // NEO-251: the disagreements, addressed by their card's index in the
      // array below. `state.matched` is emitted first, so a matched pair's
      // index IS its index in `cards` — kept singles follow and can never
      // carry a conflict.
      const conflictsByIndex: Record<number, PairingConflicts> = {};
      state.matched.forEach((m, index) => {
        if (!m.nameConflict && !m.playersConflict) return;
        // NEO-251 — a row the operator DECIDED in this session contributes
        // nothing.
        //
        // The entry exists to tell the diff "nobody has settled this, so a
        // stored value equal to the losing side is last session's answer, not
        // an upstream change". Once the operator has touched the row that
        // sentence is false, and leaving the entry in place makes the diff
        // suppress the very field they just decided — the review is skipped,
        // the commit runs with no `applyFields`, and their choice is discarded
        // without a word. Withheld rather than flagged, so the rule stays a
        // property of what is on the wire rather than of a boolean two layers
        // read differently.
        if (m.touched) return;
        conflictsByIndex[index] = {
          // The two answers only — `chosen` / `custom` / `preferred` are this
          // screen's state and mean nothing downstream.
          ...(m.nameConflict
            ? {
                nameConflict: {
                  bsc: m.nameConflict.bsc,
                  sportlots: m.nameConflict.sportlots,
                },
              }
            : {}),
          ...(m.playersConflict
            ? {
                playersConflict: {
                  bsc: m.playersConflict.bsc,
                  sportlots: m.playersConflict.sportlots,
                },
              }
            : {}),
        };
      });
      let cards: PairingCard[] = [
        ...state.matched.map((m) => m.card),
        ...state.keptBsc,
        ...state.keptSl,
      ];
      // NEO-490: the operator's checklist links. The server answers what
      // each one means for its card (the same rule its own number pairs
      // follow), and the answers fold onto the cards in place — same order,
      // so `conflictsByIndex` still addresses the right card. Rows left
      // unlinked are simply not sent: they are dropped.
      if (state.checklistRows && state.checklistLinks.size > 0) {
        const pairs = buildChecklistPairRequests(
          cards,
          state.checklistLinks,
          state.checklistRows,
          candidateKey,
        );
        if (pairs.length > 0) {
          // S4: the operator lands back on Confirm, which the alert now
          // describes, wherever they pressed it from.
          const fail = () => {
            setChecklistError(CHECKLIST_LINKS_FAILED);
            requestAnimationFrame(() => confirmBtnRef.current?.focus());
          };
          if (!resolveChecklistPairs) {
            fail();
            return;
          }
          let answers: ChecklistPairAnswer[];
          // S4: Confirm stays focusable (aria-disabled) for this wait, so
          // focus is not dropped to <body> while the server answers.
          setResolvingChecklist(true);
          try {
            answers = await resolveChecklistPairs(pairs);
          } catch {
            fail();
            return;
          } finally {
            setResolvingChecklist(false);
          }
          cards = applyChecklistAnswers(cards, answers, candidateKey);
        }
      }
      // NEO-496: the checklist rows the operator kept, as cards of their own,
      // after every marketplace card (so `conflictsByIndex` still addresses
      // the matched pairs at the front). Unkept rows are dropped. Then the
      // wire-only fields come off every card.
      cards = [
        ...cards,
        ...state.checklistKept.flatMap((i) => {
          const row = state.checklistCards[i];
          return row ? [row] : [];
        }),
      ].map(committable);
      setChecklistError(null);
      await onConfirm({ cards, conflictsByIndex });
    } finally {
      setConfirming(false);
    }
  }, [confirming, confirmBlocked, onConfirm, state, resolveChecklistPairs]);

  /**
   * NEO-220 — how much of this session a dismissal would throw away.
   *
   * Nothing on this screen is written until Confirm, so Escape and Cancel are
   * both silent discards of everything the operator has linked, kept and
   * renamed. `countPairingEdits` is pure and separately tested; see
   * `pairing-session-edits.ts` for what does and does not count.
   */
  const pendingEdits = useMemo(() => {
    // NEO-490 / NEO-496: the operator's checklist links and kept rows are
    // their work too.
    return countPairingEdits(state, candidateKey) + checklistEdits(state);
  }, [state]);

  /**
   * The single door out. Every dismissal path goes through here — root Escape
   * and the footer Cancel — so "was anything lost?" is asked in exactly one
   * place and cannot be forgotten on the next path someone adds.
   *
   * A clean session closes immediately: a confirm over nothing is a dialog that
   * teaches operators to dismiss confirms without reading them.
   */
  const requestClose = useCallback(() => {
    if (pendingEdits === 0) {
      onClose();
      return;
    }
    setDiscardOpen(true);
  }, [onClose, pendingEdits]);

  /**
   * NEO-330 a11y — the streaming announcements, written straight into an
   * always-mounted `role="status"` region (it renders no React children, so
   * nothing here fights reconciliation, and no announcement costs a render).
   *
   *   start     — the visible sentence, once, shortly after the stream is seen
   *   progress  — at each quarter (25/50/75%) of `ready / total`, never again
   *               for a quarter already said (a growing `total` can lower the
   *               fraction; it does not re-announce)
   *   done      — "Teams are in. Confirm is ready.", cleared after a few
   *               seconds so a later re-read of the region is not stale
   *
   * The visible "(X of Y done)" keeps ticking in the static sentence.
   */
  const liveRegionRef = useRef<HTMLDivElement | null>(null);
  const streamAnnounceRef = useRef<{ streaming: boolean; quarter: number }>({
    streaming: false,
    quarter: -1,
  });
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamReady = streamProgress?.ready ?? 0;
  const streamTotal = streamProgress?.total ?? 0;
  /**
   * The wait ended with teams still out — see `teamsLateNotice`. NEO-341:
   * "ended" is Confirm unblocking (`confirmBlocked`), which outlasts
   * `isStreaming` until this run's teams have landed or the owner gave up.
   */
  const teamsLate =
    !!teamsLateNotice && !confirmBlocked && streamTotal > 0 && streamReady < streamTotal;
  useEffect(() => {
    const say = (text: string, delay = 0) => {
      if (liveTimerRef.current !== null) clearTimeout(liveTimerRef.current);
      liveTimerRef.current = null;
      const write = () => {
        if (liveRegionRef.current) liveRegionRef.current.textContent = text;
      };
      if (delay > 0) liveTimerRef.current = setTimeout(write, delay);
      else write();
    };
    if (!isOpen) {
      // Closed: the region is gone. Start over on the next open.
      streamAnnounceRef.current = { streaming: false, quarter: -1 };
      return;
    }
    const seen = streamAnnounceRef.current;
    const quarter =
      streamTotal > 0 ? Math.min(3, Math.floor((streamReady / streamTotal) * 4)) : 0;
    // NEO-341 — the stream is "on" for as long as Confirm is blocked, so
    // "Confirm is ready" is said when it is, not when the fetch's promise
    // resolved with teams still on their way.
    if (confirmBlocked) {
      if (!seen.streaming) {
        streamAnnounceRef.current = { streaming: true, quarter };
        say(
          pairingStreamingSentence(
            streamTotal > 0 ? { ready: streamReady, total: streamTotal } : undefined,
          ),
          PAIRING_STREAM_START_DELAY_MS,
        );
      } else if (streamTotal > 0 && quarter > seen.quarter) {
        streamAnnounceRef.current = { streaming: true, quarter };
        say(pairingStreamProgressAnnouncement(streamReady, streamTotal));
      }
      return;
    }
    if (seen.streaming) {
      streamAnnounceRef.current = { streaming: false, quarter: -1 };
      // "Teams are in" would be false when some missed the wait: say what
      // happened instead, once, and leave the footer line to hold it.
      const done = teamsLate
        ? pairingStreamLateAnnouncement(teamsLateNotice ?? "")
        : PAIRING_STREAM_DONE_ANNOUNCEMENT;
      say(done);
      liveTimerRef.current = setTimeout(() => {
        liveTimerRef.current = null;
        if (liveRegionRef.current?.textContent === done) {
          liveRegionRef.current.textContent = "";
        }
      }, PAIRING_STREAM_DONE_CLEAR_MS);
    }
  }, [isOpen, confirmBlocked, streamReady, streamTotal, teamsLate, teamsLateNotice]);
  useEffect(
    () => () => {
      if (liveTimerRef.current !== null) clearTimeout(liveTimerRef.current);
    },
    [],
  );

  if (!isOpen) return null;

  const totalToSave =
    state.matched.length +
    state.keptBsc.length +
    state.keptSl.length +
    state.checklistKept.length;

  // ── NEO-490 / NEO-496: the publisher's checklist as a source ─────────────
  const checklistRows = state.checklistRows;
  const checklistActive = checklistRows !== null;
  /** Row index → the card it is linked to. */
  const rowToCard = new Map<number, string>();
  for (const [key, row] of state.checklistLinks) rowToCard.set(row, key);
  /** Every card on screen by key, for the Unlink control's name. */
  const cardLabels = new Map<string, string>();
  for (const c of [
    ...state.matched.map((m) => m.card),
    ...state.keptBsc,
    ...state.keptSl,
    ...state.unmatchedBsc,
    ...state.unmatchedSl,
  ]) {
    cardLabels.set(candidateKey(c), label(c));
  }
  /** NEO-496 — rows kept as cards of their own; not listed in the column. */
  const keptRowSet = new Set(state.checklistKept);
  /** Rows still waiting on a link or a Keep: the column heading's count. */
  const openRowCount = openChecklistRows(state).length;
  /** S3: how many listed rows read exactly alike, by their printed line. */
  const rowLineCounts = new Map<string, number>();
  if (checklistRows) {
    for (const i of state.checklistUnused) {
      const line = checklistRowLine(checklistRows[i]);
      rowLineCounts.set(line, (rowLineCounts.get(line) ?? 0) + 1);
    }
  }
  const checklistNeedle = checklistFilter.toLowerCase();
  const visibleRows = checklistRows
    ? state.checklistUnused.filter(
        (i) =>
          !keptRowSet.has(i) &&
          checklistRowLine(checklistRows[i]).toLowerCase().includes(checklistNeedle),
      )
    : [];
  /** S3 for a row: its printed line, with its place when another reads alike. */
  const rowName = (rowIndex: number): string => {
    const line = checklistRows ? checklistRowLine(checklistRows[rowIndex]) : "";
    return (rowLineCounts.get(line) ?? 0) > 1
      ? `${line}, row ${rowIndex + 1} of ${checklistRows?.length ?? 0}`
      : line;
  };
  /** The picked row, while it is still a row that can be linked. */
  const activeRow =
    selectedRow !== null &&
    !rowToCard.has(selectedRow) &&
    !keptRowSet.has(selectedRow) &&
    state.checklistUnused.includes(selectedRow)
      ? selectedRow
      : null;
  /**
   * A-N4 — the roving radio groups' one Tab stop each: the picked card or
   * row while it is listed, else the first one listed.
   */
  const pickableRows = visibleRows.filter((i) => !rowToCard.has(i));
  const checklistTabStop =
    activeRow !== null && pickableRows.includes(activeRow) ? activeRow : (pickableRows[0] ?? null);
  const bscTabStop =
    selectedBsc !== null && visibleBsc.some((c) => candidateKey(c) === selectedBsc)
      ? selectedBsc
      : visibleBsc[0]
        ? candidateKey(visibleBsc[0])
        : null;
  /**
   * "Checklist #1" on a linked card, with the card's own Unlink inside the
   * chip: the operator looking at the card can drop its row without hunting
   * for the row in the checklist column. Same move as the row's Unlink.
   *
   * Its name starts "Unlink card", so it never contains (or sits inside)
   * a marketplace "Unlink <card label>" or the row's "Unlink checklist row
   * … from <card label>"; specs match those by prefix and by substring.
   */
  /**
   * NEO-496 — the server's pairing as a chip. When the pair carries its row
   * and what the card was before it, the chip holds an Unlink named like a
   * hand link's ("Unlink card … from checklist row …"): the card gets its
   * own values back and the row is listed again, picked up by focus. A pair
   * stored before that data existed shows the chip alone.
   */
  const serverChip = (card: PairingCard) => {
    const link = card.checklistLink;
    if (!link) return null;
    if (!unlinkableServerPair(card)) return serverChecklistChip(link);
    const cardKey = candidateKey(card);
    // The row joins the end of the list (see `unlinkServerChecklist`).
    const rowIndex = state.checklistCards.length;
    return serverChecklistChip(
      link,
      <button
        type="button"
        className={CHIP_UNLINK}
        onClick={() => {
          dispatch({ type: "UNLINK_SERVER_CHECKLIST", cardKey });
          announceChecklist(checklistUnlinkedAnnouncement(label(card)));
          revealChecklistRow(checklistRowLine(pairedRowOf(card.checklistLink.row)));
          focusChecklistRow(rowIndex);
        }}
        aria-label={`Unlink card ${label(card)} from checklist row ${checklistRowLine(
          pairedRowOf(card.checklistLink.row),
        )}`}
      >
        Unlink
      </button>,
    );
  };
  const checklistChip = (card: PairingCard) => {
    // NEO-496: the server's own pairing reads the same way.
    if (card.checklistLink) return serverChip(card);
    const cardKey = candidateKey(card);
    const rowIndex = state.checklistLinks.get(cardKey);
    const row = rowIndex === undefined ? undefined : checklistRows?.[rowIndex];
    if (rowIndex === undefined || !row) return null;
    const cardLabel = cardLabels.get(cardKey) ?? "this card";
    return (
      <span className="inline-flex shrink-0 items-stretch rounded border border-pick-teal-rule bg-pick-teal text-xs text-pick-teal-ink">
        <span
          className="flex items-center px-1.5 py-0.5"
          title={
            row.noNumber
              ? "Your checklist prints this card with no number"
              : checklistNumberTitle(row.number)
          }
        >
          Checklist: {row.noNumber ? row.number : `#${row.number}`}
        </span>
        <button
          type="button"
          className={CHIP_UNLINK}
          onClick={() => {
            explicitUnlinkRef.current = cardKey;
            dispatch({ type: "UNLINK_CHECKLIST", cardKey });
            revealChecklistRow(checklistRowLine(row));
            focusChecklistRow(rowIndex);
          }}
          aria-label={`Unlink card ${cardLabel} from checklist row ${checklistRowLine(row)}`}
        >
          Unlink
        </button>
      </span>
    );
  };
  /** "Link" on a card a picked row may land on. */
  const checklistLinkButton = (c: PairingCard) => {
    const key = candidateKey(c);
    if (activeRow === null || state.checklistLinks.has(key)) return null;
    if (!isChecklistTarget(state, c)) return null;
    return (
      <NeonButton
        type="button"
        variant="secondary"
        outline
        size="1"
        className="shrink-0 min-h-8 min-w-11"
        onClick={() => performChecklistLink(activeRow, key)}
        aria-label={`Link selected checklist row to ${label(c)}`}
      >
        Link
      </NeonButton>
    );
  };
  // NEO-496: which columns show. A marketplace column shows when its side is
  // a source of this fetch, or when it holds a card anyway (never hide a
  // card the operator could lose); without `sources`, both show as before.
  const showAnyColumn = !nothingToReconcile;
  const showBscColumn =
    showAnyColumn &&
    (!sources ||
      sources.includes("bsc") ||
      state.unmatchedBsc.length > 0 ||
      state.keptBsc.length > 0);
  const showSlColumn =
    showAnyColumn &&
    (!sources ||
      sources.includes("sportlots") ||
      state.unmatchedSl.length > 0 ||
      state.keptSl.length > 0);
  const showChecklistColumn = showAnyColumn && checklistActive;
  // Up to three columns: BSC, SportLots, the checklist. Three stack to two at
  // tablet width and to one on a phone.
  const columnCount =
    (showBscColumn ? 1 : 0) + (showSlColumn ? 1 : 0) + (showChecklistColumn ? 1 : 0);
  const keptTotal =
    state.keptBsc.length + state.keptSl.length + state.checklistKept.length;

  return createPortal(
    <Theme>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="card-pairing-heading"
        ref={dialogRef}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // NEO-220: the discard confirm owns Escape while it is open. It is
            // a sibling in this portal, not a descendant, so a keypress inside
            // it never reaches here — this covers the case where focus is
            // somehow still behind it.
            if (discardOpen) return;
            // NEO-220 (D8): inside a text field Escape already means something
            // smaller — clear the filter, abandon the rename — and those
            // handlers stop propagation. Anything that reaches here from a
            // field is a field with no local meaning for the key, and closing
            // the whole dialog is not what the operator asked for.
            if (isEditableTarget(e.target)) return;
            // Escape during a drag CANCELS THE DRAG (dnd-kit's own document
            // listener), so it must not also close the modal — one keypress
            // that both aborts the gesture and throws away every unsaved
            // pairing is the worst possible reading of "cancel". `activeDragId`
            // is still set here whichever listener runs first: dnd-kit's cancel
            // only clears it via a React state update, which cannot land
            // mid-event.
            if (activeDragId) return;
            requestClose();
            return;
          }
          if (e.key !== "Tab") return;
          // Keep Tab inside the dialog — aria-modal="true" promises this.
          const root = dialogRef.current;
          if (!root) return;
          const focusable = root.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), [href], select, textarea, [tabindex]:not([tabindex="-1"])',
          );
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="bg-raised-deep border border-rule-strong rounded-lg shadow-offset w-full max-w-5xl max-h-[92vh] flex flex-col">
          <header className="p-4 border-b border-rule-strong">
            <h2
              id="card-pairing-heading"
              className="text-lg font-semibold text-ink"
            >
              Match Cards{setLabel ? ` — ${setLabel}` : ""}
            </h2>
            <p className="text-xs text-ink-3 mt-1">
              {nothingToReconcile
                ? checklistActive
                  ? CHECKLIST_ALL_LINED_UP
                  : "Every card paired across both marketplaces. Review and confirm — no cards are saved until you do."
                : checklistActive
                  ? CHECKLIST_SOURCES_SUBTITLE
                  : "No cards are saved until you confirm. Anything left in a column below is discarded — keep a card to save it as single-marketplace."}
            </p>
            {checklistActive && !nothingToReconcile && (
              <p className="text-xs text-ink-3 mt-1">{CHECKLIST_COLUMN_SUBTITLE}</p>
            )}
            {/* NEO-195: cards arrive as they become reviewable, so say so.
                Without this the list silently grows under the operator and a
                disabled Confirm looks broken rather than deliberate.
                NEO-330 a11y: the sentence is static (Confirm's description
                points at it); the coarse announcements go through the
                always-mounted status region beside it. NEO-341: shown for as
                long as Confirm is blocked, which outlasts the fetch itself
                until this run's teams have landed (`confirmBlocked`). */}
            {confirmBlocked && (
              <p id="pairing-streaming-status" className="text-xs text-neon-blue-text mt-1">
                {pairingStreamingSentence(streamProgress)}
              </p>
            )}
            {waitingSlot}
            <div
              ref={liveRegionRef}
              id="pairing-streaming-announcer"
              role="status"
              className="sr-only"
            />
            {/* NEO-490 (S1): the checklist's own region — see
                `announceChecklist`. Always mounted, so the first message
                is heard. */}
            <div
              ref={checklistAnnouncerRef}
              role="status"
              className="sr-only"
            />
          </header>

          {/* NEO-189 operator feedback: the collapse control stays in reach
              however long the matched list is.

              Jason: "when I scroll the matched line should lock to the
              top... that will allow somebody to quickly collapse again."
              With 220 matched rows the toggle is the only way back to the
              columns.

              It is a sibling ABOVE the scroller, not a `position: sticky`
              bar inside it. It used to be sticky, and a sticky bar paints
              over whatever row happens to be under it: at most scroll
              positions a row's own button (Edit name, Unlink) sits half
              under the bar, so the operator sees a sliver of a control they
              cannot hit until they scroll again. axe-core's target-size rule
              measures exactly that (the row's button partly covered by the
              toggle, leaving a 5px strip; NEO-343, PR #335 CI) and, worse,
              whether it fires depends on the exact scrollTop. Outside the
              scroller nothing overlaps: rows are clipped by the scroller's
              edge and never covered by a control. It also removes the two
              workarounds the sticky bar needed (the scroller's top padding
              moved into the bar, and `scroll-pt-12` so a focus-driven scroll
              did not park the linked row under the bar): the browser scrolls
              within the scroller, which now begins below the bar.

              Opaque and flush with the dialog body (`bg-gray-900`), so at
              rest it reads as the section heading it always was. */}
          <div className="flex-none px-4 pt-4 bg-raised-deep border-b border-rule-strong/60">
            <button
              type="button"
              ref={matchedToggleRef}
              className="text-sm font-semibold text-ink-2 px-2 py-1.5"
              onClick={() => setMatchedCollapsed((v) => !v)}
              // The count is appended ONLY when there is a conflict: an
              // aria-label overrides the button's own text for assistive
              // tech, so a silent label would hide the very thing the
              // visible badge exists to announce.
              // NEO-251 adds a SECOND clause rather than replacing the
              // first, and puts it BEFORE the name-conflict clause: the
              // Maestro flow addresses this label with the full-match regex
              // `Collapse matched cards, .* with a name conflict`, so the
              // name-conflict wording must stay the LAST thing in the
              // string (PR #236 run 1 failed on exactly that). A row with no
              // roster conflict still produces the string it always did.
              aria-label={
                `${matchedCollapsed ? "Expand" : "Collapse"} matched cards` +
                (playersConflictCount > 0
                  ? `, ${playersConflictCount} with a player conflict`
                  : "") +
                (nameConflictCount > 0
                  ? `, ${nameConflictCount} with a name conflict`
                  : "")
              }
            >
              {matchedCollapsed ? "▶" : "▼"} Matched ({state.matched.length})
              {nameConflictCount > 0 && (
                <span className="text-neon-pink-text ml-2">
                  {/* The glyph is decorative — "name conflict(s)" already
                      carries the meaning in words, so AT shouldn't also be
                      made to announce "warning sign" on top of that. */}
                  <span aria-hidden="true">⚠</span> {nameConflictCount} name
                  conflict
                  {nameConflictCount === 1 ? "" : "s"}
                </span>
              )}
              {/* NEO-251: its OWN line, not a second clause on the name
                  badge. The two counts are two different kinds of work, and
                  "⚠ 3 name conflicts ⚠ 2 player conflicts" run together on
                  one line reads as one number the eye has to parse apart. */}
              {playersConflictCount > 0 && (
                <span className="block text-neon-pink-text">
                  <span aria-hidden="true">⚠</span> {playersConflictCount}{" "}
                  player conflict
                  {playersConflictCount === 1 ? "" : "s"}
                </span>
              )}
            </button>
          </div>
          {/* NEO-490 (S2) — the row in hand. The checklist column comes
              last in the DOM (and, on a phone, below every card), while the
              Link buttons sit on the cards above it; without this the
              operator scrolls away from the row they picked and loses it.

              Pinned the way the Matched toggle is — a sibling ABOVE the
              scroller, not `position: sticky` inside it — so it never paints
              over a row's controls (NEO-343: a sticky bar half-covering a
              button fails axe target-size at some scroll positions). Clear
              is in the tab order and, like the row's own button, puts the
              row back down. */}
          {activeRow !== null && checklistRows?.[activeRow] && (
            <div className="flex-none flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-pick-teal-rule bg-pick-teal px-4 py-1.5 text-sm text-pick-teal-ink">
              <p className="min-w-0 flex-1">
                <span className="text-ink-2">Selected:</span>{" "}
                <span className="font-semibold">
                  {checklistRowLine(checklistRows[activeRow])}
                </span>
              </p>
              <button
                type="button"
                className="min-h-8 shrink-0 rounded px-2 py-0.5 text-xs font-semibold underline underline-offset-2 hover:text-ink focus-outline"
                onClick={() => {
                  const rowIndex = activeRow;
                  setSelectedRow(null);
                  announceChecklist(CHECKLIST_SELECTION_CLEARED);
                  focusChecklistRow(rowIndex);
                }}
                aria-label="Clear selected checklist row"
              >
                Clear
              </button>
            </div>
          )}
          <div className="flex-1 overflow-y-auto px-4 pt-2 pb-4 flex flex-col gap-4">
            {/* Matched */}
            <section>
              {!matchedCollapsed && (
                <ul className="flex flex-col gap-1">
                  {state.matched.map((m, i) => {
                    const rowKey = candidateKey(m.card);
                    // NEO-201/NEO-251: what to call this row out loud. Derived
                    // once because BOTH conflict controls have to agree about
                    // it — two regions on one row naming that row differently
                    // is worse than the ambiguity the scope exists to remove.
                    const scope =
                      conflictScopes.get(rowKey) ?? `#${m.card.cardNumber}`;
                    const editing = editingKey === rowKey;
                    /**
                     * Close the editor, optionally committing what was typed.
                     *
                     * `commit` is true for Enter and for blur, false for
                     * Escape. The reducer decides whether the typed name is
                     * actually a change (see RENAME): blank, whitespace-only
                     * and unchanged all return the same state object, so
                     * "commit" on a field the operator only tabbed through is
                     * genuinely a no-op rather than a rename to the same value.
                     *
                     * Focus goes back to the title button either way. It does
                     * not exist yet at this point — it is re-rendered by the
                     * state change on the next line — so the helper re-queries
                     * it by `domKey` after the paint.
                     */
                    const finishEdit = (commit: boolean) => {
                      // First call wins. See `editSessionDoneRef`: the browser
                      // fires a blur at the field this call is about to
                      // unmount, so without this an Escape would be followed
                      // by a commit of the very draft it cancelled.
                      if (editSessionDoneRef.current) return;
                      // a11y (NEO-251 audit) — mirror the reducer's own
                      // length bound BEFORE dispatching, so an over-length
                      // name can be reported instead of vanishing into
                      // `RENAME`'s silent no-op. Checked ahead of the
                      // `editSessionDoneRef` flip and the `setEditingKey`
                      // below: on a refusal neither runs, so the editor stays
                      // open, the typed text is untouched, and the field's own
                      // autofocus-on-render effect (below) pulls focus back in
                      // if a blur already carried it away.
                      if (commit && editDraft.trim().length > MAX_PLAYER_NAME_LENGTH) {
                        setNameError({
                          key: rowKey,
                          message: `Card names are limited to ${MAX_PLAYER_NAME_LENGTH} characters — shorten it to save.`,
                        });
                        return;
                      }
                      editSessionDoneRef.current = true;
                      setNameError(null);
                      if (commit) {
                        dispatch({
                          type: "RENAME",
                          index: i,
                          cardName: editDraft,
                        });
                      }
                      setEditingKey(null);
                      refocusCardTitle(domKey(m.card));
                    };
                    return (
                    <li
                      key={candidateKey(m.card)}
                      // A tile row, like the columns' rows. Not a control, so
                      // no hover fill. On a dark tile ink-3 and pink text
                      // miss 4.5:1, so quiet text here is ink-2, an error is
                      // notice-danger-ink, and Unlink fills pink under the
                      // pointer (DESIGN.md: Rows, chips and neutral buttons).
                      className="flex flex-col gap-1 text-sm text-ink-2 bg-row border border-row-rule rounded px-2 py-1"
                    >
                      {/* NEO-490 (S5): both levels wrap, so at 320px the
                          checklist chip drops under the title and the row's
                          controls under that, instead of crushing the title. */}
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex min-w-0 flex-wrap items-center gap-2">
                          {editing ? (
                            <>
                              {/* The number is rendered STATICALLY beside the
                                  field rather than being part of it. It is the
                                  one thing on the row that says which card is
                                  being renamed — a card and its variation share
                                  a name far more often than they share nothing —
                                  and it is not the operator's to edit: it is
                                  BSC's number, and `candidateKey`, `domKey` and
                                  `compareCards` are all derived from it. */}
                              <span className="text-ink-2 shrink-0">
                                #{m.card.cardNumber}
                              </span>
                              <Input
                                bare
                                ref={(el) => {
                                  // Autofocus with the text selected: the
                                  // common edit is replacing a wrong name
                                  // outright, not amending it, so typing
                                  // should overwrite. Done on the ref rather
                                  // than with `autoFocus` because `autoFocus`
                                  // gives no selection.
                                  if (el && document.activeElement !== el) {
                                    el.focus();
                                    el.select();
                                  }
                                }}
                                className="min-w-0 flex-1 text-sm px-1.5 py-0.5"
                                type="text"
                                value={editDraft}
                                onChange={(e) => setEditDraft(e.target.value)}
                                // Named by the row's SCOPE, not by
                                // `label(m.card)`: the name is what this
                                // control changes, and a field that renames
                                // itself as you type is re-announced mid-edit.
                                // Same reasoning as `conflictScopeLabels`.
                                //
                                // NEO-272 — the scope, not the bare card
                                // NUMBER it used to be. Product invariant 7:
                                // a card number is never unique at any scope,
                                // and on THIS screen that is not an edge case
                                // but the premise — a card and its variations
                                // share one number, which is the whole reason
                                // the operator is here pairing them by hand.
                                // `conflictScopeLabels` already computes the
                                // stable disambiguator, and both of its forms
                                // (`· <variation>`, or an ordinal when no
                                // variation separates the group) sit beside
                                // THIS field on THIS row: the number is the
                                // static span to the left, the variation the
                                // static span to the right. So the field now
                                // names itself with what the operator can
                                // actually see, and nothing name-derived —
                                // which is what SC 2.5.3 asks for and what
                                // keeps the label still mid-edit.
                                //
                                // DEGRADATION: `scope` falls back to
                                // `#<number>` for a number carrying a single
                                // conflict and for every row carrying none at
                                // all, so the ordinary row's label is
                                // byte-identical to what it has always been —
                                // no trailing separator, nothing appended.
                                //
                                // "EDIT name for", not "Name for": the
                                // radiogroup below is already `Name for
                                // <scope>` — now the very same scope — so the
                                // obvious label would put two differently-roled
                                // controls with one accessible name on the
                                // same row, which is the ambiguity
                                // `conflictScopeLabels` exists to remove. It
                                // would also make the Maestro selector
                                // `id: "Name for #FS-1"` (already used
                                // against the radiogroup in
                                // checklist-pairing-dialog-cancel.yaml) match
                                // two elements.
                                aria-label={`Edit name for ${scope}`}
                                aria-invalid={
                                  nameError?.key === rowKey || undefined
                                }
                                aria-describedby={
                                  nameError?.key === rowKey
                                    ? `name-edit-error-${domKey(m.card)}`
                                    : undefined
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    finishEdit(true);
                                    return;
                                  }
                                  if (e.key === "Escape") {
                                    // MUST stop here. The dialog root's own
                                    // onKeyDown closes the whole modal on
                                    // Escape, so without this, abandoning a
                                    // rename would throw away every pairing
                                    // decision on the screen.
                                    e.stopPropagation();
                                    finishEdit(false);
                                  }
                                  // Everything else — arrows included — is
                                  // left alone. The radiogroup's arrow handler
                                  // is on a sibling subtree, not an ancestor
                                  // of this field, so it never sees these
                                  // keys; the dialog's Tab trap is the only
                                  // other handler above us and Tab out of a
                                  // field is exactly what it should do.
                                }}
                                onBlur={() => finishEdit(true)}
                              />
                              {m.card.cardVariation && (
                                <span className="text-ink-2 shrink-0">
                                  · {m.card.cardVariation}
                                </span>
                              )}
                              {nameError?.key === rowKey && (
                                // role="alert" — an assertive live region that
                                // announces itself the instant it mounts, which
                                // is when a refusal happens (see `finishEdit`).
                                // A `<p aria-describedby>` alone would only be
                                // heard if the field were re-focused, and the
                                // field never lost the DOM in this path.
                                <span
                                  id={`name-edit-error-${domKey(m.card)}`}
                                  role="alert"
                                  className="text-xs text-notice-danger-ink"
                                >
                                  {nameError.message}
                                </span>
                              )}
                            </>
                          ) : (
                            <button
                              type="button"
                              // Re-queried by `refocusCardTitle` after the
                              // editor closes; keyed like `data-name-conflict`
                              // and for the same reason.
                              data-card-title={domKey(m.card)}
                              // inline-block + min-h-6: the text-sm line alone
                              // is a ~20px target; SC 2.5.8 needs 24px (axe
                              // target-size).
                              className="inline-block min-h-6 text-left border-b border-dotted border-control hover:border-neon-blue-text hover:text-ink"
                              onClick={() => {
                                // Prefilled with `cardName` ALONE — not
                                // `label()`. The number and the variation
                                // description are separate fields on the card;
                                // a field prefilled with "#461 Noah Cameron"
                                // invites an operator to retype the number into
                                // the name, and the commit would take it.
                                setEditDraft(m.card.cardName);
                                setEditingKey(rowKey);
                                setNameError(null);
                                // A fresh session is unsettled, whatever the
                                // last one did.
                                editSessionDoneRef.current = false;
                              }}
                              aria-label={`Edit name for ${label(m.card)}`}
                            >
                              {label(m.card)}
                            </button>
                          )}
                          {m.confidence > 0 && m.confidence < 1 && (
                            <span className="text-xs text-notice-warn-ink shrink-0">
                              {Math.round(m.confidence * 100)}%
                            </span>
                          )}
                          {checklistChip(m.card)}
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          {checklistLinkButton(m.card)}
                          {/* NEO-496: a card on one marketplace and the
                              checklist has no marketplace half to split off. */}
                          {isMarketplacePair(m.card) && (
                          <button
                            type="button"
                            className="rounded text-xs text-ink-2 underline underline-offset-2 hover:bg-neon-pink hover:text-on-neon-pink hover:no-underline px-2 py-1.5 focus-outline"
                            onClick={() => {
                              dispatch({ type: "UNLINK", index: i });
                              refocus(matchedToggleRef.current);
                            }}
                            aria-label={`Unlink ${label(m.card)}`}
                          >
                            Unlink
                          </button>
                          )}
                        </span>
                      </div>
                      {/* NEO-189: the marketplaces name this card differently.
                          Show BOTH, say which one is currently winning, and
                          let the operator switch — the ambiguity is reported,
                          never resolved by heuristic.

                          NEO-344 (Jason, 2026-10-13): the pills, their
                          accessible names and the warning say only WHAT each
                          value is, never which marketplace it came from. "The
                          name in NB should come from the user when there is a
                          conflict and I don't want the user swayed by what
                          marketplace the data comes from." The `side` keys,
                          the BSC default and the reducer are unchanged; this
                          is display only. Each option still has a distinct
                          name because the values differ as strings by construction:
                          `conflictingNames` only reports differing names, and
                          `custom` exists only when it matches neither. */}
                      {m.nameConflict && (
                        <ConflictRadioGroup
                          handleAttr="data-name-conflict"
                          handleKey={domKey(m.card)}
                          groupLabel={`Name conflict on ${scope}`}
                          warningId={`name-conflict-warning-${domKey(m.card)}`}
                          warning="Potential names for this card — pick the right one before it is listed."
                          radioGroupLabel={`Name for ${scope}`}
                          chosen={m.nameConflict.chosen}
                          // NEO-272 — each pill's "which card is this
                          // for" qualifier is the row's SCOPE, the same
                          // one naming the group and the radiogroup
                          // above it, and not the bare card number it
                          // used to be. A number carrying two conflicts
                          // is precisely the shape `conflictScopeLabels`
                          // exists for, and the marketplaces routinely
                          // file one name across a card and its
                          // variation — so on that row the two BSC pills
                          // announced one identical sentence, leaving
                          // the operator no way to hear which card
                          // either would rename. The scope is also the
                          // only qualifier that can go here: everything
                          // name-derived is the value under dispute.
                          // Unchanged on an unambiguous number, where
                          // the scope IS `#<number>`.
                          options={[
                            {
                              side: "bsc",
                              label: m.nameConflict.bsc,
                              ariaLabel: `${m.nameConflict.bsc} — use this name for ${scope}`,
                            },
                            {
                              side: "sportlots",
                              label: m.nameConflict.sportlots,
                              ariaLabel: `${m.nameConflict.sportlots} — use this name for ${scope}`,
                            },
                            // The operator's own name, once they have typed one
                            // that is neither marketplace's. Present on the SAME
                            // `custom !== undefined` condition the reducer
                            // guards `CHOOSE_NAME side:"custom"` and the
                            // arrow-key cycle on, so "every option in the group
                            // is reachable and exactly one is checked" holds by
                            // construction rather than by three places agreeing.
                            ...(m.nameConflict.custom !== undefined
                              ? [
                                  {
                                    side: "custom" as const,
                                    label: m.nameConflict.custom,
                                    ariaLabel: `${m.nameConflict.custom} — use this name for ${scope}`,
                                  },
                                ]
                              : []),
                          ]}
                          onChoose={(side, viaKeyboard) => {
                            dispatch({ type: "CHOOSE_NAME", index: i, side });
                            if (viaKeyboard) {
                              refocusSelectedRadio(
                                "data-name-conflict",
                                domKey(m.card),
                              );
                            }
                          }}
                        />
                      )}
                      {/* NEO-251: and the same for WHO IS ON the card. A
                          separate control because it is a separate decision —
                          the two marketplaces can agree about the title and
                          disagree about the roster, and the roster is what
                          becomes `playerIds` and therefore what a buyer is
                          shown. */}
                      {m.playersConflict && (
                        <ConflictRadioGroup
                          handleAttr="data-players-conflict"
                          handleKey={domKey(m.card)}
                          groupLabel={`Players conflict on ${scope}`}
                          warningId={`players-conflict-warning-${domKey(m.card)}`}
                          warning="Potential players for this card — pick the right ones before it is listed."
                          radioGroupLabel={`Players for ${scope}`}
                          chosen={m.playersConflict.chosen}
                          // Scoped exactly like the name pills above,
                          // and for the same NEO-272 reason — the two
                          // controls on one row have to agree about what
                          // that row is called, or the agreement
                          // `conflictScopeLabels` bought is spent again
                          // one level down.
                          options={[
                            {
                              side: "bsc",
                              label: joinPlayers(m.playersConflict.bsc),
                              ariaLabel: `${joinPlayers(m.playersConflict.bsc)} — use these players for ${scope}`,
                            },
                            {
                              side: "sportlots",
                              label: joinPlayers(m.playersConflict.sportlots),
                              ariaLabel: `${joinPlayers(m.playersConflict.sportlots)} — use these players for ${scope}`,
                            },
                            ...(m.playersConflict.custom !== undefined
                              ? [
                                  {
                                    side: "custom" as const,
                                    label: joinPlayers(m.playersConflict.custom),
                                    ariaLabel: `${joinPlayers(m.playersConflict.custom)} — use these players for ${scope}`,
                                  },
                                ]
                              : []),
                          ]}
                          onChoose={(side, viaKeyboard) => {
                            dispatch({ type: "CHOOSE_PLAYERS", index: i, side });
                            if (viaKeyboard) {
                              refocusSelectedRadio(
                                "data-players-conflict",
                                domKey(m.card),
                              );
                            }
                          }}
                        >
                          {/* NEO-251 — what NeonBinder ALREADY stores for this
                              card, when that is one of the two answers on
                              offer.

                              It is evidence, not a decision: the operator
                              settled this same disagreement on an earlier sync
                              and the NB row still carries their answer. Shown
                              rather than applied, and in gray rather than pink,
                              because pre-checking a radio from it would make an
                              untouched row read as reviewed — and because NB
                              owning the answer is exactly what stops a
                              marketplace becoming the source of truth. */}
                          {m.playersConflict.preferred && (
                            <span className="text-xs text-ink-2">
                              NeonBinder currently stores:{" "}
                              {joinPlayers(
                                m.playersConflict.preferred === "sportlots"
                                  ? m.playersConflict.sportlots
                                  : m.playersConflict.bsc,
                              )}
                            </span>
                          )}
                          {/* The operator's own roster. Rendered inline rather
                              than behind a click-to-edit affordance like the
                              title's: the card's players are not otherwise on
                              this row, so there is nothing to click, and a
                              roster the operator can see is half of what makes
                              the choice above answerable. */}
                          <Input
                            bare
                            // a11y/correctness (audit, NEO-251) — this field
                            // holds a `|`-joined LIST of names, and
                            // `MAX_PLAYER_NAME_LENGTH` bounds a single one. A
                            // native `maxLength` here capped the whole joined
                            // string at one name's limit, which silently
                            // truncated (no message, nothing announced) any
                            // roster of a few ordinarily-named players well
                            // before it hit the per-name or per-count bound
                            // the reducer actually enforces below — making
                            // `EDIT_PLAYERS`'s own over-length message
                            // unreachable by typing. The real bounds are
                            // reported, with a message, by `commitPlayersDraft`
                            // instead.
                            className="w-full min-w-0 text-xs px-1.5 py-0.5"
                            type="text"
                            // a11y (audit, NEO-251) — WCAG 3.3.2: the field
                            // carries no visible label at all, only the
                            // `aria-label` below, so a sighted operator who
                            // has not opened a screen reader has nothing
                            // telling them what to type or how to separate
                            // names. The placeholder repeats the
                            // `aria-label`'s own instruction rather than
                            // inventing new wording.
                            placeholder="Name | Name | Name"
                            ref={(el) => {
                              // Refocus after a refusal: `commitPlayersDraft`
                              // runs on blur too (tabbing away), by which
                              // point the browser has already moved focus
                              // elsewhere. Re-pulling it back — same trick the
                              // name editor's ref uses above — means the error
                              // message just rendered is announced from a
                              // field the operator can immediately correct,
                              // not one they have already left.
                              if (
                                el &&
                                playersError?.key === rowKey &&
                                document.activeElement !== el
                              ) {
                                el.focus();
                              }
                            }}
                            value={
                              playersDraft?.key === rowKey
                                ? playersDraft.text
                                : joinCustomPlayers(m.card.players ?? [])
                            }
                            onChange={(e) => {
                              setPlayersDraft({
                                key: rowKey,
                                text: e.target.value,
                              });
                              if (playersError?.key === rowKey) {
                                setPlayersError(null);
                              }
                            }}
                            // Named by the row's SCOPE and distinguished from
                            // the radiogroup above it, which is `Players for
                            // <scope>`: two differently-roled controls sharing
                            // one accessible name on one row is the ambiguity
                            // `conflictScopeLabels` exists to remove. The
                            // parenthetical is also where the separator is
                            // stated, since nothing else on screen says it.
                            aria-label={`Players for ${scope} (separate names with |)`}
                            aria-invalid={
                              playersError?.key === rowKey || undefined
                            }
                            aria-describedby={
                              playersError?.key === rowKey
                                ? `players-edit-error-${domKey(m.card)}`
                                : undefined
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                commitPlayersDraft(i, rowKey);
                                return;
                              }
                              if (e.key === "Escape") {
                                // MUST stop here — the dialog root's own
                                // Escape handler would otherwise throw away
                                // every pairing decision on the screen.
                                e.stopPropagation();
                                setPlayersDraft(null);
                                setPlayersError(null);
                              }
                            }}
                            onBlur={() => commitPlayersDraft(i, rowKey)}
                          />
                          {playersError?.key === rowKey && (
                            // role="alert" for the same reason as the name
                            // editor's: this mounts at the instant of refusal,
                            // so it needs to announce itself rather than wait
                            // to be discovered.
                            <span
                              id={`players-edit-error-${domKey(m.card)}`}
                              role="alert"
                              className="text-xs text-notice-danger-ink"
                            >
                              {playersError.message}
                            </span>
                          )}
                        </ConflictRadioGroup>
                      )}
                    </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* Unmatched columns — omitted entirely when both are empty.
                Two headers reading "(0)" over two dead filter inputs is not
                information; it just buries the matched list the operator
                actually came to review. */}
            {showAnyColumn && (
            <DndContext
              sensors={sensors}
              // NEO-300 — not bare `pointerWithin`, which finds nothing for a
              // drag with no pointer; shared with the set builder's other
              // drag-and-drop dialogs.
              collisionDetection={keyboardAwareCollision}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              {/* The affordance has to be SAID. Operator feedback on NEO-189:
                  a row that highlights on click, with nothing on screen naming
                  the gesture, is not discoverable — and the app's other
                  two-column pairing screens are drag-and-drop, so the missing
                  instruction was also the surprising one. Placed ABOVE the
                  columns rather than under them: below the lists it is past
                  the fold on any set with real unmatched counts, which is
                  every set where it matters.

                  Shown whenever either column has a card, not only when both
                  do. One lonely unmatched card is exactly when an operator is
                  most likely to be stuck, and the sentence still describes the
                  screen — the columns are what "the other column" means. */}
              {showBscColumn && showSlColumn &&
                (state.unmatchedBsc.length > 0 ||
                state.unmatchedSl.length > 0) && (
                <p className="text-xs text-ink-3 mb-2">
                  Drag a card onto its match in the other column to link them
                  (or click one, then click its match).
                </p>
              )}
              {/* NEO-490: the checklist's own gesture, said on screen like
                  the card one above it. The button path is the keyboard
                  path; drops land on a card in a column (the Matched list
                  and the keep shelf take the Link button). */}
              {showChecklistColumn && openRowCount > 0 && (
                <p className="text-xs text-ink-3 mb-2">{CHECKLIST_LINK_HINT}</p>
              )}
              <div
                className={
                  columnCount >= 3
                    ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
                    : columnCount === 2
                      ? "grid grid-cols-1 md:grid-cols-2 gap-4"
                      : "grid grid-cols-1 gap-4"
                }
              >
              {showBscColumn && (
              <section>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-ink-2">
                    BSC only ({state.unmatchedBsc.length})
                  </h3>
                  <NeonButton
                    type="button"
                    variant="primary"
                    outline
                    size="1"
                    className={KEEP_BUTTON}
                    disabled={state.unmatchedBsc.length === 0}
                    onClick={() => {
                      dispatch({ type: "KEEP_ALL", side: "bsc" });
                      refocus(bscFilterRef.current);
                    }}
                    aria-label="Keep all BSC-only cards"
                  >
                    Keep all
                  </NeonButton>
                </div>
                <Input
                  bare
                  ref={bscFilterRef}
                  className={`${bscFieldClass()} w-full px-3 py-1.5 text-base sm:text-sm`}
                  type="text"
                  value={bscFilter}
                  onChange={(e) => setBscFilter(e.target.value)}
                  // NEO-220 (D8): Escape in a filter clears the filter. It is
                  // the reflex every other search box on the web has trained,
                  // and letting it reach the dialog root instead means the
                  // operator loses the session to a keystroke they meant as
                  // "undo my typing".
                  onKeyDown={(e) => {
                    if (e.key !== "Escape") return;
                    e.preventDefault();
                    e.stopPropagation();
                    setBscFilter("");
                  }}
                  placeholder="Filter BSC cards"
                  aria-label="Filter BSC cards"
                />
                {/* A-N4: picking a BSC card is one-of-N, so the picks are
                    a roving radio group (one Tab stop; arrows, Home and End
                    move the pick), like the Matched rows' name choice. A
                    click on the picked card still drops the pick. */}
                <div
                  role="radiogroup"
                  aria-label="Pick a BSC card to link"
                  onKeyDown={(e) => {
                    const target = e.target as HTMLElement;
                    if (target.getAttribute("role") !== "radio") return;
                    const keys = visibleBsc.map(candidateKey);
                    const next = radioStep(
                      e.key,
                      keys.indexOf(target.getAttribute("data-pick-radio") ?? ""),
                      keys.length,
                    );
                    if (next === null) return;
                    e.preventDefault();
                    setSelectedBsc(keys[next]);
                    focusPickRadio(e.currentTarget, keys[next]);
                  }}
                >
                <ul className="flex flex-col gap-1 mt-2">
                  {visibleBsc.map((c) => (
                    <PairableRow
                      key={candidateKey(c)}
                      side="bsc"
                      cardKey={candidateKey(c)}
                      acceptsChecklist={isChecklistTarget(state, c)}
                    >
                      <button
                        type="button"
                        role="radio"
                        data-pick-radio={candidateKey(c)}
                        data-row-primary=""
                        tabIndex={bscTabStop === candidateKey(c) ? 0 : -1}
                        className={`flex-1 text-left text-sm rounded border px-2 py-1 focus-outline ${
                          selectedBsc === candidateKey(c)
                            ? "bg-pick-blue border-pick-blue-rule text-pick-blue-ink selection-edge"
                            : "bg-row border-row-rule text-ink-2 hover:bg-row-hover"
                        }`}
                        onClick={() =>
                          setSelectedBsc(
                            selectedBsc === candidateKey(c) ? null : candidateKey(c),
                          )
                        }
                        // Selection was conveyed by background colour alone.
                        aria-checked={selectedBsc === candidateKey(c)}
                        aria-label={
                          selectedBsc === candidateKey(c)
                            ? `${label(c)}, selected. Press to deselect.`
                            : `Select BSC card ${label(c)}`
                        }
                      >
                        <RadioMark checked={selectedBsc === candidateKey(c)} />
                        {label(c)}
                      </button>
                      {serverChip(c)}
                      {checklistLinkButton(c)}
                      <NeonButton
                        type="button"
                        variant="primary"
                        outline
                        size="1"
                        className={KEEP_BUTTON}
                        onClick={() => {
                          const neighbour = neighbourOf(visibleBsc, c);
                          dispatch({
                            type: "KEEP",
                            side: "bsc",
                            key: candidateKey(c),
                          });
                          // A-N3: on to the next card, not back to the top.
                          focusRowAfterRemoval(
                            "data-pair-row",
                            neighbour ? `bsc:${candidateKey(neighbour)}` : null,
                            bscFilterRef.current,
                          );
                        }}
                        aria-label={`Keep ${label(c)} as BSC-only`}
                      >
                        Keep
                      </NeonButton>
                    </PairableRow>
                  ))}
                </ul>
                </div>
              </section>
              )}

              {showSlColumn && (
              <section>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-ink-2">
                    SportLots only ({state.unmatchedSl.length})
                  </h3>
                  <NeonButton
                    type="button"
                    variant="primary"
                    outline
                    size="1"
                    className={KEEP_BUTTON}
                    disabled={state.unmatchedSl.length === 0}
                    onClick={() => {
                      dispatch({ type: "KEEP_ALL", side: "sl" });
                      refocus(slFilterRef.current);
                    }}
                    aria-label="Keep all SportLots-only cards"
                  >
                    Keep all
                  </NeonButton>
                </div>
                <Input
                  bare
                  ref={slFilterRef}
                  className={`${slFieldClass()} w-full px-3 py-1.5 text-base sm:text-sm`}
                  type="text"
                  value={slFilter}
                  onChange={(e) => setSlFilter(e.target.value)}
                  // Same as the BSC filter above (NEO-220 D8).
                  onKeyDown={(e) => {
                    if (e.key !== "Escape") return;
                    e.preventDefault();
                    e.stopPropagation();
                    setSlFilter("");
                  }}
                  placeholder="Filter SportLots cards"
                  aria-label="Filter SportLots cards"
                />
                <ul className="flex flex-col gap-1 mt-2">
                  {visibleSl.map((c) => (
                    <PairableRow
                      key={candidateKey(c)}
                      side="sl"
                      cardKey={candidateKey(c)}
                      acceptsChecklist={isChecklistTarget(state, c)}
                    >
                      <button
                        type="button"
                        disabled={!selectedBsc}
                        data-row-primary=""
                        className="flex-1 text-left text-sm rounded border border-row-rule px-2 py-1 bg-row text-ink-2 enabled:hover:bg-row-hover disabled:opacity-60 focus-outline"
                        onClick={() => {
                          if (!selectedBsc) return;
                          // Same operation the drag path performs — including
                          // NEO-189's auto-expand of the Matched section when
                          // the link creates a name disagreement. See
                          // `performLink`.
                          performLink(selectedBsc, candidateKey(c));
                        }}
                        aria-label={`Link selected BSC card to ${label(c)}`}
                      >
                        {label(c)}
                      </button>
                      {serverChip(c)}
                      {checklistLinkButton(c)}
                      <NeonButton
                        type="button"
                        variant="primary"
                        outline
                        size="1"
                        className={KEEP_BUTTON}
                        onClick={() => {
                          const neighbour = neighbourOf(visibleSl, c);
                          dispatch({
                            type: "KEEP",
                            side: "sl",
                            key: candidateKey(c),
                          });
                          // A-N3: the next card's Link, or its Keep while no
                          // BSC card is picked (Link is disabled then).
                          focusRowAfterRemoval(
                            "data-pair-row",
                            neighbour ? `sl:${candidateKey(neighbour)}` : null,
                            slFilterRef.current,
                          );
                        }}
                        aria-label={`Keep ${label(c)} as SportLots-only`}
                      >
                        Keep
                      </NeonButton>
                    </PairableRow>
                  ))}
                </ul>
              </section>
              )}

              {/* NEO-490 / NEO-496 — the publisher's checklist: the rows no
                  marketplace card paired, a source like the two marketplace
                  columns. A row is linked to its card, or kept as a card of
                  its own (Keep / Keep all, onto the keep shelf). Linked rows
                  stay listed, saying which card they went to, so a link can
                  be read and undone. A row left here is dropped at Confirm. */}
              {showChecklistColumn && checklistRows && (
                <section>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold text-ink-2">
                      {checklistColumnHeading(openRowCount)}
                    </h3>
                    <NeonButton
                      type="button"
                      variant="primary"
                      outline
                      size="1"
                      className={KEEP_BUTTON}
                      disabled={openRowCount === 0}
                      onClick={() => {
                        dispatch({ type: "KEEP_ALL_CHECKLIST" });
                        setSelectedRow(null);
                        refocus(checklistFilterRef.current);
                      }}
                      aria-label="Keep all checklist-only cards"
                    >
                      Keep all
                    </NeonButton>
                  </div>
                  {state.checklistCards.length === 0 && (
                    <p className="text-xs text-ink-3 mb-2">{CHECKLIST_ALL_FOUND}</p>
                  )}
                  <Input
                    bare
                    ref={checklistFilterRef}
                    className="w-full px-3 py-1.5 text-base sm:text-sm"
                    type="text"
                    value={checklistFilter}
                    onChange={(e) => {
                      const value = e.target.value;
                      setChecklistFilter(value);
                      // N5: a picked row the filter now hides is no longer
                      // picked — a Link on a card must never land a row the
                      // operator cannot see.
                      if (selectedRow !== null) {
                        const row = checklistRows[selectedRow];
                        if (
                          !row ||
                          !checklistRowLine(row)
                            .toLowerCase()
                            .includes(value.toLowerCase())
                        ) {
                          setSelectedRow(null);
                          announceChecklist(CHECKLIST_SELECTION_CLEARED);
                        }
                      }
                    }}
                    onKeyDown={(e) => {
                      // N4: Escape clears a filter that has text. An empty
                      // one has nothing to clear, so the key goes on to the
                      // dialog like any other.
                      if (e.key !== "Escape" || checklistFilter === "") return;
                      e.preventDefault();
                      e.stopPropagation();
                      setChecklistFilter("");
                    }}
                    placeholder="Filter checklist rows"
                    aria-label="Filter checklist rows"
                  />
                  {/* N3: named apart from "Filter checklist rows" (a label
                      query for one would otherwise find both). "Leftover":
                      these are the rows the server could not pair, linked
                      or not — a linked row stays listed. */}
                  {/* A-N4: picking a row is one-of-N, a roving radio group
                      as in the BSC column. Linked rows hold an Unlink and
                      no radio; arrows step over them. */}
                  <div
                    role="radiogroup"
                    aria-label="Pick a checklist row to link"
                    onKeyDown={(e) => {
                      const target = e.target as HTMLElement;
                      if (target.getAttribute("role") !== "radio") return;
                      const keys = pickableRows.map(String);
                      const next = radioStep(
                        e.key,
                        keys.indexOf(target.getAttribute("data-pick-radio") ?? ""),
                        keys.length,
                      );
                      if (next === null) return;
                      e.preventDefault();
                      const rowIndex = pickableRows[next];
                      setSelectedRow(rowIndex);
                      announceChecklist(
                        checklistSelectedAnnouncement(checklistRows[rowIndex].number),
                      );
                      focusPickRadio(e.currentTarget, keys[next]);
                    }}
                  >
                  <ul aria-label="Leftover checklist rows" className="flex flex-col gap-1 mt-2">
                    {visibleRows.map((rowIndex) => {
                      const row = checklistRows[rowIndex];
                      const linkedTo = rowToCard.get(rowIndex);
                      const line = checklistRowLine(row);
                      // S3: two rows reading the same would give two
                      // controls one name; the file position tells them
                      // apart.
                      const named = rowName(rowIndex);
                      if (linkedTo !== undefined) {
                        const cardLabel = cardLabels.get(linkedTo) ?? "a card";
                        return (
                          <ChecklistRowItem key={rowIndex} rowIndex={rowIndex} linked>
                            {/* The teal edge says "linked" on the tile; the
                                Unlink sits inside it so every row spans the
                                column. On a dark tile ink-3 and the pink
                                text both miss 4.5:1, so the quiet Unlink is
                                ink-2 and turns pink-filled under the pointer
                                (DESIGN.md: Rows, chips and neutral buttons). */}
                            <div className="flex min-w-0 flex-1 items-start justify-between gap-2 rounded border border-pick-teal-rule bg-row px-2 py-1 text-sm text-ink-2">
                              <span className="min-w-0">
                                <span className="block">{line}</span>
                                <span className="block text-xs text-pick-teal-ink">
                                  Linked to {cardLabel}
                                </span>
                              </span>
                              <button
                                type="button"
                                className="min-h-6 shrink-0 rounded px-2 py-1 text-xs text-ink-2 underline underline-offset-2 hover:bg-neon-pink hover:text-on-neon-pink hover:no-underline focus-outline"
                                onClick={() => {
                                  explicitUnlinkRef.current = linkedTo;
                                  dispatch({ type: "UNLINK_CHECKLIST", cardKey: linkedTo });
                                  focusChecklistRow(rowIndex);
                                }}
                                aria-label={`Unlink checklist row ${named} from ${cardLabel}`}
                              >
                                Unlink
                              </button>
                            </div>
                          </ChecklistRowItem>
                        );
                      }
                      const picked = activeRow === rowIndex;
                      return (
                        <ChecklistRowItem key={rowIndex} rowIndex={rowIndex} linked={false}>
                          <button
                            type="button"
                            role="radio"
                            data-pick-radio={String(rowIndex)}
                            data-row-primary=""
                            tabIndex={checklistTabStop === rowIndex ? 0 : -1}
                            className={`min-w-0 flex-1 text-left text-sm rounded border px-2 py-1 focus-outline ${
                              picked
                                ? "bg-pick-teal border-pick-teal-rule text-pick-teal-ink selection-edge"
                                : "bg-row border-row-rule text-ink-2 hover:bg-row-hover"
                            }`}
                            onClick={() => {
                              if (picked) {
                                setSelectedRow(null);
                                announceChecklist(CHECKLIST_SELECTION_CLEARED);
                                return;
                              }
                              setSelectedRow(rowIndex);
                              announceChecklist(checklistSelectedAnnouncement(row.number));
                            }}
                            aria-checked={picked}
                            aria-label={`Select ${named}`}
                          >
                            <RadioMark checked={picked} />
                            {line}
                          </button>
                          <NeonButton
                            type="button"
                            variant="primary"
                            outline
                            size="1"
                            className={KEEP_BUTTON}
                            onClick={() => {
                              const at = visibleRows.indexOf(rowIndex);
                              const neighbour = visibleRows[at + 1] ?? visibleRows[at - 1];
                              if (picked) setSelectedRow(null);
                              dispatch({ type: "KEEP_CHECKLIST", rowIndex });
                              // A-N3: on to the next row, not back to the filter.
                              focusRowAfterRemoval(
                                "data-checklist-row",
                                neighbour === undefined ? null : String(neighbour),
                                checklistFilterRef.current,
                              );
                            }}
                            aria-label={`Keep ${named} as checklist-only`}
                          >
                            Keep
                          </NeonButton>
                        </ChecklistRowItem>
                      );
                    })}
                  </ul>
                  </div>
                </section>
              )}
              </div>

              {/* Matches ReconciliationModal / ParallelGroupingModal exactly —
                  the same card, following the cursor. */}
              <DragOverlay>
                {activeDragLabel && (
                  <div className="px-3 py-2 rounded-lg border bg-raised border-selection ring-2 ring-selection shadow-lg text-sm font-medium">
                    <span className="text-ink-2">{activeDragLabel}</span>
                  </div>
                )}
              </DragOverlay>
            </DndContext>
            )}

            {/* Keep shelf — same affordance the set-level dialog has. Hidden
                alongside the columns: with nothing unmatched there is nothing
                that could be kept, so "Nothing kept — every unmatched card
                above will be discarded" describes cards that do not exist. */}
            {showAnyColumn && (
            <section className="border-t border-rule-strong pt-3">
              <h3 className="text-sm font-semibold text-ink-2 mb-2">
                Keeping ({keptTotal})
              </h3>
              {keptTotal === 0 ? (
                <p className="text-xs text-ink-3 italic">
                  Nothing kept — every unmatched card above will be discarded.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {state.keptBsc.map((c) => (
                    <li
                      key={`kb-${candidateKey(c)}`}
                      className="flex flex-wrap items-center justify-between gap-x-2 text-sm text-ink-2"
                    >
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <span>BSC: {label(c)}</span>
                        {checklistChip(c)}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {checklistLinkButton(c)}
                        <button
                          type="button"
                          className="text-xs text-ink-3 hover:text-neon-pink-text px-2 py-1.5"
                          onClick={() => {
                            dispatch({
                              type: "UNKEEP",
                              side: "bsc",
                              key: candidateKey(c),
                            });
                            refocus(bscFilterRef.current);
                          }}
                          aria-label={`Remove ${label(c)} from save list`}
                        >
                          Remove
                        </button>
                      </span>
                    </li>
                  ))}
                  {state.keptSl.map((c) => (
                    <li
                      key={`ks-${candidateKey(c)}`}
                      className="flex flex-wrap items-center justify-between gap-x-2 text-sm text-ink-2"
                    >
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <span>SL: {label(c)}</span>
                        {checklistChip(c)}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {checklistLinkButton(c)}
                        <button
                          type="button"
                          className="text-xs text-ink-3 hover:text-neon-pink-text px-2 py-1.5"
                          onClick={() => {
                            dispatch({
                              type: "UNKEEP",
                              side: "sl",
                              key: candidateKey(c),
                            });
                            refocus(slFilterRef.current);
                          }}
                          aria-label={`Remove ${label(c)} from save list`}
                        >
                          Remove
                        </button>
                      </span>
                    </li>
                  ))}
                  {/* NEO-496 — checklist rows kept as cards of their own. */}
                  {checklistRows &&
                    state.checklistKept.map((rowIndex) => (
                    <li
                      key={`kc-${rowIndex}`}
                      className="flex flex-wrap items-center justify-between gap-x-2 text-sm text-ink-2"
                    >
                      <span className="min-w-0">
                        Checklist: {checklistRowLine(checklistRows[rowIndex])}
                      </span>
                      <button
                        type="button"
                        className="shrink-0 text-xs text-ink-3 hover:text-neon-pink-text px-2 py-1.5 focus-outline"
                        onClick={() => {
                          dispatch({ type: "UNKEEP_CHECKLIST", rowIndex });
                          refocus(checklistFilterRef.current);
                        }}
                        aria-label={`Remove checklist row ${rowName(rowIndex)} from save list`}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            )}
          </div>

          <footer className="p-4 border-t border-rule-strong flex items-center justify-between gap-4">
            <div className="min-w-0 space-y-0.5">
              <span className="block text-xs text-ink-3">
                {totalToSave} card{totalToSave === 1 ? "" : "s"} will be saved
              </span>
              {/* NEO-330 — teams that missed the wait. The streaming line is
                  gone once Confirm unlocks, and the sync banner that says
                  this is behind the modal, so it is said here too, beside the
                  button it is about. Quiet and static (the status region
                  announced it once); Confirm's description points at it. */}
              {teamsLate && (
                <p id="pairing-teams-late" className="text-xs text-ink-2">
                  {teamsLateNotice}
                </p>
              )}
              {checklistError && (
                <p
                  id={CHECKLIST_ERROR_ID}
                  role="alert"
                  className="text-xs text-neon-pink-text"
                >
                  {checklistError}
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <NeonButton
                variant="negative"
                size="2"
                onClick={requestClose}
                // Specific, matching every other dialog in this directory —
                // CardChecklist renders a "Cancel new card" button on the same
                // page, so a bare "Cancel" would be ambiguous to assistive
                // tech and to Maestro's accessibility-tree selectors.
                aria-label="Cancel card matching"
              >
                Cancel
              </NeonButton>
              <NeonButton
                size="2"
                onClick={handleConfirm}
                // NEO-189/a11y: `disabled` only for the real terminal state
                // (already saving). While merely streaming, the button stays
                // FOCUSABLE — a native `disabled` button is pulled out of the
                // tab order entirely, so a keyboard user tabbing through the
                // footer would never even land on Confirm to learn why it
                // isn't doing anything, and `title` tooltips aren't reliably
                // announced by screen readers and can't be triggered by
                // keyboard on an unfocusable control either way. aria-disabled
                // keeps it reachable; handleConfirm's own confirmBlocked guard
                // (above) makes activating it a no-op, so this is safe.
                // NEO-490 (S4): not while the checklist links are asked
                // about — that wait keeps the button focusable, below.
                ref={confirmBtnRef}
                disabled={confirming && !resolvingChecklist}
                aria-disabled={confirmBlocked || resolvingChecklist || undefined}
                // Ties the reason to the control itself so it's available the
                // moment Confirm receives focus, rather than depending on the
                // operator having caught the coarse status announcements
                // (NEO-330: the sentence itself is no longer live).
                // NEO-490 (S4): and to the checklist alert while it shows.
                aria-describedby={
                  [
                    confirmBlocked
                      ? "pairing-streaming-status"
                      : teamsLate
                        ? "pairing-teams-late"
                        : null,
                    checklistError ? CHECKLIST_ERROR_ID : null,
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                aria-label="Confirm card matches"
                title={
                  confirmBlocked
                    ? "Still loading teams…"
                    : undefined
                }
              >
                {confirming
                  ? "Saving…"
                  : confirmBlocked
                    ? "Loading…"
                    : "Confirm"}
              </NeonButton>
            </div>
          </footer>
        </div>
      </div>
      {/* NEO-220 — a SIBLING of the overlay, not a child of it.
          The overlay stack in this directory closes on backdrop click, and a
          confirm nested inside one would hand its own backdrop click straight
          to the thing it is protecting: click "no, keep working" on the
          backdrop and lose the session anyway. Rendered here it is also outside
          the modal root's `onKeyDown`, so ConfirmDialog's Escape is its own. */}
      {discardOpen && (
        <ConfirmDialog
          title={`Discard ${plural(pendingEdits, "pairing")}?`}
          description="Closing throws away every link, keep and name choice on this screen. No cards have been saved."
          confirmLabel={`Discard ${plural(pendingEdits, "pairing")}`}
          // Nothing is written on this path, so there is no in-flight window to
          // label — the same string keeps ConfirmDialog's contract honest.
          busyLabel={`Discard ${plural(pendingEdits, "pairing")}`}
          busy={false}
          onConfirm={() => {
            setDiscardOpen(false);
            onClose();
          }}
          onCancel={() => setDiscardOpen(false)}
        />
      )}
    </Theme>,
    document.body,
  );
}
