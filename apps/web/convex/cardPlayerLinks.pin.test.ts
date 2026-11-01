/**
 * NEO-313 — one writer for the `cardPlayerLinks` index.
 *
 * `cardChecklist.playerIds` is the truth; `cardPlayerLinks` is the same fact
 * stored flat so "which cards carry this player?" has an index. Two copies of
 * one fact can disagree, and the failure is silent in the worst direction: a
 * player whose card was written without its index row can have a sport
 * removed while a card in that sport still points at him, and the Players
 * admin card list quietly misses the card.
 *
 * So exactly one module writes that table, every `playerIds` writer reaches
 * its helper, and every card delete takes the rows with it. This greps for the
 * drift. Same shape as `players.aliasIndexPin.test.ts`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const CONVEX_DIR = __dirname;

/** Every non-test `.ts` under convex/, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "_generated" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

const read = (name: string) => readFileSync(join(CONVEX_DIR, name), "utf8");

describe("NEO-313: only cardPlayerLinks.ts writes the card → player index", () => {
  test("no other module inserts into cardPlayerLinks, and only sanctioned readers query it", () => {
    /*
     * Readers outside the module, and why each is allowed:
     *   - players.ts: `cardsForPlayer` and `setAdditionalSports`'s removal
     *     guard READ the index; neither writes it.
     *   - selectorOptions.ts: the E2E reset drain, `resetCardPlayerLinksBatch`,
     *     exempt by NAME and POSITION — a second query in that module would
     *     still be flagged.
     */
    const offenders: string[] = [];
    for (const file of sourceFiles(CONVEX_DIR)) {
      if (file.endsWith(join("convex", "cardPlayerLinks.ts"))) continue;
      const src = readFileSync(file, "utf8");
      if (/\.insert\(\s*"cardPlayerLinks"/.test(src)) {
        offenders.push(`${file}: insert`);
        continue;
      }
      const queries = src.match(/query\(\s*"cardPlayerLinks"/g) ?? [];
      if (queries.length === 0) continue;
      if (file.endsWith(join("convex", "players.ts"))) continue;
      if (file.endsWith(join("convex", "selectorOptions.ts"))) {
        const drain = src.indexOf("export const resetCardPlayerLinksBatch");
        if (
          drain !== -1 &&
          queries.length === 1 &&
          src.indexOf('query("cardPlayerLinks"') > drain
        ) {
          continue;
        }
      }
      offenders.push(`${file}: query`);
    }
    expect(offenders).toEqual([]);
  });

  test("players.ts only READS the index", () => {
    // Its two readers go through `.withIndex(...)` and hand rows back; a
    // delete or patch keyed on a link row would be a second writer.
    const src = read("players.ts");
    const readers = src.match(/query\("cardPlayerLinks"\)/g) ?? [];
    expect(readers.length).toBe(2);
    expect(src).not.toMatch(/insert\(\s*"cardPlayerLinks"/);
  });

  test("the module itself has one insert, inside syncCardPlayerLinks", () => {
    const src = read("cardPlayerLinks.ts");
    expect(src.match(/ctx\.db\.insert\("cardPlayerLinks"/g) ?? []).toHaveLength(1);
    const writer = src.slice(
      src.indexOf("export async function syncCardPlayerLinks"),
      src.indexOf("export async function deleteCardPlayerLinks"),
    );
    expect(writer).toContain('ctx.db.insert("cardPlayerLinks"');
  });
});

