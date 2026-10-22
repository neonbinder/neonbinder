import { describe, expect, test } from "vitest";
import {
  buildPairingResult,
  openPairingConflicts,
  pairingReducer,
  seedPairingState,
  type PairingCard,
} from "./pairing";

const paired = (cardNumber: string, extra: Partial<PairingCard> = {}): PairingCard => ({
  cardNumber,
  cardName: "Mike Yastrzemski",
  platformData: {
    bsc: { ref: `bsc-${cardNumber}`, setId: "b-set" },
    sportlots: { ref: `#${cardNumber} sl`, setId: "s-set" },
  },
  ...extra,
});

const both = () =>
  seedPairingState({
    autoMatched: [
      {
        card: paired("227c", {
          players: ["Mike Yastrzemski"],
          nameConflict: { bsc: "Mike Yastrzemski", sportlots: "Carl Yastrzemski" },
          playersConflict: { bsc: ["Mike Yastrzemski"], sportlots: ["Carl Yastrzemski"] },
        }),
        confidence: 1,
      },
      { card: paired("1", { cardName: "Ken Griffey Jr." }), confidence: 1 },
    ],
    unmatchedBsc: [],
    unmatchedSl: [],
  });

describe("openPairingConflicts — the Confirm gate the dialog and the tool share (NEO-339)", () => {
  test("every disagreement on a matched pair is open until answered, per field", () => {
    const state = both();
    const i = state.matched.findIndex((m) => m.card.cardNumber === "227c");
    expect(openPairingConflicts(state)).toEqual([
      { index: i, field: "name", cardNumber: "227c" },
      { index: i, field: "players", cardNumber: "227c" },
    ]);
  });

  test("answering one field leaves the other open", () => {
    let state = both();
    const i = state.matched.findIndex((m) => m.card.cardNumber === "227c");
    state = pairingReducer(state, { type: "CHOOSE_NAME", index: i, side: "sportlots" });
    expect(openPairingConflicts(state).map((c) => c.field)).toEqual(["players"]);
  });

  test("re-picking the side already carried (BSC, the merge's default) is an answer", () => {
    let state = both();
    const i = state.matched.findIndex((m) => m.card.cardNumber === "227c");
    state = pairingReducer(state, { type: "CHOOSE_NAME", index: i, side: "bsc" });
    state = pairingReducer(state, { type: "CHOOSE_PLAYERS", index: i, side: "bsc" });
    expect(openPairingConflicts(state)).toEqual([]);
    // And the answered row is a decision, so nothing travels for the diff.
    expect(buildPairingResult(state).conflictsByIndex).toEqual({});
  });

  test("a typed name or roster answers its field", () => {
    let state = both();
    const i = state.matched.findIndex((m) => m.card.cardNumber === "227c");
    state = pairingReducer(state, { type: "RENAME", index: i, cardName: "Carl Yastrzemski (Legend)" });
    state = pairingReducer(state, { type: "EDIT_PLAYERS", index: i, players: ["Carl Yastrzemski", "Willie Mays"] });
    expect(openPairingConflicts(state)).toEqual([]);
  });

  test("a no-op edit (blank, or the value already carried) answers nothing", () => {
    let state = both();
    const i = state.matched.findIndex((m) => m.card.cardNumber === "227c");
    state = pairingReducer(state, { type: "EDIT_PLAYERS", index: i, players: ["  "] });
    state = pairingReducer(state, { type: "EDIT_PLAYERS", index: i, players: ["Mike Yastrzemski"] });
    state = pairingReducer(state, { type: "RENAME", index: i, cardName: "Mike Yastrzemski" });
    expect(openPairingConflicts(state)).toHaveLength(2);
  });

  test("an untouched row still reports its disagreement through buildPairingResult (the shape the diff reads)", () => {
    const state = both();
    const i = state.matched.findIndex((m) => m.card.cardNumber === "227c");
    expect(buildPairingResult(state).conflictsByIndex[i]).toEqual({
      nameConflict: { bsc: "Mike Yastrzemski", sportlots: "Carl Yastrzemski" },
      playersConflict: { bsc: ["Mike Yastrzemski"], sportlots: ["Carl Yastrzemski"] },
    });
  });

  test("an agreeing set has nothing open", () => {
    const state = seedPairingState({
      autoMatched: [{ card: paired("1", { cardName: "Ken Griffey Jr." }), confidence: 1 }],
      unmatchedBsc: [],
      unmatchedSl: [],
    });
    expect(openPairingConflicts(state)).toEqual([]);
  });
});
