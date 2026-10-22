/**
 * NEO-339 — the likely partner of an unpaired marketplace set: suggested,
 * never paired; a tie or a rival suggests nothing.
 */
import { describe, expect, test } from "vitest";
import { rankPairCandidates } from "./likely-pair";

describe("rankPairCandidates", () => {
  const ctx = { manufacturer: "Topps", slPrefixes: ["topps chrome", "chrome"] };
  const pend = (side: "bsc" | "sportlots", id: string, name: string) => ({ side, id, name });
  const cand = (side: "bsc" | "sportlots", id: string, name: string, row = false) => ({
    id, name, side, bsc: side === "bsc" ? [id] : [], sportlots: side === "sportlots" ? [id] : [], ...(row ? { row } : {}),
  });

  test("the brand word one side drops reads as the same name; a drafted one-sided row is a candidate too", () => {
    const set = pend("sportlots", "s1", "Chrome Authentics Relics");
    const row = cand("bsc", "steps[0].variants[0].sync.pairs[3]", "Topps Chrome Authentics Relics", true);
    const r = rankPairCandidates(set, [row, cand("bsc", "b9", "Future Stars")], [set], ctx);
    expect(r.suggested).toBe(row);
    expect(r.listed).toEqual([row]);
  });

  test("not reciprocal, not suggested: another set of the same side reads as much like the candidate", () => {
    const a = pend("bsc", "b1", "Topps Chrome Authentics Relics");
    const b = pend("bsc", "b2", "Chrome Authentics Relics");
    const s = cand("sportlots", "s1", "Chrome Authentics Relics");
    expect(rankPairCandidates(a, [s], [a, b], ctx).suggested).toBeUndefined();
    expect(rankPairCandidates(a, [s], [a, b], ctx).listed).toEqual([s]);
  });

  test("names that do not read alike are not listed at all", () => {
    const r = rankPairCandidates(pend("bsc", "b1", "Exposé"), [cand("sportlots", "s1", "Heritage Real One Autographs")], [], ctx);
    expect(r).toEqual({ listed: [] });
    expect(rankPairCandidates(pend("bsc", "b1", "Exposé"), [cand("sportlots", "s1", "Chrome Expose")], [], ctx).suggested).toBeDefined();
  });
});
