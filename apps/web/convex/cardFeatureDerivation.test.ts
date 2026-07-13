/**
 * NEO-71-74: integration test that `addCustomCard` inherits the complete,
 * self-contained `features` snapshot already resolved on the selectorOption
 * node it's added under — write-once feature snapshots, computed via
 * copy-down at each node's own creation (see
 * convex/features/deriveCardFeatures.ts's `deriveOwnLevelFeatures` and the
 * copy-down wiring in `storeSelectorOptions`/`addCustomSelectorOption`/
 * `storeReconciledOptions`). No ancestor-chain walk happens at card-creation
 * time anymore — `addCustomCard` reads a single node.
 *
 * These tests build the chain via the REAL creation mutation
 * (`addCustomSelectorOption`), in strict parent→child order, so each level's
 * auto-derivation and any operator overrides (via `setSelectorOptionFeature`,
 * applied BEFORE the next child is created) flow forward through copy-down —
 * exercising the real pipeline end-to-end rather than hand-injecting a
 * `features` shape production code could never produce.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_001",
  name: "Admin User",
  role: "admin",
};

describe("addCustomCard inherits the write-once feature snapshot (NEO-71-74)", () => {
  test("new custom card inherits node-level features + observed features", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "sport", value: "Baseball" },
    );
    // auto: sportId.features = { league: "MLB" }

    const yearId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "year", value: "2024", parentId: sportId },
    );
    // auto: copies league="MLB" down + own era="Modern (1980-Now)", vintage="false"

    const mfrId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "manufacturer", value: "Topps", parentId: yearId },
    );
    // auto: copies league/era/vintage down + own manufacturer="Topps"

    const setNameId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "setName", value: "Topps Chrome", parentId: mfrId },
    );
    // auto: copies everything above down + own isReprint="false"

    const variantTypeId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "variantType", value: "Base", parentId: setNameId },
    );
    // auto: copies everything above down + own cardType="Base"

    await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: variantTypeId,
      cardNumber: "1",
      cardName: "Aaron Judge",
      attributes: ["RC"],
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    expect(cards).toHaveLength(1);
    const f = cards[0].features ?? {};

    // Copied down from the leaf node's complete, self-contained snapshot.
    expect(f.league).toBe("MLB");
    expect(f.era).toBe("Modern (1980-Now)");
    expect(f.vintage).toBe("false");
    expect(f.manufacturer).toBe("Topps");
    expect(f.cardType).toBe("Base");
    // RC attribute → observed rookie (still derived per-card, wins over
    // the inherited snapshot — deriveCardObservedFeatures is unaffected).
    expect(f.isRookie).toBe("true");
  });

  test("operator-set ancestor feature is inherited by a new custom card", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "sport", value: "Baseball" },
    );
    // auto: sportId.features = { league: "MLB" }

    const setNameId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "setName", value: "BBM", parentId: sportId },
    );
    // auto: copies league="MLB" down + own isReprint="false"

    // Operator overrides league at the setName level (e.g. a Japanese set)
    // BEFORE the variantType child is created, so copy-down carries the
    // override forward — this is the single-row edit (NEO-71-74), applied
    // ahead of the next node's creation, not a cascade after the fact.
    await asAdmin.mutation(api.selectorOptions.setSelectorOptionFeature, {
      selectorOptionId: setNameId,
      key: "league",
      value: "NPB",
    });

    const variantTypeId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "variantType", value: "Base", parentId: setNameId },
    );
    // auto: copies the OVERRIDDEN league="NPB" down (copy-down reads the
    // parent's current features at creation time, override included) + own
    // cardType="Base"

    await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: variantTypeId,
      cardNumber: "1",
      cardName: "Player",
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    // The operator override reached the card purely via creation-time
    // copy-down — no cascade involved.
    expect((cards[0].features ?? {}).league).toBe("NPB");
  });
});
