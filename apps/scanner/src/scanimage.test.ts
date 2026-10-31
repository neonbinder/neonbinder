import { describe, expect, test } from "vitest";
import { DEFAULT_SETTINGS, paperLoadedIn, pickFujitsuDevice, scanArgs, wholeCards } from "./scanimage.js";

describe("wholeCards", () => {
  test("holds back the newest file while the scan runs", () => {
    expect(wholeCards(["1", "2", "3"], false)).toEqual({ pairs: [["1", "2"]], orphan: undefined });
    expect(wholeCards(["1", "2"], false)).toEqual({ pairs: [], orphan: undefined });
  });
  test("once the scan ends every file counts, and a lone last side is an orphan", () => {
    expect(wholeCards(["1", "2", "3", "4"], true)).toEqual({ pairs: [["1", "2"], ["3", "4"]], orphan: undefined });
    expect(wholeCards(["1", "2", "3"], true)).toEqual({ pairs: [["1", "2"]], orphan: "3" });
    expect(wholeCards([], true)).toEqual({ pairs: [], orphan: undefined });
  });
});

describe("scanner discovery", () => {
  test("picks the first Fujitsu device", () => {
    expect(pickFujitsuDevice("pixma:04A9\nfujitsu:fi-7160:1234\nfujitsu:other\n")).toBe("fujitsu:fi-7160:1234");
    expect(pickFujitsuDevice("pixma:04A9\n")).toBeUndefined();
  });
  test("reads the page-loaded sensor", () => {
    expect(paperLoadedIn("    --page-loaded[=(yes|no)] [yes] [hardware]\n")).toBe(true);
    expect(paperLoadedIn("    --page-loaded[=(yes|no)] [no] [hardware]\n")).toBe(false);
    expect(paperLoadedIn("")).toBe(false);
  });
});

describe("scanArgs", () => {
  test("keeps the card-stock sensor fixes and buffer mode off", () => {
    const args = scanArgs("fujitsu:x", DEFAULT_SETTINGS, "/tmp/raw-%04d.jpg").join(" ");
    expect(args).toContain("--paper-protect Off --adv-paper-protect Off --df-action Continue --df-recovery Off");
    expect(args).toContain("--buffermode Off");
    expect(args).toContain("--source ADF Duplex");
    expect(args).toContain("--hwdeskewcrop=yes");
    expect(args).toContain("--overscan Off");
  });
  test("raw mode trades the hardware crop for overscan", () => {
    const args = scanArgs("fujitsu:x", { ...DEFAULT_SETTINGS, raw: true }, "/tmp/r.jpg").join(" ");
    expect(args).toContain("--hwdeskewcrop=no");
    expect(args).toContain("--overscan On");
  });
});
