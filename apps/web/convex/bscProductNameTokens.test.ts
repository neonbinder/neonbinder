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
import { applyBscAttributeFill } from "./cardChecklist";
import {
  fillBscAttributeFields,
  type BscAttributeFields,
} from "./lib/bscAttributeTokens";

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
function stubMarketplaces(
  bscRows: BscRow[],
  cardListing: Record<string, Record<string, unknown>> = {},
): void {
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
        const id = href.match(/\/marketplace\/card\/([^/]+)\/card-listing/)?.[1] ?? "";
        const body = cardListing[id] ?? { teamName: "", playerAttribute: "" };
        return new Response(JSON.stringify(body), {
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
  cardListing?: Record<string, Record<string, unknown>>,
): Promise<Map<string, AttributeView>> {
  stubMarketplaces(bscRows, cardListing);
  const t = convexTest(schema, modules);
  const baseId = await seedBase(t);
  const preview = await t
    .withIdentity(ADMIN)
    .action(api.selectorOptions.previewCardChecklist, {
      selectorOptionId: baseId,
      ...(cardListing ? { lookupTeams: true } : {}),
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
  cardListing?: Record<string, Record<string, unknown>>,
): Promise<Map<string, AttributeView>> {
  stubMarketplaces(bscRows, cardListing);
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

/**
 * NEO-339 Gap 2 — the bulk row carries NO token (no `playerAttribute`, no
 * `productName`); only BSC's per-card card-listing does, in its
 * `productName` or as the attribute label in `teamName`. The lookup's tokens
 * ride `fetchBscCardTeamNames` → `bscTeamLookupEntries` →
 * `resolveCandidateTeams` (the stage) and the preview's in-memory twin, and
 * are filled onto the candidate fill-empty (`fillBscAttributeFields`).
 */
const BULK_NO_TOKEN_ROWS: BscRow[] = [
  { cardNo: "PBDA-CP", players: "Gerrit Cole/Andy Pettitte" },
  { cardNo: "PBDA-HS", players: "Mike Schmidt/Bryce Harper" },
  { cardNo: "PDA-1", players: "Jac Caglianone/Charlie Condon" },
  { cardNo: "7", players: "Mike Trout", playerAttribute: "RC" },
  { cardNo: "8", players: "Aubrey Huff" },
];

const CARD_LISTING: Record<string, Record<string, unknown>> = {
  // The live PBDA payload: the tokens only in productName.
  "bsc-PBDA-CP": {
    teamName: "",
    playerAttribute: "",
    productName: "Gerrit Cole / Andy Pettitte AU, SN #PBDA-CP",
  },
  // The NEO-345 shape: the label where the team belongs.
  "bsc-PBDA-HS": { teamName: "AU, SN", playerAttribute: "" },
  "bsc-PDA-1": {
    teamName: "",
    playerAttribute: "",
    productName: "Jac Caglianone / Charlie Condon AU, SN99 #PDA-1",
  },
  // The usual case: the lookup repeats the catalogue's tokens.
  "bsc-7": { teamName: "", playerAttribute: "RC", productName: "Mike Trout RC #7" },
  "bsc-8": { teamName: "", playerAttribute: "", productName: "Aubrey Huff #8" },
};

describe("card-listing-only tokens reach the draft and the stage (NEO-339)", () => {
  test("the draft preview gets AU from the per-card productName and from the teamName label", async () => {
    const cards = await previewByNumber(BULK_NO_TOKEN_ROWS, CARD_LISTING);
    // SportLots' "AU /25" is what the candidate held; BSC's AU and bare SN
    // are added after it (the stored-card fill's order), its print run kept.
    expect(cards.get("PBDA-CP")).toEqual({
      attributes: ["NUM", "AU", "SN"],
      printRun: 25,
      autographType: "Unknown",
    });
    expect(cards.get("PBDA-HS")).toEqual(cards.get("PBDA-CP"));
    expect(cards.get("PDA-1")).toEqual({
      attributes: ["NUM", "AU"],
      printRun: 99,
      autographType: "Unknown",
    });
    expect(cards.get("7")).toEqual({ attributes: ["RC"], isRookie: true });
    expect(cards.get("8")).toEqual({});
  });

  test("without the lookup the draft cannot see them: the bulk row alone has no AU", async () => {
    const cards = await previewByNumber(BULK_NO_TOKEN_ROWS);
    expect(cards.get("PBDA-CP")).toEqual({
      attributes: ["NUM", "AU"],
      printRun: 25,
      autographType: "Unknown",
    });
  });

  test("the staged candidates the commit reads carry exactly the draft's tokens", async () => {
    const preview = await previewByNumber(BULK_NO_TOKEN_ROWS, CARD_LISTING);
    const staged = await stagedByNumber(BULK_NO_TOKEN_ROWS, CARD_LISTING);
    expect(staged.get("PBDA-CP")?.attributes).toEqual(["NUM", "AU", "SN"]);
    expect(staged.get("PBDA-HS")?.attributes).toEqual(["NUM", "AU", "SN"]);
    expect(new Map([...staged].sort())).toEqual(new Map([...preview].sort()));
  });

  test("the merge with SportLots is unchanged: the same tokens, flags and print run as a catalogue card", async () => {
    const fromLookup = await previewByNumber(BULK_NO_TOKEN_ROWS, CARD_LISTING);
    const fromCatalogue = await previewByNumber(PLAYER_ATTRIBUTE_ROWS);
    for (const [cardNumber, view] of fromCatalogue) {
      const got = fromLookup.get(cardNumber)!;
      expect(got, `#${cardNumber}`).toBeDefined();
      // Order aside (the fill appends after what the card held), the card
      // carries what the reconcile would have given it.
      expect([...(got.attributes ?? [])].sort(), `#${cardNumber}`).toEqual(
        [...(view.attributes ?? [])].sort(),
      );
      const { attributes: _a, ...gotRest } = got;
      const { attributes: _b, ...viewRest } = view;
      expect(gotRest, `#${cardNumber}`).toEqual(viewRest);
    }
  });

  test("a lookup that repeats the catalogue's tokens leaves the candidate byte-identical", async () => {
    const withCatalogueTokens = await previewByNumber(PLAYER_ATTRIBUTE_ROWS, {
      "bsc-PBDA-CP": { teamName: "", playerAttribute: "AU, SN" },
      "bsc-PBDA-HS": { teamName: "", playerAttribute: "AU, SN" },
      "bsc-PDA-1": { teamName: "", playerAttribute: "AU, SN99" },
      "bsc-7": { teamName: "", playerAttribute: "RC" },
      "bsc-8": { teamName: "", playerAttribute: "" },
    });
    const withoutLookup = await previewByNumber(PLAYER_ATTRIBUTE_ROWS);
    expect(withCatalogueTokens).toEqual(withoutLookup);
  });
});

/**
 * DRIFT GUARD — `fillBscAttributeFields` (candidates) and
 * `cardChecklist.applyBscAttributeFill` (stored cards) hold one rule in two
 * places. Same inputs, same attributes, print run and flags.
 */
describe("fillBscAttributeFields matches applyBscAttributeFill (NEO-339)", () => {
  const CASES: Array<{
    name: string;
    current: BscAttributeFields;
    tokens: string[];
    printRun?: number;
  }> = [
    { name: "empty card, AU + bare SN", current: {}, tokens: ["AU", "SN"] },
    {
      name: "SportLots AU /25, BSC AU + bare SN",
      current: { attributes: ["NUM", "AU"], printRun: 25 },
      tokens: ["AU", "SN"],
    },
    {
      name: "RC card, BSC AU SN99",
      current: { attributes: ["RC"], isRookie: true },
      tokens: ["AU", "SN99"],
      printRun: 99,
    },
    {
      name: "print runs disagree",
      current: { attributes: ["AU", "NUM"], printRun: 25 },
      tokens: ["AU", "SN99"],
      printRun: 99,
    },
    { name: "a raw stored run", current: { attributes: ["SN25"] }, tokens: ["MEM"] },
    {
      name: "explicit false flags",
      current: { attributes: [], isRookie: false, isRelic: false },
      tokens: ["RC", "JSY"],
    },
    { name: "nothing new", current: { attributes: ["AU", "NUM"], printRun: 5 }, tokens: ["AU", "SN5"] },
  ];

  for (const c of CASES) {
    test(c.name, async () => {
      const t = convexTest(schema, modules);
      const stored = await t.run(async (ctx) => {
        const selectorOptionId = await ctx.db.insert("selectorOptions", {
          level: "variantType",
          value: "Base",
          platformData: {},
          children: [],
          lastUpdated: T,
        });
        const id = await ctx.db.insert("cardChecklist", {
          selectorOptionId,
          cardNumber: "1",
          cardName: "Card 1",
          platformData: {},
          sortOrder: 1,
          lastUpdated: T,
          ...c.current,
        });
        const row = (await ctx.db.get(id))!;
        await applyBscAttributeFill(ctx, row, {
          tokens: c.tokens,
          ...(c.printRun !== undefined ? { printRun: c.printRun } : {}),
        });
        const after = (await ctx.db.get(id))!;
        return {
          attributes: after.attributes,
          printRun: after.printRun,
          isRookie: after.isRookie,
          isRelic: after.isRelic,
        };
      });
      const { fields } = fillBscAttributeFields(c.current, {
        tokens: c.tokens,
        printRun: c.printRun,
      });
      const clean = (f: BscAttributeFields) => JSON.parse(JSON.stringify(f));
      expect(clean(fields)).toEqual(clean(stored));
    });
  }
});
