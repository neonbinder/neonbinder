/**
 * NEO-189 AC #2 — real-data verification.
 *
 * "Importing 2021 Topps Heritage base yields 725 parent cards and 183
 * variations correctly attached, with #11 showing exactly 2 variations named
 * Action and Alternate."
 *
 * That claim had only ever been checked in a throwaway harness against a live
 * BSC payload, which was deleted — every *committed* test used small hand-cut
 * fixtures (see `../../lib/cards/variations.test.ts`,
 * `./buysportscards.test.ts`, `../commitCardChecklist.variations.test.ts`).
 * This file closes that gap by running the real 908-row set through the
 * actual production functions: BSC's own row classification
 * (`parsePlayerAttributeTokens` → `isBscVariationRow` /
 * `parseVariationDescription`) feeding the marketplace-agnostic domain
 * resolver (`resolveVariationParents`). Nothing here is a reimplementation of
 * that logic — a regression in any of those functions fails this test.
 *
 * ## Fixture provenance
 *
 * `__fixtures__/bsc-heritage-2021-cards.json` is derived from a live BSC
 * `POST /seller/bulk-upload/results` pull for 2021 Topps Heritage base,
 * captured 2026-08-27 (908 rows). It is NOT hand-written: every row is
 * `{ cardNo, playerAttribute?, playerAttributeDesc? }` sliced verbatim from
 * the real response, keeping every row (so the aggregate counts below are the
 * real full-set numbers, not a curated subset) while dropping the ~95% of
 * each row that this derivation never reads — `productId`, `cardId`, price,
 * image paths, seller/listing metadata, etc. That takes the source payload
 * from 828KB down to 37KB. `players`/`cardName` fields are omitted too:
 * `resolveVariationParents` groups on `cardNumber` and `isVariation` only, so
 * they carry no signal for what this test checks.
 *
 * ## The real numbers (verified against the code, not assumed from the ticket)
 *
 * 725 parents + 183 variations = 908, all 183 successfully linked, zero
 * unresolved stems. The ticket's numbers are correct.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  isBscVariationRow,
  parsePlayerAttributeTokens,
  parseVariationDescription,
} from "./buysportscards";
import {
  cardNumberStem,
  resolveVariationParents,
  type VariationCandidate,
} from "../../lib/cards/variations";

interface RawHeritageRow {
  cardNo: string;
  playerAttribute?: string;
  playerAttributeDesc?: string;
}

const FIXTURE_PATH = path.join(
  __dirname,
  "__fixtures__/bsc-heritage-2021-cards.json",
);

/**
 * Mirrors the row → `VariationCandidate` mapping in `fetchBscChecklist`
 * (buysportscards.ts, the bulk-upload catalog branch) exactly: same
 * functions, same order, same `cardVariation` ternary. Only field names not
 * read by that derivation (players, ids, images, …) are absent from the
 * fixture — see the file-level doc comment above.
 */
function loadRealRows(): VariationCandidate[] {
  const raw: RawHeritageRow[] = JSON.parse(
    fs.readFileSync(FIXTURE_PATH, "utf8"),
  );
  return raw.map((r) => {
    const attributes = parsePlayerAttributeTokens(r.playerAttribute);
    const isVariation = isBscVariationRow({
      attributes,
      playerAttributeDesc: r.playerAttributeDesc,
    });
    const parsed = parseVariationDescription(r.playerAttributeDesc);
    const variationLabel = parsed?.isVariety ? parsed.text : undefined;
    return { cardNumber: r.cardNo, isVariation, variationLabel };
  });
}

describe("NEO-189 AC #2 — 2021 Topps Heritage base, real BSC payload", () => {
  test("908 real rows resolve to 725 parents and 183 correctly-linked variations", () => {
    const rows = loadRealRows();
    expect(rows).toHaveLength(908);

    const { parentByIndex, unresolvedStems } = resolveVariationParents(rows);

    // Every variation group found a single, unambiguous parent — nothing
    // fell into the "ambiguous, needs review" bucket.
    expect(unresolvedStems).toEqual([]);

    // 183 variation rows, each linked to a parent.
    const linkedVariationCount = parentByIndex.size;
    expect(linkedVariationCount).toBe(183);

    // The remaining 725 rows are parents (unlinked, including every row with
    // no variations at all).
    const parentCount = rows.length - linkedVariationCount;
    expect(parentCount).toBe(725);
  });

  test("#11 has exactly two variations, named Action and Alternate", () => {
    const rows = loadRealRows();
    const { parentByIndex } = resolveVariationParents(rows);

    const stem11 = rows
      .map((_, i) => i)
      .filter((i) => cardNumberStem(rows[i].cardNumber) === "11");

    const parents = stem11.filter((i) => !rows[i].isVariation);
    const variations = stem11.filter((i) => rows[i].isVariation);

    expect(parents).toHaveLength(1);
    expect(variations).toHaveLength(2);

    // Both variations link to the one parent found above.
    const [parentIndex] = parents;
    expect(variations.every((i) => parentByIndex.get(i) === parentIndex)).toBe(
      true,
    );

    // Named exactly "Action" and "Alternate" (BSC's raw `VAR:` labels for
    // #11b / #11c), order-independent.
    const names = variations.map((i) => rows[i].variationLabel).sort();
    expect(names).toEqual(["Action", "Alternate"]);
  });
});
