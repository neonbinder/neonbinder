/**
 * Unit tests for convex/lib/pairing/pairBatch.ts.
 *
 * Covers identity ingestion (every image keeps the card number it read; the
 * label ladder — user label, then the resolver's side, then the stored
 * classifier label, then none; failures degrade rather than raise) and
 * pairBatch end to end through the pool, including the NEO-327 property that
 * a pair's sides come from its evidence and not from upload order.
 *
 * No API access anywhere: the resolver is a callable fake, and the hasher is
 * a record lookup.
 */

import { describe, expect, test, vi } from "vitest";

import { pairBatch, poolCardFromIdentity } from "./pairBatch";
import {
  BatchImage,
  CardIdentity,
  CardSide,
  IdentityResolver,
  ImageHasher,
  hasIdentity,
} from "./types";

// Measured shapes from a photo-back run: fronts carry a handful of Vision
// words, backs over a hundred.
const FRONT_WORDS = 6;
const BACK_WORDS = 120;

/**
 * Fake `IdentityResolver` that records every call.
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
  side: string | null = "front",
  fields: { player?: string; team?: string; cardNumber?: string } = {},
): CardIdentity {
  return {
    players: fields.player ? [fields.player] : [],
    player: fields.player ?? null,
    team: fields.team ?? null,
    cardNumber: fields.cardNumber ?? null,
    side: side as CardSide | null,
  };
}

function frontImage(key: string): BatchImage {
  return { key, textCount: FRONT_WORDS };
}

function backImage(key: string): BatchImage {
  return { key, textCount: BACK_WORDS };
}

describe("poolCardFromIdentity", () => {
  test("every image keeps the card number it read", () => {
    // Which image is the back is not known until the pair is oriented, so a
    // number is never dropped by label. It names the pair only if this image
    // turns out to be the back.
    const result = poolCardFromIdentity(
      frontImage("f"),
      identity("front", { cardNumber: "25" }),
    );
    expect(result.label).toBe("front");
    expect(result.cardNumber).toBe("25");
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

  test("missing identity leaves no label and no identity", () => {
    const result = poolCardFromIdentity(backImage("b"), null);
    expect(result.label).toBeNull();
    expect(result.labelByUser).toBe(false);
    expect(result.identityResolved).toBe(false);
    expect(hasIdentity(result)).toBe(false);
  });

  test("an unexpected side value is no label", () => {
    expect(poolCardFromIdentity(backImage("b"), identity("sideways")).label).toBeNull();
  });

  test("a null classifier side is no label", () => {
    expect(poolCardFromIdentity(backImage("b"), identity(null)).label).toBeNull();
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

describe("label ladder", () => {
  test("a stored label is used when identity is null", () => {
    const image: BatchImage = { key: "x", textCount: FRONT_WORDS, label: "front" };
    const result = poolCardFromIdentity(image, null);
    expect(result.label).toBe("front");
    expect(result.labelByUser).toBe(false);
  });

  test("the resolver's side wins over a stored classifier label", () => {
    const image: BatchImage = { key: "x", textCount: FRONT_WORDS, label: "front" };
    expect(poolCardFromIdentity(image, identity("back")).label).toBe("back");
  });

  test("a user-set label wins over the resolver's side", () => {
    const image: BatchImage = {
      key: "x",
      textCount: FRONT_WORDS,
      label: "back",
      labelByUser: true,
    };
    const result = poolCardFromIdentity(image, identity("front"));
    expect(result.label).toBe("back");
    expect(result.labelByUser).toBe(true);
  });

  test("labelByUser without a valid label is not a user label", () => {
    const image: BatchImage = { key: "x", textCount: FRONT_WORDS, labelByUser: true };
    const result = poolCardFromIdentity(image, identity("front"));
    expect(result.label).toBe("front");
    expect(result.labelByUser).toBe(false);
  });

  test("an invalid stored label is ignored", () => {
    const image: BatchImage = {
      key: "x",
      textCount: BACK_WORDS,
      label: "sideways" as unknown as CardSide,
    };
    expect(poolCardFromIdentity(image, null).label).toBeNull();
  });
});

describe("pairBatch through the pool", () => {
  test("pool matches are marked and carry confidence", () => {
    const images: BatchImage[] = [frontImage("f"), backImage("b")];
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
    expect(match.orientedBy).toBe("text");
  });

  test("merged identity is asymmetric", () => {
    const images = [frontImage("f"), frontImage("f2")];
    const resolver = countingResolver({
      // Both images keep the number they read, but the merged number is the
      // oriented back's. Text counts are equal here, so the labels orient.
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
    expect(match.front.cardNumber).toBe("99");
    expect(match.orientedBy).toBe("label");
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
    // No identity, no labels and no text gap: nothing to orient them by, so
    // neither pairs — but the batch completes.
    expect(result.resolverCalls).toBe(2);
    expect(result.unmatched.map((c) => c.label)).toEqual([null, null]);
  });

  test("a throwing resolver degrades instead of failing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const boom: IdentityResolver = () => {
        throw new Error("anthropic exploded");
      };

      const images: BatchImage[] = [frontImage("f"), backImage("b")];
      const result = pairBatch(images, { resolveIdentity: boom });

      // No identity on either card and exactly one orientable candidate, so
      // the side-only fallback still pairs them, oriented by text.
      expect(result.resolverCalls).toBe(2);
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].confidence).toBe("side-only");
      expect(result.matches[0].front.key).toBe("f");
      expect(result.matches[0].orientedBy).toBe("text");
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

    // Two images of the same card force a re-scan check, which is the only
    // path that reaches the hasher.
    const images = [frontImage("f1"), frontImage("f2")];
    const resolver = countingResolver({
      f1: identity("front", { player: "Walker Buehler" }),
      f2: identity("front", { player: "Walker Buehler" }),
    });

    pairBatch(images, { resolveIdentity: resolver.resolve, hashImage: hasher });

    expect(hashed).toEqual(["f2", "f1"]);
  });

  test("every image is resolved exactly once", () => {
    const images = [frontImage("a"), backImage("b"), frontImage("c")];
    const resolver = countingResolver();
    const result = pairBatch(images, { resolveIdentity: resolver.resolve });
    expect(resolver.calls).toEqual(["a", "b", "c"]);
    expect(result.resolverCalls).toBe(3);
  });

  test("an empty batch is a no-op", () => {
    const result = pairBatch([], { resolveIdentity: countingResolver().resolve });
    expect(result.matches).toEqual([]);
    expect(result.unmatched).toEqual([]);
    expect(result.resolverCalls).toBe(0);
  });
});

describe("upload order never decides a side (NEO-327)", () => {
  // The photo-back failure: the classifier labels both sides "front", and the
  // back arrives first. Text count orients the pair either way.
  const identities: Record<string, CardIdentity> = {
    "tate-front": identity("front", { player: "Ben Tate", team: "Browns" }),
    "tate-back": identity("front", { player: "Ben Tate", cardNumber: "20" }),
  };

  test.each([
    [["tate-back", "tate-front"]],
    [["tate-front", "tate-back"]],
  ])("order %j", (order) => {
    const images: BatchImage[] = order.map((key) =>
      key.endsWith("front") ? frontImage(key) : backImage(key),
    );
    const result = pairBatch(images, {
      resolveIdentity: countingResolver(identities).resolve,
    });
    expect(result.matches).toHaveLength(1);
    const match = result.matches[0];
    expect(match.front.key).toBe("tate-front");
    expect(match.back.key).toBe("tate-back");
    expect(match.orientedBy).toBe("text");
    expect(match.cardNumber).toBe("20");
  });
});

describe("label ladder: every rung", () => {
  const img = (extra: Partial<BatchImage> = {}): BatchImage => ({
    key: "x",
    textCount: FRONT_WORDS,
    ...extra,
  });

  test("user label with a valid stored label is that label, set by the user", () => {
    for (const side of ["front", "back"] as const) {
      const r = poolCardFromIdentity(
        img({ label: side, labelByUser: true }),
        identity(side === "front" ? "back" : "front"),
      );
      expect(r.label).toBe(side);
      expect(r.labelByUser).toBe(true);
    }
  });

  test("a user label survives a null identity", () => {
    const r = poolCardFromIdentity(img({ label: "back", labelByUser: true }), null);
    expect([r.label, r.labelByUser]).toEqual(["back", true]);
  });

  test("labelByUser with an invalid stored label falls to the resolver's side, not user", () => {
    const r = poolCardFromIdentity(
      img({ label: "sideways" as unknown as CardSide, labelByUser: true }),
      identity("back"),
    );
    expect([r.label, r.labelByUser]).toEqual(["back", false]);
  });

  test("labelByUser false with a stored label: the resolver's side still wins, not user", () => {
    const r = poolCardFromIdentity(img({ label: "front", labelByUser: false }), identity("back"));
    expect([r.label, r.labelByUser]).toEqual(["back", false]);
  });

  test("a null resolver side falls to the stored label", () => {
    const r = poolCardFromIdentity(img({ label: "back" }), identity(null));
    expect([r.label, r.labelByUser]).toEqual(["back", false]);
  });

  test("an invalid resolver side falls to the stored label", () => {
    const r = poolCardFromIdentity(img({ label: "back" }), identity("sideways"));
    expect([r.label, r.labelByUser]).toEqual(["back", false]);
  });

  test("no side and no stored label is null", () => {
    const r = poolCardFromIdentity(img(), identity(null));
    expect([r.label, r.labelByUser]).toEqual([null, false]);
  });

  test("the text count and order reach the pool card", () => {
    const r = poolCardFromIdentity(img({ textCount: 77, order: 4 }), null);
    expect(r.textCount).toBe(77);
    expect(r.order).toBe(4);
  });
});

describe("pairBatch: orientation end to end", () => {
  const run = (images: BatchImage[], ids: Record<string, CardIdentity>) =>
    pairBatch(images, { resolveIdentity: countingResolver(ids).resolve });

  test("a user label orients a pair against the text", () => {
    const result = run(
      [
        { key: "heavy", textCount: BACK_WORDS, label: "front", labelByUser: true },
        { key: "light", textCount: FRONT_WORDS },
      ],
      {
        heavy: identity("back", { player: "Ben Tate" }),
        light: identity("front", { player: "Ben Tate" }),
      },
    );
    expect(result.matches[0].front.key).toBe("heavy");
    expect(result.matches[0].orientedBy).toBe("user");
  });

  test("two user labels for the same side never pair", () => {
    const result = run(
      [
        { key: "a", textCount: FRONT_WORDS, label: "front", labelByUser: true },
        { key: "b", textCount: BACK_WORDS, label: "front", labelByUser: true },
      ],
      {
        a: identity("front", { player: "Ben Tate" }),
        b: identity("front", { player: "Ben Tate" }),
      },
    );
    expect(result.matches).toEqual([]);
    expect(result.unmatched).toHaveLength(2);
  });

  test("unpairedFrom is honoured", () => {
    const result = run(
      [
        { key: "f", textCount: FRONT_WORDS, unpairedFrom: ["b"] },
        { key: "b", textCount: BACK_WORDS },
      ],
      {
        f: identity("front", { player: "Ben Tate" }),
        b: identity("back", { player: "Ben Tate" }),
      },
    );
    expect(result.matches).toEqual([]);
  });

  test("a duplicate copy is held and the true partner pairs", () => {
    const result = run(
      [frontImage("f1"), frontImage("f2"), backImage("b")],
      {
        f1: identity("front", { player: "Ben Tate" }),
        f2: identity("front", { player: "Ben Tate" }),
        b: identity("front", { player: "Ben Tate", cardNumber: "20" }),
      },
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].back.key).toBe("b");
    expect(result.unmatched).toHaveLength(1);
  });

  test("a front's jersey number never names the pair (Ben Tate)", () => {
    const result = run([frontImage("f"), backImage("b")], {
      f: identity("front", { player: "Ben Tate", cardNumber: "44" }),
      b: identity("front", { player: "Ben Tate", cardNumber: "20" }),
    });
    expect(result.matches[0].cardNumber).toBe("20");
    expect(result.matches[0].front.cardNumber).toBe("44");
  });
});

// ── Offer-order independence ────────────────────────────────────────────────

/** Deterministic PRNG (mulberry32) so a failing permutation reproduces. */
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

