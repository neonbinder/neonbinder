import { describe, expect, test } from "vitest";
import {
  cardLabel,
  laneOf,
  proposedCount,
  readOf,
  reasonText,
  tileLabel,
  whyNotSave,
  type IntakeImage,
  type IntakeMatchRow,
  type IntakePair,
} from "./realLanes";

/** NEO-382 — every photo of a run sits in exactly one lane. */

const image = (entryIndex: number, status: IntakeImage["status"], extra: Partial<IntakeImage> = {}): IntakeImage =>
  ({ entryIndex, originalName: `scan-${entryIndex}.jpg`, status, ...extra }) as IntakeImage;
const pair = (frontIndex: number, backIndex: number): IntakePair =>
  ({ frontIndex, backIndex, confidence: "exact", mechanism: "adjacency", score: 1, createdAt: 0 }) as IntakePair;
const match = (frontIndex: number, backIndex: number, extra: Partial<IntakeMatchRow> = {}): IntakeMatchRow =>
  ({
    _id: `m${frontIndex}`,
    pairId: `p${frontIndex}`,
    frontIndex,
    backIndex,
    confidence: 97,
    band: "matched",
    reason: "numberAndPlayer",
    candidates: [],
    variations: [],
    card: null,
    haveHere: 0,
    ...extra,
  }) as IntakeMatchRow;

describe("laneOf", () => {
  test("reading, loose, matching, waiting, saved and set aside", () => {
    const images = [
      image(0, "done"),
      image(1, "done"),
      image(2, "done"),
      image(3, "done"),
      image(4, "done"),
      image(5, "done"),
      image(6, "done"),
      image(7, "done"),
      image(8, "processing"),
      image(9, "awaiting_upload"),
      image(10, "failed"),
      image(11, "done"),
    ];
    const pairs = [pair(0, 1), pair(2, 3), pair(4, 5), pair(6, 7)];
    const matches = [
      match(2, 3),
      match(4, 5, { savedAt: 5, savedQuantity: 1 }),
      match(6, 7, { setAside: true }),
    ];
    const lanes = laneOf(images, pairs, matches);
    expect(lanes.reading.map((i) => i.entryIndex)).toEqual([8, 9]);
    expect(lanes.loose.map((i) => i.entryIndex)).toEqual([10, 11]);
    expect(lanes.matching.map((p) => p.frontIndex)).toEqual([0]);
    expect(lanes.review.map((m) => m.frontIndex)).toEqual([2]);
    expect(lanes.saved.map((m) => m.frontIndex)).toEqual([4]);
    expect(lanes.setAside.map((m) => m.frontIndex)).toEqual([6]);
  });
});

describe("words", () => {
  test("what was read comes from both sides, number from the back first", () => {
    const byIndex = new Map([
      [0, image(0, "done", { players: ["Le'Veon Bell"], cardNumber: "9" })],
      [1, image(1, "done", { players: ["Le'Veon Bell", "Steelers"], cardNumber: "174" })],
    ]);
    expect(readOf(byIndex, 0, 1)).toEqual({ number: "174", players: ["Le'Veon Bell", "Steelers"] });
  });

  test("a number/player conflict says both readings", () => {
    const text = reasonText(match(0, 1, { reason: "numberPlayerConflict" }), { number: "174", players: ["Le'Veon Bell"] });
    expect(text).toContain("#174");
    expect(text).toContain("Le'Veon Bell");
  });

  test("a card label carries its variation", () => {
    expect(cardLabel({ _id: "c" as never, cardNumber: "13", cardName: "Gunnar Henderson", variation: "Sliding" })).toBe(
      "#13 Gunnar Henderson (Sliding)",
    );
    expect(cardLabel(null)).toBe("No card picked");
  });

  test("an unmatched card is named by what was read and which photo, so two never share a name", () => {
    const read = { number: "47", players: ["Le'Veon Bell"] };
    expect(tileLabel({ card: null, frontIndex: 4 }, read)).toBe("Unmatched photo 5, read #47 Le'Veon Bell");
    expect(tileLabel({ card: null, frontIndex: 6 }, { number: null, players: [] })).toBe("Unmatched photo 7");
  });

  test("why a card can't be saved yet", () => {
    expect(whyNotSave({ cardId: undefined })).toBe("Pick which card this is first.");
    expect(whyNotSave({ cardId: "c" as never, repeatOfPairId: "p" as never })).toMatch(/second copy/);
    expect(whyNotSave({ cardId: "c" as never, repeatOfPairId: "p" as never, repeatIsSecondCopy: true })).toBe("");
  });

  test("every reason has words, and the conflict and shared-number ones name the number", () => {
    const read = { number: "7", players: ["Ann"] };
    const reasons = [
      "numberAndPlayer", "numberOnly", "playerUnconfirmed", "numberPlayerConflict", "numberSharedPlayerPicked",
      "numberShared", "numberFuzzy", "playerOnly", "playerShared", "noMatch", "nothingRead", "noVariant", "byUser",
    ] as const;
    for (const reason of reasons) expect(reasonText(match(0, 1, { reason }), read)).toMatch(/\w/);
    expect(reasonText(match(0, 1, { reason: "numberShared" }), read)).toContain("#7");
  });

  test("the proposed count is what's here plus this scan", () => {
    expect(proposedCount({ haveHere: 3 })).toBe(4);
  });
});
