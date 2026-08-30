/**
 * NEO-137 — BSC does NOT OR multi-value facets, so the checklist fetch must
 * fan out: one request per source set.
 *
 * MEASURED LIVE on dev 2026-08-12, 1996 Score inserts (Dugout Collection
 * Artist's Proofs, which BSC splits into Series 1 and Series 2):
 *
 *   filters.variantName = ["…series-2"]                 -> 110 cards
 *   filters.variantName = ["…series-2", "…series-1"]    -> 200 OK, ZERO rows
 *
 * The adapter used to send both slugs in one request, on the strength of a
 * comment claiming "BSC's bulk-upload API accepts multi-value facets in one
 * call … no fan-out needed". That was never verified and is false.
 *
 * WHY NOTHING CAUGHT IT — and why this file mocks at a different layer.
 * Every existing checklist test (`fetchCardChecklist.stickyPairing`,
 * `fetchCardChecklistTeamLookup`) replaces `fetchBscChecklist` wholesale with
 * `vi.mock`, so the request BSC actually receives was never asserted and two
 * variantName values were never sent. These tests stub `fetch` instead and
 * assert on the outgoing request bodies, which is the only layer where this
 * class of bug is visible.
 *
 * The user-visible symptom was maximally misleading: a well-formed query, no
 * error anywhere, an empty checklist, and a UI reporting "0 BSC cards" as
 * though the marketplace had nothing — while SportLots returned 220.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_user_137",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_137",
  name: "Admin",
  role: "admin",
};

const S1 = "dugout-collection-artists-proofs-series-1";
const S2 = "dugout-collection-artists-proofs-series-2";

/** The credentials layer is not under test — hand the adapter a token. */
vi.mock("./credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credentials")>();
  const { internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    getSiteToken: internalAction({
      args: { site: v.string() },
      returns: v.any(),
      handler: async () => ({ token: "test-bsc-token" }),
    }),
    authenticateBsc: internalAction({
      args: {},
      returns: v.any(),
      handler: async () => ({ success: true }),
    }),
  };
});

type Recorded = {
  variantName?: string[];
  setName?: string[];
  filters: Record<string, string[]>;
};

/**
 * Stub BSC's bulk-upload endpoint.
 *
 * `perSlug` maps a variantName slug -> how many cards to return. A slug absent
 * from the map returns []. `multiValueReturnsEmpty` reproduces the real API's
 * behaviour: any request carrying more than one variantName yields zero rows.
 *
 * `startAt` sets the first card number a slug returns, DEFAULT 1 FOR EVERY
 * SLUG — which is what the set this fixture models actually looks like.
 *
 * 1996 Score Dugout Collection Artist's Proofs is split by BSC into Series 1
 * and Series 2, and BOTH series are numbered #1-110. They do not continue one
 * another's numbering. So the default here — every slug starting at 1 — IS the
 * realistic case: 220 distinct cards wearing 110 card numbers twice over.
 *
 * A previous revision of this file gave Series 2 `startAt: 111` so the union
 * still came to 220 while a cross-source dedup silently discarded half of it.
 * That fixture described no real set and hid a production regression: CI's
 * `inserts-1996-score-one-nb-set-two-bsc-sources.yaml` saw 110 where it demands
 * 220. Do NOT renumber these fixtures to make a merge rule look correct.
 *
 * `startAt` is kept for the genuinely different shape — sets whose numbering
 * DOES continue (2024 Topps Series 1 #1-350, Series 2 #351-700) — where the
 * union must be reported with no collisions at all.
 */
