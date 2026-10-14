import { describe, expect, test } from "vitest";
import {
  decideDuplicateNumberPairs,
  type NumberPairingCard,
} from "./duplicateNumberPairing";

type C = NumberPairingCard & { id: string };

const card = (id: string, cardNumber: string, name: string, extra: Partial<C> = {}): C => ({
  id,
  cardNumber,
  cardName: name,
  players: [name],
  ...extra,
});

function decide(
  bscCards: C[],
  slCards: C[],
  opts: { shortCircuit?: Record<string, C>; prefix?: string } = {},
) {
  const res = decideDuplicateNumberPairs({
    bscCards,
    slCards,
    numberKeysOf: (b) =>
      opts.prefix && b.cardNumber.startsWith(opts.prefix)
        ? [b.cardNumber, b.cardNumber.slice(opts.prefix.length)]
        : [b.cardNumber],
    shortCircuit: (b) => opts.shortCircuit?.[b.id],
  });
  const decided = Object.fromEntries(
    [...res.decided].map(([b, s]) => [b.id, s ? s.id : null]),
  );
  return { decided, fuzzyExcluded: [...res.fuzzyExcluded].map((s) => s.id).sort() };
}

describe("decideDuplicateNumberPairs (NEO-339)", () => {
  test("an unambiguous number is left to the ordinary lookup", () => {
    const res = decide(
      [card("b1", "1", "A"), card("b2", "2", "B")],
      [card("s1", "1", "Z"), card("s2", "2", "B")],
    );
    expect(res.decided).toEqual({});
    expect(res.fuzzyExcluded).toEqual([]);
  });

  test("pairs by player on a duplicated number, folding spelling the way the merge does", () => {
    const res = decide(
      [card("bH", "482", "Rickey Henderson"), card("bG", "482", "Tony Gwynn")],
      [
        card("sG", "482", "tony gwynn", { players: undefined }),
        card("sH", "482", "Henderson, Rickey"),
      ],
    );
    expect(res.decided).toEqual({ bH: "sH", bG: "sG" });
    expect(res.fuzzyExcluded).toEqual(["sG", "sH"]);
  });

  test("a SportLots row taken by a higher-ranked rule is not offered on the number", () => {
    // The operator's stored pairing gave BSC Henderson to SL Henderson; BSC
    // Gwynn must not fall back onto it.
    const sH = card("sH", "482", "Rickey Henderson");
    const res = decide(
      [card("bH", "482", "Rickey Henderson"), card("bG", "482", "Tony Gwynn")],
      [sH],
      { shortCircuit: { bH: sH } },
    );
    expect(res.decided).toEqual({ bG: null });
  });

  test("a BSC variation reaching an ambiguous number gets no guess", () => {
    const res = decide(
      [card("bV", "482", "Tony Gwynn", { isVariation: true })],
      [card("sH", "482", "Rickey Henderson"), card("sG", "482", "Tony Gwynn")],
    );
    expect(res.decided).toEqual({ bV: null });
  });

  test("a prefixed BSC number lands on the stripped SportLots number, as the lookup does", () => {
    const res = decide(
      [card("bH", "ATR-482", "Rickey Henderson"), card("bG", "ATR-482", "Tony Gwynn")],
      [card("sH", "482", "Rickey Henderson"), card("sG", "482", "Tony Gwynn")],
      { prefix: "ATR-" },
    );
    expect(res.decided).toEqual({ bH: "sH", bG: "sG" });
  });

  test("a card with no name at all matches nothing", () => {
    const res = decide(
      [card("b0", "482", "", { players: [] })],
      [card("sH", "482", "Rickey Henderson"), card("s0", "482", "", { players: [] })],
    );
    expect(res.decided).toEqual({ b0: null });
  });
});
