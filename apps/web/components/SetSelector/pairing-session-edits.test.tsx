/**
 * NEO-220 — the number the pairing discard confirm shows.
 *
 * A count that reads 0 while work exists turns the guard off silently, so each
 * kind of edit is pinned separately rather than through the component.
 */

import { describe, expect, test } from "vitest";
import { countPairingEdits, type PairingEditState } from "./pairing-session-edits";

type Card = { ref: string };
const keyOf = (c: Card) => c.ref;

function state(
  over: Partial<PairingEditState<Card>> = {},
): PairingEditState<Card> {
  return {
    matched: [],
    keptBsc: [],
    keptSl: [],
    seedMatchedKeys: new Set<string>(),
    ...over,
  };
}

const auto = (ref: string) => ({ card: { ref }, confidence: 1 });
const manual = (ref: string) => ({ card: { ref }, confidence: 0 });

describe("countPairingEdits", () => {
  test("an untouched auto-matched session has nothing to discard", () => {
    expect(
      countPairingEdits(
        state({
          matched: [auto("a"), auto("b")],
          seedMatchedKeys: new Set(["a", "b"]),
        }),
        keyOf,
      ),
    ).toBe(0);
  });

  test("counts each hand-linked pair", () => {
    expect(
      countPairingEdits(
        state({ matched: [auto("a"), manual("b"), manual("c")] , seedMatchedKeys: new Set(["a"]) }),
        keyOf,
      ),
    ).toBe(2);
  });

  test("counts kept cards on both shelves", () => {
    expect(
      countPairingEdits(
        state({ keptBsc: [{}, {}], keptSl: [{}] }),
        keyOf,
      ),
    ).toBe(3);
  });

  /**
   * BSC-and-untouched is what `seedMatched` produces, so it is the absence of a
   * decision — counting it would make every conflicted set look dirty on open.
   */
  test("a conflict left on its BSC default is not an edit", () => {
    expect(
      countPairingEdits(
        state({
          matched: [
            {
              card: { ref: "a" },
              confidence: 1,
              nameConflict: { chosen: "bsc" },
            },
          ],
          seedMatchedKeys: new Set(["a"]),
        }),
        keyOf,
      ),
    ).toBe(0);
  });

  test("counts a conflict settled on SportLots", () => {
    expect(
      countPairingEdits(
        state({
          matched: [
            {
              card: { ref: "a" },
              confidence: 1,
              nameConflict: { chosen: "sportlots" },
            },
          ],
          seedMatchedKeys: new Set(["a"]),
        }),
        keyOf,
      ),
    ).toBe(1);
  });

  /**
   * A rename that happens to match BSC's spelling leaves `chosen: "bsc"` — the
   * typed name is the evidence, which is why `custom` is checked as well.
   */
  test("counts a typed name even when the choice fell back to BSC", () => {
    expect(
      countPairingEdits(
        state({
          matched: [
            {
              card: { ref: "a" },
              confidence: 1,
              nameConflict: { chosen: "bsc", custom: "Carl Yastrzemski" },
            },
          ],
          seedMatchedKeys: new Set(["a"]),
        }),
        keyOf,
      ),
    ).toBe(1);
  });

  /**
   * The edit no other signal can see: both halves land back in the unmatched
   * columns, indistinguishable from cards that never matched at all.
   */
  test("counts an auto-pair the operator took apart", () => {
    expect(
      countPairingEdits(
        state({
          matched: [auto("a")],
          seedMatchedKeys: new Set(["a", "b"]),
        }),
        keyOf,
      ),
    ).toBe(1);
  });

  test("re-linking an unlinked auto-pair still counts once, not twice", () => {
    expect(
      countPairingEdits(
        state({
          // Same key back in `matched`, now hand-made.
          matched: [manual("a")],
          seedMatchedKeys: new Set(["a"]),
        }),
        keyOf,
      ),
    ).toBe(1);
  });

  test("sums across every kind of edit", () => {
    expect(
      countPairingEdits(
        state({
          matched: [
            manual("m1"),
            {
              card: { ref: "a" },
              confidence: 1,
              nameConflict: { chosen: "custom", custom: "Real Name" },
            },
          ],
          keptBsc: [{}],
          keptSl: [{}, {}],
          seedMatchedKeys: new Set(["a", "gone"]),
        }),
        keyOf,
      ),
    ).toBe(6); // 1 manual + 1 name + 3 kept + 1 unlinked
  });
});
