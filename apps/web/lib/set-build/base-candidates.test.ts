/**
 * NEO-339 — direct tests for `listBaseCandidates`, the set-building tool's
 * view of the Base picker. The dialog tests reach the scoring and the
 * pre-select rule one function at a time; the assembly (paused sides, the set
 * listing, what is pre-selected) has no other caller under test.
 */
import { describe, expect, it } from "vitest";
import { listBaseCandidates, type BaseOptionsFetch } from "./base-candidates";

const opt = (value: string, platformValue: string) => ({ value, platformValue });

const ancestor = (value: string, bscSlug?: string) => ({
  value,
  platformData: bscSlug ? { bsc: { b0: bscSlug } } : undefined,
});

const fetchOf = (parts: Partial<BaseOptionsFetch> = {}): BaseOptionsFetch => ({
  bscOptions: [],
  slOptions: [],
  ...parts,
});

describe("listBaseCandidates: SportLots side", () => {
  it("ranks options best first and pre-selects the sole exact match by id", () => {
    const out = listBaseCandidates(
      fetchOf({
        slOptions: [opt("Chrome Refractors", "s3"), opt("Topps Chrome", "s1"), opt("Base", "s2")],
      }),
      ancestor("Topps Chrome"),
    );
    expect(out.sl.map((o) => o.platformValue)).toEqual(["s1", "s2", "s3"]);
    expect(out.preselected.sl).toBe("s1");
  });

  it("pre-selects nothing when two options are exact matches, and never the first of them", () => {
    const out = listBaseCandidates(
      fetchOf({ slOptions: [opt("Topps Chrome", "s1"), opt("Topps Chrome", "s2")] }),
      ancestor("Topps Chrome"),
    );
    expect(out.sl).toHaveLength(2);
    expect(out.preselected.sl).toBeNull();
  });

  it("pre-selects nothing when the best option is only a generic Base row", () => {
    const out = listBaseCandidates(
      fetchOf({ slOptions: [opt("Base", "s1")] }),
      ancestor("Topps Chrome"),
    );
    expect(out.sl[0].score).toBeLessThan(950);
    expect(out.preselected.sl).toBeNull();
  });

  it("strips the manufacturer prefix when scoring", () => {
    const out = listBaseCandidates(
      fetchOf({ slOptions: [opt("Opening Day", "s1")] }),
      ancestor("Topps Opening Day"),
      "Topps",
    );
    expect(out.sl[0].score).toBe(950);
    expect(out.preselected.sl).toBe("s1");
  });

  it("returns no SportLots options and no pre-selection for a paused side", () => {
    const out = listBaseCandidates(
      fetchOf({ slOptions: [opt("Topps Chrome", "s1")], pausedSides: ["sportlots"] }),
      ancestor("Topps Chrome"),
    );
    expect(out.sl).toEqual([]);
    expect(out.preselected.sl).toBeNull();
  });
});

describe("listBaseCandidates: BSC side", () => {
  it("puts the set listing last, unscored, after the scored options", () => {
    const out = listBaseCandidates(
      fetchOf({ bscOptions: [opt("Chrome Refractors", "b2"), opt("Topps Chrome", "b1")] }),
      ancestor("Topps Chrome", "topps-chrome"),
    );
    expect(out.bsc.map((c) => c.item.platformValue)).toEqual(["b1", "b2", "topps-chrome"]);
    const listing = out.bsc[out.bsc.length - 1];
    expect(listing).toMatchObject({ isSetListing: true, score: null, key: "bsc:set-listing" });
    expect(out.setListing).toEqual({ value: "Topps Chrome", platformValue: "topps-chrome" });
  });

  it("pre-selects the set listing when it is the only BSC candidate", () => {
    const out = listBaseCandidates(fetchOf(), ancestor("Topps Chrome", "topps-chrome"));
    expect(out.bsc).toHaveLength(1);
    expect(out.preselected.bsc).toBe("bsc:set-listing");
  });

  it("pre-selects the sole exact BSC option, not the set listing beside it", () => {
    const out = listBaseCandidates(
      fetchOf({ bscOptions: [opt("Topps Chrome", "b1"), opt("Other", "b2")] }),
      ancestor("Topps Chrome", "topps-chrome"),
    );
    expect(out.preselected.bsc).toBe("bsc:b1:Topps Chrome");
  });

  it("pre-selects nothing when the set listing sits beside options that are not exact", () => {
    const out = listBaseCandidates(
      fetchOf({ bscOptions: [opt("Base", "b1")] }),
      ancestor("Topps Chrome", "topps-chrome"),
    );
    expect(out.bsc).toHaveLength(2);
    expect(out.preselected.bsc).toBeNull();
  });

  it("pre-selects nothing when two BSC options share the exact name but not the id", () => {
    const out = listBaseCandidates(
      fetchOf({ bscOptions: [opt("Topps Chrome", "b1"), opt("Topps Chrome", "b2")] }),
      ancestor("Topps Chrome"),
    );
    expect(out.preselected.bsc).toBeNull();
  });

  it("labels two options that share a name with their slug so they can be told apart", () => {
    const out = listBaseCandidates(
      fetchOf({ bscOptions: [opt("Twin", "b1"), opt("Twin", "b2")] }),
      ancestor("Something Else"),
    );
    const labels = out.bsc.map((c) => c.label);
    expect(new Set(labels).size).toBe(2);
  });

  it("returns no BSC candidates, not even the set listing, for a paused side", () => {
    const out = listBaseCandidates(
      fetchOf({ bscOptions: [opt("Topps Chrome", "b1")], pausedSides: ["bsc"] }),
      ancestor("Topps Chrome", "topps-chrome"),
    );
    expect(out.bsc).toEqual([]);
    expect(out.preselected.bsc).toBeNull();
    expect(out.setListing).toEqual({ value: "Topps Chrome", platformValue: "topps-chrome" });
  });
});

describe("listBaseCandidates: the set row", () => {
  it("omits setListing when the set has no BSC id", () => {
    const out = listBaseCandidates(fetchOf(), ancestor("Topps Chrome"));
    expect("setListing" in out).toBe(false);
    expect(out.bsc).toEqual([]);
    expect(out.preselected).toEqual({ sl: null, bsc: null });
  });

  it("copes with no set row at all", () => {
    const out = listBaseCandidates(
      fetchOf({ slOptions: [opt("Base", "s1")], bscOptions: [opt("Base", "b1")] }),
      undefined,
    );
    expect(out.sl).toHaveLength(1);
    expect(out.bsc).toHaveLength(1);
    expect("setListing" in out).toBe(false);
    expect(out.preselected).toEqual({ sl: null, bsc: null });
  });

  it("pauses each side independently", () => {
    const out = listBaseCandidates(
      fetchOf({
        slOptions: [opt("Topps Chrome", "s1")],
        bscOptions: [opt("Topps Chrome", "b1")],
        pausedSides: ["sportlots", "bsc"],
      }),
      ancestor("Topps Chrome"),
    );
    expect(out.sl).toEqual([]);
    expect(out.bsc).toEqual([]);
  });
});
