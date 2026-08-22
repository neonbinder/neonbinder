/**
 * Unit tests for convex/lib/pairing/pairBatch.ts — a case-for-case mirror of
 * the preprocess service's `tests/unit/test_pairing_batch.py`, plus a block
 * for the NEO-170 contract addition (a pre-computed `side` on `BatchImage`).
 *
 * Covers: the free text-count side heuristic and its confidence band, the
 * adjacency pre-pass scan (including recovery from a leading stray and a
 * trailing odd image), identity ingestion rules (a front's card number is
 * discarded, side falls back to the heuristic, failures degrade rather than
 * raise), and the headline cost property — adjacency measurably reducing
 * identity-resolver calls, asserted against a fake resolver that counts them.
 *
 * No API access anywhere: the resolver is a callable fake, and the hasher is
 * a record lookup.
 */

import { describe, expect, test, vi } from "vitest";

import {
  ADJACENCY_CONFIDENCE_MARGIN,
  TEXT_COUNT_BACK_THRESHOLD,
  confidentSide,
  pairBatch,
  planAdjacency,
  poolCardFromIdentity,
  sideFromTextCount,
} from "./pairBatch";
import {
  BatchImage,
  CardIdentity,
  CardSide,
  IdentityResolver,
  ImageHasher,
  hasIdentity,
} from "./types";

// Text counts comfortably clear of the ambiguous band in either direction.
const FRONT_WORDS = TEXT_COUNT_BACK_THRESHOLD - 1 - ADJACENCY_CONFIDENCE_MARGIN;
const BACK_WORDS = TEXT_COUNT_BACK_THRESHOLD + ADJACENCY_CONFIDENCE_MARGIN;
// ...and one sitting inside it: too close to the threshold for the pre-pass to
// act on, but still on the "back" side of the plain heuristic, so a card with
// this count degrades to a back when identity is unavailable.
const AMBIGUOUS_WORDS = BACK_WORDS - 1;

/**
 * Fake `IdentityResolver` that records every call.
 *
 * `calls.length` is the assertion target for the cost tests: in production
 * each call is a model request, so the count is the batch's AI spend.
 */
function countingResolver(identities: Record<string, CardIdentity> = {}): {
  resolve: IdentityResolver;
  calls: string[];
} {
  const calls: string[] = [];
  const resolve: IdentityResolver = (key) => {
    calls.push(key);
    return identities[key] ?? null;
  };
  return { resolve, calls };
}

function identity(
  side: string = "front",
  fields: { player?: string; team?: string; cardNumber?: string } = {},
): CardIdentity {
  return {
    players: fields.player ? [fields.player] : [],
    player: fields.player ?? null,
    team: fields.team ?? null,
    cardNumber: fields.cardNumber ?? null,
    side: side as CardSide,
  };
}

function frontImage(key: string): BatchImage {
  return { key, textCount: FRONT_WORDS };
}

function backImage(key: string): BatchImage {
  return { key, textCount: BACK_WORDS };
}

/** `cardCount` cards, each as a front immediately followed by its back. */
function orderedZip(cardCount: number): BatchImage[] {
  const images: BatchImage[] = [];
  for (let i = 0; i < cardCount; i++) {
    images.push(frontImage(`card${i}-front.jpg`));
    images.push(backImage(`card${i}-back.jpg`));
  }
  return images;
}

describe("sideFromTextCount", () => {
  test.each([
    [0, "front"],
    [TEXT_COUNT_BACK_THRESHOLD - 1, "front"],
    [TEXT_COUNT_BACK_THRESHOLD, "back"],
    [TEXT_COUNT_BACK_THRESHOLD + 50, "back"],
  ])("threshold: %i words -> %s", (textCount, expected) => {
    expect(sideFromTextCount(textCount)).toBe(expected);
  });

  test.each([
    [0, "front"],
    [FRONT_WORDS, "front"],
    [FRONT_WORDS + 1, null],
    [TEXT_COUNT_BACK_THRESHOLD, null],
    [BACK_WORDS - 1, null],
    [BACK_WORDS, "back"],
    [BACK_WORDS + 50, "back"],
  ])("confidence band: %i words -> %s", (textCount, expected) => {
    expect(confidentSide(textCount)).toBe(expected);
  });
});

