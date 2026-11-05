import { describe, expect, test } from "vitest";
import {
  ENTRY_TOO_MANY_PIXELS,
  isRasterTooLargeError,
  MAX_REJECTION_EXAMPLE_CHARS,
  MAX_REJECTION_EXAMPLES,
  rejectionExampleName,
  rejectionKind,
  summarizeRejections,
  unknownRejectionReasons,
} from "./extractRejections";

/** NEO-446 — what a zip's rejected entries are summarised as. */

type Entry = { name: string; accepted: boolean; reason?: string | null };
const rejected = (name: string, reason?: string | null): Entry => ({ name, accepted: false, reason });
const accepted = (name: string): Entry => ({ name, accepted: true });

describe("rejectionKind", () => {
  test.each([
    ["image_too_many_pixels", "tooBig"],
    ["entry_too_large", "tooBig"],
    ["unsupported_image_type", "wrongFormat"],
    ["unsupported_output_type", "wrongFormat"],
    ["no_data", "unreadable"],
    ["entry_undecodable", "unreadable"],
    ["entry_unreadable", "unreadable"],
    ["symlink_entry", "unreadable"],
    ["encrypted_entry", "unreadable"],
    ["absolute_entry_name", "unreadable"],
    ["drive_letter_entry_name", "unreadable"],
    ["empty_entry_name", "unreadable"],
    ["entry_name_has_control_chars", "unreadable"],
  ] as const)("%s reads as %s", (reason, kind) => {
    expect(rejectionKind(reason)).toBe(kind);
  });

  test("an unknown, empty, null or missing reason reads as unreadable and never throws", () => {
    expect(rejectionKind("brand_new_reason")).toBe("unreadable");
    expect(rejectionKind("")).toBe("unreadable");
    expect(rejectionKind(null)).toBe("unreadable");
    expect(rejectionKind(undefined)).toBe("unreadable");
  });

  test("matches whole reasons only, never a prefix or different case", () => {
    expect(rejectionKind("image_too_many_pixels_extra")).toBe("unreadable");
    expect(rejectionKind("IMAGE_TOO_MANY_PIXELS")).toBe("unreadable");
    // Inherited Object keys are not reasons.
    expect(rejectionKind("constructor")).toBe("unreadable");
    expect(rejectionKind("__proto__")).toBe("unreadable");
  });
});

describe("rejectionExampleName", () => {
  test("keeps the last path segment, for either separator", () => {
    expect(rejectionExampleName("cards/page 2/IMG_1.heic")).toBe("IMG_1.heic");
    expect(rejectionExampleName("cards\\page 2\\IMG_1.heic")).toBe("IMG_1.heic");
    expect(rejectionExampleName("a/b\\c.png")).toBe("c.png");
  });

  test("is null when nothing is left to show", () => {
    expect(rejectionExampleName("")).toBeNull();
    expect(rejectionExampleName("folder/")).toBeNull();
    expect(rejectionExampleName("folder\\")).toBeNull();
    expect(rejectionExampleName("/")).toBeNull();
  });

  test("clips to 80 code points and never splits a surrogate pair", () => {
    const long = "a".repeat(200);
    expect(rejectionExampleName(long)).toHaveLength(MAX_REJECTION_EXAMPLE_CHARS);
    const emoji = "😀".repeat(100);
    const clipped = rejectionExampleName(emoji)!;
    expect(Array.from(clipped)).toHaveLength(MAX_REJECTION_EXAMPLE_CHARS);
    expect(clipped).toBe("😀".repeat(80));
    // A name of exactly 80 is left whole.
    expect(rejectionExampleName("b".repeat(80))).toBe("b".repeat(80));
  });
});