describe("NEO-313: every playerIds writer and every card delete reaches the helper", () => {
  const SRC = read("selectorOptions.ts");

  test("no module but selectorOptions.ts and cardRowCreate.ts inserts a card", () => {
    // The insert sites below are the whole population; a third module
    // inserting cards would be a writer this file does not see. NEO-312 moved
    // the commit chunk's insert into `cardRowCreate.insertCardRow`, which the
    // parallel build shares.
    const offenders = sourceFiles(CONVEX_DIR).filter(
      (file) =>
        !file.endsWith(join("convex", "selectorOptions.ts")) &&
        !file.endsWith(join("convex", "cardRowCreate.ts")) &&
        /\.insert\(\s*"cardChecklist"/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  test("each cardChecklist insert syncs the index for the new card", () => {
    const lines = SRC.split("\n");
    const sites = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /ctx\.db\.insert\("cardChecklist"/.test(line));
    // addCustomCard. The commit chunk's insert branch goes through
    // `insertCardRow`, pinned below.
    expect(sites).toHaveLength(1);
    for (const { i } of sites) {
      const window = lines.slice(i, i + 120).join("\n");
      expect(window, `insert at line ${i + 1}`).toContain("syncCardPlayerLinks(");
    }
  });

  test("insertCardRow (commit chunk + parallel build) syncs the index for every card it inserts", () => {
    // NEO-312 — the one insert in cardRowCreate.ts sits inside insertCardRow,
    // and the index call follows it in the same function, so no caller can
    // mint an unindexed card.
    const src = read("cardRowCreate.ts");
    expect(src.match(/ctx\.db\.insert\(\s*"cardChecklist"/g) ?? []).toHaveLength(1);
    const fn = src.slice(src.indexOf("export async function insertCardRow"));
    const insertAt = fn.search(/ctx\.db\.insert\(\s*"cardChecklist"/);
    expect(insertAt).toBeGreaterThan(0);
    expect(fn.slice(insertAt)).toMatch(/syncCardPlayerLinks\(ctx, id, card\.playerIds,[\s\S]*fresh: true/);
  });

  test("updateCard syncs the index after its patch", () => {
    const start = SRC.indexOf("export const updateCard = mutation(");
    const body = SRC.slice(start, SRC.indexOf("\n});", start));
    expect(body).toContain("filtered.playerIds = ids;");
    expect(body).toContain("syncCardPlayerLinks(");
  });

  test("the re-sync's accepted playerIds write syncs the index", () => {
    const start = SRC.indexOf("export const commitCardChecklistChunk = internalMutation(");
    const body = SRC.slice(start, SRC.indexOf("\n});", start));
    const patch = body.indexOf("...contentPatch,");
    expect(patch).toBeGreaterThan(0);
    expect(body.slice(patch, patch + 3000)).toContain("syncCardPlayerLinks(");
  });

  test("every card delete in selectorOptions.ts removes the card's index rows", () => {
    // `orphanVariationsOf` runs immediately before every card delete in this
    // module (NEO-189), so it counts the delete sites.
    const deletes = (SRC.match(/await orphanVariationsOf\(ctx,/g) ?? []).length;
    const indexDeletes = (SRC.match(/await deleteCardPlayerLinks\(ctx,/g) ?? []).length;
    expect(deletes).toBeGreaterThan(0);
    expect(indexDeletes).toBe(deletes);
  });

  test("the parallel build's delete page removes each deleted card's index rows", () => {
    // NEO-312 — the rebuild deletes the parallel's old cards; same pairing as
    // selectorOptions.ts: one index delete per card delete.
    const src = read("parallelChecklistBuild.ts");
    const deletes = (src.match(/await orphanVariationsOf\(ctx,/g) ?? []).length;
    const indexDeletes = (src.match(/await deleteCardPlayerLinks\(ctx,/g) ?? []).length;
    expect(deletes).toBeGreaterThan(0);
    expect(indexDeletes).toBe(deletes);
  });

  test("the subtree wipe removes a wiped card's index rows", () => {
    const src = read("wipeVariantTypeSubtree.ts");
    const dropCard = src.slice(
      src.indexOf("const dropCard = async"),
      src.indexOf("let stoppedEarly = false;"),
    );
    expect(dropCard).toContain("deleteCardPlayerLinks(ctx, card._id)");
  });
});
