import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import NeonButton from "../modules/NeonButton";
import { Input } from "../primitives/Input";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";
import { compareCardNumbers } from "@/lib/cards/card-number";
// NEO-199: the wrong-player check is SHARED with the server. `fetchCardChecklist`
// runs this exact function over an auto-matched pair before it discards the
// losing name, so an auto-matched disagreement and a hand-linked one are
// definitionally the same thing. See lib/cards/card-name.ts.
import {
  conflictingNames,
  type NameDisagreement,
} from "@/lib/cards/card-name";

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
  platformData: {
    bsc?: { ref: string; setId?: string };
    sportlots?: { ref: string; setId?: string };
  };
  unmatched?: "bsc" | "sl";
};

export type PairingResult = { cards: PairingCard[] };

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
 * A pair as it ARRIVES — off the streamed `checklistCandidates` query, which
 * is the only wire the cards travel now that `fetchCardChecklist` returns just
 * a count and a message.
 *
 * Distinct from `MatchedPair` on purpose: an incoming pair has no `chosen`,
 * because nobody has chosen yet. `seedMatched` turns one into the other.
 */
type IncomingPair = { card: PairingCard; confidence: number };

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
};

type State = {
  matched: MatchedPair[];
  unmatchedBsc: PairingCard[];
  unmatchedSl: PairingCard[];
  keptBsc: PairingCard[];
  keptSl: PairingCard[];
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
    };

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
 * The listeners alone are what the PointerSensor needs; the accessible
 * affordance for the same action is the click path, which is untouched.
 *
 * Plain clicks on the inner buttons still work because the PointerSensor's
 * 5px activation constraint means a drag never starts from a stationary press
 * (same reasoning as ParallelGroupingModal).
 */