describe("planAdjacency", () => {
  test("empty batch", () => {
    expect(planAdjacency([])).toEqual({ pairs: [], leftovers: [] });
  });

  test("single image is a leftover", () => {
    const only = frontImage("a");
    expect(planAdjacency([only])).toEqual({ pairs: [], leftovers: [only] });
  });

  test("alternating batch pairs completely", () => {
    const images = orderedZip(3);
    const { pairs, leftovers } = planAdjacency(images);
    expect(pairs).toHaveLength(3);
    expect(leftovers).toEqual([]);
  });

  test("back-first ordering also pairs", () => {
    const images = [backImage("b"), frontImage("f")];
    const { pairs, leftovers } = planAdjacency(images);
    expect(pairs).toEqual([[images[0], images[1]]]);
    expect(leftovers).toEqual([]);
  });

  test("two confident fronts in a row are left over", () => {
    const images = [frontImage("f1"), frontImage("f2")];
    const { pairs, leftovers } = planAdjacency(images);
    expect(pairs).toEqual([]);
    expect(leftovers).toEqual(images);
  });

  test("ambiguous text count is never paired blind", () => {
    const images: BatchImage[] = [frontImage("f"), { key: "?", textCount: AMBIGUOUS_WORDS }];
    const { pairs, leftovers } = planAdjacency(images);
    expect(pairs).toEqual([]);
    expect(leftovers).toEqual(images);
  });

  test("trailing odd image is a leftover", () => {
    const images = [...orderedZip(1), frontImage("stray")];
    const { pairs, leftovers } = planAdjacency(images);
    expect(pairs).toHaveLength(1);
    expect(leftovers.map((i) => i.key)).toEqual(["stray"]);
  });

  test("a leading stray does not desynchronise the rest", () => {
    // Advancing by one on a failed pair (rather than by two) is what lets
    // the scan resynchronise behind a stray.
    const images = [frontImage("stray"), ...orderedZip(2)];
    const { pairs, leftovers } = planAdjacency(images);
    expect(pairs).toHaveLength(2);
    expect(leftovers.map((i) => i.key)).toEqual(["stray"]);
  });

  test("leftovers keep upload order", () => {
    const images = [frontImage("f1"), frontImage("f2"), frontImage("f3")];
    const { leftovers } = planAdjacency(images);
    expect(leftovers.map((i) => i.key)).toEqual(["f1", "f2", "f3"]);
  });
});

describe("poolCardFromIdentity", () => {
  test("a front's card number is discarded", () => {
    // Card numbers are printed on backs. Anything read as one off a front
    // is a jersey number, a copyright year or a subset code.
    const image = frontImage("f");
    const result = poolCardFromIdentity(image, identity("front", { cardNumber: "25" }));
    expect(result.side).toBe("front");
    expect(result.cardNumber).toBeNull();
  });

  test("a back's card number is kept", () => {
    const result = poolCardFromIdentity(
      backImage("b"),
      identity("back", { cardNumber: "25" }),
    );
    expect(result.cardNumber).toBe("25");
  });

  test("player and team carry through", () => {
    const result = poolCardFromIdentity(
      frontImage("f"),
      identity("front", { player: "Walker Buehler", team: "Dodgers" }),
    );
    expect(result.player).toBe("Walker Buehler");
    expect(result.team).toBe("Dodgers");
    expect(result.identityResolved).toBe(true);
  });

  test("multi-player cards collapse to the first name", () => {
    const multi: CardIdentity = {
      players: ["Salvador Perez", "Adam Duvall"],
      player: null,
      team: null,
      cardNumber: null,
      side: "front",
    };
    expect(poolCardFromIdentity(frontImage("f"), multi).player).toBe("Salvador Perez");
  });

  test("missing identity falls back to the text-count heuristic", () => {
    const result = poolCardFromIdentity(backImage("b"), null);
    expect(result.side).toBe("back");
    expect(result.identityResolved).toBe(false);
    expect(hasIdentity(result)).toBe(false);
  });

  test("an unexpected side value falls back to the heuristic", () => {
    const result = poolCardFromIdentity(backImage("b"), identity("sideways"));
    expect(result.side).toBe("back");
  });

  test("originalFilename is preserved", () => {
    const image: BatchImage = {
      key: "member-3",
      textCount: 1,
      originalFilename: "IMG_0042.HEIC",
    };
    expect(poolCardFromIdentity(image, null).originalFilename).toBe("IMG_0042.HEIC");
  });
});

