import { describe, expect, test } from "vitest";
import {
  canRetryPhoto,
  cardLabel,
  columnsClear,
  compareNaturalNames,
  failedText,
  inNaturalOrder,
  MAX_PHOTO_RETRIES,
  photoLabels,
  photoLine,
  photoNews,
  photoStates,
  runSummary,
  laneOf,
  proposedCount,
  readOf,
  reasonText,
  runNotice,
  zipOverLimitLine,
  type NoticeJob,
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
    expect(failedText({ errorCode: "PHOTO_TIMED_OUT" }, false)).toBe("Took too long to read. Send a fresh one.");
    expect(failedText({}, false)).toBe("Couldn't read it. Send a fresh one.");
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

describe("NEO-446: a loose photo set aside", () => {
  const lanes = (...images: IntakeImage[]) => laneOf(images, [], []);

  test("leaves the Pairing lane, done or failed, and sits apart", () => {
    const l = lanes(image(0, "done"), image(1, "done", { setAside: true }), image(2, "failed", { setAside: true }));
    expect(l.loose.map((i) => i.entryIndex)).toEqual([0]);
    expect(l.looseAside.map((i) => i.entryIndex)).toEqual([1, 2]);
  });

  test("clears the columns, as a pair set aside does; brought back, it holds them again", () => {
    expect(columnsClear(lanes(image(0, "failed", { setAside: true })))).toBe(true);
    expect(columnsClear(lanes(image(0, "failed")))).toBe(false);
  });

  test("a photo stored in a pair is the pair's, not the aside list's", () => {
    const pair = { frontIndex: 0, backIndex: 1 } as IntakePair;
    const l = laneOf([image(0, "done", { setAside: true }), image(1, "done")], [pair], []);
    expect(l.looseAside).toEqual([]);
    expect(l.matching).toEqual([pair]);
  });

  test("the empty lanes carry the list too, so the screen can read it before the data lands", () => {
    expect(columnsClear(laneOf([], [], []))).toBe(true);
    expect(laneOf([], [], []).looseAside).toEqual([]);
  });
});

describe("NEO-446: photoLabels", () => {
  test("a unique file name is the label", () => {
    expect(photoLabels([{ entryIndex: 0, originalName: "a.jpg" }]).get(0)).toBe("a.jpg");
  });
  test("photos of one name say which photo they are, and every label differs", () => {
    const labels = photoLabels([
      { entryIndex: 0, originalName: "image.jpg" },
      { entryIndex: 1, originalName: "image.jpg" },
      { entryIndex: 2, originalName: "other.jpg" },
    ]);
    expect([...labels.values()]).toEqual(["image.jpg, photo 1", "image.jpg, photo 2", "other.jpg"]);
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

describe("NEO-446: a photo over the pixel ceiling", () => {
  test("is never offered Try again, whatever its try count", () => {
    expect(canRetryPhoto({ status: "failed", errorCode: "ENTRY_TOO_MANY_PIXELS" })).toBe(false);
    expect(canRetryPhoto({ status: "failed", errorCode: "ENTRY_TOO_MANY_PIXELS", retries: 0 })).toBe(false);
    expect(canRetryPhoto({ status: "failed", errorCode: "PHOTO_TIMED_OUT" })).toBe(true);
    expect(canRetryPhoto({ status: "failed", errorCode: undefined })).toBe(true);
  });

  test("says it is too big and what to do, retry offered or not", () => {
    const line = "Too big (over 64 megapixels). Shrink it and send it again.";
    expect(failedText({ errorCode: "ENTRY_TOO_MANY_PIXELS" }, false)).toBe(line);
    expect(failedText({ errorCode: "ENTRY_TOO_MANY_PIXELS" }, true)).toBe(line);
  });
});

describe("NEO-446: compareNaturalNames and inNaturalOrder", () => {
  const sorted = (names: string[]) => names.sort(compareNaturalNames);

  test("digit runs compare by value: img2 before img10", () => {
    expect(sorted(["img10.jpg", "img2.jpg", "img1.jpg"])).toEqual(["img1.jpg", "img2.jpg", "img10.jpg"]);
    expect(compareNaturalNames("img2", "img10")).toBeLessThan(0);
    expect(compareNaturalNames("img10", "img2")).toBeGreaterThan(0);
  });

  test("case is ignored, and names equal apart from case or leading zeros tie", () => {
    expect(compareNaturalNames("IMG_1.jpg", "img_1.jpg")).toBe(0);
    expect(compareNaturalNames("img007.jpg", "img7.jpg")).toBe(0);
    expect(compareNaturalNames("A2", "b1")).toBeLessThan(0);
  });

  test("fixed-width Pixel names sort in capture order", () => {
    const names = ["PXL_20240101_120000123.jpg", "PXL_20231231_235959999.jpg", "PXL_20240101_090000001.jpg"];
    expect(sorted([...names])).toEqual([names[1], names[2], names[0]]);
  });

  test("a prefix sorts before the longer name; empty first", () => {
    expect(compareNaturalNames("a", "a1")).toBeLessThan(0);
    expect(compareNaturalNames("", "a")).toBeLessThan(0);
    expect(compareNaturalNames("", "")).toBe(0);
  });

  test("a digit run past the safe integer range compares by length, then text", () => {
    const a = "x" + "9".repeat(40);
    const b = "x1" + "0".repeat(40);
    expect(compareNaturalNames(a, b)).toBeLessThan(0);
    expect(compareNaturalNames(b, a)).toBeGreaterThan(0);
    expect(compareNaturalNames("x" + "1".repeat(5000), "x" + "1".repeat(5000))).toBe(0);
  });

  test("mirrors the preprocess service's ordering on the same cases", () => {
    // services/preprocess/app/jobs/zipsafe.py `_natural_sort_key`: split on digit runs, casefold,
    // compare digit runs by (length, text) after stripping leading zeros.
    expect(sorted(["card (10).jpg", "card (9).jpg", "Card (1).jpg"])).toEqual(["Card (1).jpg", "card (9).jpg", "card (10).jpg"]);
    expect(sorted(["2-back.jpg", "10-front.jpg", "1-front.jpg"])).toEqual(["1-front.jpg", "2-back.jpg", "10-front.jpg"]);
    // Text and digit runs alternate, so a name starting with a digit has an empty first text part.
    expect(compareNaturalNames("1a", "a1")).toBeLessThan(0);
  });

  test("inNaturalOrder returns a new array, keeps the files, and keeps tied names in their order", () => {
    const f = (name: string) => new File(["x"], name);
    const input = [f("img10.jpg"), f("IMG2.jpg"), f("img02.jpg"), f("img1.jpg")];
    const out = inNaturalOrder(input);
    expect(out).not.toBe(input);
    expect(input.map((x) => x.name)).toEqual(["img10.jpg", "IMG2.jpg", "img02.jpg", "img1.jpg"]);
    expect(out.map((x) => x.name)).toEqual(["img1.jpg", "IMG2.jpg", "img02.jpg", "img10.jpg"]);
    expect(out[1]).toBe(input[1]);
    expect(inNaturalOrder([])).toEqual([]);
  });
});

describe("NEO-446: runNotice", () => {
  const job = (extra: Partial<NoticeJob> = {}): NoticeJob => ({
    status: "succeeded",
    mode: "zip",
    totalImages: 10,
    failedImages: 0,
    rejectedEntries: 0,
    errorCode: undefined,
    rejected: undefined,
    ...extra,
  });
  const summary = (tooBig: number, wrongFormat: number, unreadable: number, examples: { name: string; kind: "tooBig" | "wrongFormat" | "unreadable" }[] = []) => ({
    tooBig,
    wrongFormat,
    unreadable,
    examples,
  });

  test("is silent while collecting, and says the row is gone for a null job", () => {
    expect(runNotice(job({ status: "collecting", mode: "stream", totalImages: 0 }))).toBeNull();
    expect(runNotice(null)).toMatchObject({
      line: "Our photo reader hit a snag. That's on us. Start a new run and send them again.",
      problem: true,
      hideWorkspace: false,
    });
  });

  test.each(["pending", "uploaded", "extracting"] as const)("%s says the zip is unpacking, not a problem", (status) => {
    expect(runNotice(job({ status, totalImages: 0 }))).toMatchObject({ line: "Unpacking your zip…", problem: false, hideWorkspace: false });
  });

  test("a healthy finished run says the photos are all in", () => {
    expect(runNotice(job())).toMatchObject({
      line: "This run's photos are all in. To add more, start a new run.",
      problem: false,
      hideWorkspace: false,
    });
    // Mid-run, with photos registered, reads the same.
    expect(runNotice(job({ status: "processing" }))?.problem).toBe(false);
    // An older row with no mode is a zip; with images it is healthy.
    expect(runNotice(job({ mode: undefined }))?.line).toMatch(/all in/);
  });

  test("a zip with no images yet is still unpacking until it reaches a terminal state", () => {
    for (const status of ["processing", "pairing"] as const) {
      expect(runNotice(job({ status, totalImages: 0 }))?.line).toBe("Unpacking your zip…");
    }
    // Older row with no mode and no images: still a zip.
    expect(runNotice(job({ status: "processing", mode: undefined, totalImages: 0 }))?.line).toBe("Unpacking your zip…");
  });

  test("a succeeded run with nothing in it is not called unpacking", () => {
    expect(runNotice(job({ totalImages: 0 }))?.line).not.toBe("Unpacking your zip…");
  });

  test("a stream with none yet is not called unpacking", () => {
    expect(runNotice(job({ status: "processing", mode: "stream", totalImages: 0 }))?.line).toMatch(/all in/);
  });

  describe("failed codes", () => {
    test("CANCELED", () => {
      expect(runNotice(job({ status: "failed", errorCode: "CANCELED", totalImages: 0 }))).toMatchObject({
        line: "This run was stopped.",
        problem: true,
        hideWorkspace: true,
      });
    });
    test("INPUT_NOT_FOUND", () => {
      expect(runNotice(job({ status: "failed", errorCode: "INPUT_NOT_FOUND", totalImages: 0 }))?.line).toBe(
        "Your zip never landed. Send it again in a new run.",
      );
    });
    test.each(["ZIP_REJECTED", "EXTRACT_REJECTED", "INPUT_TOO_LARGE", "INVALID_IDENTIFIER"])("%s says the zip wouldn't open", (errorCode) => {
      const notice = runNotice(job({ status: "failed", errorCode, totalImages: 0 }));
      expect(notice).toMatchObject({
        line: "That zip wouldn't open. Zip your photos again (up to 1,000 photos, 500 MB) and start a new run.",
        problem: true,
        hideWorkspace: true,
      });
    });
    test.each([undefined, "SOMETHING_NEW", "EXTRACT_UNAVAILABLE", "PHOTO_TIMED_OUT"])("%s falls to the snag line", (errorCode) => {
      expect(runNotice(job({ status: "failed", errorCode, totalImages: 0 }))?.line).toMatch(/hit a snag/);
    });
    test("a failure that kept some photos keeps the lanes", () => {
      expect(runNotice(job({ status: "failed", errorCode: "CANCELED", totalImages: 4 }))).toMatchObject({
        line: "This run was stopped.",
        problem: true,
        hideWorkspace: false,
      });
      expect(runNotice(job({ status: "failed", errorCode: "WHATEVER", totalImages: 3 }))?.hideWorkspace).toBe(false);
    });
  });

  describe("TOO_MANY_IMAGE_FAILURES with nothing in", () => {
    const failed = (extra: Partial<NoticeJob>) =>
      runNotice(job({ status: "failed", errorCode: "TOO_MANY_IMAGE_FAILURES", totalImages: 0, ...extra }))!;

    test("all too big, singular", () => {
      const n = failed({ rejectedEntries: 1, rejected: summary(1, 0, 0, [{ name: "a.jpg", kind: "tooBig" }]) });
      expect(n.line).toBe("Whoa, that photo is too big! It's over 64 megapixels or 32 MB. Shrink it, zip it up again, and start a new run.");
      expect(n.problem).toBe(true);
      expect(n.hideWorkspace).toBe(true);
    });
    test("all too big, plural", () => {
      expect(failed({ rejectedEntries: 3, rejected: summary(3, 0, 0) }).line).toBe(
        "Whoa, those photos are too big! All 3 are over 64 megapixels or 32 MB. Use your camera's normal setting or shrink them, zip them up again, and start a new run.",
      );
    });
    test("wrong format", () => {
      expect(failed({ rejectedEntries: 2, rejected: summary(0, 2, 0) }).line).toBe(
        "No JPEGs or PNGs in that zip, and we can't read iPhone HEICs. Convert them to JPEG, zip them up again, and start a new run.",
      );
      expect(failed({ rejectedEntries: 1, rejected: summary(0, 1, 0) }).line).toContain("Convert it to JPEG, zip it up again");
    });
    test("unreadable, singular and plural", () => {
      expect(failed({ rejectedEntries: 1, rejected: summary(0, 0, 1) }).line).toBe(
        "We couldn't read the photo in that zip. Check it opens on your end, then start a new run.",
      );
      expect(failed({ rejectedEntries: 4, rejected: summary(0, 0, 4) }).line).toBe(
        "We couldn't read the photos in that zip. Check they open on your end, then start a new run.",
      );
    });
    test("mixed reasons give a count for each kind", () => {
      expect(failed({ rejectedEntries: 4, rejected: summary(1, 2, 1) }).line).toBe(
        "Nothing in that zip made it in: 1 is too big (over 64 megapixels or 32 MB); 2 aren't JPEGs or PNGs; 1 couldn't be read. Fix them, zip them up again, and start a new run.",
      );
    });
    test("an older row with rejections but no summary reads as unreadable", () => {
      expect(failed({ rejectedEntries: 2, rejected: undefined }).line).toBe(
        "We couldn't read the photos in that zip. Check they open on your end, then start a new run.",
      );
    });
    test("an empty zip", () => {
      const n = failed({ rejectedEntries: 0 });
      expect(n.line).toBe("No photos in that zip.");
      expect(n.problem).toBe(true);
      expect(n.hideWorkspace).toBe(true);
    });
    test("a stream that closed with none", () => {
      expect(failed({ mode: "stream" }).line).toBe("No photos came in before this run closed. Start a new run and drop some in.");
      // Even if rejections are somehow present, a stream has no zip to blame.
      expect(failed({ mode: "stream", rejectedEntries: 2, rejected: summary(2, 0, 0) }).line).toMatch(/No photos came in/);
    });
  });

  describe("TOO_MANY_IMAGE_FAILURES with photos in", () => {
    const most = "Most of these photos wouldn't read. Anything below is still yours to save. Re-shoot the rest, sharp and well lit, in a new run, with their other sides.";
    const failed = (extra: Partial<NoticeJob>) =>
      runNotice(job({ status: "failed", errorCode: "TOO_MANY_IMAGE_FAILURES", totalImages: 10, failedImages: 6, ...extra }))!;

    test("keeps the lanes and says most would not read", () => {
      const n = failed({});
      expect(n).toMatchObject({ line: most, problem: true, hideWorkspace: false });
    });
    test("tails the rejections, with names", () => {
      const n = failed({ rejectedEntries: 3, rejected: summary(0, 3, 0, [{ name: "a.heic", kind: "wrongFormat" }, { name: "b.heic", kind: "wrongFormat" }]) });
      expect(n.line).toBe(`${most} 3 more didn't make it in: \"a.heic\", \"b.heic\" and 1 more aren't JPEGs or PNGs.`);
    });
    test("no tail when the rejection summary is missing or nothing was rejected", () => {
      expect(failed({ rejectedEntries: 3, rejected: undefined }).line).toBe(most);
      expect(failed({ rejectedEntries: 0, rejected: summary(0, 0, 0) }).line).toBe(most);
    });
  });

  describe("a snag with photos already in", () => {
    const snagged = "Our photo reader hit a snag. That's on us. Anything below is still yours to save. Send the rest in a new run.";
    test("says the cards below are safe, and to send only the rest", () => {
      expect(runNotice(job({ status: "failed", errorCode: "EXTRACT_UNAVAILABLE", totalImages: 4 }))).toMatchObject({
        line: snagged,
        problem: true,
        hideWorkspace: false,
      });
    });
    test("keeps asking for them all when nothing got in", () => {
      expect(runNotice(job({ status: "failed", errorCode: "EXTRACT_UNAVAILABLE", totalImages: 0 }))?.line).toBe(
        "Our photo reader hit a snag. That's on us. Start a new run and send them again.",
      );
    });
  });

  describe("file names in the line", () => {
    const named = (examples: { name: string; kind: "tooBig" | "wrongFormat" | "unreadable" }[]) =>
      runNotice(job({ rejectedEntries: examples.length, rejected: summary(examples.length, 0, 0, examples) }))!;

    test("parts join back to the line, with each name at an odd index", () => {
      const n = named([
        { name: "a.jpg", kind: "tooBig" },
        { name: "תמונה.jpg", kind: "tooBig" },
      ]);
      expect(n.parts.join("")).toBe(n.line);
      expect(n.parts.filter((_, i) => i % 2 === 1)).toEqual(['"a.jpg"', '"תמונה.jpg"']);
    });
    test("a line with no name is a single part", () => {
      const n = runNotice(job({ rejectedEntries: 2, rejected: summary(0, 0, 2) }))!;
      expect(n.parts).toEqual([n.line]);
    });
    test("no invisible character reaches the text", () => {
      expect(named([{ name: "a.jpg", kind: "tooBig" }]).line).not.toMatch(/\p{C}/u);
    });
    test("a stored name holding one is stripped, so it can't split the line or reorder it", () => {
      const n = named([{ name: "a\u2069b\u202Ec\u2068.jpg", kind: "tooBig" }]);
      expect(n.line).not.toMatch(/\p{C}/u);
      expect(n.parts.filter((_, i) => i % 2 === 1)).toEqual(['"abc.jpg"']);
    });
    test("a name spelled like the markup stays one plain name", () => {
      const n = named([{ name: "<b>x</b>.jpg", kind: "tooBig" }]);
      expect(n.parts[1]).toBe('"<b>x</b>.jpg"');
    });
  });

  test("a zip over the upload limit says how to split it", () => {
    expect(zipOverLimitLine(500)).toBe(
      "Couldn't send that zip: it's over 500 MB. Split it into smaller zips, each card's front and back together, one per run.",
    );
  });

  describe("a finished run where some of the zip was rejected", () => {
    test("older row with no summary asks to check them", () => {
      expect(runNotice(job({ rejectedEntries: 2 }))).toMatchObject({
        line: "10 photos made it in. 2 didn't. Check them and drop them in a new run, with their other sides.",
        problem: true,
        hideWorkspace: false,
      });
      expect(runNotice(job({ totalImages: 1, rejectedEntries: 1 }))?.line).toBe(
        "1 photo made it in. 1 didn't. Check it and drop it in a new run, with its other side.",
      );
    });
    test("names what it can and how many more", () => {
      const rejected = summary(5, 0, 0, [
        { name: "a.jpg", kind: "tooBig" },
        { name: "b.jpg", kind: "tooBig" },
      ]);
      expect(runNotice(job({ rejectedEntries: 5, rejected }))?.line).toBe(
        "10 photos made it in. 5 didn't: \"a.jpg\", \"b.jpg\" and 3 more are too big (over 64 megapixels or 32 MB). Shrink them and drop them in a new run, with their other sides.",
      );
    });
    test("a count alone when no name can be shown", () => {
      expect(runNotice(job({ rejectedEntries: 2, rejected: summary(0, 0, 2) }))?.line).toBe(
        "10 photos made it in. 2 didn't: 2 couldn't be read. Check they open on your end, then drop them in a new run, with their other sides.",
      );
    });
    test("every fix says to bring the other side, singular and plural", () => {
      const tooBig = [{ name: "a.jpg", kind: "tooBig" as const }];
      expect(runNotice(job({ totalImages: 1, rejectedEntries: 1, rejected: summary(1, 0, 0, tooBig) }))?.line).toBe(
        '1 photo made it in. 1 didn\'t: "a.jpg" is too big (over 64 megapixels or 32 MB). Shrink it and drop it in a new run, with its other side.',
      );
      expect(runNotice(job({ rejectedEntries: 2, rejected: summary(0, 2, 0) }))?.line).toBe(
        "10 photos made it in. 2 didn't: 2 aren't JPEGs or PNGs. Convert them to JPEGs and drop them in a new run, with their other sides.",
      );
      expect(runNotice(job({ rejectedEntries: 1, rejected: summary(0, 0, 1) }))?.line).toBe(
        "10 photos made it in. 1 didn't: 1 couldn't be read. Check it opens on your end, then drop it in a new run, with its other side.",
      );
    });
    test("singular", () => {
      expect(
        runNotice(job({ totalImages: 3, rejectedEntries: 1, rejected: summary(0, 1, 0, [{ name: "x.heic", kind: "wrongFormat" }]) }))?.line,
      ).toBe("3 photos made it in. 1 didn't: \"x.heic\" isn't a JPEG or PNG. Convert it to JPEG and drop it in a new run, with its other side.");
    });
    test("mixed kinds get one clause each and a generic fix", () => {
      const line = runNotice(
        job({ rejectedEntries: 3, rejected: summary(1, 1, 1, [{ name: "a.jpg", kind: "tooBig" }, { name: "b.heic", kind: "wrongFormat" }]) }),
      )!.line;
      expect(line).toBe(
        "10 photos made it in. 3 didn't: \"a.jpg\" is too big (over 64 megapixels or 32 MB); \"b.heic\" isn't a JPEG or PNG; 1 couldn't be read. Fix them and drop them in a new run, with their other sides.",
      );
    });
    test("an example of one kind is never named under another", () => {
      const line = runNotice(
        job({ rejectedEntries: 2, rejected: summary(1, 1, 0, [{ name: "a.jpg", kind: "tooBig" }]) }),
      )!.line;
      expect(line).toContain('"a.jpg" is too big');
      expect(line).toContain("1 isn't a JPEG or PNG");
    });
    test("never names more examples than the kind's count", () => {
      const line = runNotice(
        job({ rejectedEntries: 1, rejected: summary(1, 0, 0, [{ name: "a.jpg", kind: "tooBig" }, { name: "b.jpg", kind: "tooBig" }]) }),
      )!.line;
      expect(line).toContain('"a.jpg" is too big');
      expect(line).not.toContain("b.jpg");
    });
    test("a stream run is judged the same way once it has images", () => {
      expect(runNotice(job({ mode: "stream", rejectedEntries: 1 }))?.problem).toBe(true);
    });
  });
});
