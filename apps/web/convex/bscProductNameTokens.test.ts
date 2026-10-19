/**
 * NEO-339 — BSC attribute tokens read from a card's `productName` when its
 * `playerAttribute` is empty (Jason: "yes read AU from product name").
 *
 * Seen live on BSC's public card-listing for 2024 Topps Chrome Black "Pitch
 * Black Pairings Dual Autographs": `playerAttribute` "" with `productName`
 * "Gerrit Cole / Andy Pettitte AU, SN #PBDA-CP", while the sibling
 * single-autograph inserts carry `["AU", "SN50"]`. 2025 Bowman Draft
 * "Prospect Dual Autographs" printed "AU, SN99" the same way.
 *
 * This runs the REAL adapters (`fetchBscChecklist`, `fetchSportLotsChecklist`)
 * under the real reconcile, with only `fetch` and the credentials layer
 * stubbed, through both readers of the reconciled card: the read-only
 * `previewCardChecklist` (the draft) and `fetchCardChecklist` (the staged
 * candidates the commit reads). Both build their cards with
 * `checklistCandidateFields`, so a token the parse lifts reaches both or
 * neither; the assertions below check each.
 *
 * Lives at the convex/ ROOT for the import.meta.glob reason documented at the
 * top of `convex/sportlots.test.ts`.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { drainScheduled } from "../lib/testing/drain-scheduled";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_neo339_product_name",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo339_product_name",
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

// Load the mocked credentials module before convex-test loads the
// selectorOptions graph. Observed without it: the FIRST action in this file
// reached the real `getSiteToken` (logging "Failed to retrieve token") and
// every later one reached the mock, so whichever test ran first failed.
beforeAll(async () => {
  await import("./credentials");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type BscRow = {
  cardNo: string;
  players: string;
  playerAttribute?: string;
  productName?: string;
};

type SlRow = { cardNumber: string; description: string };

/**
 * One card per case. The BSC `productName` strings for PBDA-CP and PBDA-HS
 * are the live ones; PDA-1 has the Bowman Draft "AU, SN99" shape.
 */
const SL_ROWS: SlRow[] = [
  { cardNumber: "PBDA-CP", description: "Gerrit Cole/Andy Pettitte AU /25" },
  { cardNumber: "PBDA-HS", description: "Mike Schmidt/Bryce Harper AU /25" },
  { cardNumber: "PDA-1", description: "Jac Caglianone/Charlie Condon AU /99" },
  { cardNumber: "7", description: "Mike Trout RC" },
  { cardNumber: "8", description: "Aubrey Huff" },
];

const PRODUCT_NAME_ROWS: BscRow[] = [
  {
    cardNo: "PBDA-CP",
    players: "Gerrit Cole/Andy Pettitte",
    playerAttribute: "",
    productName: "Gerrit Cole / Andy Pettitte AU, SN #PBDA-CP",
  },
  {
    cardNo: "PBDA-HS",
    players: "Mike Schmidt/Bryce Harper",
    playerAttribute: "",
    productName: "Mike Schmidt / Bryce Harper AU, SN #PBDA-HS",
  },
  {
    cardNo: "PDA-1",
    players: "Jac Caglianone/Charlie Condon",
    playerAttribute: "",
    productName: "Jac Caglianone / Charlie Condon AU, SN99 #PDA-1",
  },
  // playerAttribute present: productName is never read, even when it
  // disagrees.
  {
    cardNo: "7",
    players: "Mike Trout",
    playerAttribute: "RC",
    productName: "Mike Trout AU, SN99 #7",
  },
  // No token run, and a name made of "Au"/"Sn" letters.
  {
    cardNo: "8",
    players: "Aubrey Huff",
    playerAttribute: "",
    productName: "Aubrey Huff #8",
  },
];

/**
 * The same cards with the tokens where BSC normally puts them. The merge with
 * SportLots must read these exactly as it reads the productName rows.
 */
const PLAYER_ATTRIBUTE_ROWS: BscRow[] = [
  { cardNo: "PBDA-CP", players: "Gerrit Cole/Andy Pettitte", playerAttribute: "AU, SN" },
  { cardNo: "PBDA-HS", players: "Mike Schmidt/Bryce Harper", playerAttribute: "AU, SN" },
  { cardNo: "PDA-1", players: "Jac Caglianone/Charlie Condon", playerAttribute: "AU, SN99" },
  { cardNo: "7", players: "Mike Trout", playerAttribute: "RC" },
  { cardNo: "8", players: "Aubrey Huff", playerAttribute: "" },
];

/**
 * Route each request to its stubbed marketplace: SportLots listcards HTML,
 * BSC's per-card card-listing (no team, no tokens — the bulk parse is under
 * test here), BSC's bulk-upload catalogue, and `{}` for anything else.
 */