function stubBsc(opts: {
  perSlug: Record<string, number>;
  startAt?: Record<string, number>;
  recorded: Recorded[];
  multiValueReturnsEmpty?: boolean;
  status?: number;
  failSlug?: string;
}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const filters = (body.filters ?? {}) as Record<string, string[]>;
    const variantName = filters.variantName;
    opts.recorded.push({ variantName, setName: filters.setName, filters });

    if (opts.failSlug && variantName?.includes(opts.failSlug)) {
      return new Response("boom", { status: opts.status ?? 500 });
    }

    const multi = (variantName?.length ?? 0) > 1;
    if (multi && (opts.multiValueReturnsEmpty ?? true)) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const slug = variantName?.[0];
    const count = slug ? (opts.perSlug[slug] ?? 0) : 0;
    const base = (slug ? opts.startAt?.[slug] : undefined) ?? 1;
    const rows = Array.from({ length: count }, (_, i) => ({
      id: `${slug}-card-${base + i}`,
      cardNo: String(base + i),
      players: `Player ${base + i}`,
      // BSC returns the PARENT set here for an insert query — never the
      // insert's own slug. This is why source attribution had to stop
      // trusting it.
      setName: "score",
    }));
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const PARENT = {
  sport: "Baseball",
  year: "1996",
  setName: "Score",
  variantType: "insert",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchBscChecklist — per-source-set fan-out (NEO-137)", () => {
  test("two source sets produce TWO requests, one slug each, and the union", async () => {
    const recorded: Recorded[] = [];
    vi.stubGlobal(
      "fetch",
      stubBsc({ perSlug: { [S1]: 110, [S2]: 110 }, recorded }),
    );
    const t = convexTest(schema, modules);

    const result = await t
      .withIdentity(ADMIN)
      .action(api.adapters.buysportscards.fetchBscChecklist, {
        parentFilters: PARENT,
        platformFilters: { insert: [S2, S1] },
      });

    // THE REGRESSION: one request per slug, never both in one facet.
    expect(recorded).toHaveLength(2);
    expect(recorded.map((r) => r.variantName)).toEqual([[S2], [S1]]);
    expect(recorded.every((r) => (r.variantName?.length ?? 0) === 1)).toBe(true);

    expect(result.success).toBe(true);
    expect(result.cards).toHaveLength(220);
  });

  test("REAL 1996 Score: both series are #1-110, and ALL 220 survive", async () => {
    // THE FIXTURE THAT MATTERS. Both BSC series number from 1, so every one of
    // the 110 numbers arrives from two source sets. A cross-source dedup by
    // card number therefore discards an entire series — 220 becomes 110 — and
    // that is precisely the production regression CI's
    // `inserts-1996-score-one-nb-set-two-bsc-sources.yaml` catches ("110 means
    // one source"). This test fails the moment such a drop is reintroduced.
    //
    // Reporting the overlap is right; NARROWING the data to report it is not.
    // The operator is the only one who can say whether two attached sets
    // sharing numbers is intended, and they cannot judge what they cannot see.
    // SportLots' own fan-out (`mergeSlFanOut`) has always reported without
    // dropping; this is BSC brought in line with it.
    const recorded: Recorded[] = [];
    vi.stubGlobal(
      "fetch",
      stubBsc({ perSlug: { [S1]: 110, [S2]: 110 }, recorded }),
    );
    const t = convexTest(schema, modules);

    const result = await t
      .withIdentity(ADMIN)
      .action(api.adapters.buysportscards.fetchBscChecklist, {
        parentFilters: PARENT,
        platformFilters: { insert: [S2, S1] },
      });

    expect(result.success).toBe(true);
    expect(result.cards).toHaveLength(220);

    // Every number really is present TWICE — 220 rows over 110 numbers, not
    // 220 distinct numbers. A `toHaveLength(220)` alone would also pass on a
    // fixture that renumbered the second series out of the way.
    const byNumber = new Map<string, number>();
    for (const c of result.cards) {
      byNumber.set(c.cardNumber, (byNumber.get(c.cardNumber) ?? 0) + 1);
    }
    expect(byNumber.size).toBe(110);
    expect([...byNumber.values()].every((n) => n === 2)).toBe(true);

    // Both sides keep their own attribution, so the operator can still tell
    // which series a surviving row came from.
    const bySlug = new Map<string, number>();
    for (const c of result.cards) {
      const slug = c.sourceBscSetSlug ?? "(none)";
      bySlug.set(slug, (bySlug.get(slug) ?? 0) + 1);
    }
    expect(bySlug.get(S1)).toBe(110);
    expect(bySlug.get(S2)).toBe(110);

    // Surfaced, not silently swallowed: all 110 overlaps are reported.
    expect(result.collisions).toHaveLength(110);
    expect(result.collisions?.[0]).toMatchObject({
      keptSource: S2,
      skippedSource: S1,
    });
  });

  test("sets whose numbering CONTINUES report no collisions at all", async () => {
    // The other real shape, and why `startAt` still exists: 2024 Topps splits
    // #1-350 / #351-700 across two BSC sets, so nothing overlaps. The collision
    // report must stay quiet here — a note that fires on every split set is a
    // note the operator learns to ignore.
    const recorded: Recorded[] = [];
    vi.stubGlobal(
      "fetch",
      stubBsc({
        perSlug: { [S1]: 110, [S2]: 110 },
        startAt: { [S1]: 1, [S2]: 111 },
        recorded,
      }),
    );
    const t = convexTest(schema, modules);

    const result = await t
      .withIdentity(ADMIN)
      .action(api.adapters.buysportscards.fetchBscChecklist, {
        parentFilters: PARENT,
        platformFilters: { insert: [S2, S1] },
      });

    expect(result.success).toBe(true);
    expect(result.cards).toHaveLength(220);
    expect(new Set(result.cards.map((c) => c.cardNumber)).size).toBe(220);
    expect(result.collisions).toBeUndefined();
  });

  test("batching both slugs into one request would return NOTHING — the bug", async () => {
    // Proves the stub models the real API, so the assertion above is meaningful
    // rather than tautological. A single request carrying both slugs is exactly
    // what the old code sent, and it yields zero.
    const recorded: Recorded[] = [];
    const fetchStub = stubBsc({
      perSlug: { [S1]: 110, [S2]: 110 },
      recorded,
    });
    const res = await fetchStub("https://example.test/search/bulk-upload/results", {
      method: "POST",
      body: JSON.stringify({ filters: { variantName: [S2, S1] } }),
    } as RequestInit);

    await expect(res.json()).resolves.toEqual([]);
  });

  test("each card is tagged with the slug WE queried, not the response's setName", async () => {
    // The rows above all carry setName: "score" (the parent set). Trusting it
    // made every card claim the same source, so the BSC SOURCE chips could not
    // tell two attached sets apart.
    const recorded: Recorded[] = [];
    vi.stubGlobal(
      "fetch",
      // Overlapping numbers on purpose: attribution has to survive the very
      // case a number-keyed merge would have collapsed.
      stubBsc({ perSlug: { [S1]: 2, [S2]: 3 }, recorded }),
    );
    const t = convexTest(schema, modules);

    const result = await t
      .withIdentity(ADMIN)
      .action(api.adapters.buysportscards.fetchBscChecklist, {
        parentFilters: PARENT,
        platformFilters: { insert: [S2, S1] },
      });

    const bySlug = new Map<string, number>();
    for (const c of result.cards) {
      const s = c.sourceBscSetSlug ?? "(none)";
      bySlug.set(s, (bySlug.get(s) ?? 0) + 1);
    }
    expect(bySlug.get(S2)).toBe(3);
    expect(bySlug.get(S1)).toBe(2);
    expect(bySlug.get("score")).toBeUndefined();
  });

  test("a single source set still makes exactly ONE request", async () => {
    const recorded: Recorded[] = [];
    vi.stubGlobal("fetch", stubBsc({ perSlug: { [S2]: 110 }, recorded }));
    const t = convexTest(schema, modules);

    const result = await t
      .withIdentity(ADMIN)
      .action(api.adapters.buysportscards.fetchBscChecklist, {
        parentFilters: PARENT,
        platformFilters: { insert: [S2] },
      });

    expect(recorded).toHaveLength(1);
    expect(result.cards).toHaveLength(110);
  });

  test("if ONE source set fails, the whole fetch fails — never a partial checklist", async () => {
    // Commit REPLACES the stored checklist. Returning only the slugs that
    // succeeded would delete the failing set's cards and look like a clean run.
    const recorded: Recorded[] = [];
    vi.stubGlobal(
      "fetch",
      stubBsc({
        perSlug: { [S1]: 110, [S2]: 110 },
        recorded,
        failSlug: S1,
        status: 500,
      }),
    );
    const t = convexTest(schema, modules);

    const result = await t
      .withIdentity(ADMIN)
      .action(api.adapters.buysportscards.fetchBscChecklist, {
        parentFilters: PARENT,
        platformFilters: { insert: [S2, S1] },
      });

    expect(result.success).toBe(false);
    expect(result.cards).toHaveLength(0);
    expect(result.message).toMatch(/partial|only 1 of 2/i);
  });

  test("duplicate cards across source sets are deduped by BSC card id", async () => {
    const recorded: Recorded[] = [];
    // Both slugs return identical ids — overlapping sets mapped to one NB set.
    vi.stubGlobal(
      "fetch",
      (async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        recorded.push({ variantName: body.filters?.variantName, filters: body.filters });
        return new Response(
          JSON.stringify([
            { id: "shared-1", cardNo: "1", players: "A", setName: "score" },
            { id: "shared-2", cardNo: "2", players: "B", setName: "score" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    );
    const t = convexTest(schema, modules);

    const result = await t
      .withIdentity(ADMIN)
      .action(api.adapters.buysportscards.fetchBscChecklist, {
        parentFilters: PARENT,
        platformFilters: { insert: [S2, S1] },
      });

    expect(recorded).toHaveLength(2);
    expect(result.cards).toHaveLength(2);
  });
});

/**
 * NEO-189 — the fan-out generalised off the `variantName` axis.
 *
 * BSC splits Topps into Series 1 and Series 2 at **setName** while SportLots
 * files one set, so one NB Base row must draw from two BSC setName sets. The
 * fan-out was written for the insert case and keyed on `variantName` alone:
 * two setName slugs went out as ONE multi-value facet, which BSC answers 200
 * OK with an empty body. Zero cards, no error, and a UI reporting "0 BSC
 * cards" as though BSC had nothing — the same silent failure NEO-137 fixed on
 * the other axis.
 */

/**
 * Stub that models a setName-split set. `perSet` maps a setName slug -> the
 * card numbers it contains. A multi-value facet on EITHER axis returns nothing,
 * which is the behaviour being defended against.
 */
function stubBscBySet(opts: {
  perSet: Record<string, string[]>;
  recorded: Recorded[];
}): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const filters = (body.filters ?? {}) as Record<string, string[]>;
    opts.recorded.push({
      variantName: filters.variantName,
      setName: filters.setName,
      filters,
    });

    const multiValued = Object.values(filters).some((val) => val.length > 1);
    if (multiValued) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const slug = filters.setName?.[0];
    const numbers = slug ? (opts.perSet[slug] ?? []) : [];
    const rows = numbers.map((cardNo) => ({
      id: `${slug}-${cardNo}`,
      cardNo,
      players: `Player ${cardNo}`,
      setName: slug,
    }));
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const SET1 = "topps-series-1";
const SET2 = "topps-series-2";

const BASE_PARENT = {
  sport: "Baseball",
  year: "2024",
  setName: "Topps",
  variantType: "Base",
};

describe("fetchBscChecklist — setName fan-out (NEO-189)", () => {
  test("two setName slugs produce TWO requests, one slug each — THE BUG", async () => {
    const recorded: Recorded[] = [];
    vi.stubGlobal(
      "fetch",
      stubBscBySet({
        perSet: { [SET1]: ["1", "2", "3"], [SET2]: ["351", "352"] },
        recorded,
      }),
    );
    const t = convexTest(schema, modules);

    const result = await t
      .withIdentity(ADMIN)
      .action(api.adapters.buysportscards.fetchBscChecklist, {
        parentFilters: BASE_PARENT,
        facetFilters: {
          sport: ["baseball"],
          year: ["2024"],
          setName: [SET1, SET2],
        },
        sourceFacet: "setName",
      });

    expect(recorded).toHaveLength(2);
    expect(recorded.map((r) => r.setName)).toEqual([[SET1], [SET2]]);
    expect(recorded.every((r) => (r.setName?.length ?? 0) === 1)).toBe(true);

    expect(result.success).toBe(true);
    expect(result.cards).toHaveLength(5);
  });

  test("the row's `variant` is applied to EVERY request in the fan-out", async () => {
    // Without it a setName-only query returns the set's whole catalogue —
    // base, inserts and parallels together — under an NB Base row.
    const recorded: Recorded[] = [];
    vi.stubGlobal(
      "fetch",
      stubBscBySet({ perSet: { [SET1]: ["1"], [SET2]: ["2"] }, recorded }),
    );
    const t = convexTest(schema, modules);

    await t
      .withIdentity(ADMIN)
      .action(api.adapters.buysportscards.fetchBscChecklist, {
        parentFilters: BASE_PARENT,
        facetFilters: { sport: ["baseball"], setName: [SET1, SET2] },
        sourceFacet: "setName",
      });

    expect(recorded).toHaveLength(2);
    for (const r of recorded) {
      expect(r.filters.variant).toEqual(["base"]);
      expect(r.filters.sport).toEqual(["baseball"]);
    }
  });

  test("batching both setName slugs into one request returns NOTHING", async () => {
    // Proves the stub models the real API, so the assertion above is not
    // tautological. This is exactly what the pre-NEO-189 code sent.
    const recorded: Recorded[] = [];
    const fetchStub = stubBscBySet({
      perSet: { [SET1]: ["1"], [SET2]: ["2"] },
      recorded,
    });
    const res = await fetchStub("https://example.test/search/bulk-upload/results", {
      method: "POST",
      body: JSON.stringify({ filters: { setName: [SET1, SET2] } }),
    } as RequestInit);
    await expect(res.json()).resolves.toEqual([]);
  });

  test("each card is attributed to the setName WE queried, so it binds to a slot", async () => {
    // `sourceBscSetSlug` is resolved against the row's attached slots at
    // commit. Tagging with anything the operator did not attach leaves the
    // card unattributed and it drops out of source filtering entirely.
    const recorded: Recorded[] = [];
    vi.stubGlobal(
      "fetch",
      stubBscBySet({
        perSet: { [SET1]: ["1", "2"], [SET2]: ["351"] },
        recorded,
      }),
    );
    const t = convexTest(schema, modules);

    const result = await t
      .withIdentity(ADMIN)
      .action(api.adapters.buysportscards.fetchBscChecklist, {
        parentFilters: BASE_PARENT,
        facetFilters: { sport: ["baseball"], setName: [SET1, SET2] },
        sourceFacet: "setName",
      });

    const bySlug = new Map<string, number>();
    for (const c of result.cards) {
      const slug = c.sourceBscSetSlug ?? "(none)";
      bySlug.set(slug, (bySlug.get(slug) ?? 0) + 1);
    }
    expect(bySlug.get(SET1)).toBe(2);
    expect(bySlug.get(SET2)).toBe(1);
  });

  test("a card number in BOTH source sets keeps BOTH rows and REPORTS it", async () => {
    // Report, do not narrow. Both #2s are real cards on real BSC sets the
    // operator deliberately attached; discarding one at FETCH time destroys the
    // evidence before anyone can look at it, and the checklist that results is
    // indistinguishable from a correct one. `mergeSlFanOut` already made this
    // call for SportLots — same rule, both marketplaces now.
    const recorded: Recorded[] = [];
    vi.stubGlobal(
      "fetch",
      stubBscBySet({
        perSet: { [SET1]: ["1", "2"], [SET2]: ["2", "3"] },
        recorded,
      }),
    );
    const t = convexTest(schema, modules);

    const result = await t
      .withIdentity(ADMIN)
      .action(api.adapters.buysportscards.fetchBscChecklist, {
        parentFilters: BASE_PARENT,
        facetFilters: { sport: ["baseball"], setName: [SET1, SET2] },
        sourceFacet: "setName",
      });

    expect(result.cards.map((c) => c.cardNumber).sort()).toEqual([
      "1",
      "2",
      "2",
      "3",
    ]);
    // The two #2s stay distinguishable by the set each came from.
    expect(
      result.cards
        .filter((c) => c.cardNumber === "2")
        .map((c) => c.sourceBscSetSlug)
        .sort(),
    ).toEqual([SET1, SET2]);
    expect(result.collisions).toEqual([
      { cardNumber: "2", keptSource: SET1, skippedSource: SET2 },
    ]);
  });

  test("a SINGLE request reports no cross-source collision", async () => {
    // Two rows sharing a number inside ONE BSC set is a marketplace data error,
    // not an overlap between attached sets — and there are no "two source sets"
    // to name when only one request went out. Reporting it as one would send
    // the operator off to inspect a second set that does not exist.
    const recorded: Recorded[] = [];
    vi.stubGlobal(
      "fetch",
      (async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        recorded.push({ variantName: undefined, filters: body.filters });
        return new Response(
          JSON.stringify([
            { id: "dup-a", cardNo: "1", players: "A", setName: SET1 },
            { id: "dup-b", cardNo: "1", players: "B", setName: SET1 },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    );
    const t = convexTest(schema, modules);

    const result = await t
      .withIdentity(ADMIN)
      .action(api.adapters.buysportscards.fetchBscChecklist, {
        parentFilters: BASE_PARENT,
        facetFilters: { sport: ["baseball"], setName: [SET1] },
        sourceFacet: "setName",
      });

    expect(recorded).toHaveLength(1);
    expect(result.cards).toHaveLength(2);
    expect(result.collisions).toBeUndefined();
  });

  test("facetFilters wins over platformFilters in full", async () => {
    // Merging them would resurrect the NB-level guess for whichever facet the
    // caller happened to leave out of facetFilters, which is the guess this
    // ticket removes.
    const recorded: Recorded[] = [];
    vi.stubGlobal(
      "fetch",
      stubBscBySet({ perSet: { [SET2]: ["1"] }, recorded }),
    );
    const t = convexTest(schema, modules);

    await t
      .withIdentity(ADMIN)
      .action(api.adapters.buysportscards.fetchBscChecklist, {
        parentFilters: BASE_PARENT,
        platformFilters: { setName: ["topps"], insert: ["legacy-variant"] },
        facetFilters: { setName: [SET2] },
        sourceFacet: "setName",
      });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].setName).toEqual([SET2]);
    expect(recorded[0].filters.variantName).toBeUndefined();
  });
});
