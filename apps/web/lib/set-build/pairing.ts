/**
 * NEO-339 — the card-pairing decisions, as plain functions.
 *
 * Moved out of `CardPairingModal` (and `withConflicts` out of `CardChecklist`)
 * with no change in behaviour, so the Set Builder dialog and the set-building
 * tool (`tools/setbuild/`) read and write the SAME state and send the SAME
 * `PairingResult`. The dialog keeps the rendering, focus and drag handling; the
 * reducer, its seed and the Confirm payload live here.
 *
 * Pure and env-free: no React, no `convex/react`, no `process.env`, and only
 * relative imports, so a Node script can load it. See the NEO-137 module
 * comment in `CardPairingModal.tsx` for what the screen itself is for.
 */

import { compareCardNumbers } from "../cards/card-number";
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
} from "../cards/card-name";
// NEO-251 security review — the two bounds the server enforces on every path a
// player name can take, applied here as well so the operator finds out while
// the field is still in front of them rather than at the end of a 900-card
// commit. `MAX_CARD_PLAYERS` is the same constant the `card-attention` seam
// re-exports to the components.
import { MAX_CARD_PLAYERS } from "../../convex/features/cardAttention";
import { MAX_PLAYER_NAME_LENGTH } from "../players/name-limits";

// NEO-255 — one streamed candidate → one `PairingCard`. Re-exported so the tool
// builds its cards through the same mapping the dialog's caller does.
export {
  candidateToPairingCard,
  candidatesToPairingCards,
  type ReadyCandidate,
} from "../../components/SetSelector/pairing-cards";

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
  teamLookup?: "answered" | "failed";
  /**
   * NEO-335 — BSC's team value for this card exactly as its fetch-time lookup
   * returned it, unsplit (`checklistCandidates.rawTeamName`). Present only
   * where `teams` does not already say it. Rides through the dialog
   * untouched; the commit stores it as the "Listed as:" hint on an answered
   * card that saves with no team. A listing claim, never a team.
   */
  rawTeamName?: string;
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
export type NameConflict = NameDisagreement & {
  /** Whose name the merged card is carrying right now. */
  chosen: "bsc" | "sportlots" | "custom";
  /**
   * NEO-339 — the operator has answered THIS disagreement in this session (a
   * pill, including the one already checked, or a typed name). Per field,
   * unlike `MatchedPair.touched`: a row disagreeing on its name AND its
   * roster is two questions, and answering one must not pass for both.
   * Confirm waits until every conflict is decided (`openPairingConflicts`).
   */
  decided?: true;
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
export type PlayersConflict = PlayersDisagreement & {
  /** Whose roster the merged card is carrying right now. */
  chosen: "bsc" | "sportlots" | "custom";
  /** NEO-339 — answered in this session; see `NameConflict.decided`. */
  decided?: true;
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
export type IncomingPair = { card: PairingCard; confidence: number };

/**
 * The candidates snapshot this dialog opens on, and keeps receiving.
 *
 * Named rather than inlined on the props so `seedState` — the reducer's lazy
 * initializer, which lives outside the component — can take it by type.
 */
export type PairingInitialData = {
  /**
   * Pairs the server already merged. Typed as INCOMING — no `chosen`, because
   * nobody has chosen yet; `seedMatched` derives that here (NEO-199).
   */
  autoMatched: IncomingPair[];
  unmatchedBsc: PairingCard[];
  unmatchedSl: PairingCard[];
};

export type MatchedPair = {
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
      /** NEO-341 — the parent has seen this fetch end; see `State.streamSettled`. */
      settled: boolean;
    };

/**
 * NEO-195 — stable identity for a candidate across streamed updates.
 *
 * The marketplace ref is the real identity; SportLots in particular reuses a
 * card NUMBER across a card and its variations, so keying on the number would
 * make three rows look like one and absorb would drop two of them.
 */
export function candidateKey(c: PairingCard): string {
  return (
    c.platformData.bsc?.ref ??
    c.platformData.sportlots?.ref ??
    `#${c.cardNumber}`
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
export function compareCards(a: PairingCard, b: PairingCard): number {
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
export function ordered(state: State): State {
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
export function nameConflictOf(
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
export function playersConflictOf(
  bsc: PairingCard,
  sl: PairingCard,
): PlayersConflict | undefined {
  const conflict = conflictingPlayers(bsc.players, sl.players);
  return conflict ? { ...conflict, chosen: "bsc" } : undefined;
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
export function seedMatched(incoming: IncomingPair[]): MatchedPair[] {
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
function seedState(initialData: PairingInitialData): State {
  // NEO-199: `seedMatched`, not the raw array — an auto-matched pair the
  // marketplaces name differently has to arrive already flagged, on the very
  // first paint. That is the common path; waiting for the operator to
  // hand-link something before the guard exists is the defect.
  const matched = seedMatched(initialData.autoMatched);
  // NEO-195: `ordered` on the seed too — the first paint is otherwise in
  // whatever order the fetch produced, which for a streamed batch is arrival
  // order, not card order.
  return ordered({
    matched,
    unmatchedBsc: initialData.unmatchedBsc,
    unmatchedSl: initialData.unmatchedSl,
    keptBsc: [],
    keptSl: [],
    seedMatchedKeys: new Set(matched.map((m) => candidateKey(m.card))),
    // NEO-341: only an ABSORB may say so — see `State.streamSettled`.
    streamSettled: false,
  });
}

/** Merge a BSC-side and SL-side candidate into the single NB card they describe. */
export function mergePair(bsc: PairingCard, sl: PairingCard): PairingCard {
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
    platformData: {
      ...(bsc.platformData.bsc ? { bsc: bsc.platformData.bsc } : {}),
      ...(sl.platformData.sportlots
        ? { sportlots: sl.platformData.sportlots }
        : {}),
    },
  };
}

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
/**
 * The re-pick of the side already chosen: the row is touched and that
 * field's conflict is decided (NEO-339), with nothing else moved. Returns the
 * same state when both were already true.
 */
function markTouched(state: State, index: number, field: "name" | "players"): State {
  const pair = state.matched[index];
  if (!pair) return state;
  const conflict = field === "name" ? pair.nameConflict : pair.playersConflict;
  if (pair.touched && (!conflict || conflict.decided)) return state;
  return {
    ...state,
    matched: state.matched.map((m, i) =>
      i === index
        ? {
            ...m,
            touched: true,
            ...(field === "name" && m.nameConflict
              ? { nameConflict: { ...m.nameConflict, decided: true as const } }
              : {}),
            ...(field === "players" && m.playersConflict
              ? { playersConflict: { ...m.playersConflict, decided: true as const } }
              : {}),
          }
        : m,
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

      const newMatched = action.autoMatched.filter((m) => isNew(m.card));
      const newBsc = action.unmatchedBsc.filter(isNew);
      const newSl = action.unmatchedSl.filter(isNew);

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
        !enriched &&
        streamSettled === state.streamSettled
      ) {
        return state;
      }

      return {
        ...state,
        streamSettled,
        matched: [...matched, ...newMatched],
        unmatchedBsc: [...unmatchedBsc, ...newBsc],
        unmatchedSl: [...unmatchedSl, ...newSl],
        keptBsc,
        keptSl,
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
      const slSide: PairingCard = {
        ...pair.card,
        cardName: pair.nameConflict?.sportlots ?? pair.card.cardName,
        players: pair.playersConflict?.sportlots ?? pair.card.players,
        platformData: pair.card.platformData.sportlots
          ? { sportlots: pair.card.platformData.sportlots }
          : {},
        unmatched: "bsc",
      };
      return {
        ...state,
        matched: state.matched.filter((_, i) => i !== action.index),
        unmatchedBsc: pair.card.platformData.bsc
          ? [...state.unmatchedBsc, bscSide]
          : state.unmatchedBsc,
        unmatchedSl: pair.card.platformData.sportlots
          ? [...state.unmatchedSl, slSide]
          : state.unmatchedSl,
      };
    }
    /**
     * NEO-189 — the operator settles a name disagreement.
     *
     * Both names are retained on the pair either way, so this is reversible
     * right up to Confirm, and after Confirm the name is editable in
     * CardDetailPanel. NEO-339 reversed NEO-189's "nothing here blocks
     * Confirm": an unanswered conflict now holds Confirm
     * (`openPairingConflicts`), because letting it through committed BSC's
     * name over a disagreement nobody settled. This action is the answer.
     */
    case "CHOOSE_NAME": {
      const pair = state.matched[action.index];
      if (!pair?.nameConflict) return state;
      // NEO-251: re-picking the side that is ALREADY chosen is still a
      // decision, and on a row whose NB value came from the other side it is
      // the whole decision. Recorded rather than dropped — see
      // `MatchedPair.touched`.
      if (pair.nameConflict.chosen === action.side) {
        return markTouched(state, action.index, "name");
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
                nameConflict: { ...conflict, chosen: action.side, decided: true },
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
          ? { ...conflict, chosen, custom: cardName, decided: true }
          : { ...conflict, chosen, decided: true };
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
     * `CHOOSE_NAME`'s shape exactly, one field over. Since NEO-339 an
     * unanswered roster conflict holds Confirm, like a name conflict; this
     * action is the answer.
     */
    case "CHOOSE_PLAYERS": {
      const pair = state.matched[action.index];
      if (!pair?.playersConflict) return state;
      // Same as `CHOOSE_NAME` above: the re-pick is the decision.
      if (pair.playersConflict.chosen === action.side) {
        return markTouched(state, action.index, "players");
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
                playersConflict: { ...conflict, chosen: action.side, decided: true },
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
          ? { ...conflict, chosen, custom: players, decided: true }
          : { ...conflict, chosen, decided: true };
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
      if (action.side === "bsc") {
        return {
          ...state,
          keptBsc: state.keptBsc.filter((_, i) => i !== idx),
          unmatchedBsc: [...state.unmatchedBsc, card],
        };
      }
      return {
        ...state,
        keptSl: state.keptSl.filter((_, i) => i !== idx),
        unmatchedSl: [...state.unmatchedSl, card],
      };
    }
    default:
      return state;
  }
}

/** One disagreement on a matched pair nobody has answered yet. */
export type OpenPairingConflict = {
  /** The pair's index in `state.matched` (the CHOOSE_* actions' `index`). */
  index: number;
  field: "name" | "players";
  cardNumber: string;
};

/**
 * NEO-339 — every disagreement on a matched pair still waiting for the
 * operator, in list order. Confirm is refused while this is non-empty, in the
 * Match Cards dialog and in the set-building tool alike: a conflict left
 * unanswered used to commit BSC's side over it in silence.
 */
export function openPairingConflicts(state: State): OpenPairingConflict[] {
  const open: OpenPairingConflict[] = [];
  state.matched.forEach((m, index) => {
    if (m.nameConflict && !m.nameConflict.decided) {
      open.push({ index, field: "name", cardNumber: m.card.cardNumber });
    }
    if (m.playersConflict && !m.playersConflict.decided) {
      open.push({ index, field: "players", cardNumber: m.card.cardNumber });
    }
  });
  return open;
}

export {
  reducer as pairingReducer,
  seedState as seedPairingState,
  type State as PairingState,
  type Action as PairingAction,
};

/**
 * NEO-339 — what the dialog's Confirm hands back, built from reducer state.
 *
 * Moved verbatim from `CardPairingModal`'s `handleConfirm`, which now calls
 * this. `keepUnmatchedBsc` / `keepUnmatchedSl` are the dialog's own "Keep all
 * BSC-only / SportLots-only cards" buttons: each is applied as the `KEEP_ALL`
 * action the button dispatches, through the same reducer (and so the same
 * ordering), before the payload is read. The dialog itself passes neither — by
 * the time Confirm is pressed the operator has already pressed those buttons.
 */
export function buildPairingResult(
  state: State,
  opts: { keepUnmatchedBsc?: boolean; keepUnmatchedSl?: boolean } = {},
): PairingResult {
  let s = state;
  if (opts.keepUnmatchedBsc) s = reducer(s, { type: "KEEP_ALL", side: "bsc" });
  if (opts.keepUnmatchedSl) s = reducer(s, { type: "KEEP_ALL", side: "sl" });
  // Only confirmed pairs and deliberately-kept singles become NB cards.
  // Everything still sitting in an unmatched column is discarded — that
  // is what keeps a shared SL set's sibling-owned cards from being
  // invented under this row.
  // NEO-251: the disagreements, addressed by their card's index in the
  // array below. `state.matched` is emitted first, so a matched pair's
  // index IS its index in `cards` — kept singles follow and can never
  // carry a conflict.
  const conflictsByIndex: Record<number, PairingConflicts> = {};
  s.matched.forEach((m, index) => {
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
  return {
    cards: [...s.matched.map((m) => m.card), ...s.keptBsc, ...s.keptSl],
    conflictsByIndex,
  };
}

/**
 * NEO-251 — the cards as the SYNC-REVIEW DIFF needs to see them: each one
 * carrying whatever the two marketplaces disagreed about on it.
 *
 * `CardPairingModal` deliberately hands back committable cards and a SEPARATE,
 * index-keyed record of the disagreements (see `PairingResult`), because a card
 * on its way to `commitCardChecklist` has one answer rather than an open
 * question — the commit throws on one that still carries `playersConflict`.
 * This is the one place the two are put back together, and the result is
 * handed to the diff query alone; nothing downstream of it sees the field.
 *
 * A card with no conflict is returned BY REFERENCE. On a 908-card set that is
 * every row but a handful, and this runs on the way into a query argument that
 * is about to be serialised.
 */
export function withConflicts(
  cards: PairingCard[],
  conflictsByIndex: Record<number, PairingConflicts>,
): PairingCard[] {
  return cards.map((card, index) => {
    const conflicts = conflictsByIndex[index];
    if (!conflicts) return card;
    return { ...card, ...conflicts };
  });
}