describe("summarizeRejections", () => {
  test("is undefined when nothing was rejected", () => {
    expect(summarizeRejections([])).toBeUndefined();
    expect(summarizeRejections([accepted("a.jpg"), accepted("b.jpg")])).toBeUndefined();
  });

  test("counts by kind and names the entries whose reason is known", () => {
    const summary = summarizeRejections([
      accepted("ok.jpg"),
      rejected("big.jpg", "image_too_many_pixels"),
      rejected("scan.heic", "unsupported_image_type"),
      rejected("broken.jpg", "entry_undecodable"),
    ]);
    expect(summary).toEqual({
      tooBig: 1,
      wrongFormat: 1,
      unreadable: 1,
      examples: [
        { name: "big.jpg", kind: "tooBig" },
        { name: "scan.heic", kind: "wrongFormat" },
        { name: "broken.jpg", kind: "unreadable" },
      ],
    });
  });

  test("keeps only the first five examples, still counting every entry", () => {
    const entries = Array.from({ length: 12 }, (_, i) => rejected(`big-${i}.jpg`, "entry_too_large"));
    const summary = summarizeRejections(entries)!;
    expect(summary.tooBig).toBe(12);
    expect(summary.examples).toHaveLength(MAX_REJECTION_EXAMPLES);
    expect(summary.examples.map((e) => e.name)).toEqual(["big-0.jpg", "big-1.jpg", "big-2.jpg", "big-3.jpg", "big-4.jpg"]);
  });

  test("entries rejected for their name count but never become examples", () => {
    const summary = summarizeRejections([
      rejected("/etc/passwd", "absolute_entry_name"),
      rejected("C:\\x.jpg", "drive_letter_entry_name"),
      rejected("", "empty_entry_name"),
      rejected("ev\u0000il.jpg", "entry_name_has_control_chars"),
      rejected("anything.jpg", "entry_name_brand_new_flavour"),
    ])!;
    expect(summary).toEqual({ tooBig: 0, wrongFormat: 0, unreadable: 5, examples: [] });
  });

  test("a bidi-character name is counted and not shown", () => {
    // The service rejects it for its name; a right-to-left override must not reach a screen.
    const summary = summarizeRejections([rejected("invoice\u202Egpj.exe", "entry_name_has_bidi_chars")])!;
    expect(summary.unreadable).toBe(1);
    expect(summary.examples).toEqual([]);
  });

  test("unknown and missing reasons count as unreadable and never expose a name", () => {
    const summary = summarizeRejections([
      rejected("mystery.jpg", "reason_from_the_future"),
      rejected("no-reason.jpg"),
      rejected("null-reason.jpg", null),
      rejected("empty-reason.jpg", ""),
    ])!;
    expect(summary).toEqual({ tooBig: 0, wrongFormat: 0, unreadable: 4, examples: [] });
  });

  test("a name that is only a folder is counted but not shown", () => {
    const summary = summarizeRejections([rejected("photos/", "entry_unreadable")])!;
    expect(summary.unreadable).toBe(1);
    expect(summary.examples).toEqual([]);
  });

  test("a skipped entry does not use up an example slot", () => {
    const entries: Entry[] = [
      ...Array.from({ length: 6 }, (_, i) => rejected(`bad-${i}`, "entry_name_x")),
      ...Array.from({ length: 7 }, (_, i) => rejected(`heic-${i}.heic`, "unsupported_image_type")),
    ];
    const summary = summarizeRejections(entries)!;
    expect(summary.examples).toHaveLength(MAX_REJECTION_EXAMPLES);
    expect(summary.examples.every((e) => e.kind === "wrongFormat")).toBe(true);
  });

  test("the counts always sum to the rejected total", () => {
    const reasons = [
      "image_too_many_pixels", "entry_too_large", "unsupported_image_type", "unsupported_output_type",
      "no_data", "entry_name_x", "absolute_entry_name", "who_knows", undefined, null, "",
    ];
    const entries: Entry[] = [];
    for (let i = 0; i < 60; i++) {
      entries.push(i % 4 === 0 ? accepted(`ok-${i}`) : rejected(`f-${i}.jpg`, reasons[i % reasons.length]));
    }
    const summary = summarizeRejections(entries)!;
    const total = entries.filter((e) => !e.accepted).length;
    expect(summary.tooBig + summary.wrongFormat + summary.unreadable).toBe(total);
    expect(summary.examples.length).toBeLessThanOrEqual(MAX_REJECTION_EXAMPLES);
  });

  test("an accepted entry that carries a reason is not counted", () => {
    expect(summarizeRejections([{ name: "a.jpg", accepted: true, reason: "entry_too_large" }])).toBeUndefined();
  });
});

describe("unknownRejectionReasons", () => {
  test("lists each unknown reason once, and skips known, accepted and empty ones", () => {
    expect(
      unknownRejectionReasons([
        rejected("a", "image_too_many_pixels"),
        rejected("b", "entry_name_whatever"),
        rejected("c", "absolute_entry_name"),
        rejected("d", "new_one"),
        rejected("e", "new_one"),
        rejected("f", "another_new_one"),
        rejected("g"),
        rejected("h", null),
        rejected("i", ""),
        { name: "j", accepted: true, reason: "ignored_because_accepted" },
      ]),
    ).toEqual(["new_one", "another_new_one"]);
  });

  test("is empty when every reason is recognised", () => {
    expect(unknownRejectionReasons([rejected("a", "no_data")])).toEqual([]);
    expect(unknownRejectionReasons([])).toEqual([]);
  });
});

describe("isRasterTooLargeError", () => {
  test("recognises the adapter's message, bare or wrapped", () => {
    const bare = `preprocess ${ENTRY_TOO_MANY_PIXELS} (HTTP 413): image has 70000000 pixels`;
    expect(isRasterTooLargeError(bare)).toBe(true);
    expect(isRasterTooLargeError(`Uncaught Error: ${bare}\n  at handler`)).toBe(true);
    expect(isRasterTooLargeError(JSON.stringify({ message: bare }))).toBe(true);
  });

  test("does not match other failures, other codes or a different status shape", () => {
    expect(isRasterTooLargeError("preprocess HTTP 502: upstream boom")).toBe(false);
    expect(isRasterTooLargeError("preprocess ENTRY_UNDECODABLE (HTTP 422): bad")).toBe(false);
    expect(isRasterTooLargeError("preprocess ENTRY_TOO_MANY_PIXELS_EXTRA (HTTP 413)")).toBe(false);
    expect(isRasterTooLargeError("ENTRY_TOO_MANY_PIXELS")).toBe(false);
    expect(isRasterTooLargeError("")).toBe(false);
  });
});
