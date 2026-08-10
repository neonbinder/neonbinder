import React, { useCallback, useMemo, useReducer, useState } from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import NeonButton from "../modules/NeonButton";
import { Input } from "../primitives/Input";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";

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
  platformData: {
    bsc?: { ref: string; setId?: string };
    sportlots?: { ref: string; setId?: string };
  };
  unmatched?: "bsc" | "sl";
};

export type PairingResult = { cards: PairingCard[] };

type MatchedPair = { card: PairingCard; confidence: number };

type State = {
  matched: MatchedPair[];
  unmatchedBsc: PairingCard[];
  unmatchedSl: PairingCard[];
  keptBsc: PairingCard[];
  keptSl: PairingCard[];
};

type Action =
  | { type: "LINK"; bscNumber: string; slNumber: string }
  | { type: "UNLINK"; index: number }
  | { type: "KEEP"; side: "bsc" | "sl"; cardNumber: string }
  | { type: "UNKEEP"; side: "bsc" | "sl"; cardNumber: string };

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
    cardVariation: bsc.cardVariation,
    platformData: {
      ...(bsc.platformData.bsc ? { bsc: bsc.platformData.bsc } : {}),
      ...(sl.platformData.sportlots
        ? { sportlots: sl.platformData.sportlots }
        : {}),
    },
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "LINK": {
      const bi = state.unmatchedBsc.findIndex(
        (c) => c.cardNumber === action.bscNumber,
      );
      const si = state.unmatchedSl.findIndex(
        (c) => c.cardNumber === action.slNumber,
      );
      if (bi === -1 || si === -1) return state;
      return {
        ...state,
        matched: [
          ...state.matched,
          {
            card: mergePair(state.unmatchedBsc[bi], state.unmatchedSl[si]),
            // Operator-made pairing: shown as manual rather than scored, so a
            // hand-linked row is never mistaken for a high-confidence guess.
            confidence: 0,
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
        platformData: pair.card.platformData.bsc
          ? { bsc: pair.card.platformData.bsc }
          : {},
        unmatched: "sl",
      };
      const slSide: PairingCard = {
        ...pair.card,
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

function label(card: PairingCard): string {
  return `#${card.cardNumber} ${card.cardName}`.trim();
}

export default function CardPairingModal({
  isOpen,
  onClose,
  onConfirm,
  setLabel,
  initialData,
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
}) {
  const [state, dispatch] = useReducer(reducer, {
    matched: initialData.autoMatched,
    unmatchedBsc: initialData.unmatchedBsc,
    unmatchedSl: initialData.unmatchedSl,
    keptBsc: [],
    keptSl: [],
  });
  const [selectedBsc, setSelectedBsc] = useState<string | null>(null);
  const [bscFilter, setBscFilter] = useState("");
  const [slFilter, setSlFilter] = useState("");
  const [matchedCollapsed, setMatchedCollapsed] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const bscFieldClass = useFieldTestClass();
  const slFieldClass = useFieldTestClass();

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
  }, [confirming, onConfirm, state]);

  if (!isOpen) return null;

  const totalToSave =
    state.matched.length + state.keptBsc.length + state.keptSl.length;

  return createPortal(
    <Theme>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        role="dialog"
        aria-modal="true"
        aria-label="Match cards"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-5xl max-h-[92vh] flex flex-col">
          <header className="p-4 border-b border-gray-700">
            <h2 className="text-lg font-semibold text-gray-100">
              Match Cards{setLabel ? ` — ${setLabel}` : ""}
            </h2>
            <p className="text-xs text-gray-400 mt-1">
              No cards are saved until you confirm. Anything left in a column
              below is discarded — keep a card to save it as
              single-marketplace.
            </p>
          </header>

          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
            {/* Matched */}
            <section>
              <button
                type="button"
                className="text-sm font-semibold text-gray-200 mb-2"
                onClick={() => setMatchedCollapsed((v) => !v)}
                aria-label={`${matchedCollapsed ? "Expand" : "Collapse"} matched cards`}
              >
                {matchedCollapsed ? "▶" : "▼"} Matched ({state.matched.length})
              </button>
              {!matchedCollapsed && (
                <ul className="flex flex-col gap-1">
                  {state.matched.map((m, i) => (
                    <li
                      key={`${m.card.cardNumber}-${i}`}
                      className="flex items-center justify-between text-sm text-gray-200 bg-gray-800/60 rounded px-2 py-1"
                    >
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
                        className="text-xs text-gray-400 hover:text-red-400"
                        onClick={() => dispatch({ type: "UNLINK", index: i })}
                        aria-label={`Unlink ${label(m.card)}`}
                      >
                        Unlink
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Unmatched columns */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <section>
                <h3 className="text-sm font-semibold text-gray-200 mb-2">
                  BSC only ({state.unmatchedBsc.length})
                </h3>
                <Input
                  bare
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
                          selectedBsc === c.cardNumber
                            ? "bg-cyan-900/60 text-cyan-100"
                            : "bg-gray-800/60 text-gray-200"
                        }`}
                        onClick={() =>
                          setSelectedBsc(
                            selectedBsc === c.cardNumber ? null : c.cardNumber,
                          )
                        }
                        aria-label={`Select BSC card ${label(c)}`}
                      >
                        {label(c)}
                      </button>
                      <button
                        type="button"
                        className="text-xs text-gray-400 hover:text-cyan-300"
                        onClick={() =>
                          dispatch({
                            type: "KEEP",
                            side: "bsc",
                            cardNumber: c.cardNumber,
                          })
                        }
                        aria-label={`Keep ${label(c)} as BSC-only`}
                      >
                        Keep
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h3 className="text-sm font-semibold text-gray-200 mb-2">
                  SportLots only ({state.unmatchedSl.length})
                </h3>
                <Input
                  bare
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
                          dispatch({
                            type: "LINK",
                            bscNumber: selectedBsc,
                            slNumber: c.cardNumber,
                          });
                          setSelectedBsc(null);
                        }}
                        aria-label={`Link selected BSC card to ${label(c)}`}
                      >
                        {label(c)}
                      </button>
                      <button
                        type="button"
                        className="text-xs text-gray-400 hover:text-cyan-300"
                        onClick={() =>
                          dispatch({
                            type: "KEEP",
                            side: "sl",
                            cardNumber: c.cardNumber,
                          })
                        }
                        aria-label={`Keep ${label(c)} as SportLots-only`}
                      >
                        Keep
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            </div>

            {/* Keep shelf — same affordance the set-level dialog has. */}
            <section className="border-t border-gray-700 pt-3">
              <h3 className="text-sm font-semibold text-gray-200 mb-2">
                Keeping ({state.keptBsc.length + state.keptSl.length})
              </h3>
              {state.keptBsc.length + state.keptSl.length === 0 ? (
                <p className="text-xs text-gray-500 italic">
                  Nothing kept. Cards left unmatched above are discarded.
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
                        className="text-xs text-gray-400 hover:text-red-400"
                        onClick={() =>
                          dispatch({
                            type: "UNKEEP",
                            side: "bsc",
                            cardNumber: c.cardNumber,
                          })
                        }
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
                        className="text-xs text-gray-400 hover:text-red-400"
                        onClick={() =>
                          dispatch({
                            type: "UNKEEP",
                            side: "sl",
                            cardNumber: c.cardNumber,
                          })
                        }
                        aria-label={`Remove ${label(c)} from save list`}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <footer className="p-4 border-t border-gray-700 flex items-center justify-between">
            <span className="text-xs text-gray-400">
              {totalToSave} card{totalToSave === 1 ? "" : "s"} will be saved
            </span>
            <div className="flex gap-2">
              <NeonButton secondary size="2" onClick={onClose} aria-label="Cancel">
                Cancel
              </NeonButton>
              <NeonButton
                size="2"
                onClick={handleConfirm}
                disabled={confirming}
                aria-label="Confirm card matches"
              >
                {confirming ? "Saving…" : "Confirm"}
              </NeonButton>
            </div>
          </footer>
        </div>
      </div>
    </Theme>,
    document.body,
  );
}
