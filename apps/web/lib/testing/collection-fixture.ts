/**
 * NEO-358 — a small catalog for the collection tests
 * (`convex/collection.test.ts`, `convex/collectionCatalog.test.ts`).
 *
 *   Baseball
 *   └ 2024
 *     └ Topps
 *       └ Topps Chrome  (set)
 *         ├ Base         cards #1 Gooden, #2 Strawberry, #1 Gooden "Sliding"
 *         │              (a variation of #1); stored counts 3 / 2
 *         ├ Inserts
 *         │ └ Future Stars   card #FS-1 Gooden; NO stored counts
 *         └ Parallels
 *           └ Gold Refractor  card #1 Gooden /50
 *
 * Every card and row carries marketplace residue (`platformData`, labels,
 * `isCustom`, `sku`, a `bscTeamName`, pending names, raw attributes) so the
 * catalog's NB-only `returns` can be checked against a row that HAS them.
 *
 * Lives under lib/ rather than convex/ so it is never deployed as a module.
 */

import type { convexTest } from "convex-test";
import type { Id } from "../../convex/_generated/dataModel";
import { normalizeEntityName } from "../entities/normalize-name";

type T = ReturnType<typeof convexTest>;

export type CollectionFixture = Awaited<ReturnType<typeof seedCollectionCatalog>>;

const NOW = 1_700_000_000_000;

