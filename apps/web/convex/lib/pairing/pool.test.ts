/**
 * Unit tests for convex/lib/pairing/pool.ts — a case-for-case mirror of the
 * preprocess service's `tests/unit/test_pairing_pool.py`.
 *
 * Covers the ported matcher end to end: every scoring weight (parametrized
 * off the production constants), the accept threshold, the three confidence
 * levels, the player-disagreement hard reject beating a coincidentally-equal
 * card number, surname-only fronts, the side-only fallback and its two
 * guards, insertion-order tie-breaking, the asymmetric post-pair merge, and
 * same-side collision resolution in all four hasher states (same image /
 * different image / no hasher / hasher failure).
 *
 * The perceptual hasher is faked as a record lookup — distance semantics are
 * exercised in dhash.test.ts, and the pool only cares about the verdict.
 */

import { describe, expect, test, vi } from "vitest";

import { SAME_IMAGE_THRESHOLD } from "./dhash";
import {
  CARD_NUMBER_EXACT_SCORE,
  CardPool,
  MATCH_ACCEPT_THRESHOLD,
  PLAYER_EXACT_SCORE,
  PLAYER_FUZZY_SCORE,
  TEAM_EXACT_SCORE,
  TEAM_FUZZY_SCORE,
  oppositeSide,
  sameCardIdentity,
} from "./pool";
import {
  CardSide,
  ImageHasher,
  PoolCard,
  cardLabel,
  createPoolCard,
  identitySummary,
} from "./types";

/** A hex hash with exactly `bits` low bits set. */
function lowBitsHex(bits: number): string {
  return ((BigInt(1) << BigInt(bits)) - BigInt(1)).toString(16).padStart(16, "0");
}

// Two hashes far enough apart that the pool must read them as different images.
const HASH_A = lowBitsHex(0);
const HASH_FAR = lowBitsHex(SAME_IMAGE_THRESHOLD + 5);
// ...and one close enough to read as the same physical scan.
const HASH_NEAR = lowBitsHex(SAME_IMAGE_THRESHOLD - 1);

function card(
  key: string,
  side: CardSide = "front",
  fields: {
    player?: string | null;
    team?: string | null;
    cardNumber?: string | null;
  } = {},
): PoolCard {
  return createPoolCard({ key, side, identityResolved: true, ...fields });
}

/** Fake ImageHasher backed by a record. */
function hasherFrom(mapping: Record<string, string | null>): ImageHasher {
  return (key) => mapping[key] ?? null;
}

describe("pool basics", () => {
  test("starts empty", () => {
    expect(new CardPool().size).toBe(0);
  });

  test("holds an unmatched card", () => {
    const pool = new CardPool();
    expect(pool.addCard(card("a", "front", { player: "Walker Buehler" }))).toBeNull();
    expect(pool.size).toBe(1);
    expect(pool.entries().map((c) => c.key)).toEqual(["a"]);
  });

  test("remove reports presence", () => {
    const pool = new CardPool();
    pool.addCard(card("a", "front", { player: "Walker Buehler" }));
    expect(pool.remove("a")).toBe(true);
    expect(pool.remove("a")).toBe(false);
  });

  test("same-side cards never match", () => {
    const pool = new CardPool();
    pool.addCard(card("a", "front", { player: "Walker Buehler" }));
    expect(pool.addCard(card("b", "front", { player: "Clayton Kershaw" }))).toBeNull();
    expect(pool.size).toBe(2);
  });

  test("a match removes the partner and retains neither", () => {
    const pool = new CardPool();
    pool.addCard(card("back", "back", { player: "Walker Buehler" }));
    expect(pool.addCard(card("front", "front", { player: "Walker Buehler" }))).not.toBeNull();
    expect(pool.size).toBe(0);
  });

  test("oppositeSide is an involution", () => {
    expect(oppositeSide("front")).toBe("back");
    expect(oppositeSide(oppositeSide("front"))).toBe("front");
  });
});

