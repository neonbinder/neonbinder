/**
 * NEO-363 — insert a `cardChecklist` row from a convex-test fixture.
 *
 * `listingTitle` and `sportId` are required on every card. The app's writers
 * (`insertCardRow`, `addCustomCard`) generate the one and walk for the other;
 * a fixture that writes a card straight into the table, and has no interest
 * in either field, gets the same two answers here instead of repeating them
 * at every insert:
 *
 *   - `listingTitle`: `#<cardNumber>`, which is how every generated title
 *     ends (`assessListingTitle`), so it is never blank.
 *   - `sportId`: the root of the card's selector chain, the walk
 *     `findSportForSelectorOption` does. A chain that reaches no sport row
 *     THROWS: the app refuses such a card (`requireCardSport`), so a fixture
 *     that builds one is building something production cannot hold. Give the
 *     fixture a sport row instead.
 *
 * A fixture that does care passes its own value, which is kept as given.
 *
 * Lives under lib/ rather than convex/ so it is never deployed as a module.
 */

import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { MutationCtx } from "../../convex/_generated/server";

type CardRow = WithoutSystemFields<Doc<"cardChecklist">>;

export type TestCardRow = Omit<CardRow, "listingTitle" | "sportId"> &
  Partial<Pick<CardRow, "listingTitle" | "sportId">>;

/** The sport at the root of `selectorOptionId`'s chain, or a thrown error. */
export async function testCardSport(
  ctx: Pick<MutationCtx, "db">,
  selectorOptionId: Id<"selectorOptions">,
): Promise<Id<"selectorOptions">> {
  let cursor: Id<"selectorOptions"> | undefined = selectorOptionId;
  for (let depth = 0; cursor && depth < 16; depth++) {
    const node: Doc<"selectorOptions"> | null = await ctx.db.get(cursor);
    if (!node) break;
    if (node.level === "sport") return node._id;
    cursor = node.parentId;
  }
  throw new Error(
    `insertTestCard: selector row ${selectorOptionId} has no sport above it; ` +
      "give the fixture a sport row (a card cannot exist without one).",
  );
}

export async function insertTestCard(
  ctx: Pick<MutationCtx, "db">,
  row: TestCardRow,
): Promise<Id<"cardChecklist">> {
  return ctx.db.insert("cardChecklist", {
    ...row,
    listingTitle: row.listingTitle ?? `#${row.cardNumber}`,
    sportId: row.sportId ?? (await testCardSport(ctx, row.selectorOptionId)),
  });
}