function stubMarketplaces(bscRows: BscRow[]): void {
  const bulk = bscRows.map((r) => ({
    id: `bsc-${r.cardNo}`,
    setName: "2024-topps-chrome-black",
    ...r,
  }));
  const slHtml = `<table>${SL_ROWS.map(
    (r) =>
      `<tr><td class="smallleft">${r.cardNumber}</td><td class="smallleft">${r.description}</td></tr>`,
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
      if (href.includes("/card-listing")) {
        return new Response(JSON.stringify({ teamName: "", playerAttribute: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (href.includes("bulk-upload/results")) {
        return new Response(JSON.stringify(bulk), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

const T = 1_700_000_000_000;

/** Sport → year → manufacturer → set → Base, both marketplaces attached. */
async function seedBase(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: { bsc: { b0: "baseball" }, sportlots: { s0: "BB" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      children: [],
      lastUpdated: T,
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2024",
      platformData: { bsc: { b0: "2024" }, sportlots: { s0: "2024" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      parentId: sportId,
      children: [],
      lastUpdated: T,
    });
    const mfrId = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Topps",
      platformData: { sportlots: { s0: "TP" } },
      platformSlotSeq: { sportlots: 1 },
      parentId: yearId,
      children: [],
      lastUpdated: T,
    });
    const setId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Chrome Black",
      platformData: { bsc: { b0: "2024-topps-chrome-black" } },
      platformSlotSeq: { bsc: 1 },
      parentId: mfrId,
      children: [],
      lastUpdated: T,
    });
    return ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: { bsc: { b0: "base" }, sportlots: { s0: "555" } },
      platformLabels: { sportlots: { s0: "Topps Chrome Black" } },
      platformFacets: { bsc: { b0: "variant" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      parentId: setId,
      children: [],
      lastUpdated: T,
    });
  });
}

/** The attribute fields of a reconciled card, by card number. */
type AttributeView = {
  attributes?: string[];
  printRun?: number;
  isRookie?: boolean;
  isRelic?: boolean;
  autographType?: string;
};

function attributeView(card: unknown): AttributeView {
  const c = card as AttributeView;
  return JSON.parse(
    JSON.stringify({
      attributes: c.attributes,
      printRun: c.printRun,
      isRookie: c.isRookie,
      isRelic: c.isRelic,
      autographType: c.autographType,
    }),
  ) as AttributeView;
}

async function previewByNumber(
  bscRows: BscRow[],
): Promise<Map<string, AttributeView>> {
  stubMarketplaces(bscRows);
  const t = convexTest(schema, modules);
  const baseId = await seedBase(t);
  const preview = await t
    .withIdentity(ADMIN)
    .action(api.selectorOptions.previewCardChecklist, {
      selectorOptionId: baseId,
    });
  await drainScheduled(t);
  expect(preview.success).toBe(true);
  expect(preview.attachedSides).toEqual(["bsc", "sportlots"]);
  // Every card pairs by number, so the merge is what is being read.
  expect(preview.bscOnly).toEqual([]);
  expect(preview.slOnly).toEqual([]);
  const out = new Map<string, AttributeView>();
  for (const { card } of preview.matched) {
    out.set((card as { cardNumber: string }).cardNumber, attributeView(card));
  }
  return out;
}

async function stagedByNumber(
  bscRows: BscRow[],
): Promise<Map<string, AttributeView>> {
  stubMarketplaces(bscRows);
  const t = convexTest(schema, modules);
  const baseId = await seedBase(t);
  const staged = await t
    .withIdentity(ADMIN)
    .action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId: baseId,
    });
  await drainScheduled(t);
  expect(staged.success).toBe(true);
  const live = await t
    .withIdentity(ADMIN)
    .query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: baseId,
    });
  const out = new Map<string, AttributeView>();
  for (const card of live.cards) {
    expect(card.bucket).toBe("matched");
    out.set(card.cardNumber, attributeView(card));
  }
  return out;
}

describe("BSC productName attribute tokens through the real reconcile (NEO-339)", () => {
  test("the draft preview carries the productName tokens, merged with SportLots", async () => {
    const cards = await previewByNumber(PRODUCT_NAME_ROWS);

    // Live PBDA shape: "AU, SN" — AU, and a bare SN that names no print run
    // (kept raw, as it always was). SportLots' "/25" supplies NUM and the
    // print run on the merge.
    expect(cards.get("PBDA-CP")).toEqual({
      attributes: ["AU", "SN", "NUM"],
      printRun: 25,
      autographType: "Unknown",
    });
    expect(cards.get("PBDA-HS")).toEqual(cards.get("PBDA-CP"));
    // "AU, SN99": BSC's own print run, read the NEO-345 way.
    expect(cards.get("PDA-1")).toEqual({
      attributes: ["AU", "NUM"],
      printRun: 99,
      autographType: "Unknown",
    });
    // playerAttribute present: productName's "AU, SN99" is never read.
    expect(cards.get("7")).toEqual({ attributes: ["RC"], isRookie: true });
    // No run, and "Au"/"Sn" letters in a name, read nothing.
    expect(cards.get("8")).toEqual({});
  });

  test("the merge with SportLots is the one a playerAttribute card gets", async () => {
    const fromProductName = await previewByNumber(PRODUCT_NAME_ROWS);
    const fromPlayerAttribute = await previewByNumber(PLAYER_ATTRIBUTE_ROWS);
    expect([...fromProductName.keys()].sort()).toEqual(
      SL_ROWS.map((r) => r.cardNumber).sort(),
    );
    for (const [cardNumber, view] of fromPlayerAttribute) {
      expect(fromProductName.get(cardNumber), `#${cardNumber}`).toEqual(view);
    }
  });

  test("the staged candidates the commit reads carry the same tokens as the draft", async () => {
    const preview = await previewByNumber(PRODUCT_NAME_ROWS);
    const staged = await stagedByNumber(PRODUCT_NAME_ROWS);
    expect(staged.get("PBDA-CP")?.attributes).toEqual(["AU", "SN", "NUM"]);
    expect(staged.get("PDA-1")?.printRun).toBe(99);
    expect(new Map([...staged].sort())).toEqual(new Map([...preview].sort()));
  });
});