describe("scoring weights", () => {
  // Each signal in isolation, scored against the production constant.
  test.each([
    [
      "card-number-exact",
      { cardNumber: "25" },
      { cardNumber: "25" },
      CARD_NUMBER_EXACT_SCORE,
      // Was "side-only" under the old boolean rule, which is the bug this
      // banding fixes: a card number is the ONLY field that uniquely
      // identifies a card within a set — it is weighted 2000 for exactly that
      // reason — and the old rule labelled the strongest possible signal with
      // the lowest confidence, because it also demanded a name or team.
      "exact",
    ],
    [
      "player-exact",
      { player: "Walker Buehler" },
      { player: "Walker Buehler" },
      PLAYER_EXACT_SCORE,
      "fuzzy",
    ],
    [
      "player-fuzzy",
      { player: "BUEHLER" },
      { player: "Walker Buehler" },
      PLAYER_FUZZY_SCORE,
      "fuzzy",
    ],
    ["team-exact", { team: "Dodgers" }, { team: "Dodgers" }, TEAM_EXACT_SCORE, "fuzzy"],
    [
      "team-fuzzy",
      { team: "Dodgers" },
      { team: "Los Angeles Dodgers" },
      TEAM_FUZZY_SCORE,
      "fuzzy",
    ],
  ])("single signal: %s", (_id, frontFields, backFields, expectedScore, expectedConfidence) => {
    const pool = new CardPool();
    pool.addCard(card("b", "back", backFields));
    const match = pool.addCard(card("f", "front", frontFields));
    expect(match).not.toBeNull();
    expect(match!.score).toBe(expectedScore);
    expect(match!.confidence).toBe(expectedConfidence);
    expect(match!.mechanism).toBe("pool");
  });

  test("signals are additive", () => {
    const pool = new CardPool();
    pool.addCard(
      card("b", "back", { player: "Walker Buehler", team: "Dodgers", cardNumber: "25" }),
    );
    const match = pool.addCard(
      card("f", "front", { player: "Walker Buehler", team: "Dodgers", cardNumber: "25" }),
    );
    expect(match).not.toBeNull();
    expect(match!.score).toBe(
      CARD_NUMBER_EXACT_SCORE + PLAYER_EXACT_SCORE + TEAM_EXACT_SCORE,
    );
  });

  test("card-number comparison is case and whitespace insensitive", () => {
    const pool = new CardPool();
    pool.addCard(card("b", "back", { cardNumber: " RC-12 " }));
    const match = pool.addCard(card("f", "front", { cardNumber: "rc-12" }));
    expect(match).not.toBeNull();
    expect(match!.score).toBe(CARD_NUMBER_EXACT_SCORE);
  });

  test("card-number ordering dominates every other signal combined", () => {
    // The weight gaps, not the absolute values, are what the port preserves.
    expect(CARD_NUMBER_EXACT_SCORE).toBeGreaterThan(PLAYER_EXACT_SCORE + TEAM_EXACT_SCORE);
    expect(PLAYER_EXACT_SCORE).toBeGreaterThan(PLAYER_FUZZY_SCORE);
    expect(PLAYER_FUZZY_SCORE).toBeGreaterThan(TEAM_FUZZY_SCORE);
    expect(TEAM_EXACT_SCORE).toBeGreaterThan(TEAM_FUZZY_SCORE);
  });
});

describe("accept threshold", () => {
  test("weakest accepted signal sits exactly on the threshold", () => {
    expect(
      Math.min(
        CARD_NUMBER_EXACT_SCORE,
        PLAYER_EXACT_SCORE,
        PLAYER_FUZZY_SCORE,
        TEAM_EXACT_SCORE,
        TEAM_FUZZY_SCORE,
      ),
    ).toBe(MATCH_ACCEPT_THRESHOLD);
  });

  test("a threshold-scoring candidate is accepted", () => {
    const pool = new CardPool();
    pool.addCard(card("b", "back", { team: "Los Angeles Dodgers" }));
    const match = pool.addCard(
      card("f", "front", { team: "Dodgers", player: "Walker Buehler" }),
    );
    expect(match).not.toBeNull();
    expect(match!.score).toBe(TEAM_FUZZY_SCORE);
  });

  test("zero-scoring candidates are not paired", () => {
    // Both carry identity, so the side-only fallback is also blocked.
    const pool = new CardPool();
    pool.addCard(card("b", "back", { team: "Chiefs" }));
    expect(pool.addCard(card("f", "front", { team: "Dodgers" }))).toBeNull();
    expect(pool.size).toBe(2);
  });
});