function PairableRow({
  side,
  cardKey,
  children,
}: {
  side: DragSide;
  cardKey: string;
  children: React.ReactNode;
}) {
  const id = dragId(side, cardKey);
  const { listeners, setNodeRef: setDragRef, isDragging } = useDraggable({ id });
  const { setNodeRef: setDropRef, isOver, active } = useDroppable({ id });
  const setRef = useCallback(
    (node: HTMLLIElement | null) => {
      setDragRef(node);
      setDropRef(node);
    },
    [setDragRef, setDropRef],
  );
  // Highlight only for a drop that would actually DO something. A row is its
  // own droppable, and same-column drops are no-ops, so an unconditional
  // `isOver` would promise a link that `handleDragEnd` then declines to make.
  const isLinkTarget =
    isOver &&
    typeof active?.id === "string" &&
    parseDragId(active.id)?.side !== side;

  return (
    <li
      ref={setRef}
      {...listeners}
      className={`flex items-center gap-2 rounded cursor-grab active:cursor-grabbing ${
        isDragging ? "opacity-40" : ""
      } ${isLinkTarget ? "ring-2 ring-[#00B7FF] bg-[#00B7FF]/10" : ""}`}
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
    const wire = pair.card.nameConflict;
    if (!wire) return pair;
    const card: PairingCard = { ...pair.card };
    delete card.nameConflict;
    const conflict = conflictingNames(wire.bsc, wire.sportlots);
    if (!conflict) return { card, confidence: pair.confidence };
    // BSC by default: the server's merge took `bsc.cardName || sl.cardName`,
    // and a conflict requires both sides to be non-empty, so `card.cardName` is
    // necessarily BSC's. Same invariant `nameConflictOf` relies on above.
    return {
      card,
      confidence: pair.confidence,
      nameConflict: { ...conflict, chosen: "bsc" },
    };
  });
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
    players: bsc.players ?? sl.players,
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
    platformData: {
      ...(bsc.platformData.bsc ? { bsc: bsc.platformData.bsc } : {}),
      ...(sl.platformData.sportlots
        ? { sportlots: sl.platformData.sportlots }
        : {}),
    },
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

      // Nothing arrived and nothing changed — return the SAME state object so
      // the render this dispatch would otherwise cause does not happen. The
      // stream fires this on every reactive update of a 900-row batch.
      if (!newMatched.length && !newBsc.length && !newSl.length && !enriched) {
        return state;
      }

      return {
        ...state,
        matched: [...matched, ...newMatched],
        unmatchedBsc: [...unmatchedBsc, ...newBsc],
        unmatchedSl: [...unmatchedSl, ...newSl],
        keptBsc,
        keptSl,
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
        platformData: pair.card.platformData.bsc
          ? { bsc: pair.card.platformData.bsc }
          : {},
        unmatched: "sl",
      };
      const slSide: PairingCard = {
        ...pair.card,
        cardName: pair.nameConflict?.sportlots ?? pair.card.cardName,
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
     * CardDetailPanel. Nothing here blocks Confirm: a conflict is recoverable,
     * and blocking would mean one flagged row in a streamed 660-card set holds
     * the entire commit hostage.
     */
    case "CHOOSE_NAME": {
      const pair = state.matched[action.index];
      if (!pair?.nameConflict) return state;
      if (pair.nameConflict.chosen === action.side) return state;
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
     *     would leave the radiogroup showing "Custom: <BSC's name>" checked
     *     alongside an unchecked, identical "BSC: <BSC's name>", which is a
     *     control asking the operator to choose between two spellings of the
     *     same decision. Matched on the exact trimmed string rather than
     *     `nameKey`, deliberately: `nameKey` folds accents and punctuation, so
     *     "José Ramírez" typed over BSC's "Jose Ramirez" would be swallowed as
     *     "you picked BSC" and the operator's correction silently discarded.
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
      const cardName = action.cardName.trim();
      if (!cardName) return state;
      const conflict = pair.nameConflict;
      if (!conflict) {
        if (cardName === pair.card.cardName) return state;
        return {
          ...state,
          matched: state.matched.map((m, i) =>
            i === action.index ? { ...pair, card: { ...pair.card, cardName } } : m,
          ),
        };
      }
      const chosen: NameConflict["chosen"] =
        cardName === conflict.bsc
          ? "bsc"
          : cardName === conflict.sportlots
            ? "sportlots"
            : "custom";
      const nameConflict: NameConflict =
        chosen === "custom"
          ? { ...conflict, chosen, custom: cardName }
          : { ...conflict, chosen };
      if (
        cardName === pair.card.cardName &&
        conflict.chosen === nameConflict.chosen &&
        conflict.custom === nameConflict.custom
      ) {
        return state;
      }
      return {
        ...state,
        matched: state.matched.map((m, i) =>
          i === action.index
            ? { ...pair, card: { ...pair.card, cardName }, nameConflict }
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
    if (!m.nameConflict) continue;
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

export default function CardPairingModal({
  isOpen,
  onClose,
  onConfirm,
  setLabel,
  initialData,
  isStreaming,
  streamProgress,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (result: PairingResult) => Promise<void>;
  /** e.g. "Dugout Collection Artist's Proofs Series 1" — for the heading. */
  setLabel?: string;
  initialData: {
    /**
     * Pairs the server already merged. Typed as INCOMING — no `chosen`, because
     * nobody has chosen yet; `seedMatched` derives that here (NEO-199).
     */
    autoMatched: IncomingPair[];
    unmatchedBsc: PairingCard[];
    unmatchedSl: PairingCard[];
  };
  /**
   * NEO-195 — the fetch is still running and more candidates are coming.
   *
   * Review may begin, but Confirm is BLOCKED while this is true: committing
   * mid-stream would save a partial checklist and silently discard every card
   * that had not arrived yet. Early review is the point; early commit is a bug.
   */
  isStreaming?: boolean;
  /** Progress for the streaming banner: cards released / cards found so far. */
  streamProgress?: { ready: number; total: number };
}) {
  // NEO-195: `ordered` on the seed too — the first paint is otherwise in
  // whatever order the fetch produced, which for a streamed batch is arrival
  // order, not card order.
  const [state, dispatch] = useReducer(
    reducer,
    ordered({
      // NEO-199: `seedMatched`, not the raw array — an auto-matched pair the
      // marketplaces name differently has to arrive already flagged, on the
      // very first paint. That is the common path; waiting for the operator to
      // hand-link something before the guard exists is the defect.
      matched: seedMatched(initialData.autoMatched),
      unmatchedBsc: initialData.unmatchedBsc,
      unmatchedSl: initialData.unmatchedSl,
      keptBsc: [],
      keptSl: [],
    }),
  );
  const [selectedBsc, setSelectedBsc] = useState<string | null>(null);
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
  const [matchedCollapsed, setMatchedCollapsed] = useState(
    initialData.unmatchedBsc.length > 0 || initialData.unmatchedSl.length > 0,
  );
  const [confirming, setConfirming] = useState(false);

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
    });
  }, [initialData]);
  // Everything paired and nothing set aside: the columns and keep shelf have
  // nothing to show and only add noise. Derived from CURRENT state, not the
  // initial snapshot, so unlinking a pair brings the columns straight back.
  const nothingToReconcile =
    state.unmatchedBsc.length === 0 &&
    state.unmatchedSl.length === 0 &&
    state.keptBsc.length === 0 &&
    state.keptSl.length === 0;
  // NEO-189: how many merged rows the marketplaces disagree about the name on.
  // Surfaced on the section header too, because the Matched list is COLLAPSED
  // by default whenever there is unmatched work — which is exactly the state
  // manual pairing happens in — and a warning inside a closed section is not a
  // warning.
  const nameConflictCount = state.matched.filter((m) => m.nameConflict).length;
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
    // than falling to <body>.
    triggerRef.current = document.activeElement as HTMLElement | null;
    const id = requestAnimationFrame(() => cancelBtnRef.current?.focus());
    return () => {
      cancelAnimationFrame(id);
      triggerRef.current?.focus?.();
    };
  }, [isOpen]);

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
   * NEO-189/a11y — focus the now-checked radio in a name-conflict
   * radiogroup, by `domKey` rather than by array index: the
   * radiogroup's own arrow-key handler dispatches CHOOSE_NAME first, and by
   * the time this runs the DOM has to be re-queried anyway (the CHOSEN radio
   * — the one that must end up focused — only exists post-render), and
   * `state.matched` is re-sorted by `ordered()` after every dispatch, so a
   * captured index or element ref from before the dispatch cannot be trusted
   * to still point at the same row afterward.
   */
  const refocusSelectedRadio = useCallback((key: string) => {
    requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>(
          `[data-name-conflict="${key}"] [role="radio"][tabindex="0"]`,
        )
        ?.focus();
    });
  }, []);

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
      const createsConflict = !!(
        bscSide &&
        slSide &&
        nameConflictOf(bscSide, slSide)
      );
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
        refocusSelectedRadio(domKey(bscSide));
      }
    },
    [state.unmatchedBsc, state.unmatchedSl, refocusSelectedRadio],
  );

  // ── Drag-and-drop linking ────────────────────────────────────────────────
  // The 5px activation constraint is load-bearing, not cosmetic: without it a
  // stationary press on a row's inner <button> starts a drag and the button's
  // onClick never fires, which would break the click-to-select path (and the
  // Maestro flow that drives it) the moment the listeners went on.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
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
    [performLink],
  );

  const handleDragCancel = useCallback(() => setActiveDragId(null), []);

  /** What the drag overlay shows: the dragged card's own row label. */
  const activeDragLabel = useMemo(() => {
    if (!activeDragId) return null;
    const parsed = parseDragId(activeDragId);
    if (!parsed) return null;
    const pool =
      parsed.side === "bsc" ? state.unmatchedBsc : state.unmatchedSl;
    const card = pool.find((c) => candidateKey(c) === parsed.key);
    return card ? label(card) : null;
  }, [activeDragId, state.unmatchedBsc, state.unmatchedSl]);

  const handleConfirm = useCallback(async () => {
    if (confirming) return;
    // NEO-195: never commit a partial checklist. The button is disabled while
    // streaming; this is the guard for a keyboard or programmatic path.
    if (isStreaming) return;
    setConfirming(true);
    try {
      // Only confirmed pairs and deliberately-kept singles become NB cards.
      // Everything still sitting in an unmatched column is discarded — that
      // is what keeps a shared SL set's sibling-owned cards from being
      // invented under this row.
      await onConfirm({
        cards: [
          ...state.matched.map((m) => m.card),
          ...state.keptBsc,
          ...state.keptSl,
        ],
      });
    } finally {
      setConfirming(false);
    }
  }, [confirming, isStreaming, onConfirm, state]);

  if (!isOpen) return null;

  const totalToSave =
    state.matched.length + state.keptBsc.length + state.keptSl.length;

  return createPortal(
    <Theme>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="card-pairing-heading"
        ref={dialogRef}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // Escape during a drag CANCELS THE DRAG (dnd-kit's own document
            // listener), so it must not also close the modal — one keypress
            // that both aborts the gesture and throws away every unsaved
            // pairing is the worst possible reading of "cancel". `activeDragId`
            // is still set here whichever listener runs first: dnd-kit's cancel
            // only clears it via a React state update, which cannot land
            // mid-event.
            if (activeDragId) return;
            onClose();
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
        <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-5xl max-h-[92vh] flex flex-col">
          <header className="p-4 border-b border-gray-700">
            <h2
              id="card-pairing-heading"
              className="text-lg font-semibold text-gray-100"
            >
              Match Cards{setLabel ? ` — ${setLabel}` : ""}
            </h2>
            <p className="text-xs text-gray-400 mt-1">
              {nothingToReconcile
                ? "Every card paired across both marketplaces. Review and confirm — no cards are saved until you do."
                : "No cards are saved until you confirm. Anything left in a column below is discarded — keep a card to save it as single-marketplace."}
            </p>
            {/* NEO-195: cards arrive as they become reviewable, so say so.
                Without this the list silently grows under the operator and a
                disabled Confirm looks broken rather than deliberate. */}
            {isStreaming && (
              <p
                id="pairing-streaming-status"
                className="text-xs text-[#00B7FF] mt-1"
                role="status"
                aria-live="polite"
              >
                Pair away — teams are still resolving in the background
                {streamProgress && streamProgress.total > 0
                  ? ` (${streamProgress.ready} of ${streamProgress.total} done)`
                  : ""}
                . Confirm unlocks when the fetch finishes.
              </p>
            )}
          </header>

          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
            {/* Matched */}
            <section>
              <button
                type="button"
                ref={matchedToggleRef}
                className="text-sm font-semibold text-gray-200 mb-2 px-2 py-1.5"
                onClick={() => setMatchedCollapsed((v) => !v)}
                // The count is appended ONLY when there is a conflict: an
                // aria-label overrides the button's own text for assistive
                // tech, so a silent label would hide the very thing the
                // visible badge exists to announce.
                aria-label={
                  nameConflictCount > 0
                    ? `${matchedCollapsed ? "Expand" : "Collapse"} matched cards, ${nameConflictCount} with a name conflict`
                    : `${matchedCollapsed ? "Expand" : "Collapse"} matched cards`
                }
              >
                {matchedCollapsed ? "▶" : "▼"} Matched ({state.matched.length})
                {nameConflictCount > 0 && (
                  <span className="text-[#FF2EB3] ml-2">
                    {/* The glyph is decorative — "name conflict(s)" already
                        carries the meaning in words, so AT shouldn't also be
                        made to announce "warning sign" on top of that. */}
                    <span aria-hidden="true">⚠</span> {nameConflictCount} name
                    conflict
                    {nameConflictCount === 1 ? "" : "s"}
                  </span>
                )}
              </button>
              {!matchedCollapsed && (
                <ul className="flex flex-col gap-1">
                  {state.matched.map((m, i) => {
                    const rowKey = candidateKey(m.card);
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
                      editSessionDoneRef.current = true;
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
                      className="flex flex-col gap-1 text-sm text-gray-200 bg-gray-800/60 rounded px-2 py-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2">
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
                              <span className="text-gray-400 shrink-0">
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
                                // Named by the NUMBER, not by `label(m.card)`:
                                // the name is what this control changes, and a
                                // field that renames itself as you type is
                                // re-announced mid-edit. Same reasoning as
                                // `conflictScopeLabels`.
                                //
                                // "EDIT name for", not "Name for": the
                                // radiogroup below is already `Name for
                                // #<scope>`, and on a single-conflict row that
                                // scope IS the bare number — so the obvious
                                // label would put two differently-roled
                                // controls with one accessible name on the
                                // same row, which is the ambiguity
                                // `conflictScopeLabels` exists to remove. It
                                // would also make the Maestro selector
                                // `id: "Name for #FS-1"` (already used
                                // against the radiogroup in
                                // checklist-pairing-dialog-cancel.yaml) match
                                // two elements.
                                aria-label={`Edit name for #${m.card.cardNumber}`}
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
                                <span className="text-gray-400 shrink-0">
                                  · {m.card.cardVariation}
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
                              className="text-left border-b border-dotted border-gray-600 hover:border-[#00B7FF] hover:text-white"
                              onClick={() => {
                                // Prefilled with `cardName` ALONE — not
                                // `label()`. The number and the variation
                                // description are separate fields on the card;
                                // a field prefilled with "#461 Noah Cameron"
                                // invites an operator to retype the number into
                                // the name, and the commit would take it.
                                setEditDraft(m.card.cardName);
                                setEditingKey(rowKey);
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
                            <span className="text-xs text-amber-400 shrink-0">
                              {Math.round(m.confidence * 100)}%
                            </span>
                          )}
                        </span>
                        <button
                          type="button"
                          className="text-xs text-gray-400 hover:text-red-400 px-2 py-1.5"
                          onClick={() => {
                            dispatch({ type: "UNLINK", index: i });
                            refocus(matchedToggleRef.current);
                          }}
                          aria-label={`Unlink ${label(m.card)}`}
                        >
                          Unlink
                        </button>
                      </div>
                      {/* NEO-189: the marketplaces name this card differently.
                          Show BOTH, say which one is currently winning, and
                          let the operator switch — the ambiguity is reported,
                          never resolved by heuristic. */}
                      {m.nameConflict && (
                        <div
                          role="group"
                          // Named by the row's SCOPE, not by `label(m.card)`:
                          // see `conflictScopeLabels`. The name has to hold
                          // still while the operator uses the control it names.
                          aria-label={`Name conflict on ${
                            conflictScopes.get(candidateKey(m.card)) ??
                            `#${m.card.cardNumber}`
                          }`}
                          // COLUMN, not a wrapping row. As `flex flex-wrap`
                          // the warning sentence and the pills sat side by
                          // side when they happened to fit and dropped below
                          // when they did not, so the same control was laid
                          // out differently on adjacent rows purely as a
                          // function of how long the two names were — the
                          // operator has to re-find the pills on every row.
                          // The sentence is the explanation and the pills are
                          // the decision; they read top-to-bottom, always.
                          // (The pills themselves still wrap — see the
                          // radiogroup's own `flex flex-wrap` below, which is
                          // what keeps two long names from overflowing.)
                          className="flex flex-col items-start gap-1.5 border-l-2 border-[#FF2EB3] pl-2 py-1"
                          // a11y — lets both the LINK handler (below) and the
                          // radiogroup's own arrow-key handler find this row's
                          // controls by marketplace ref after a dispatch,
                          // without depending on `i`, which `ordered()` can
                          // reshuffle — and without the card number, which a
                          // variation shares with the card it varies.
                          data-name-conflict={domKey(m.card)}
                        >
                          <span
                            id={`name-conflict-warning-${domKey(m.card)}`}
                            className="text-xs text-[#FF2EB3]"
                          >
                            {/* Decorative — the sentence itself carries the
                                meaning, so the glyph shouldn't make AT
                                announce a redundant "warning sign" first. */}
                            <span aria-hidden="true">⚠</span> These
                            marketplaces name this card differently — pick the
                            right one before it is listed.
                          </span>
                          {/*
                            a11y (NEO-189 audit) — this is a mutually exclusive,
                            always-exactly-one-chosen pair, i.e. exactly the
                            case the WAI-ARIA APG radio-group pattern is for,
                            not two independent aria-pressed toggles (which
                            carry no guarantee, semantic or enforced, that
                            they're mutually exclusive, and give a keyboard
                            user no arrow-key way to move between them as a
                            set). Kept visually as a pair of pill buttons per
                            the design — only the semantics and keyboard
                            handling changed.
                          */}
                          <div
                            role="radiogroup"
                            aria-label={`Name for ${
                              conflictScopes.get(candidateKey(m.card)) ??
                              `#${m.card.cardNumber}`
                            }`}
                            aria-describedby={`name-conflict-warning-${domKey(m.card)}`}
                            className="flex flex-wrap items-center gap-2"
                            onKeyDown={(e) => {
                              if (
                                ![
                                  "ArrowLeft",
                                  "ArrowRight",
                                  "ArrowUp",
                                  "ArrowDown",
                                ].includes(e.key)
                              ) {
                                return;
                              }
                              // The APG pattern moves focus WITH selection on
                              // a single-select radio group, and wraps at both
                              // ends. This used to be a toggle, which was only
                              // correct while there were exactly two options —
                              // an operator-typed name makes a third, and a
                              // toggle would have made it unreachable by
                              // keyboard while leaving it clickable by mouse.
                              // The order matches the rendered order, so
                              // "next" means the pill to the right.
                              e.preventDefault();
                              const options: NameConflict["chosen"][] =
                                m.nameConflict!.custom !== undefined
                                  ? ["bsc", "sportlots", "custom"]
                                  : ["bsc", "sportlots"];
                              const step =
                                e.key === "ArrowLeft" || e.key === "ArrowUp"
                                  ? -1
                                  : 1;
                              const at = options.indexOf(m.nameConflict!.chosen);
                              const next =
                                options[
                                  (at + step + options.length) % options.length
                                ];
                              dispatch({
                                type: "CHOOSE_NAME",
                                index: i,
                                side: next,
                              });
                              refocusSelectedRadio(domKey(m.card));
                            }}
                          >
                            <button
                              type="button"
                              role="radio"
                              aria-checked={m.nameConflict.chosen === "bsc"}
                              // Roving tabindex: only the checked radio is a
                              // Tab stop, matching native radio-group
                              // behaviour and the APG pattern.
                              tabIndex={m.nameConflict.chosen === "bsc" ? 0 : -1}
                              // The accessible name STARTS WITH the visible
                              // label ("BSC: <name>") so it satisfies WCAG
                              // 2.5.3 Label in Name — a speech-input user
                              // saying "click BSC: <name>" has to match what
                              // is actually announced.
                              aria-label={`BSC: ${m.nameConflict.bsc} — use this name for #${m.card.cardNumber}`}
                              onClick={() =>
                                dispatch({
                                  type: "CHOOSE_NAME",
                                  index: i,
                                  side: "bsc",
                                })
                              }
                              className={`text-xs rounded px-2 py-1.5 ${
                                m.nameConflict.chosen === "bsc"
                                  ? "bg-cyan-900/60 text-cyan-100 ring-2 ring-[#00B7FF]"
                                  : "bg-gray-700/60 text-gray-300"
                              }`}
                            >
                              {/* 1.4.1 Use of Color — the cyan/gray fill pair
                                  differs by hue only (~1:1 lightness
                                  contrast), indistinguishable to a
                                  colour-blind operator deciding which name
                                  wins. The checkmark + ring give a non-colour
                                  cue for the state colour alone was carrying. */}
                              {m.nameConflict.chosen === "bsc" && (
                                <span aria-hidden="true">✓ </span>
                              )}
                              BSC: {m.nameConflict.bsc}
                            </button>
                            <button
                              type="button"
                              role="radio"
                              aria-checked={
                                m.nameConflict.chosen === "sportlots"
                              }
                              tabIndex={
                                m.nameConflict.chosen === "sportlots" ? 0 : -1
                              }
                              aria-label={`SportLots: ${m.nameConflict.sportlots} — use this name for #${m.card.cardNumber}`}
                              onClick={() =>
                                dispatch({
                                  type: "CHOOSE_NAME",
                                  index: i,
                                  side: "sportlots",
                                })
                              }
                              className={`text-xs rounded px-2 py-1.5 ${
                                m.nameConflict.chosen === "sportlots"
                                  ? "bg-cyan-900/60 text-cyan-100 ring-2 ring-[#00B7FF]"
                                  : "bg-gray-700/60 text-gray-300"
                              }`}
                            >
                              {m.nameConflict.chosen === "sportlots" && (
                                <span aria-hidden="true">✓ </span>
                              )}
                              SportLots: {m.nameConflict.sportlots}
                            </button>
                            {/* The operator's own name, once they have typed
                                one that is neither marketplace's. Rendered on
                                the SAME `custom !== undefined` condition the
                                reducer guards `CHOOSE_NAME side:"custom"` and
                                the arrow-key cycle on, so "every option in the
                                group is reachable and exactly one is checked"
                                holds by construction rather than by three
                                places agreeing. Identical semantics to the two
                                above — role, roving tabindex, label-in-name
                                aria-label, non-colour ✓ cue. */}
                            {m.nameConflict.custom !== undefined && (
                              <button
                                type="button"
                                role="radio"
                                aria-checked={m.nameConflict.chosen === "custom"}
                                tabIndex={
                                  m.nameConflict.chosen === "custom" ? 0 : -1
                                }
                                aria-label={`Custom: ${m.nameConflict.custom} — use this name for #${m.card.cardNumber}`}
                                onClick={() =>
                                  dispatch({
                                    type: "CHOOSE_NAME",
                                    index: i,
                                    side: "custom",
                                  })
                                }
                                className={`text-xs rounded px-2 py-1.5 ${
                                  m.nameConflict.chosen === "custom"
                                    ? "bg-cyan-900/60 text-cyan-100 ring-2 ring-[#00B7FF]"
                                    : "bg-gray-700/60 text-gray-300"
                                }`}
                              >
                                {m.nameConflict.chosen === "custom" && (
                                  <span aria-hidden="true">✓ </span>
                                )}
                                Custom: {m.nameConflict.custom}
                              </button>
                            )}
                          </div>
                        </div>
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
            {!nothingToReconcile && (
            <DndContext
              sensors={sensors}
              collisionDetection={pointerWithin}
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
              {(state.unmatchedBsc.length > 0 ||
                state.unmatchedSl.length > 0) && (
                <p className="text-xs text-gray-500 mb-2">
                  Drag a card onto its match in the other column to link them
                  (or click one, then click its match).
                </p>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <section>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-gray-200">
                    BSC only ({state.unmatchedBsc.length})
                  </h3>
                  <button
                    type="button"
                    className="text-xs text-gray-400 hover:text-cyan-300 disabled:opacity-40 px-2 py-1.5"
                    disabled={state.unmatchedBsc.length === 0}
                    onClick={() => {
                      dispatch({ type: "KEEP_ALL", side: "bsc" });
                      refocus(bscFilterRef.current);
                    }}
                    aria-label="Keep all BSC-only cards"
                  >
                    Keep all
                  </button>
                </div>
                <Input
                  bare
                  ref={bscFilterRef}
                  className={`${bscFieldClass()} w-full`}
                  type="text"
                  value={bscFilter}
                  onChange={(e) => setBscFilter(e.target.value)}
                  placeholder="Filter BSC cards"
                  aria-label="Filter BSC cards"
                />
                <ul className="flex flex-col gap-1 mt-2">
                  {visibleBsc.map((c) => (
                    <PairableRow
                      key={candidateKey(c)}
                      side="bsc"
                      cardKey={candidateKey(c)}
                    >
                      <button
                        type="button"
                        className={`flex-1 text-left text-sm rounded px-2 py-1 ${
                          selectedBsc === candidateKey(c)
                            ? "bg-cyan-900/60 text-cyan-100"
                            : "bg-gray-800/60 text-gray-200"
                        }`}
                        onClick={() =>
                          setSelectedBsc(
                            selectedBsc === candidateKey(c) ? null : candidateKey(c),
                          )
                        }
                        // Selection was conveyed by background colour alone.
                        aria-pressed={selectedBsc === candidateKey(c)}
                        aria-label={
                          selectedBsc === candidateKey(c)
                            ? `${label(c)}, selected. Press to deselect.`
                            : `Select BSC card ${label(c)}`
                        }
                      >
                        {label(c)}
                      </button>
                      <button
                        type="button"
                        className="text-xs text-gray-400 hover:text-cyan-300 px-2 py-1.5"
                        onClick={() => {
                          dispatch({
                            type: "KEEP",
                            side: "bsc",
                            key: candidateKey(c),
                          });
                          refocus(bscFilterRef.current);
                        }}
                        aria-label={`Keep ${label(c)} as BSC-only`}
                      >
                        Keep
                      </button>
                    </PairableRow>
                  ))}
                </ul>
              </section>

              <section>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-gray-200">
                    SportLots only ({state.unmatchedSl.length})
                  </h3>
                  <button
                    type="button"
                    className="text-xs text-gray-400 hover:text-cyan-300 disabled:opacity-40 px-2 py-1.5"
                    disabled={state.unmatchedSl.length === 0}
                    onClick={() => {
                      dispatch({ type: "KEEP_ALL", side: "sl" });
                      refocus(slFilterRef.current);
                    }}
                    aria-label="Keep all SportLots-only cards"
                  >
                    Keep all
                  </button>
                </div>
                <Input
                  bare
                  ref={slFilterRef}
                  className={`${slFieldClass()} w-full`}
                  type="text"
                  value={slFilter}
                  onChange={(e) => setSlFilter(e.target.value)}
                  placeholder="Filter SportLots cards"
                  aria-label="Filter SportLots cards"
                />
                <ul className="flex flex-col gap-1 mt-2">
                  {visibleSl.map((c) => (
                    <PairableRow
                      key={candidateKey(c)}
                      side="sl"
                      cardKey={candidateKey(c)}
                    >
                      <button
                        type="button"
                        disabled={!selectedBsc}
                        className="flex-1 text-left text-sm rounded px-2 py-1 bg-gray-800/60 text-gray-200 disabled:opacity-60"
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
                      <button
                        type="button"
                        className="text-xs text-gray-400 hover:text-cyan-300 px-2 py-1.5"
                        onClick={() => {
                          dispatch({
                            type: "KEEP",
                            side: "sl",
                            key: candidateKey(c),
                          });
                          refocus(slFilterRef.current);
                        }}
                        aria-label={`Keep ${label(c)} as SportLots-only`}
                      >
                        Keep
                      </button>
                    </PairableRow>
                  ))}
                </ul>
              </section>
              </div>

              {/* Matches ReconciliationModal / ParallelGroupingModal exactly —
                  the same card, following the cursor. */}
              <DragOverlay>
                {activeDragLabel && (
                  <div className="px-3 py-2 rounded-lg border bg-gray-800 border-[#00B7FF] ring-2 ring-[#00B7FF] shadow-lg text-sm font-medium">
                    <span className="text-gray-200">{activeDragLabel}</span>
                  </div>
                )}
              </DragOverlay>
            </DndContext>
            )}

            {/* Keep shelf — same affordance the set-level dialog has. Hidden
                alongside the columns: with nothing unmatched there is nothing
                that could be kept, so "Nothing kept — every unmatched card
                above will be discarded" describes cards that do not exist. */}
            {!nothingToReconcile && (
            <section className="border-t border-gray-700 pt-3">
              <h3 className="text-sm font-semibold text-gray-200 mb-2">
                Keeping ({state.keptBsc.length + state.keptSl.length})
              </h3>
              {state.keptBsc.length + state.keptSl.length === 0 ? (
                <p className="text-xs text-gray-400 italic">
                  Nothing kept — every unmatched card above will be discarded.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {state.keptBsc.map((c) => (
                    <li
                      key={`kb-${candidateKey(c)}`}
                      className="flex items-center justify-between text-sm text-gray-200"
                    >
                      <span>BSC: {label(c)}</span>
                      <button
                        type="button"
                        className="text-xs text-gray-400 hover:text-red-400 px-2 py-1.5"
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
                    </li>
                  ))}
                  {state.keptSl.map((c) => (
                    <li
                      key={`ks-${candidateKey(c)}`}
                      className="flex items-center justify-between text-sm text-gray-200"
                    >
                      <span>SL: {label(c)}</span>
                      <button
                        type="button"
                        className="text-xs text-gray-400 hover:text-red-400 px-2 py-1.5"
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
                    </li>
                  ))}
                </ul>
              )}
            </section>
            )}
          </div>

          <footer className="p-4 border-t border-gray-700 flex items-center justify-between">
            <span className="text-xs text-gray-400">
              {totalToSave} card{totalToSave === 1 ? "" : "s"} will be saved
            </span>
            <div className="flex gap-2">
              <NeonButton
                secondary
                size="2"
                onClick={onClose}
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
                // keeps it reachable; handleConfirm's own isStreaming guard
                // (above) makes activating it a no-op, so this is safe.
                disabled={confirming}
                aria-disabled={isStreaming || undefined}
                // Ties the reason to the control itself so it's available the
                // moment Confirm receives focus, rather than depending on the
                // operator having caught the aria-live banner when it first
                // appeared (or on every re-announcement as progress ticks).
                aria-describedby={
                  isStreaming ? "pairing-streaming-status" : undefined
                }
                aria-label="Confirm card matches"
                title={
                  isStreaming
                    ? "Still loading cards — confirming now would save only what has arrived"
                    : undefined
                }
              >
                {confirming
                  ? "Saving…"
                  : isStreaming
                    ? "Loading…"
                    : "Confirm"}
              </NeonButton>
            </div>
          </footer>
        </div>
      </div>
    </Theme>,
    document.body,
  );
}