describe("adjacency reduces resolver calls", () => {
  // The cost property this module exists for.

  test("a fully ordered zip costs zero identity calls", () => {
    const images = orderedZip(6);
    const resolver = countingResolver();

    const result = pairBatch(images, { resolveIdentity: resolver.resolve });

    expect(result.matches).toHaveLength(6);
    expect(result.unmatched).toEqual([]);
    expect(resolver.calls).toHaveLength(0);
    expect(result.resolverCalls).toBe(0);
  });

  test("the same zip without adjacency costs one call per image", () => {
    // The control: the pool alone would classify every single image.
    const images = orderedZip(6);
    const identities: Record<string, CardIdentity> = {};
    for (const image of images) {
      identities[image.key] = identity(
        image.key.endsWith("front.jpg") ? "front" : "back",
        { player: "Walker Buehler" },
      );
    }
    const resolver = countingResolver(identities);

    const result = pairBatch(images, {
      resolveIdentity: resolver.resolve,
      useAdjacency: false,
    });

    expect(images).toHaveLength(12);
    expect(resolver.calls).toHaveLength(12);
    expect(result.resolverCalls).toBe(12);
  });

  test("only the images adjacency could not claim are resolved", () => {
    // One card's back cropped badly and came back with an ambiguous text
    // count, so that card — and only that card — costs two resolver calls.
    const images: BatchImage[] = [
      frontImage("a-front"),
      backImage("a-back"),
      frontImage("b-front"),
      { key: "b-back", textCount: AMBIGUOUS_WORDS },
      frontImage("c-front"),
      backImage("c-back"),
    ];
    const resolver = countingResolver({
      "b-front": identity("front", { player: "Walker Buehler" }),
      "b-back": identity("back", { player: "Walker Buehler", cardNumber: "25" }),
    });

    const result = pairBatch(images, { resolveIdentity: resolver.resolve });

    expect(resolver.calls).toEqual(["b-front", "b-back"]);
    expect(result.resolverCalls).toBe(2);
    expect(result.matches).toHaveLength(3);
    expect(result.unmatched).toEqual([]);
  });

  test("adjacency pairs are marked and never resolved", () => {
    const result = pairBatch(orderedZip(1), {
      resolveIdentity: countingResolver().resolve,
    });
    const match = result.matches[0];
    expect(match.mechanism).toBe("adjacency");
    expect(match.confidence).toBe("side-only");
    expect(match.score).toBe(0);
    expect(match.front.identityResolved).toBe(false);
    expect(match.back.identityResolved).toBe(false);
  });

  test("adjacency orients front and back by text count", () => {
    const images = [backImage("the-back"), frontImage("the-front")];
    const result = pairBatch(images, { resolveIdentity: countingResolver().resolve });
    const match = result.matches[0];
    expect(match.front.key).toBe("the-front");
    expect(match.front.side).toBe("front");
    expect(match.back.key).toBe("the-back");
    expect(match.back.side).toBe("back");
  });
});