describe("player-disagreement hard reject", () => {
  // A disagreeing player name is decisive — never a mere penalty.

  test("disagreement beats a coincidentally-equal card number", () => {
    // 2000 points of card-number agreement on the table; the port must still
    // refuse. Card numbers misread off fronts (jersey numbers, copyright
    // years) are exactly how unrelated cards used to pair.
    const pool = new CardPool();
    pool.addCard(card("b", "back", { player: "Clayton Kershaw", cardNumber: "25" }));
    expect(
      pool.addCard(card("f", "front", { player: "Walker Buehler", cardNumber: "25" })),
    ).toBeNull();
    expect(pool.size).toBe(2);
  });

  test("the same card number does pair when no player contradicts it", () => {
    // Control for the test above: the card number really was worth 2000, so
    // the rejection above came from the player check and nothing else.
    const pool = new CardPool();
    pool.addCard(card("b", "back", { player: "Clayton Kershaw", cardNumber: "25" }));
    const match = pool.addCard(card("f", "front", { cardNumber: "25" }));
    expect(match).not.toBeNull();
    expect(match!.score).toBe(CARD_NUMBER_EXACT_SCORE);
  });

  test("rejection does not block a different valid candidate", () => {
    const pool = new CardPool();
    pool.addCard(card("wrong", "back", { player: "Clayton Kershaw", cardNumber: "25" }));
    pool.addCard(card("right", "back", { player: "Walker Buehler" }));
    const match = pool.addCard(
      card("f", "front", { player: "Walker Buehler", cardNumber: "25" }),
    );
    expect(match).not.toBeNull();
    expect(match!.back.key).toBe("right");
  });

  test("disagreement also blocks team agreement", () => {
    const pool = new CardPool();
    pool.addCard(card("b", "back", { player: "Clayton Kershaw", team: "Dodgers" }));
    expect(
      pool.addCard(card("f", "front", { player: "Walker Buehler", team: "Dodgers" })),
    ).toBeNull();
  });
});

describe("surname-only front", () => {
  test("surname-only front pairs with a full-name back", () => {
    const pool = new CardPool();
    pool.addCard(card("b", "back", { player: "Walker Buehler" }));
    const match = pool.addCard(card("f", "front", { player: "BUEHLER" }));
    expect(match).not.toBeNull();
    expect(match!.confidence).toBe("fuzzy");
    expect(match!.score).toBe(PLAYER_FUZZY_SCORE);
  });

  test("a surname-only front still rejects a different surname", () => {
    const pool = new CardPool();
    pool.addCard(card("b", "back", { player: "Clayton Kershaw" }));
    expect(pool.addCard(card("f", "front", { player: "BUEHLER" }))).toBeNull();
  });
});

describe("side-only fallback", () => {
  test("pairs two identity-free cards when only one candidate exists", () => {
    const pool = new CardPool();
    pool.addCard(createPoolCard({ key: "b", side: "back" }));
    const match = pool.addCard(createPoolCard({ key: "f", side: "front" }));
    expect(match).not.toBeNull();
    expect(match!.confidence).toBe("side-only");
    expect(match!.score).toBe(0);
    expect(match!.front.key).toBe("f");
    expect(match!.back.key).toBe("b");
  });

  test("blocked when more than one candidate exists", () => {
    const pool = new CardPool();
    pool.addCard(createPoolCard({ key: "b1", side: "back" }));
    pool.addCard(createPoolCard({ key: "b2", side: "back" }));
    expect(pool.addCard(createPoolCard({ key: "f", side: "front" }))).toBeNull();
  });

  test("blocked when the new card has identity", () => {
    const pool = new CardPool();
    pool.addCard(createPoolCard({ key: "b", side: "back" }));
    expect(pool.addCard(card("f", "front", { player: "Walker Buehler" }))).toBeNull();
  });

  test("blocked when the pooled card has identity", () => {
    const pool = new CardPool();
    pool.addCard(card("b", "back", { team: "Dodgers" }));
    expect(pool.addCard(createPoolCard({ key: "f", side: "front" }))).toBeNull();
  });
});

