/**
 * NEO-343 — a team card reads the same from BOTH marketplaces.
 *
 * BSC sends a Topps Football team card as "Philadelphia Eagles TL". SportLots
 * sends the same card as "Philadelphia Eagles Team" on 2013 Topps, and as the
 * bare "Buffalo Bills" on 2014 and 2015. Before this ticket the first BSC form
 * and the "Team" SportLots form each kept their card-type word, so every team
 * card in those sets arrived with a name conflict for the operator to settle.
 *
 * This runs both REAL adapter actions end to end, with only `fetch` and the
 * credentials layer stubbed, and feeds their output to the same
 * `conflictingNames` / `conflictingPlayers` helpers `fetchCardChecklist` and
 * the pairing modal use. Replicating either adapter's naming rule here would
 * prove only that the replica agrees with itself.
 *
 * Lives at the convex/ ROOT for the import.meta.glob reason documented at the
 * top of `convex/sportlots.test.ts`.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  conflictingNames,
  conflictingPlayers,
  playersKey,
} from "../lib/cards/card-name";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_user_343",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_343",
  name: "Admin",
  role: "admin",
};

/** The credentials layer is not under test — hand each adapter a token. */
vi.mock("./credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credentials")>();
  const { internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    getSiteToken: internalAction({
      args: { site: v.string() },
      returns: v.any(),
      handler: async (_ctx, { site }: { site: string }) => ({
        token: `test-${site}-token`,
      }),
    }),
    authenticateBsc: internalAction({
      args: {},
      returns: v.any(),
      handler: async () => ({ success: true }),
    }),
    authenticateSportlots: internalAction({
      args: {},
      returns: v.any(),
      handler: async () => ({ success: true }),
    }),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * One card per case, by number: what BSC's bulk-upload `players` field holds
 * and what SportLots' `listcards.tpl` description cell holds. Strings are the
 * marketplaces' own, read off their public catalogues on 2026-10-13 (2013 and
 * 2014 Topps Football base).
 */
const CASES = [
  // 2013: "<Team> Team" on SportLots.
  { cardNumber: "432", bsc: "Philadelphia Eagles TL", sl: "Philadelphia Eagles Team" },
  { cardNumber: "346", bsc: "Buffalo Bills TL", sl: "Buffalo Bills Team" },
  // SportLots' own casing of the nickname; the comparison folds case.
  { cardNumber: "119", bsc: "San Francisco 49ers TL", sl: "San Francisco 49Ers Team" },
  { cardNumber: "191", bsc: "St. Louis Rams TL", sl: "St. Louis Rams Team" },
  // 2013 #97 and every 2014/2015 team card: the bare name on SportLots.
  { cardNumber: "97", bsc: "Detroit Lions TL", sl: "Detroit Lions" },
] as const;

/** A genuine disagreement on a real row (2013 #23), which must still speak. */
const CONTROL = {
  cardNumber: "23",
  bsc: "Baltimore Ravens TL",
  sl: "Ravens Super Bowl",
} as const;

const ROWS = [...CASES, CONTROL];

/** Route each adapter's request to its own stubbed marketplace. */
function stubBothMarketplaces(): void {
  const bscRows = ROWS.map((row) => ({
    id: `bsc-${row.cardNumber}`,
    cardNo: row.cardNumber,
    players: row.bsc,
    setName: "topps",
  }));
  const slHtml = `<table>${ROWS.map(
    (row) =>
      `<tr><td class="smallleft">${row.cardNumber}</td><td class="smallleft">${row.sl}</td></tr>`,
  ).join("")}</table>`;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      const href = String(url instanceof Request ? url.url : url);
      if (href.includes("sportlots")) {
        return new Response(slHtml, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      return new Response(JSON.stringify(bscRows), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

type AdapterCard = {
  cardNumber: string;
  cardName: string;
  players?: string[];
  teams?: string[];
};

async function fetchBoth(): Promise<{
  bsc: Map<string, AdapterCard>;
  sl: Map<string, AdapterCard>;
}> {
  stubBothMarketplaces();
  const asAdmin = convexTest(schema, modules).withIdentity(ADMIN);

  const bscResult = await asAdmin.action(
    api.adapters.buysportscards.fetchBscChecklist,
    {
      parentFilters: { sport: "Football", year: "2013", setName: "Topps" },
      facetFilters: {
        sport: ["football"],
        year: ["2013"],
        setName: ["topps"],
        variant: ["base"],
      },
    },
  );
  const slResult = await asAdmin.action(
    api.adapters.sportlots.fetchSportLotsChecklist,
    {
      parentFilters: { sport: "Football", year: "2013", setName: "Topps" },
      platformFilters: { variantType: "12345" },
    },
  );

  expect(bscResult.success).toBe(true);
  expect(slResult.success).toBe(true);
  const byNumber = (cards: AdapterCard[]) =>
    new Map(cards.map((card) => [card.cardNumber, card]));
  return { bsc: byNumber(bscResult.cards), sl: byNumber(slResult.cards) };
}

describe("a team card from BSC and SportLots raises no conflict (NEO-343)", () => {
  test("name, players and teams agree on every real team-card shape", async () => {
    const { bsc, sl } = await fetchBoth();

    for (const { cardNumber } of CASES) {
      const b = bsc.get(cardNumber)!;
      const s = sl.get(cardNumber)!;
      expect(b, `BSC #${cardNumber}`).toBeDefined();
      expect(s, `SportLots #${cardNumber}`).toBeDefined();

      // Both sides carry a roster, so "no conflict" is agreement rather than
      // one side being empty — `conflictingPlayers` is silent on an empty side.
      expect(b.players?.length, `BSC #${cardNumber} players`).toBe(1);
      expect(s.players?.length, `SportLots #${cardNumber} players`).toBe(1);

      expect(conflictingNames(b.cardName, s.cardName), `#${cardNumber} name`).toBeUndefined();
      expect(conflictingPlayers(b.players, s.players), `#${cardNumber} players`).toBeUndefined();
      // Teams are compared on the same fold the roster uses.
      expect(playersKey(s.teams ?? s.players ?? [])).toBe(playersKey(b.teams ?? []));
    }
  });

  test("the SportLots 'Team' row carries the bare team in all three fields", async () => {
    const { sl } = await fetchBoth();
    const eagles = sl.get("432")!;
    expect(eagles.cardName).toBe("Philadelphia Eagles");
    expect(eagles.players).toEqual(["Philadelphia Eagles"]);
    expect(eagles.teams).toEqual(["Philadelphia Eagles"]);

    // The bare SportLots form is unchanged: a name and a roster, and no team,
    // because nothing in "Detroit Lions" says it is a team rather than a
    // two-token name. BSC's TL row supplies the team on the merge.
    const lions = sl.get("97")!;
    expect(lions.cardName).toBe("Detroit Lions");
    expect(lions.players).toEqual(["Detroit Lions"]);
    expect(lions.teams).toBeUndefined();
  });

  test("a real disagreement on a team card still raises a name conflict", async () => {
    const { bsc, sl } = await fetchBoth();
    const b = bsc.get(CONTROL.cardNumber)!;
    const s = sl.get(CONTROL.cardNumber)!;
    expect(conflictingNames(b.cardName, s.cardName)).toEqual({
      bsc: "Baltimore Ravens",
      sportlots: "Ravens Super Bowl",
    });
  });
});
