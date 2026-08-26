import { describe, expect, test } from "vitest";
import { classifyIntake, isZipFile } from "./intake-kind";

const f = (name: string) => new File(["x"], name, { type: "" });

describe("isZipFile", () => {
  // Matched on the name because browsers disagree about the zip MIME type
  // (application/zip, application/x-zip-compressed, or "" on some platforms).
  test.each(["cards.zip", "CARDS.ZIP", "a.b.zip"])("%s is a zip", (n) =>
    expect(isZipFile(f(n))).toBe(true),
  );
  test.each(["cards.jpg", "zip", "cards.zip.jpg"])("%s is not", (n) =>
    expect(isZipFile(f(n))).toBe(false),
  );
});

describe("classifyIntake", () => {
  test("an empty selection is invalid", () => {
    expect(classifyIntake([])).toEqual({ kind: "invalid", reason: "no files selected" });
  });

  test("a lone zip takes the zip path", () => {
    const zip = f("cards.zip");
    expect(classifyIntake([zip])).toEqual({ kind: "zip", file: zip });
  });

  test("images take the stream path", () => {
    const files = [f("1.jpg"), f("2.jpg")];
    expect(classifyIntake(files)).toEqual({ kind: "images", files });
  });

  test("a single image is still the stream path, not a special case", () => {
    const files = [f("only.png")];
    expect(classifyIntake(files)).toEqual({ kind: "images", files });
  });

  // Each zip becomes its own job server-side, so honouring this would turn one
  // drop into N batches and consume the user's active-batch cap unasked.
  test("several zips are refused rather than becoming several batches", () => {
    const result = classifyIntake([f("a.zip"), f("b.zip")]);
    expect(result.kind).toBe("invalid");
    expect(result.kind === "invalid" && result.reason).toMatch(/one zip at a time/);
  });

  // Entry order is a pairing correctness constraint; an interleaving of an
  // expanded archive and loose files has no defined order.
  test("a mixed selection is refused rather than half-honoured", () => {
    const result = classifyIntake([f("a.zip"), f("1.jpg")]);
    expect(result.kind).toBe("invalid");
    expect(result.kind === "invalid" && result.reason).toMatch(/not both/);
  });
});