describe("insertion-order tie-break", () => {
  // Distinct players keep the two candidates from colliding as one card,
  // while the identity-free front leaves the team as the only scoring signal
  // — so both candidates tie at TEAM_EXACT_SCORE.

  test("ties keep the first-offered candidate", () => {
    // `bestScore` starts at 0 with a strict `>`, so the first candidate
    // offered wins a tie. JS Maps iterate in insertion order, which is what
    // makes that reproducible — the original TS relied on `Map` for the same,
    // and the Python port on dict insertion order.
    const pool = new CardPool();
    pool.addCard(card("first", "back", { team: "Dodgers", player: "Walker Buehler" }));
    pool.addCard(card("second", "back", { team: "Dodgers", player: "Clayton Kershaw" }));
    const match = pool.addCard(card("f", "front", { team: "Dodgers" }));
    expect(match).not.toBeNull();
    expect(match!.back.key).toBe("first");
  });

  test("reversing the offer order reverses the winner", () => {
    const pool = new CardPool();
    pool.addCard(card("second", "back", { team: "Dodgers", player: "Clayton Kershaw" }));
    pool.addCard(card("first", "back", { team: "Dodgers", player: "Walker Buehler" }));
    const match = pool.addCard(card("f", "front", { team: "Dodgers" }));
    expect(match).not.toBeNull();
    expect(match!.back.key).toBe("second");
  });

  test("a strictly better candidate still wins from second place", () => {
    const pool = new CardPool();
    pool.addCard(card("weak", "back", { team: "Dodgers", player: "Clayton Kershaw" }));
    pool.addCard(
      card("strong", "back", {
        team: "Dodgers",
        player: "Walker Buehler",
        cardNumber: "25",
      }),
    );
    const match = pool.addCard(card("f", "front", { team: "Dodgers", cardNumber: "25" }));
    expect(match).not.toBeNull();
    expect(match!.back.key).toBe("strong");
    expect(match!.score).toBe(TEAM_EXACT_SCORE + CARD_NUMBER_EXACT_SCORE);
  });
});

describe("post-pair merge", () => {
  test("player and team prefer the front", () => {
    const pool = new CardPool();
    pool.addCard(
      card("b", "back", { player: "Walker Buehler", team: "Los Angeles Dodgers" }),
    );
    const match = pool.addCard(card("f", "front", { player: "BUEHLER", team: "Dodgers" }));
    expect(match).not.toBeNull();
    expect(match!.player).toBe("BUEHLER");
    expect(match!.team).toBe("Dodgers");
  });

  test("player and team fall back to the back", () => {
    // An identity-free front — a photo the model read nothing off — paired
    // on the card number alone still yields a fully identified card.
    const pool = new CardPool();
    pool.addCard(
      card("b", "back", { player: "Walker Buehler", team: "Dodgers", cardNumber: "25" }),
    );
    const match = pool.addCard(card("f", "front", { cardNumber: "25" }));
    expect(match).not.toBeNull();
    expect(match!.player).toBe("Walker Buehler");
    expect(match!.team).toBe("Dodgers");
  });

  test("card number comes from the back only", () => {
    // A card number on a front is a misread, so it never wins the merge —
    // even when the back has none at all.
    const pool = new CardPool();
    pool.addCard(card("b", "back", { player: "Walker Buehler" }));
    const match = pool.addCard(
      card("f", "front", { player: "Walker Buehler", cardNumber: "99" }),
    );
    expect(match).not.toBeNull();
    expect(match!.cardNumber).toBeNull();
  });

  test("card number from the back survives", () => {
    const pool = new CardPool();
    pool.addCard(card("b", "back", { player: "Walker Buehler", cardNumber: "25" }));
    const match = pool.addCard(
      card("f", "front", { player: "Walker Buehler", cardNumber: "99" }),
    );
    expect(match).not.toBeNull();
    expect(match!.cardNumber).toBe("25");
  });

  test("front and back are assigned by side, not arrival", () => {
    const pool = new CardPool();
    pool.addCard(card("arrived-first", "front", { player: "Walker Buehler" }));
    const match = pool.addCard(card("arrived-second", "back", { player: "Walker Buehler" }));
    expect(match).not.toBeNull();
    expect(match!.front.key).toBe("arrived-first");
    expect(match!.back.key).toBe("arrived-second");
  });
});

