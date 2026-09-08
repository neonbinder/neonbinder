/**
 * NEO-255 — the one mapping from a streamed candidate to a `PairingCard`.
 *
 * It was a closure inside `CardChecklist`'s `streamedPairing` memo until the
 * auto-keep path (exactly one marketplace attached, no dialog) needed to build
 * the same cards from the same rows. Two copies of this mapping is the shape
 * that drifts — NEO-199 and NEO-251 each added a field to one and had to chase
 * it into the other — so these tests pin the two properties that make one copy
 * safe: every field survives, and the committable form drops exactly the two
 * fields the dialog would have lifted off before Confirm.
 *
 * Pure functions, no Convex, no React.
 */

import { describe, expect, test } from "vitest";
import {
  candidateToPairingCard,
  candidatesToPairingCards,
  type ReadyCandidate,
} from "./pairing-cards";

/** Every optional field populated, so a dropped one is visible. */
const FULL: ReadyCandidate = {
  cardNumber: "11",
  cardName: "Ken Griffey Jr.",
  teams: ["Mariners"],
  players: ["Ken Griffey Jr."],
  attributes: ["Rookie"],
  isRookie: true,
  isRelic: false,
  printRun: 199,
  autographType: "On-card",
  cardVariation: "Photo Variation",
  isVariation: true,
  platformData: {
    bsc: { ref: "bsc-11", setId: "2024-topps" },
    sportlots: { ref: "#11 Ken Griffey Jr.", setId: "884412" },
  },
  nameConflict: { bsc: "Ken Griffey Jr.", sportlots: "Ken Griffey" },
  playersConflict: {
    bsc: ["Ken Griffey Jr."],
    sportlots: ["Ken Griffey"],
    preferred: "sportlots",
  },
  bucket: "matched",
};

describe("candidateToPairingCard", () => {
  test("carries every field the dialog reads, disagreements included", () => {
    expect(candidateToPairingCard(FULL)).toEqual({
      cardNumber: "11",
      cardName: "Ken Griffey Jr.",
      teams: ["Mariners"],
      players: ["Ken Griffey Jr."],
      attributes: ["Rookie"],
      isRookie: true,
      isRelic: false,
      printRun: 199,
      autographType: "On-card",
      cardVariation: "Photo Variation",
      isVariation: true,
      platformData: FULL.platformData,
      nameConflict: FULL.nameConflict,
      playersConflict: FULL.playersConflict,
      // A matched pair is missing nothing.
      unmatched: undefined,
    });
  });

  test("reads the bucket from the OTHER end: bscOnly is missing SportLots", () => {
    // The direction is the thing to get right — this value becomes the
    // `unmatched-<side>` attribute on the committed card and the badge on its
    // row, so a flipped bucket labels every kept single with the wrong
    // marketplace.
    expect(candidateToPairingCard({ ...FULL, bucket: "bscOnly" }).unmatched).toBe(
      "sl",
    );
    expect(candidateToPairingCard({ ...FULL, bucket: "slOnly" }).unmatched).toBe(
      "bsc",
    );
    expect(candidateToPairingCard({ ...FULL, bucket: "matched" }).unmatched).toBe(
      undefined,
    );
  });

  test("a sparse candidate stays sparse — nothing is invented", () => {
    const card = candidateToPairingCard({
      cardNumber: "1",
      cardName: "Rookie Card",
      platformData: { sportlots: { ref: "#1 Rookie Card" } },
      bucket: "slOnly",
    });
    expect(card.teams).toBeUndefined();
    expect(card.players).toBeUndefined();
    expect(card.isVariation).toBeUndefined();
    expect(card.printRun).toBeUndefined();
    expect(card.unmatched).toBe("bsc");
  });
});

describe("candidatesToPairingCards", () => {
  test("produces COMMITTABLE cards — no conflicts ride along", () => {
    // `commitCardChecklist` throws on a card still carrying `playersConflict`,
    // because a card being written has one answer rather than an open
    // question. The dialog lifts them onto the pair; this path has no pair to
    // lift them onto, so it drops them.
    const [card] = candidatesToPairingCards([{ ...FULL, bucket: "bscOnly" }]);
    expect(card.nameConflict).toBeUndefined();
    expect(card.playersConflict).toBeUndefined();
    expect("nameConflict" in card).toBe(false);
    expect("playersConflict" in card).toBe(false);
  });

  test("everything else is identical to the dialog's own mapping", () => {
    const candidate: ReadyCandidate = { ...FULL, bucket: "slOnly" };
    const viaDialog = candidateToPairingCard(candidate);
    delete viaDialog.nameConflict;
    delete viaDialog.playersConflict;
    expect(candidatesToPairingCards([candidate])).toEqual([viaDialog]);
  });

  test("keeps every row, in order", () => {
    const cards = candidatesToPairingCards([
      { ...FULL, cardNumber: "1", bucket: "bscOnly" },
      { ...FULL, cardNumber: "2", bucket: "bscOnly" },
      { ...FULL, cardNumber: "3", bucket: "bscOnly" },
    ]);
    expect(cards.map((c) => c.cardNumber)).toEqual(["1", "2", "3"]);
    expect(cards.every((c) => c.unmatched === "sl")).toBe(true);
  });

  test("an empty batch maps to an empty array", () => {
    expect(candidatesToPairingCards([])).toEqual([]);
  });
});
