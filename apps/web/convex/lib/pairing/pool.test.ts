/**
 * Unit tests for convex/lib/pairing/pool.ts — a case-for-case mirror of the
 * preprocess service's `tests/unit/test_pairing_pool.py`.
 *
 * Covers the ported matcher end to end: every scoring weight (parametrized
 * off the production constants), the accept threshold, the three confidence
 * levels, the player-disagreement hard reject beating a coincidentally-equal
 * card number, surname-only fronts, the side-only fallback and its two
 * guards, insertion-order tie-breaking, the asymmetric post-pair merge, and
 * re-scan eviction in all four hasher states (same image / different image /
 * no hasher / hasher failure). NEO-327: pairs are oriented by `orientPair`
 * (user label, then text count, then disagreeing labels), never by arrival.
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
  TEXT_ORIENT_MIN_GAP,
  TEXT_ORIENT_MIN_RATIO,
  orientPair,
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

/**
 * A resolved card carrying a classifier `label`. Text counts default to 0 on
 * both sides, so unless a test sets them, pairs are oriented by the labels.
 */
function card(
  key: string,
  label: CardSide | null = "front",
  fields: {
    player?: string | null;
    team?: string | null;
    cardNumber?: string | null;
    textCount?: number;
    labelByUser?: boolean;
  } = {},
): PoolCard {
  return createPoolCard({ key, label, identityResolved: true, ...fields });
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

  test("two same-label images with no text gap never match", () => {
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

});

describe("orientPair", () => {
  const FRONT_WORDS = 6;
  const BACK_WORDS = 120;

  test("clearly more text is the back, whatever the labels say", () => {
    // The photo-back case: the classifier calls both images "front".
    const photo = card("photo", "front", { textCount: FRONT_WORDS });
    const back = card("back", "front", { textCount: BACK_WORDS });
    const o = orientPair(back, photo);
    expect(o).not.toBeNull();
    expect(o!.front.key).toBe("photo");
    expect(o!.back.key).toBe("back");
    expect(o!.rule).toBe("text");
  });

  test("is symmetric in its arguments", () => {
    const a = card("a", null, { textCount: FRONT_WORDS });
    const b = card("b", null, { textCount: BACK_WORDS });
    const ab = orientPair(a, b)!;
    const ba = orientPair(b, a)!;
    expect([ab.front.key, ab.back.key, ab.rule]).toEqual([
      ba.front.key,
      ba.back.key,
      ba.rule,
    ]);
  });

  test("both thresholds must hold for a text orientation", () => {
    // Ratio passes, gap fails: two text-light images.
    expect(
      orientPair(card("a", null, { textCount: 1 }), card("b", null, { textCount: 1 + TEXT_ORIENT_MIN_GAP - 1 })),
    ).toBeNull();
    // Gap passes, ratio fails: two text-heavy images.
    expect(
      orientPair(card("a", null, { textCount: 100 }), card("b", null, { textCount: 100 * TEXT_ORIENT_MIN_RATIO - 1 })),
    ).toBeNull();
  });

  test("close text counts fall back to disagreeing labels", () => {
    const o = orientPair(card("b", "back"), card("f", "front"));
    expect(o).not.toBeNull();
    expect(o!.front.key).toBe("f");
    expect(o!.rule).toBe("label");
  });

  test("close text counts and agreeing labels are not a pair", () => {
    expect(orientPair(card("a", "front"), card("b", "front"))).toBeNull();
    expect(orientPair(card("a", null), card("b", "front"))).toBeNull();
  });

  test("a user-set label decides over text", () => {
    // The person says the text-heavy image is the front.
    const o = orientPair(
      card("heavy", "front", { textCount: BACK_WORDS, labelByUser: true }),
      card("light", "front", { textCount: FRONT_WORDS }),
    );
    expect(o).not.toBeNull();
    expect(o!.front.key).toBe("heavy");
    expect(o!.back.key).toBe("light");
    expect(o!.rule).toBe("user");
  });

  test("two disagreeing user labels decide", () => {
    const o = orientPair(
      card("a", "back", { textCount: FRONT_WORDS, labelByUser: true }),
      card("b", "front", { textCount: BACK_WORDS, labelByUser: true }),
    );
    expect(o!.front.key).toBe("b");
    expect(o!.rule).toBe("user");
  });

  test("two agreeing user labels are not a pair, whatever the text says", () => {
    // The side the person set wins: they said both show the front, so a
    // strong text gap must not turn them into a front/back pair.
    expect(
      orientPair(
        card("a", "front", { textCount: FRONT_WORDS, labelByUser: true }),
        card("b", "front", { textCount: BACK_WORDS, labelByUser: true }),
      ),
    ).toBeNull();
    expect(
      orientPair(
        card("a", "back", { textCount: BACK_WORDS, labelByUser: true }),
        card("b", "front", { textCount: FRONT_WORDS, labelByUser: false }),
      )!.rule,
    ).toBe("user");
  });

  test("two agreeing user labels never pair in the pool", () => {
    const pool = new CardPool();
    pool.addCard(
      card("a", "front", { player: "Walker Buehler", textCount: FRONT_WORDS, labelByUser: true }),
    );
    expect(
      pool.addCard(
        card("b", "front", { player: "Walker Buehler", textCount: BACK_WORDS, labelByUser: true }),
      ),
    ).toBeNull();
    expect(pool.size).toBe(2);
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
    pool.addCard(createPoolCard({ key: "b", label: "back" }));
    const match = pool.addCard(createPoolCard({ key: "f", label: "front" }));
    expect(match).not.toBeNull();
    expect(match!.confidence).toBe("side-only");
    expect(match!.score).toBe(0);
    expect(match!.front.key).toBe("f");
    expect(match!.back.key).toBe("b");
  });

  test("blocked when more than one orientable candidate exists", () => {
    const pool = new CardPool();
    pool.addCard(createPoolCard({ key: "b1", label: "back" }));
    pool.addCard(createPoolCard({ key: "b2", label: "back" }));
    expect(pool.addCard(createPoolCard({ key: "f", label: "front" }))).toBeNull();
  });

  test("blocked when the new card has identity", () => {
    const pool = new CardPool();
    pool.addCard(createPoolCard({ key: "b", label: "back" }));
    expect(pool.addCard(card("f", "front", { player: "Walker Buehler" }))).toBeNull();
  });

  test("blocked when the pooled card has identity", () => {
    const pool = new CardPool();
    pool.addCard(card("b", "back", { team: "Dodgers" }));
    expect(pool.addCard(createPoolCard({ key: "f", label: "front" }))).toBeNull();
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
    // The front image keeps the number it read (often a jersey number), but
    // it never names the pair — even when the back has none at all.
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

  test("front and back are assigned by orientation, not arrival", () => {
    for (const order of [
      ["the-back", "the-front"],
      ["the-front", "the-back"],
    ]) {
      const pool = new CardPool();
      const cards: Record<string, PoolCard> = {
        // Both labelled "front" — the photo-back failure the labels make.
        "the-front": card("the-front", "front", { player: "Walker Buehler", textCount: 6 }),
        "the-back": card("the-back", "front", { player: "Walker Buehler", textCount: 120 }),
      };
      pool.addCard(cards[order[0]]);
      const match = pool.addCard(cards[order[1]]);
      expect(match).not.toBeNull();
      expect(match!.front.key).toBe("the-front");
      expect(match!.back.key).toBe("the-back");
      expect(match!.orientedBy).toBe("text");
    }
  });

  test("a duplicate copy is skipped and the true partner still wins", () => {
    const pool = new CardPool();
    // Two fronts of the same card, then its back.
    pool.addCard(card("front-1", "front", { player: "Walker Buehler", textCount: 6 }));
    expect(
      pool.addCard(card("front-2", "front", { player: "Walker Buehler", textCount: 7 })),
    ).toBeNull();
    const match = pool.addCard(
      card("the-back", "front", { player: "Walker Buehler", textCount: 120 }),
    );
    expect(match).not.toBeNull();
    expect(match!.back.key).toBe("the-back");
    expect(match!.front.key).toBe("front-1");
    expect(pool.entries().map((c) => c.key)).toEqual(["front-2"]);
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

describe("re-scan eviction", () => {
  test("same identity and same image evicts the stale entry", () => {
    const pool = new CardPool({ hashImage: hasherFrom({ old: HASH_A, new: HASH_NEAR }) });
    pool.addCard(card("old", "back", { player: "Walker Buehler" }));
    expect(pool.addCard(card("new", "back", { player: "Walker Buehler" }))).toBeNull();
    expect(pool.entries().map((c) => c.key)).toEqual(["new"]);
    expect(pool.entries()[0].label).toBe("back");
  });

  test("a re-scan is evicted whatever its label", () => {
    // Labels are not trusted to say which side an image shows, so a re-scan
    // the classifier labelled differently is still the same picture.
    const pool = new CardPool({ hashImage: hasherFrom({ old: HASH_A, new: HASH_NEAR }) });
    pool.addCard(card("old", "back", { player: "Walker Buehler" }));
    expect(pool.addCard(card("new", "front", { player: "Walker Buehler" }))).toBeNull();
    expect(pool.entries().map((c) => c.key)).toEqual(["new"]);
  });

  test("a different image with the same label is never flipped into a pair", () => {
    // The old pool flipped the incoming label here, so upload order picked
    // the front. Now two same-label images with no text gap are what a
    // duplicate copy looks like, and both are held.
    const pool = new CardPool({
      hashImage: hasherFrom({ pooled: HASH_A, incoming: HASH_FAR }),
    });
    pool.addCard(card("pooled", "back", { player: "Walker Buehler" }));
    expect(pool.addCard(card("incoming", "back", { player: "Walker Buehler" }))).toBeNull();
    expect(pool.entries().map((c) => c.key)).toEqual(["pooled", "incoming"]);
    expect(pool.entries().map((c) => c.label)).toEqual(["back", "back"]);
  });

  test("a different image with the same label pairs on a text gap", () => {
    const pool = new CardPool({
      hashImage: hasherFrom({ pooled: HASH_A, incoming: HASH_FAR }),
    });
    pool.addCard(card("pooled", "front", { player: "Walker Buehler", textCount: 120 }));
    const match = pool.addCard(
      card("incoming", "front", { player: "Walker Buehler", textCount: 6 }),
    );
    expect(match).not.toBeNull();
    expect(match!.front.key).toBe("incoming");
    expect(match!.back.key).toBe("pooled");
    expect(match!.orientedBy).toBe("text");
    expect(pool.size).toBe(0);
  });

  test("without a hasher nothing is evicted", () => {
    const pool = new CardPool();
    pool.addCard(card("old", "back", { player: "Walker Buehler" }));
    expect(pool.addCard(card("new", "back", { player: "Walker Buehler" }))).toBeNull();
    expect(pool.entries().map((c) => c.key)).toEqual(["old", "new"]);
  });

  test("an unhashable image evicts nothing", () => {
    const pool = new CardPool({ hashImage: hasherFrom({ old: HASH_A, new: null }) });
    pool.addCard(card("old", "back", { player: "Walker Buehler" }));
    expect(pool.addCard(card("new", "back", { player: "Walker Buehler" }))).toBeNull();
    expect(pool.entries().map((c) => c.key)).toEqual(["old", "new"]);
  });

  test("a raising hasher evicts nothing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const boom: ImageHasher = () => {
        throw new Error("cannot read image");
      };
      const pool = new CardPool({ hashImage: boom });
      pool.addCard(card("old", "back", { player: "Walker Buehler" }));
      expect(pool.addCard(card("new", "back", { player: "Walker Buehler" }))).toBeNull();
      expect(pool.entries().map((c) => c.key)).toEqual(["old", "new"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("hashing failed"));
    } finally {
      warn.mockRestore();
    }
  });

  test("a hasher returning malformed hex evicts nothing", () => {
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
      expect(pool.entries().map((c) => c.key)).toEqual(["old", "new"]);
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
    // Second re-scan against the surviving card must not re-hash it.
    const before = calls.length;
    pool.addCard(card("newer", "back", { player: "Walker Buehler" }));
    expect(calls.slice(before)).toEqual(["newer"]);
  });

  test("identity-free cards skip re-scan detection", () => {
    const pool = new CardPool({ hashImage: hasherFrom({ a: HASH_A, b: HASH_A }) });
    pool.addCard(createPoolCard({ key: "a", label: "back" }));
    pool.addCard(createPoolCard({ key: "b", label: "back" }));
    expect(pool.size).toBe(2);
  });

  test("a card never evicts its own key", () => {
    // Re-offering the same key (a retried image, say) replaces the held copy
    // without reading it as a re-scan or a partner.
    const pool = new CardPool({ hashImage: hasherFrom({ a: HASH_A }) });
    pool.addCard(card("a", "back", { player: "Walker Buehler" }));
    expect(pool.addCard(card("a", "back", { player: "Walker Buehler" }))).toBeNull();
    expect(pool.size).toBe(1);
    expect(pool.entries()[0].label).toBe("back");
  });

  test("a different card is left alone", () => {
    const pool = new CardPool({ hashImage: hasherFrom({ a: HASH_A, b: HASH_A }) });
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
      label: "front",
      player: "Walker Buehler",
      originalFilename: "IMG_0042.HEIC",
    });
    expect(cardLabel(named)).toBe("Walker Buehler (IMG_0042.HEIC)");
    expect(cardLabel(createPoolCard({ key: "member-3", label: "front" }))).toBe(
      "unknown (member-3)",
    );
  });

  test("identitySummary renders null fields literally", () => {
    const c = createPoolCard({ key: "k", label: "back", player: "Walker Buehler" });
    expect(identitySummary(c)).toBe("player=Walker Buehler team=null cardNumber=null");
  });
});

// ── NEO-327 adversarial coverage ─────────────────────────────────────────────

describe("orientPair: text thresholds at their boundaries", () => {
  /** Orient two label-free cards with the given text counts. */
  const byText = (x: number, y: number) =>
    orientPair(card("x", null, { textCount: x }), card("y", null, { textCount: y }));

  test("the production thresholds are what these boundary tests assume", () => {
    expect(TEXT_ORIENT_MIN_RATIO).toBe(4);
    expect(TEXT_ORIENT_MIN_GAP).toBe(40);
  });

  test("ratio exactly 4 with a gap under 40 does not fire", () => {
    expect(byText(13, 52)).toBeNull(); // ratio 4, gap 39
  });

  test("a zero-word image against fewer than 40 words does not fire", () => {
    // Ratio is trivially met against zero; the gap is what holds it back.
    expect(byText(0, 39)).toBeNull();
    expect(byText(0, 0)).toBeNull();
  });

  test("gap exactly 40 with a ratio under 4 does not fire", () => {
    expect(byText(14, 54)).toBeNull(); // gap 40, ratio 3.86
    expect(byText(100, 140)).toBeNull();
  });

  test("each edge is inclusive", () => {
    // Integers cannot sit on both edges at once (lo*4 - lo = 40 has no
    // integer lo), so each edge is pinned with the other comfortably met.
    const atRatio = byText(14, 56)!; // ratio exactly 4, gap 42
    expect(atRatio.rule).toBe("text");
    expect(atRatio.back.key).toBe("y");
    expect(atRatio.front.key).toBe("x");
    expect(byText(13, 53)!.rule).toBe("text"); // gap exactly 40, ratio 4.08
  });

  test("one word under either edge stops firing", () => {
    expect(byText(13, 52)).toBeNull(); // gap 39
    expect(byText(14, 55)).toBeNull(); // ratio just under 4
    expect(byText(14, 56)!.rule).toBe("text");
  });

  test("zero words against 40 fires", () => {
    expect(byText(0, 40)!.back.key).toBe("y");
  });

  test("two text-light fronts (13 vs 4) do not orient", () => {
    // Ratio 3.25, gap 9: a duplicate front, not a pair.
    expect(byText(13, 4)).toBeNull();
    expect(byText(4, 13)).toBeNull();
  });

  test("every observed same-side combination is blocked", () => {
    expect(byText(5, 13)).toBeNull(); // two fronts, ratio 2.6 / gap 9
    expect(byText(110, 142)).toBeNull(); // two backs, ratio 1.29 / gap 32
    expect(byText(138, 155)).toBeNull(); // two stat backs
  });

  test("the most text-heavy front against the most text-light back still orients", () => {
    // Worst case across the measured ranges: max front 15, min back 110.
    const o = byText(15, 110)!;
    expect(o.rule).toBe("text");
    expect(o.back.key).toBe("y");
  });

  test("the heavier image is the back in either argument order", () => {
    expect(byText(120, 6)!.back.key).toBe("x");
    expect(byText(6, 120)!.back.key).toBe("y");
  });
});

describe("orientPair: labels and user rules around the text rule", () => {
  const FEW = 6;
  const MANY = 120;

  test("text beats labels that point the other way", () => {
    // The labels say the heavy image is the front; the text says back.
    const o = orientPair(
      card("heavy", "front", { textCount: MANY }),
      card("light", "back", { textCount: FEW }),
    )!;
    expect(o.rule).toBe("text");
    expect(o.back.key).toBe("heavy");
  });

  test("labels break the tie only inside the text band", () => {
    const inBand = orientPair(
      card("f", "front", { textCount: 50 }),
      card("b", "back", { textCount: 60 }),
    )!;
    expect(inBand.rule).toBe("label");
    expect(inBand.front.key).toBe("f");
    // The label can disagree with which image has more words; inside the band
    // it still decides.
    const inverted = orientPair(
      card("f", "front", { textCount: 60 }),
      card("b", "back", { textCount: 50 }),
    )!;
    expect(inverted.rule).toBe("label");
    expect(inverted.front.key).toBe("f");
  });

  test("labels are symmetric in argument order", () => {
    const a = card("a", "back", { textCount: 50 });
    const b = card("b", "front", { textCount: 55 });
    const ab = orientPair(a, b)!;
    const ba = orientPair(b, a)!;
    expect([ab.front.key, ab.back.key, ab.rule]).toEqual([ba.front.key, ba.back.key, ba.rule]);
  });

  test("same labels inside the band are not a pair", () => {
    expect(orientPair(card("a", "back", { textCount: 50 }), card("b", "back", { textCount: 60 }))).toBeNull();
    expect(orientPair(card("a", "front", { textCount: 50 }), card("b", "front", { textCount: 60 }))).toBeNull();
  });

  test("null labels inside the band are not a pair", () => {
    expect(orientPair(card("a", null, { textCount: 50 }), card("b", null, { textCount: 60 }))).toBeNull();
    expect(orientPair(card("a", "front", { textCount: 50 }), card("b", null, { textCount: 60 }))).toBeNull();
  });

  test("a label that is not front or back is no label", () => {
    const bogus = createPoolCard({ key: "a", label: "sideways" as unknown as CardSide });
    expect(orientPair(bogus, card("b", "front"))).toBeNull();
  });

  test("a lone user label decides which is the front, whichever side it names", () => {
    const userFront = orientPair(
      card("u", "front", { textCount: 120, labelByUser: true }),
      card("o", "back", { textCount: 6 }),
    )!;
    expect([userFront.front.key, userFront.rule]).toEqual(["u", "user"]);
    const userBack = orientPair(
      card("u", "back", { textCount: 6, labelByUser: true }),
      card("o", "front", { textCount: 120 }),
    )!;
    expect([userBack.back.key, userBack.rule]).toEqual(["u", "user"]);
  });

  test("a lone user label is argument-order symmetric", () => {
    const u = card("u", "back", { labelByUser: true });
    const o = card("o", null);
    expect(orientPair(u, o)!.back.key).toBe("u");
    expect(orientPair(o, u)!.back.key).toBe("u");
    expect(orientPair(o, u)!.front.key).toBe("o");
  });

  test("a lone user label ignores the other image's classifier label", () => {
    // The other image's label agrees with the user's side: still the user wins.
    const o = orientPair(
      card("u", "front", { labelByUser: true }),
      card("o", "front"),
    )!;
    expect([o.front.key, o.back.key, o.rule]).toEqual(["u", "o", "user"]);
  });

  test("two disagreeing user labels are symmetric", () => {
    const a = card("a", "front", { labelByUser: true });
    const b = card("b", "back", { labelByUser: true });
    expect(orientPair(a, b)!.front.key).toBe("a");
    expect(orientPair(b, a)!.front.key).toBe("a");
  });

  test("two same-side user labels are null for both sides and argument orders", () => {
    for (const side of ["front", "back"] as const) {
      const a = card("a", side, { textCount: 6, labelByUser: true });
      const b = card("b", side, { textCount: 120, labelByUser: true });
      expect(orientPair(a, b)).toBeNull();
      expect(orientPair(b, a)).toBeNull();
    }
  });

  test("labelByUser on a card with no label is not a user label", () => {
    // The flag without a valid side must not fire rule 0.
    const flagOnly = createPoolCard({ key: "a", label: null, labelByUser: true, textCount: 6 });
    const o = orientPair(flagOnly, card("b", null, { textCount: 120 }))!;
    expect(o.rule).toBe("text");
  });
});

describe("orientPair: the duplicate-copy guard", () => {
  test("two low-text cards with the same label never pair (5 vs 11)", () => {
    expect(
      orientPair(card("a", "front", { textCount: 5 }), card("b", "front", { textCount: 11 })),
    ).toBeNull();
    expect(
      orientPair(card("a", "back", { textCount: 5 }), card("b", "back", { textCount: 11 })),
    ).toBeNull();
  });

  test("two high-text cards never pair on text (110 vs 142)", () => {
    expect(
      orientPair(card("a", "back", { textCount: 110 }), card("b", "back", { textCount: 142 })),
    ).toBeNull();
  });

  test("two high-text cards with disagreeing labels pair by label", () => {
    const o = orientPair(
      card("a", "front", { textCount: 110 }),
      card("b", "back", { textCount: 142 }),
    )!;
    expect(o.rule).toBe("label");
    expect(o.front.key).toBe("a");
  });

  test("two same-label copies of one card never pair in the pool", () => {
    for (const [lo, hi] of [
      [5, 11],
      [110, 142],
    ]) {
      const pool = new CardPool();
      pool.addCard(card("a", "front", { player: "Walker Buehler", textCount: lo }));
      expect(
        pool.addCard(card("b", "front", { player: "Walker Buehler", textCount: hi })),
      ).toBeNull();
      expect(pool.size).toBe(2);
    }
  });
});

describe("findMatch: orientation instead of a label gate", () => {
  test("same-label cards pair when the text separates them", () => {
    const pool = new CardPool();
    pool.addCard(card("a", "back", { player: "Walker Buehler", textCount: 6 }));
    const match = pool.addCard(card("b", "back", { player: "Walker Buehler", textCount: 120 }));
    expect(match).not.toBeNull();
    expect(match!.front.key).toBe("a");
    expect(match!.back.key).toBe("b");
  });

  test("front and back follow the text whatever the labels or the arrival order", () => {
    const labelPairs: [CardSide | null, CardSide | null][] = [
      ["front", "front"],
      ["back", "back"],
      ["back", "front"], // both wrong
      [null, null],
      ["front", null],
    ];
    for (const [frontLabel, backLabel] of labelPairs) {
      for (const backFirst of [false, true]) {
        const front = card("the-front", frontLabel, { player: "Ben Tate", textCount: 8 });
        const back = card("the-back", backLabel, { player: "Ben Tate", textCount: 130 });
        const pool = new CardPool();
        const [first, second] = backFirst ? [back, front] : [front, back];
        pool.addCard(first);
        const match = pool.addCard(second);
        expect(match, `${frontLabel}/${backLabel} backFirst=${backFirst}`).not.toBeNull();
        expect(match!.front.key).toBe("the-front");
        expect(match!.back.key).toBe("the-back");
      }
    }
  });

  test("a user-set side beats the text when the pool pairs", () => {
    const pool = new CardPool();
    pool.addCard(card("heavy", "front", { player: "Ben Tate", textCount: 130, labelByUser: true }));
    const match = pool.addCard(card("light", "front", { player: "Ben Tate", textCount: 8 }));
    expect(match!.front.key).toBe("heavy");
    expect(match!.orientedBy).toBe("user");
  });

  test("a held duplicate does not block the true partner (copy held first)", () => {
    const pool = new CardPool();
    pool.addCard(card("front-1", "front", { player: "Ben Tate", textCount: 8 }));
    pool.addCard(card("other", "front", { player: "Walker Buehler", textCount: 9 }));
    expect(
      pool.addCard(card("front-2", "front", { player: "Ben Tate", textCount: 6 })),
    ).toBeNull();
    const match = pool.addCard(card("back", "back", { player: "Ben Tate", textCount: 130 }));
    expect(match).not.toBeNull();
    expect(match!.back.key).toBe("back");
    expect(match!.front.key).toBe("front-1");
  });

  test("unpairedFrom on the incoming card still rejects", () => {
    const pool = new CardPool();
    pool.addCard(card("b", "back", { player: "Ben Tate", textCount: 130 }));
    const incoming = createPoolCard({
      key: "f",
      label: "front",
      player: "Ben Tate",
      textCount: 8,
      unpairedFrom: ["b"],
    });
    expect(pool.addCard(incoming)).toBeNull();
    expect(pool.size).toBe(2);
  });

  test("unpairedFrom on the held card still rejects", () => {
    const pool = new CardPool();
    pool.addCard(
      createPoolCard({
        key: "b",
        label: "back",
        player: "Ben Tate",
        textCount: 130,
        unpairedFrom: ["f"],
      }),
    );
    expect(pool.addCard(card("f", "front", { player: "Ben Tate", textCount: 8 }))).toBeNull();
    expect(pool.size).toBe(2);
  });

  test("a split from one candidate leaves the other candidate available", () => {
    const pool = new CardPool();
    pool.addCard(card("split", "back", { player: "Ben Tate", textCount: 130 }));
    pool.addCard(card("ok", "back", { player: "Ben Tate", textCount: 125 }));
    // `ok` was a duplicate of `split`'s side: held. Now the front arrives.
    const front = createPoolCard({
      key: "f",
      label: "front",
      player: "Ben Tate",
      textCount: 8,
      unpairedFrom: ["split"],
    });
    const match = pool.addCard(front);
    expect(match!.back.key).toBe("ok");
  });

  test("a player disagreement still rejects when the text would orient them", () => {
    const pool = new CardPool();
    pool.addCard(card("b", "back", { player: "Clayton Kershaw", textCount: 130 }));
    expect(
      pool.addCard(card("f", "front", { player: "Ben Tate", textCount: 8, cardNumber: "20" })),
    ).toBeNull();
  });

  test("an unorientable candidate is skipped even with a perfect identity", () => {
    const pool = new CardPool();
    pool.addCard(
      card("copy", "front", { player: "Ben Tate", team: "Browns", cardNumber: "20", textCount: 7 }),
    );
    expect(
      pool.addCard(
        card("copy-2", "front", { player: "Ben Tate", team: "Browns", cardNumber: "20", textCount: 9 }),
      ),
    ).toBeNull();
  });

  test("the orientation rule is reported on the match", () => {
    const pool = new CardPool();
    pool.addCard(card("b", "back", { player: "Ben Tate", textCount: 50 }));
    const m = pool.addCard(card("f", "front", { player: "Ben Tate", textCount: 55 }));
    expect(m!.orientedBy).toBe("label");
  });
});

describe("card numbers: every card keeps its own", () => {
  test("both carrying one and agreeing adds the card-number score", () => {
    const pool = new CardPool();
    pool.addCard(card("b", "back", { cardNumber: "20", textCount: 130 }));
    const match = pool.addCard(card("f", "front", { cardNumber: "20", textCount: 8 }));
    expect(match!.score).toBe(CARD_NUMBER_EXACT_SCORE);
    expect(match!.confidence).toBe("exact");
  });

  test("a front's jersey number that disagrees is no penalty and is kept", () => {
    // Ben Tate: the back prints card number 20, the front photo reads 44.
    const pool = new CardPool();
    const back = card("back", "front", { player: "Ben Tate", cardNumber: "20", textCount: 130 });
    const front = card("front", "front", { player: "Ben Tate", cardNumber: "44", textCount: 8 });
    pool.addCard(back);
    const match = pool.addCard(front);
    expect(match!.score).toBe(PLAYER_EXACT_SCORE);
    expect(match!.cardNumber).toBe("20");
    expect(match!.front.cardNumber).toBe("44");
    expect(match!.back.cardNumber).toBe("20");
  });

  test("the pair's number is the oriented back's whichever image arrived first", () => {
    for (const backFirst of [true, false]) {
      const pool = new CardPool();
      const back = card("back", "front", { player: "Ben Tate", cardNumber: "20", textCount: 130 });
      const front = card("front", "front", { player: "Ben Tate", cardNumber: "44", textCount: 8 });
      if (backFirst) pool.addCard(back);
      else pool.addCard(front);
      const match = pool.addCard(backFirst ? front : back);
      expect(match!.cardNumber).toBe("20");
    }
  });

  test("the pool never rewrites a held card's number or label", () => {
    const pool = new CardPool();
    const held = card("held", "front", { player: "Ben Tate", cardNumber: "44", textCount: 8 });
    pool.addCard(held);
    pool.addCard(card("other", "front", { player: "Walker Buehler", textCount: 9 }));
    expect(held.cardNumber).toBe("44");
    expect(held.label).toBe("front");
  });
});

describe("side-only fallback: orientation and splits", () => {
  const bare = (key: string, label: CardSide | null, extra: Partial<PoolCard> = {}) =>
    createPoolCard({ key, label, ...extra });

  test("pairs a lone orientable identity-free card by text, no labels", () => {
    const pool = new CardPool();
    pool.addCard(bare("b", null, { textCount: 130 }));
    const m = pool.addCard(bare("f", null, { textCount: 8 }));
    expect(m!.confidence).toBe("side-only");
    expect(m!.orientedBy).toBe("text");
    expect(m!.front.key).toBe("f");
  });

  test("respects unpairedFrom in either direction", () => {
    const incomingSplit = new CardPool();
    incomingSplit.addCard(bare("b", "back"));
    expect(incomingSplit.addCard(bare("f", "front", { unpairedFrom: ["b"] }))).toBeNull();

    const heldSplit = new CardPool();
    heldSplit.addCard(bare("b", "back", { unpairedFrom: ["f"] }));
    expect(heldSplit.addCard(bare("f", "front"))).toBeNull();
    expect(heldSplit.size).toBe(2);
  });

  test("a split candidate does not count toward the one-candidate rule", () => {
    // Two backs held, but the user split one: exactly one orientable remains.
    const pool = new CardPool();
    pool.addCard(bare("b1", "back"));
    pool.addCard(bare("b2", "back"));
    const m = pool.addCard(bare("f", "front", { unpairedFrom: ["b1"] }));
    expect(m!.back.key).toBe("b2");
  });

  test("a held card that cannot orient does not count either", () => {
    // `b` and `f0` were split by the user so both stay held. Incoming `f1`
    // orients against `b` only; `f0` is the same side with no text gap.
    const pool = new CardPool();
    pool.addCard(bare("b", "back"));
    pool.addCard(bare("f0", "front", { unpairedFrom: ["b"] }));
    expect(pool.size).toBe(2);
    const m = pool.addCard(bare("f1", "front"));
    expect(m!.back.key).toBe("b");
    expect(m!.front.key).toBe("f1");
  });

  test("an identity-free orientable card is not paired with an identity-carrying one", () => {
    const pool = new CardPool();
    pool.addCard(bare("b", "back"));
    expect(pool.addCard(card("f", "front", { cardNumber: "9" }))).toBeNull();
  });

  test("two orientable candidates do not pair", () => {
    const pool = new CardPool();
    pool.addCard(bare("b1", "back"));
    pool.addCard(bare("b2", "back"));
    expect(pool.addCard(bare("f", "front"))).toBeNull();
    expect(pool.size).toBe(3);
  });

  test("a user-set label orients identity-free cards too", () => {
    const pool = new CardPool();
    pool.addCard(bare("a", "front", { labelByUser: true }));
    const m = pool.addCard(bare("b", null));
    expect(m!.orientedBy).toBe("user");
    expect(m!.front.key).toBe("a");
  });

  test("two identity-free same-label copies never pair", () => {
    const pool = new CardPool();
    pool.addCard(bare("a", "front", { textCount: 5 }));
    expect(pool.addCard(bare("b", "front", { textCount: 11 }))).toBeNull();
  });
});

describe("evictRescan: identity plus picture, never label", () => {
  test("a re-scan is evicted at exactly the same-image threshold, not beyond", () => {
    const atEdge = new CardPool({
      hashImage: hasherFrom({ old: HASH_A, new: lowBitsHex(SAME_IMAGE_THRESHOLD) }),
    });
    atEdge.addCard(card("old", "front", { player: "Walker Buehler" }));
    atEdge.addCard(card("new", "front", { player: "Walker Buehler" }));
    expect(atEdge.entries().map((c) => c.key)).toEqual(["new"]);

    const past = new CardPool({
      hashImage: hasherFrom({ old: HASH_A, new: lowBitsHex(SAME_IMAGE_THRESHOLD + 1) }),
    });
    past.addCard(card("old", "front", { player: "Walker Buehler" }));
    past.addCard(card("new", "front", { player: "Walker Buehler" }));
    expect(past.entries().map((c) => c.key)).toEqual(["old", "new"]);
  });

  test("identical hash evicts for every label combination", () => {
    const labels: (CardSide | null)[] = ["front", "back", null];
    for (const heldLabel of labels) {
      for (const newLabel of labels) {
        const pool = new CardPool({ hashImage: hasherFrom({ old: HASH_A, new: HASH_A }) });
        pool.addCard(card("old", heldLabel, { player: "Walker Buehler" }));
        pool.addCard(card("new", newLabel, { player: "Walker Buehler" }));
        expect(pool.entries().map((c) => c.key), `${heldLabel}/${newLabel}`).toEqual(["new"]);
      }
    }
  });

  test("identity by team alone is enough to evict", () => {
    const pool = new CardPool({ hashImage: hasherFrom({ old: HASH_A, new: HASH_A }) });
    pool.addCard(card("old", "front", { team: "Dodgers" }));
    pool.addCard(card("new", "front", { team: "Los Angeles Dodgers" }));
    expect(pool.entries().map((c) => c.key)).toEqual(["new"]);
  });

  test("the same picture under a different identity is left alone", () => {
    const pool = new CardPool({ hashImage: hasherFrom({ old: HASH_A, new: HASH_A }) });
    pool.addCard(card("old", "front", { player: "Walker Buehler" }));
    pool.addCard(card("new", "front", { player: "Clayton Kershaw" }));
    expect(pool.entries().map((c) => c.key)).toEqual(["old", "new"]);
  });

  test("a different picture of the same card is held, then pairs with its other side", () => {
    const pool = new CardPool({
      hashImage: hasherFrom({ front: HASH_A, back: HASH_FAR }),
    });
    pool.addCard(card("front", "front", { player: "Ben Tate", textCount: 8 }));
    const m = pool.addCard(card("back", "front", { player: "Ben Tate", textCount: 130 }));
    expect(m!.front.key).toBe("front");
    expect(pool.size).toBe(0);
  });

  test("an evicted stale copy cannot be the partner", () => {
    // The re-scan arrives, evicts the stale copy, and is held; the back then
    // pairs with the fresh copy.
    const pool = new CardPool({
      hashImage: hasherFrom({ old: HASH_A, new: HASH_NEAR, back: "ffffffffffff0000" }),
    });
    pool.addCard(card("old", "front", { player: "Ben Tate", textCount: 8 }));
    pool.addCard(card("new", "front", { player: "Ben Tate", textCount: 8 }));
    const m = pool.addCard(card("back", "front", { player: "Ben Tate", textCount: 130 }));
    expect(m!.front.key).toBe("new");
    expect(pool.size).toBe(0);
  });

  test("a hasher that fails for the incoming image hashes nothing else", () => {
    const calls: string[] = [];
    const hasher: ImageHasher = (key) => {
      calls.push(key);
      return null;
    };
    const pool = new CardPool({ hashImage: hasher });
    pool.addCard(card("old", "front", { player: "Walker Buehler" }));
    pool.addCard(card("new", "front", { player: "Walker Buehler" }));
    expect(calls).toEqual(["new"]);
  });

  test("a held card with a malformed hash is not evicted", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pool = new CardPool({ hashImage: hasherFrom({ old: "XYZ", new: HASH_A }) });
      pool.addCard(card("old", "front", { player: "Walker Buehler" }));
      pool.addCard(card("new", "front", { player: "Walker Buehler" }));
      expect(pool.entries().map((c) => c.key)).toEqual(["old", "new"]);
    } finally {
      warn.mockRestore();
    }
  });
});

// ── Offer-order independence ────────────────────────────────────────────────

/** Deterministic PRNG (mulberry32) so a failing permutation is reproducible. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe("offer order never changes the pairings or the sides", () => {
  // Five physical cards, ten images, distinct players, realistic Vision word
  // counts (fronts ~5-11, backs ~110-142), and labels that are wrong or
  // missing on purpose. One card (Salvador Perez) sits inside the text band
  // and is oriented only by a user-set label on its back.
  const specs: Array<{
    key: string;
    label: CardSide | null;
    labelByUser?: boolean;
    player: string;
    team: string | null;
    cardNumber: string | null;
    textCount: number;
  }> = [
    { key: "tate-f", label: "back", player: "Ben Tate", team: "Browns", cardNumber: "44", textCount: 8 },
    { key: "tate-b", label: "front", player: "Ben Tate", team: null, cardNumber: "20", textCount: 130 },
    { key: "bue-f", label: null, player: "BUEHLER", team: "Dodgers", cardNumber: null, textCount: 6 },
    { key: "bue-b", label: "front", player: "Walker Buehler", team: null, cardNumber: "25", textCount: 120 },
    { key: "ker-f", label: "front", player: "Clayton Kershaw", team: "Dodgers", cardNumber: null, textCount: 11 },
    { key: "ker-b", label: null, player: "Clayton Kershaw", team: null, cardNumber: "22", textCount: 142 },
    { key: "per-f", label: null, player: "Salvador Perez", team: null, cardNumber: null, textCount: 30 },
    { key: "per-b", label: "back", labelByUser: true, player: "Salvador Perez", team: null, cardNumber: "13", textCount: 40 },
    { key: "mah-f", label: "front", player: "Patrick Mahomes", team: "Chiefs", cardNumber: null, textCount: 5 },
    { key: "mah-b", label: "front", player: "Patrick Mahomes", team: null, cardNumber: "15", textCount: 110 },
  ];
  const expected = [
    { front: "bue-f", back: "bue-b", by: "text" },
    { front: "ker-f", back: "ker-b", by: "text" },
    { front: "mah-f", back: "mah-b", by: "text" },
    { front: "per-f", back: "per-b", by: "user" },
    { front: "tate-f", back: "tate-b", by: "text" },
  ];

  test("50 seeded permutations all pair identically", () => {
    const rand = mulberry32(327);
    for (let run = 0; run < 50; run++) {
      const order = shuffled(specs, rand);
      const pool = new CardPool();
      const matches = [];
      // `order` here is the entry index of this permutation. It feeds the
      // ADJACENCY_SCORE bonus, so scores and confidence legitimately vary
      // between permutations; this test asserts pairings and orientation ONLY.
      for (const [index, spec] of order.entries()) {
        const m = pool.addCard(
          createPoolCard({ ...spec, order: index, identityResolved: true }),
        );
        if (m !== null) matches.push(m);
      }
      const got = matches
        .map((m) => ({ front: m.front.key, back: m.back.key, by: m.orientedBy }))
        .sort((a, b) => a.front.localeCompare(b.front));
      expect(got, `run ${run}: ${order.map((s) => s.key).join(",")}`).toEqual(expected);
      expect(pool.size).toBe(0);
    }
  });

  test("the pair's card number is the back's in every permutation", () => {
    const rand = mulberry32(44);
    for (let run = 0; run < 20; run++) {
      const pool = new CardPool();
      const numbers: Record<string, string | null> = {};
      for (const [index, spec] of shuffled(specs, rand).entries()) {
        const m = pool.addCard(createPoolCard({ ...spec, order: index, identityResolved: true }));
        if (m !== null) numbers[m.front.key] = m.cardNumber;
      }
      expect(numbers["tate-f"]).toBe("20");
      expect(numbers["per-f"]).toBe("13");
    }
  });
});