describe("sameCardIdentity", () => {
  test("agreeing players are the same card", () => {
    expect(
      sameCardIdentity(
        card("a", "front", { player: "BUEHLER" }),
        card("b", "front", { player: "Walker Buehler" }),
      ),
    ).toBe(true);
  });

  test("disagreeing players are decisive over an equal card number", () => {
    const a = card("a", "front", { player: "Walker Buehler", cardNumber: "25" });
    const b = card("b", "front", { player: "Clayton Kershaw", cardNumber: "25" });
    expect(sameCardIdentity(a, b)).toBe(false);
  });

  test("card number is a fallback when a player is missing", () => {
    expect(
      sameCardIdentity(
        card("a", "front", { cardNumber: "25" }),
        card("b", "front", { cardNumber: "25" }),
      ),
    ).toBe(true);
  });

  test("differing card numbers fall through to the team check", () => {
    const a = card("a", "front", { cardNumber: "25", team: "Dodgers" });
    const b = card("b", "front", { cardNumber: "99", team: "Los Angeles Dodgers" });
    expect(sameCardIdentity(a, b)).toBe(true);
  });

  test("differing card numbers with no team are not the same card", () => {
    expect(
      sameCardIdentity(
        card("a", "front", { cardNumber: "25" }),
        card("b", "front", { cardNumber: "99" }),
      ),
    ).toBe(false);
  });

  test("team is the last fallback", () => {
    expect(
      sameCardIdentity(
        card("a", "front", { team: "Dodgers" }),
        card("b", "front", { team: "Los Angeles Dodgers" }),
      ),
    ).toBe(true);
  });

  test("nothing in common is not the same card", () => {
    expect(
      sameCardIdentity(
        card("a", "front", { team: "Chiefs" }),
        card("b", "front", { team: "Dodgers" }),
      ),
    ).toBe(false);
  });
});

