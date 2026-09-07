/**
 * NEO-254 — every Wikidata label-service call asks for `en,mul`.
 *
 * ## The bug this pins
 *
 * Wikidata has been migrating names that are the same in every language into
 * the `mul` (multilingual) label since 2024, and removing the per-language
 * copies as it goes. `SERVICE wikibase:label` does not fall back across
 * languages unless its list says so, and when it finds no label it returns the
 * bare QID as the label.
 *
 * Q1215892 is the National Hockey League. Its name is in `mul` and it has no
 * `en` label, so a query asking for `"en"` got back the string "Q1215892" —
 * and the review wizard offered to create a league named that (Jason, preview
 * test on California Golden Seals Q849315).
 *
 * ## Why a source test and not only a behavioural one
 *
 * `wikidataEntityReviewQueue.test.ts` asserts the wire query for the team
 * lookup, which is the one that produced the bug. It cannot assert the other
 * label-service blocks without a stub per call path, and the real risk here is
 * the NEXT query somebody adds to `adapters/wikidata.ts` — written by copying
 * a neighbour, which is exactly how three copies of `"en"` came to exist. So
 * this reads the source and refuses any label-service block that does not go
 * through the shared constant.
 *
 * The same shape, and the same reasoning, as `convex/teams.dedupPin.test.ts`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const ADAPTERS_DIR = join(__dirname, "adapters");
const WIKIDATA_SRC = join(ADAPTERS_DIR, "wikidata.ts");

/** Every `SERVICE wikibase:label { … }` block written out literally. */
function literalLabelServiceBlocks(src: string): string[] {
  return src.match(/SERVICE\s+wikibase:label\s*\{[^}]*\}/g) ?? [];
}

describe("NEO-254: the Wikidata label service is asked for en,mul", () => {
  test("the shared constant asks for en and mul, in that order", () => {
    const src = readFileSync(WIKIDATA_SRC, "utf8");
    expect(src).toContain('const LABEL_SERVICE_LANGUAGES = "en,mul";');
    // `en` first: where both exist, the English label is the one curated for
    // an English audience.
    expect(src).toMatch(
      /const LABEL_SERVICE = `SERVICE wikibase:label \{ bd:serviceParam wikibase:language "\$\{LABEL_SERVICE_LANGUAGES\}"\. \}`;/,
    );
  });

  test("no query builds a label-service block any other way", () => {
    const src = readFileSync(WIKIDATA_SRC, "utf8");
    const blocks = literalLabelServiceBlocks(src);
    // Exactly one literal block — the constant's own definition. Every query
    // interpolates `${LABEL_SERVICE}` instead.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("${LABEL_SERVICE_LANGUAGES}");
  });

  test("every SPARQL query in the file uses the constant", () => {
    const src = readFileSync(WIKIDATA_SRC, "utf8");
    const uses = src.match(/\$\{LABEL_SERVICE\}/g) ?? [];
    // Three today (player detail, team detail, league detail). A new query is
    // free to push this number up; what it may not do is drop to fewer uses
    // than there are label-service call sites, which the block count above
    // pins from the other side.
    expect(uses.length).toBeGreaterThanOrEqual(3);
  });

  test("no OTHER adapter has grown its own label-service block", () => {
    // If a second adapter ever queries Wikidata, it must not re-declare the
    // language list — the fix has to be one edit, not a hunt.
    const offenders: string[] = [];
    for (const file of readdirSync(ADAPTERS_DIR)) {
      if (!file.endsWith(".ts") || file === "wikidata.ts") continue;
      if (file.endsWith(".test.ts")) continue;
      const src = readFileSync(join(ADAPTERS_DIR, file), "utf8");
      if (literalLabelServiceBlocks(src).length > 0) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
