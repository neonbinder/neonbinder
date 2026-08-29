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
import NeonButton from "../modules/NeonButton";
import { Input } from "../primitives/Input";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";
import { compareCardNumbers } from "@/lib/cards/card-number";

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
 * This lives on the PAIR, not on the card: `previewCardValidator` is a strict
 * `v.object`, so an extra field on a confirmed card would be rejected by
 * `resolveEntities` on the way to commit. Nothing here crosses that boundary —
 * only `m.card` is handed to `onConfirm`.
 */
type NameConflict = {
  /** BSC's name for the card, exactly as that marketplace spelled it. */
  bsc: string;
  /** SportLots' name for the same card, likewise verbatim. */
  sportlots: string;
  /** Whose name the merged card is carrying right now. */
  chosen: "bsc" | "sportlots";
};

type MatchedPair = {
  card: PairingCard;
  confidence: number;
  /**
   * Set only for pairs merged HERE, by `LINK`. An auto-matched pair arrives
   * from `fetchCardChecklist` already merged, with the losing name discarded
   * server-side, so there is nothing left for this to compare — see the note
   * on `nameConflictOf`.
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
  | { type: "CHOOSE_NAME"; index: number; side: "bsc" | "sportlots" }
  | { type: "KEEP"; side: "bsc" | "sl"; cardNumber: string }
  | { type: "KEEP_ALL"; side: "bsc" | "sl" }
  | { type: "UNKEEP"; side: "bsc" | "sl"; cardNumber: string }
  // NEO-195: more candidates arrived while the operator is already working.
  | {
      type: "ABSORB";
      autoMatched: MatchedPair[];
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
 */
function ordered(state: State): State {
  const byNumber = (a: PairingCard, b: PairingCard) =>
    compareCardNumbers(a.cardNumber, b.cardNumber);
  return {
    matched: [...state.matched].sort((a, b) => byNumber(a.card, b.card)),
    unmatchedBsc: [...state.unmatchedBsc].sort(byNumber),
    unmatchedSl: [...state.unmatchedSl].sort(byNumber),
    keptBsc: [...state.keptBsc].sort(byNumber),
    keptSl: [...state.keptSl].sort(byNumber),
  };
}

function reducer(state: State, action: Action): State {
  const next = baseReducer(state, action);
  // A no-op action returns the same reference; do not churn the list for it.
  return next === state ? state : ordered(next);
}

/**
 * Compare two marketplace names for MEANING rather than spelling.
 *
 * BSC joins multiple players with " / " and SportLots with "|"; one prints
 * "Ken Griffey Jr." and the other "Ken Griffey Jr"; BSC routinely strips the
 * accents SportLots keeps ("Jose"/"Jos\u00e9 Ram\u00edrez"). Flagging any of those as a
 * disagreement would bury the real ones under noise, and a warning nobody
 * reads is the same as no warning. Diacritics are folded, then everything that
 * is not a letter or digit collapses to a single space, so only the words
 * themselves are compared.
 *
 * Word ORDER is deliberately still significant: two sources listing the same
 * players in a different order on a multi-player card is worth a glance, and
 * this control costs a glance, not a click.
 */
function nameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Do these two candidates disagree about the card's name?
 *
 * Applies to EVERY merged pair, not only `isVariation` ones. Two reasons the
 * narrower variation-only scope was rejected:
 *
 *  1. The wrong-player-on-a-listing failure is not exclusive to variations. A
 *     fuzzy 0.92 Jaro-Winkler auto-match, or an operator clicking one row off
 *     in a 660-row column, merges two genuinely different players into one
 *     card — and the name disagreement is the ONLY signal that the mis-click
 *     happened. Suppressing it there throws away the cheapest mis-pair
 *     detector this screen has.
 *  2. `isVariation` is exactly the field that is unreliable on the row that
 *     motivated this. BSC filed #227c with an EMPTY variation description;
 *     gating on a flag the defect report shows to be under-populated risks the
 *     fix not firing on its own motivating example.
 *
 * The cost of the wider scope is bounded because this is not a gate: a correct
 * pairing agrees on the name almost always, and a false positive costs one
 * glance.
 *
 * A side with no name at all is not a disagreement — there is nothing to
 * decide, and `mergePair` already falls through to whichever side has one.
 */
function nameConflictOf(
  bsc: PairingCard,
  sl: PairingCard,
): NameConflict | undefined {
  const b = (bsc.cardName ?? "").trim();
  const s = (sl.cardName ?? "").trim();
  if (!b || !s) return undefined;
  if (nameKey(b) === nameKey(s)) return undefined;
  // `chosen` starts on BSC because that is what `mergePair` produces when both
  // sides have a name. It is a DEFAULT, not a decision — which is the whole
  // reason the row has to say so out loud.
  return { bsc: b, sportlots: s, chosen: "bsc" };
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
     * The fetch streams, so the modal opens on the first complete stem group
     * and keeps receiving more. This must APPEND ONLY: whatever the operator
     * has already linked, unlinked or kept stays exactly as they left it. A
     * card is new if no bucket — including the kept shelves — already holds its
     * ref.
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
      if (!newMatched.length && !newBsc.length && !newSl.length) return state;

      return {
        ...state,
        matched: [...state.matched, ...newMatched],
        unmatchedBsc: [...state.unmatchedBsc, ...newBsc],
        unmatchedSl: [...state.unmatchedSl, ...newSl],
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
        action.side === "bsc" ? conflict.bsc : conflict.sportlots;
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
    case "KEEP": {
      const from = action.side === "bsc" ? state.unmatchedBsc : state.unmatchedSl;
      const idx = from.findIndex((c) => c.cardNumber === action.cardNumber);
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
      const idx = from.findIndex((c) => c.cardNumber === action.cardNumber);
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
    autoMatched: MatchedPair[];
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
      matched: initialData.autoMatched,
      unmatchedBsc: initialData.unmatchedBsc,
      unmatchedSl: initialData.unmatchedSl,
      keptBsc: [],
      keptSl: [],
    }),
  );
  const [selectedBsc, setSelectedBsc] = useState<string | null>(null);
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
      autoMatched: initialData.autoMatched,
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
   * radiogroup, by card number rather than by ref or array index: the
   * radiogroup's own arrow-key handler dispatches CHOOSE_NAME first, and by
   * the time this runs the DOM has to be re-queried anyway (the CHOSEN radio
   * — the one that must end up focused — only exists post-render), and
   * `state.matched` is re-sorted by `ordered()` after every dispatch, so a
   * captured index or element ref from before the dispatch cannot be trusted
   * to still point at the same row afterward.
   */
  const refocusSelectedRadio = useCallback((cardNumber: string) => {
    requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>(
          `[data-name-conflict="${cardNumber}"] [role="radio"][tabindex="0"]`,
        )
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
                  {state.matched.map((m, i) => (
                    <li
                      key={`${m.card.cardNumber}-${i}`}
                      className="flex flex-col gap-1 text-sm text-gray-200 bg-gray-800/60 rounded px-2 py-1"
                    >
                      <div className="flex items-center justify-between">
                        <span>
                          {label(m.card)}
                          {m.confidence > 0 && m.confidence < 1 && (
                            <span className="text-xs text-amber-400 ml-2">
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
                          aria-label={`Name conflict on #${m.card.cardNumber}`}
                          className="flex flex-wrap items-center gap-2 border-l-2 border-[#FF2EB3] pl-2 py-1"
                          // a11y — lets both the LINK handler (below) and the
                          // radiogroup's own arrow-key handler find this row's
                          // controls by card number after a dispatch, without
                          // depending on `i`, which `ordered()` can reshuffle.
                          data-name-conflict={m.card.cardNumber}
                        >
                          <span
                            id={`name-conflict-warning-${m.card.cardNumber}`}
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
                            aria-label={`Name for #${m.card.cardNumber}`}
                            aria-describedby={`name-conflict-warning-${m.card.cardNumber}`}
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
                              // Only two options, so either arrow direction
                              // just toggles — the APG pattern moves focus
                              // WITH selection on a single-select radio group.
                              e.preventDefault();
                              const other =
                                m.nameConflict!.chosen === "bsc"
                                  ? "sportlots"
                                  : "bsc";
                              dispatch({
                                type: "CHOOSE_NAME",
                                index: i,
                                side: other,
                              });
                              refocusSelectedRadio(m.card.cardNumber);
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
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Unmatched columns — omitted entirely when both are empty.
                Two headers reading "(0)" over two dead filter inputs is not
                information; it just buries the matched list the operator
                actually came to review. */}
            {!nothingToReconcile && (
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
                    <li key={c.cardNumber} className="flex items-center gap-2">
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
                            cardNumber: c.cardNumber,
                          });
                          refocus(bscFilterRef.current);
                        }}
                        aria-label={`Keep ${label(c)} as BSC-only`}
                      >
                        Keep
                      </button>
                    </li>
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
                    <li key={c.cardNumber} className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={!selectedBsc}
                        className="flex-1 text-left text-sm rounded px-2 py-1 bg-gray-800/60 text-gray-200 disabled:opacity-60"
                        onClick={() => {
                          if (!selectedBsc) return;
                          // NEO-189: a conflict the operator cannot see is the
                          // defect itself. Manual pairing always happens with
                          // the Matched section collapsed (it collapses by
                          // default whenever a column has anything in it,
                          // which is necessarily true while linking), so open
                          // it the moment a link creates a disagreement.
                          // Only ever opens — never closes a section the
                          // operator deliberately expanded.
                          const bscSide = state.unmatchedBsc.find(
                            (x) => candidateKey(x) === selectedBsc,
                          );
                          const createsConflict =
                            bscSide && nameConflictOf(bscSide, c);
                          if (createsConflict) {
                            setMatchedCollapsed(false);
                          }
                          dispatch({
                            type: "LINK",
                            bscKey: selectedBsc,
                            slKey: candidateKey(c),
                          });
                          setSelectedBsc(null);
                          // a11y (NEO-189 audit) — this button (and the whole
                          // <li> it lives in) is about to unmount: it just
                          // moved from unmatchedSl into matched. Left alone,
                          // that drops focus to <body> at the exact moment a
                          // brand-new decision (which name to keep) appears
                          // for the operator to make — worse than the
                          // ordinary silent-focus-loss case, and worth fixing
                          // here rather than filing separately, since the
                          // conflict is what makes the dropped focus consequential.
                          if (createsConflict && bscSide) {
                            refocusSelectedRadio(bscSide.cardNumber);
                          }
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
                            cardNumber: c.cardNumber,
                          });
                          refocus(slFilterRef.current);
                        }}
                        aria-label={`Keep ${label(c)} as SportLots-only`}
                      >
                        Keep
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
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
                      key={`kb-${c.cardNumber}`}
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
                            cardNumber: c.cardNumber,
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
                      key={`ks-${c.cardNumber}`}
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
                            cardNumber: c.cardNumber,
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