describe("pairBatch: upload order never changes pairings or sides", () => {
  // Five cards, ten images, distinct players, realistic word counts, with
  // wrong and null classifier labels. Salvador Perez's images sit inside the
  // text band; only the user-set label on his back orients him.
  const rows: Array<{
    image: BatchImage;
    identity: CardIdentity;
  }> = [
    { image: { key: "tate-f", textCount: 8 }, identity: identity("back", { player: "Ben Tate", team: "Browns", cardNumber: "44" }) },
    { image: { key: "tate-b", textCount: 130 }, identity: identity("front", { player: "Ben Tate", cardNumber: "20" }) },
    { image: { key: "bue-f", textCount: 6 }, identity: identity(null, { player: "BUEHLER", team: "Dodgers" }) },
    { image: { key: "bue-b", textCount: 120 }, identity: identity("front", { player: "Walker Buehler", cardNumber: "25" }) },
    { image: { key: "ker-f", textCount: 11 }, identity: identity("front", { player: "Clayton Kershaw", team: "Dodgers" }) },
    { image: { key: "ker-b", textCount: 142 }, identity: identity(null, { player: "Clayton Kershaw", cardNumber: "22" }) },
    { image: { key: "per-f", textCount: 30 }, identity: identity(null, { player: "Salvador Perez" }) },
    { image: { key: "per-b", textCount: 40, label: "back", labelByUser: true }, identity: identity("front", { player: "Salvador Perez", cardNumber: "13" }) },
    { image: { key: "mah-f", textCount: 5 }, identity: identity("front", { player: "Patrick Mahomes", team: "Chiefs" }) },
    { image: { key: "mah-b", textCount: 110 }, identity: identity("front", { player: "Patrick Mahomes", cardNumber: "15" }) },
  ];
  const expected = [
    { front: "bue-f", back: "bue-b", by: "text", number: "25" },
    { front: "ker-f", back: "ker-b", by: "text", number: "22" },
    { front: "mah-f", back: "mah-b", by: "text", number: "15" },
    { front: "per-f", back: "per-b", by: "user", number: "13" },
    { front: "tate-f", back: "tate-b", by: "text", number: "20" },
  ];

  test("50 seeded permutations of offer order give identical pairings", () => {
    const rand = mulberry32(327);
    const ids: Record<string, CardIdentity> = Object.fromEntries(
      rows.map((r) => [r.image.key, r.identity]),
    );
    for (let run = 0; run < 50; run++) {
      const order = [...rows];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      // `order` is the position in this permutation. It feeds ADJACENCY_SCORE,
      // so score and confidence may differ between runs; only pairings and
      // orientation are asserted.
      const images = order.map((r, i) => ({ ...r.image, order: i }));
      const result = pairBatch(images, { resolveIdentity: countingResolver(ids).resolve });
      const got = result.matches
        .map((m) => ({
          front: m.front.key,
          back: m.back.key,
          by: m.orientedBy,
          number: m.cardNumber,
        }))
        .sort((a, b) => a.front.localeCompare(b.front));
      expect(got, `run ${run}: ${order.map((r) => r.image.key).join(",")}`).toEqual(expected);
      expect(result.unmatched).toEqual([]);
    }
  });
});