describe("same-side collision", () => {
  test("same image evicts the stale entry", () => {
    const pool = new CardPool({ hashImage: hasherFrom({ old: HASH_A, new: HASH_NEAR }) });
    pool.addCard(card("old", "back", { player: "Walker Buehler" }));
    expect(pool.addCard(card("new", "back", { player: "Walker Buehler" }))).toBeNull();
    expect(pool.entries().map((c) => c.key)).toEqual(["new"]);
    expect(pool.entries()[0].side).toBe("back");
  });

  test("different image flips the incoming side and pairs", () => {
    // The mis-classification case: two different images both labelled
    // "back". The incoming one is flipped rather than clobbering the pooled
    // image, and the flip immediately lets the two pair.
    const pool = new CardPool({
      hashImage: hasherFrom({ pooled: HASH_A, incoming: HASH_FAR }),
    });
    pool.addCard(card("pooled", "back", { player: "Walker Buehler" }));
    const match = pool.addCard(card("incoming", "back", { player: "Walker Buehler" }));
    expect(match).not.toBeNull();
    expect(match!.front.key).toBe("incoming");
    expect(match!.front.side).toBe("front");
    expect(match!.back.key).toBe("pooled");
    expect(pool.size).toBe(0);
  });

  test("without a hasher the newest card wins", () => {
    const pool = new CardPool();
    pool.addCard(card("old", "back", { player: "Walker Buehler" }));
    expect(pool.addCard(card("new", "back", { player: "Walker Buehler" }))).toBeNull();
    expect(pool.entries().map((c) => c.key)).toEqual(["new"]);
  });

  test("an unhashable image degrades to newer-wins", () => {
    const pool = new CardPool({ hashImage: hasherFrom({ old: HASH_A, new: null }) });
    pool.addCard(card("old", "back", { player: "Walker Buehler" }));
    expect(pool.addCard(card("new", "back", { player: "Walker Buehler" }))).toBeNull();
    expect(pool.entries().map((c) => c.key)).toEqual(["new"]);
  });

  test("a raising hasher degrades to newer-wins", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const boom: ImageHasher = () => {
        throw new Error("cannot read image");
      };
      const pool = new CardPool({ hashImage: boom });
      pool.addCard(card("old", "back", { player: "Walker Buehler" }));
      expect(pool.addCard(card("new", "back", { player: "Walker Buehler" }))).toBeNull();
      expect(pool.entries().map((c) => c.key)).toEqual(["new"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("hashing failed"));
    } finally {
      warn.mockRestore();
    }
  });

  test("a hasher returning malformed hex degrades to newer-wins", () => {
    // TS-contract addition: hashes are hex strings here, so a hasher can hand
    // back garbage the Python int-based port could not. It must degrade the
    // same way a hashing failure does.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pool = new CardPool({
        hashImage: hasherFrom({ old: HASH_A, new: "NOT-HEX" }),
      });
      pool.addCard(card("old", "back", { player: "Walker Buehler" }));
      expect(pool.addCard(card("new", "back", { player: "Walker Buehler" }))).toBeNull();
      expect(pool.entries().map((c) => c.key)).toEqual(["new"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("malformed hash"));
    } finally {
      warn.mockRestore();
    }
  });

  test("hashes are memoised on the card", () => {
    const calls: string[] = [];
    const counting: ImageHasher = (key) => {
      calls.push(key);
      return HASH_A;
    };

    const pool = new CardPool({ hashImage: counting });
    pool.addCard(card("old", "back", { player: "Walker Buehler" }));
    pool.addCard(card("new", "back", { player: "Walker Buehler" }));
    expect(pool.entries()[0].imageHash).toBe(HASH_A);
    // Second collision on the surviving card must not re-hash it.
    const before = calls.length;
    pool.addCard(card("newer", "back", { player: "Walker Buehler" }));
    expect(calls.slice(before)).toEqual(["newer"]);
  });

  test("identity-free cards skip collision resolution", () => {
    const pool = new CardPool({ hashImage: hasherFrom({ a: HASH_A, b: HASH_FAR }) });
    pool.addCard(createPoolCard({ key: "a", side: "back" }));
    pool.addCard(createPoolCard({ key: "b", side: "back" }));
    expect(pool.size).toBe(2);
  });

  test("cards of different sides do not collide", () => {
    const pool = new CardPool({ hashImage: hasherFrom({ f: HASH_A, b: HASH_FAR }) });
    pool.addCard(card("b", "back", { player: "Walker Buehler" }));
    const match = pool.addCard(card("f", "front", { player: "Walker Buehler" }));
    expect(match).not.toBeNull();
    expect(match!.front.key).toBe("f");
  });

  test("a card never collides with its own key", () => {
    // Re-offering the same key (a retried image, say) must not read the
    // pooled copy of itself as a collision and flip its own side.
    const pool = new CardPool({ hashImage: hasherFrom({ a: HASH_A }) });
    pool.addCard(card("a", "back", { player: "Walker Buehler" }));
    expect(pool.addCard(card("a", "back", { player: "Walker Buehler" }))).toBeNull();
    expect(pool.size).toBe(1);
    expect(pool.entries()[0].side).toBe("back");
  });

  test("a non-colliding same-side card is left alone", () => {
    const pool = new CardPool({ hashImage: hasherFrom({ a: HASH_A, b: HASH_FAR }) });
    pool.addCard(card("a", "back", { player: "Walker Buehler" }));
    pool.addCard(card("b", "back", { player: "Clayton Kershaw" }));
    expect(pool.entries().map((c) => c.key)).toEqual(["a", "b"]);
  });
});

describe("PoolCard log helpers (TS additions)", () => {
  // The Python port carries these as untested properties; minimal coverage
  // here keeps the ported behaviour honest.

  test("cardLabel prefers originalFilename and falls back to key/unknown", () => {
    const named = createPoolCard({
      key: "member-3",
      side: "front",
      player: "Walker Buehler",
      originalFilename: "IMG_0042.HEIC",
    });
    expect(cardLabel(named)).toBe("Walker Buehler (IMG_0042.HEIC)");
    expect(cardLabel(createPoolCard({ key: "member-3", side: "front" }))).toBe(
      "unknown (member-3)",
    );
  });

  test("identitySummary renders null fields literally", () => {
    const c = createPoolCard({ key: "k", side: "back", player: "Walker Buehler" });
    expect(identitySummary(c)).toBe("player=Walker Buehler team=null cardNumber=null");
  });
});