describe("pairBatch through the pool", () => {
  test("pool matches are marked and carry confidence", () => {
    const images: BatchImage[] = [frontImage("f"), { key: "b", textCount: AMBIGUOUS_WORDS }];
    const resolver = countingResolver({
      f: identity("front", { player: "Walker Buehler", team: "Dodgers" }),
      b: identity("back", { player: "Walker Buehler", cardNumber: "25" }),
    });

    const result = pairBatch(images, { resolveIdentity: resolver.resolve });

    expect(result.matches).toHaveLength(1);
    const match = result.matches[0];
    expect(match.mechanism).toBe("pool");
    expect(match.confidence).toBe("fuzzy");
    expect(match.front.key).toBe("f");
    expect(match.back.key).toBe("b");
  });

  test("merged identity is asymmetric", () => {
    const images = [frontImage("f"), frontImage("f2")];
    const resolver = countingResolver({
      // A card number read off the front is dropped at ingestion, so the
      // merged number can only ever come from the back.
      f: identity("front", { player: "BUEHLER", team: "Dodgers", cardNumber: "99" }),
      f2: identity("back", {
        player: "Walker Buehler",
        team: "Los Angeles Dodgers",
        cardNumber: "25",
      }),
    });

    const match = pairBatch(images, { resolveIdentity: resolver.resolve }).matches[0];

    expect(match.player).toBe("BUEHLER");
    expect(match.team).toBe("Dodgers");
    expect(match.cardNumber).toBe("25");
  });

  test("unpairable cards are surfaced as unmatched", () => {
    const images = [frontImage("f1"), frontImage("f2")];
    const resolver = countingResolver({
      f1: identity("front", { player: "Walker Buehler" }),
      f2: identity("front", { player: "Clayton Kershaw" }),
    });

    const result = pairBatch(images, { resolveIdentity: resolver.resolve });

    expect(result.matches).toEqual([]);
    expect(result.unmatched.map((c) => c.key)).toEqual(["f1", "f2"]);
  });

  test("a resolver returning null degrades instead of failing", () => {
    const images = [frontImage("f"), frontImage("f2")];
    const result = pairBatch(images, { resolveIdentity: countingResolver().resolve });
    // Both fall back to the text-count heuristic, so both read as fronts
    // and neither pairs — but the batch completes.
    expect(result.resolverCalls).toBe(2);
    expect(result.unmatched.map((c) => c.side)).toEqual(["front", "front"]);
  });

  test("a throwing resolver degrades instead of failing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const boom: IdentityResolver = () => {
        throw new Error("anthropic exploded");
      };

      const images: BatchImage[] = [frontImage("f"), { key: "b", textCount: AMBIGUOUS_WORDS }];
      const result = pairBatch(images, { resolveIdentity: boom });

      // No identity on either card and exactly one opposite-side candidate,
      // so the side-only fallback still pairs them.
      expect(result.resolverCalls).toBe(2);
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].confidence).toBe("side-only");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("identity resolution failed"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("the hasher is threaded through to the pool", () => {
    const hashed: string[] = [];
    const hasher: ImageHasher = (key) => {
      hashed.push(key);
      return "0".repeat(16);
    };

    // Two same-side images of the same card force a collision, which is the
    // only path that reaches the hasher.
    const images = [frontImage("f1"), frontImage("f2")];
    const resolver = countingResolver({
      f1: identity("front", { player: "Walker Buehler" }),
      f2: identity("front", { player: "Walker Buehler" }),
    });

    pairBatch(images, { resolveIdentity: resolver.resolve, hashImage: hasher });

    expect(hashed).toEqual(["f2", "f1"]);
  });

  test("an empty batch is a no-op", () => {
    const result = pairBatch([], { resolveIdentity: countingResolver().resolve });
    expect(result.matches).toEqual([]);
    expect(result.unmatched).toEqual([]);
    expect(result.resolverCalls).toBe(0);
  });
});

describe("provided side field (NEO-170 contract addition)", () => {
  // `BatchImage.side` has no counterpart in the Python port, whose BatchImage
  // carried only key/textCount/originalFilename. Under NEO-170 a side
  // classification may already exist server-side, so a provided side is
  // treated as authoritative over the text-count heuristic and as confident
  // evidence for the adjacency pre-pass.

  test("a provided side wins over the text-count heuristic when identity is null", () => {
    const image: BatchImage = { key: "x", textCount: AMBIGUOUS_WORDS, side: "front" };
    expect(poolCardFromIdentity(image, null).side).toBe("front");
  });

  test("a resolver-reported side wins over the provided side", () => {
    const image: BatchImage = { key: "x", textCount: FRONT_WORDS, side: "front" };
    expect(poolCardFromIdentity(image, identity("back")).side).toBe("back");
  });

  test("an invalid provided side value is ignored", () => {
    const image: BatchImage = {
      key: "x",
      textCount: BACK_WORDS,
      side: "sideways" as unknown as CardSide,
    };
    expect(poolCardFromIdentity(image, null).side).toBe("back");
  });

  test("provided opposite sides make ambiguous neighbours adjacency-pairable at zero cost", () => {
    const images: BatchImage[] = [
      { key: "f", textCount: AMBIGUOUS_WORDS, side: "front" },
      { key: "b", textCount: AMBIGUOUS_WORDS, side: "back" },
    ];
    const resolver = countingResolver();

    const result = pairBatch(images, { resolveIdentity: resolver.resolve });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].mechanism).toBe("adjacency");
    expect(resolver.calls).toHaveLength(0);
    expect(result.resolverCalls).toBe(0);
  });

  test("adjacency orients by the provided side", () => {
    const images: BatchImage[] = [
      { key: "the-back", textCount: AMBIGUOUS_WORDS, side: "back" },
      { key: "the-front", textCount: AMBIGUOUS_WORDS, side: "front" },
    ];
    const result = pairBatch(images, { resolveIdentity: countingResolver().resolve });
    const match = result.matches[0];
    expect(match.front.key).toBe("the-front");
    expect(match.front.side).toBe("front");
    expect(match.back.key).toBe("the-back");
    expect(match.back.side).toBe("back");
  });
});