export async function seedCollectionCatalog(t: T) {
  return t.run(async (ctx) => {
    const row = async (
      level:
        | "sport"
        | "year"
        | "manufacturer"
        | "setName"
        | "variantType"
        | "insert"
        | "parallel",
      value: string,
      parentId?: Id<"selectorOptions">,
      extra: Record<string, unknown> = {},
    ) => {
      const id = await ctx.db.insert("selectorOptions", {
        level,
        value,
        platformData: { bsc: { b0: "bsc-slug-" + value } },
        platformLabels: { bsc: { b0: "BSC label " + value } },
        isCustom: false,
        children: [],
        ...(parentId ? { parentId } : {}),
        lastUpdated: NOW,
        ...extra,
      } as never);
      if (parentId) {
        const parent = await ctx.db.get(parentId);
        await ctx.db.patch(parentId, { children: [...(parent?.children ?? []), id] });
      }
      return id;
    };

    const sportId = await row("sport", "Baseball");
    const yearId = await row("year", "2024", sportId);
    const toppsId = await row("manufacturer", "Topps", yearId);
    const setId = await row("setName", "Topps Chrome", toppsId);
    const baseId = await row("variantType", "Base", setId, {
      cardCount: 3,
      nonVariationCardCount: 2,
    });
    const insertsTypeId = await row("variantType", "Inserts", setId, {
      cardCount: 0,
      nonVariationCardCount: 0,
    });
    const futureStarsId = await row("insert", "Future Stars", insertsTypeId);
    const parallelsTypeId = await row("variantType", "Parallels", setId, {
      cardCount: 0,
      nonVariationCardCount: 0,
    });
    const goldId = await row("insert", "Gold Refractor", parallelsTypeId, {
      cardCount: 1,
      nonVariationCardCount: 1,
    });

    // An older set, so the drill's year order has something to order.
    const year1986Id = await row("year", "1986", sportId);
    const topps86Id = await row("manufacturer", "Topps", year1986Id);
    const set86Id = await row("setName", "Topps Traded", topps86Id);

    const franchiseId = await ctx.db.insert("franchises", {
      name: "Expos / Nationals",
      nameNormalized: normalizeEntityName("Expos / Nationals"),
      sportId,
      lastUpdated: NOW,
    });
    const team = (location: string, name: string, extra: Record<string, unknown> = {}) =>
      ctx.db.insert("teams", {
        name,
        location,
        nameNormalized: normalizeEntityName(`${location} ${name}`),
        sportId,
        lastUpdated: NOW,
        ...extra,
      } as never);
    const metsId = await team("New York", "Mets", {
      colors: { primary: "#002D72", secondary: "#FF5910" },
    });
    const exposId = await team("Montreal", "Expos", { franchiseId });
    const nationalsId = await team("Washington", "Nationals", { franchiseId });
    await ctx.db.insert("teamAliases", {
      teamId: metsId,
      sportId,
      aliasNormalized: normalizeEntityName("Amazins"),
    });

    const player = (name: string, aliases?: string[]) =>
      ctx.db.insert("players", {
        name,
        nameNormalized: normalizeEntityName(name),
        sportId,
        ...(aliases ? { aliases } : {}),
        lastUpdated: NOW,
      });
    const goodenId = await player("Dwight Gooden", ["Doc Gooden"]);
    await ctx.db.insert("playerAliases", {
      playerId: goodenId,
      sportId,
      aliasNormalized: normalizeEntityName("Doc Gooden"),
    });
    const strawberryId = await player("Darryl Strawberry");

    const card = async (
      variantId: Id<"selectorOptions">,
      cardNumber: string,
      listingTitle: string,
      playerId: Id<"players">,
      nameOnCard: string,
      teamIds: Array<Id<"teams">>,
      sortOrder: number,
      extra: Record<string, unknown> = {},
    ) => {
      const id = await ctx.db.insert("cardChecklist", {
        selectorOptionId: variantId,
        cardNumber,
        cardName: nameOnCard,
        playerIds: [playerId],
        playerLinks: [{ playerId, nameOnCard }],
        teamOnCardIds: teamIds,
        listingTitle,
        sportId,
        platformData: { bsc: { ref: "bsc-ref-" + cardNumber, src: "b0" } },
        isCustom: false,
        sku: "SKU-" + cardNumber,
        bscTeamName: "BSC Team",
        pendingTeamNames: ["Pending Team"],
        pendingPlayerNames: ["Pending Player"],
        attributes: ["RC", "platform-attr"],
        autographType: "On-Card",
        sortOrder,
        lastUpdated: NOW,
        ...extra,
      } as never);
      await ctx.db.insert("cardPlayerLinks", { cardChecklistId: id, playerId, sportId });
      for (const teamId of teamIds) {
        await ctx.db.insert("cardTeamLinks", { cardChecklistId: id, teamId });
      }
      return id;
    };

    const gooden1 = await card(
      baseId, "1", "2024 Topps Chrome #1 Doc Gooden Mets", goodenId, "Doc Gooden", [metsId], 0,
      { isRookie: true, features: { autographed: "On Card", shortPrint: "SP" } },
    );
    const strawberry2 = await card(
      baseId, "2", "2024 Topps Chrome #2 Darryl Strawberry Mets RC", strawberryId,
      "Darryl Strawberry", [metsId], 1,
    );
    const gooden1Sliding = await card(
      baseId, "1", "2024 Topps Chrome #1 Dwight Gooden Sliding Variation Expos", goodenId,
      "Dwight Gooden", [exposId], 2,
      { cardVariation: "Sliding" },
    );
    await ctx.db.patch(gooden1Sliding, { variationOfCardId: gooden1 });
    const futureStar = await card(
      futureStarsId, "FS-1", "2024 Topps Chrome Future Stars #FS-1 Dwight Gooden Nationals",
      goodenId, "Dwight Gooden", [nationalsId], 0,
    );
    const gold1 = await card(
      goldId, "1", "2024 Topps Chrome Gold Refractor #1 Dwight Gooden /50 Mets",
      goodenId, "Dwight Gooden", [metsId], 0, { printRun: 50 },
    );

    return {
      sportId, yearId, toppsId, setId, baseId, insertsTypeId, futureStarsId,
      parallelsTypeId, goldId, year1986Id, set86Id,
      franchiseId, metsId, exposId, nationalsId, goodenId, strawberryId,
      gooden1, strawberry2, gooden1Sliding, futureStar, gold1,
    };
  });
}
