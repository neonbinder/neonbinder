import { describe, expect, test } from "vitest";
import {
  canRetryPhoto,
  cardLabel,
  columnsClear,
  failedText,
  MAX_PHOTO_RETRIES,
  photoLine,
  photoNews,
  photoStates,
  runSummary,
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

describe("NEO-411: failed photos end, and can be sent again", () => {
  test("Try again is offered on a failed photo until it has had its tries", () => {
    expect(canRetryPhoto({ status: "failed" })).toBe(true);
    expect(canRetryPhoto({ status: "failed", retries: MAX_PHOTO_RETRIES - 1 })).toBe(true);
    expect(canRetryPhoto({ status: "failed", retries: MAX_PHOTO_RETRIES })).toBe(false);
    expect(canRetryPhoto({ status: "processing" })).toBe(false);
    expect(canRetryPhoto({ status: "done" })).toBe(false);
  });

  test("the failure reads as the collector's words, and says what to do when no retry is left", () => {
    expect(failedText({ errorCode: "PHOTO_TIMED_OUT" }, true)).toBe("Took too long to read");
    expect(failedText({ errorCode: "PROCESS_ENTRY_FAILED" }, true)).toBe("Couldn't read it");
    expect(failedText({ errorCode: "PHOTO_TIMED_OUT" }, false)).toBe("Took too long to read. Scan it again.");
    expect(failedText({}, false)).toBe("Couldn't read it. Scan it again.");
  });

  test("the run summary never calls a run with failed photos fully read", () => {
    const base = { loading: false, working: 0, waiting: 0, saved: 0, unread: 0 };
    expect(runSummary({ ...base, loading: true })).toBe("Loading this run…");
    expect(runSummary({ ...base, working: 1, waiting: 2, saved: 3 })).toBe(
      "Working on 1 photo. 2 waiting for you, 3 saved.",
    );
    expect(runSummary({ ...base, working: 2, unread: 1 })).toBe(
      "Working on 2 photos. 0 waiting for you, 0 saved. 1 photo couldn't be read.",
    );
    expect(runSummary({ ...base, waiting: 2, saved: 1 })).toBe("Everything is read. 2 waiting for you, 1 saved.");
    expect(runSummary({ ...base, waiting: 2, saved: 1, unread: 2 })).toBe(
      "Done reading. 2 waiting for you, 1 saved. 2 photos couldn't be read.",
    );
    expect(runSummary({ ...base, saved: 4 })).toBe("4 saved.");
    expect(runSummary({ ...base, saved: 4, unread: 1 })).toBe("4 saved. 1 photo couldn't be read.");
  });
});

describe("NEO-370: leaving after Done waits for the columns", () => {
  const lanes = { reading: [] as number[], loose: [] as number[], matching: [] as number[], review: [] as number[] };
  test("clear only when every column but Saved is empty", () => {
    expect(columnsClear(lanes as never)).toBe(true);
    for (const lane of ["reading", "loose", "matching", "review"] as const) {
      expect(columnsClear({ ...lanes, [lane]: [1] } as never)).toBe(false);
    }
  });
});

describe("NEO-427: a Saved tile's photos", () => {
  const saved = (i: number, extra: Partial<IntakeMatchRow>) =>
    match(i, i + 1, {
      savedAt: 1,
      card: { _id: `c${i}`, cardNumber: String(i), cardName: `Player ${i}` } as IntakeMatchRow["card"],
      ...extra,
    });

  test("each state has its words; a pair saved before photos came along has none", () => {
    expect(photoLine(saved(0, { photos: "pending" }))).toBe("Slipping in the photos…");
    expect(photoLine(saved(0, { photos: "attached" }))).toBe("Photos are in!");
    expect(photoLine(saved(0, { photos: "failed", photoFailure: "error" }))).toBe("Photos didn't stick.");
    expect(photoLine(saved(0, { photos: "failed", photoFailure: "scanGone" }))).toBe("The scans aged out.");
    expect(photoLine(saved(0, { photos: "failed", photoFailure: "unusable" }))).toBe("These scans won't cut it.");
    expect(photoLine(saved(0, {}))).toBeNull();
  });

  test("news says what changed, by name for one and by count for many", () => {
    const pending = [saved(0, { photos: "pending" }), saved(2, { photos: "pending" }), saved(4, { photos: "pending" })];
    const before = photoStates(pending);
    expect(photoNews(before, pending)).toBe("");
    expect(photoNews(before, [saved(0, { photos: "attached" }), pending[1], pending[2]])).toBe(
      "Photos are in for #0 Player 0.",
    );
    expect(photoNews(before, [saved(0, { photos: "attached" }), saved(2, { photos: "attached" }), pending[2]])).toBe(
      "Photos are in for 2 cards.",
    );
    expect(
      photoNews(before, [
        saved(0, { photos: "attached" }),
        saved(2, { photos: "failed", photoFailure: "error", photoCanRetry: true }),
        saved(4, { photos: "failed", photoFailure: "scanGone" }),
      ]),
    ).toBe(
      "Photos are in for #0 Player 0. Photos didn't stick on #2 Player 2. Try again from its tile in Saved. The scans for #4 Player 4 aged out. Add a photo from its tile in Saved.",
    );
    expect(
      photoNews(before, [
        saved(0, { photos: "failed", photoFailure: "error", photoCanRetry: true }),
        saved(2, { photos: "failed", photoFailure: "error", photoCanRetry: true }),
        saved(4, { photos: "pending" }),
      ]),
    ).toBe("Photos didn't stick on 2 cards. Try again from their tiles in Saved.");
    expect(
      photoNews(before, [
        saved(0, { photos: "failed", photoFailure: "scanGone" }),
        saved(2, { photos: "failed", photoFailure: "scanGone" }),
        saved(4, { photos: "pending" }),
      ]),
    ).toBe("The scans for 2 cards aged out. Add photos from their tiles in Saved.");
    expect(
      photoNews(before, [
        saved(0, { photos: "failed", photoFailure: "unusable" }),
        saved(2, { photos: "failed", photoFailure: "error" }),
        pending[2],
      ]),
    ).toBe(
      "Photos didn't stick on #2 Player 2. Add a photo from its tile in Saved. The scans for #0 Player 0 won't cut it. Add a photo from its tile in Saved.",
    );
    expect(
      photoNews(before, [
        saved(0, { photos: "failed", photoFailure: "unusable" }),
        saved(2, { photos: "failed", photoFailure: "unusable" }),
        saved(4, { photos: "failed", photoFailure: "error" }),
      ]),
    ).toBe(
      "Photos didn't stick on #4 Player 4. Add a photo from its tile in Saved. The scans for 2 cards won't cut it. Add photos from their tiles in Saved.",
    );
    expect(
      photoNews(before, [
        saved(0, { photos: "failed", photoFailure: "error" }),
        saved(2, { photos: "failed", photoFailure: "error" }),
        pending[2],
      ]),
    ).toBe("Photos didn't stick on 2 cards. Add photos from their tiles in Saved.");
  });

  test("a row seen for the first time says nothing, so opening a finished run stays quiet", () => {
    expect(photoNews(new Map(), [saved(0, { photos: "attached" })])).toBe("");
  });

  test("going back to pending (Try again) says nothing: focus lands on the line itself", () => {
    const failed = [saved(0, { photos: "failed", photoFailure: "error" })];
    expect(photoNews(photoStates(failed), [saved(0, { photos: "pending" })])).toBe("");
  });
});
