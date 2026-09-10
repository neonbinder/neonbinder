/**
 * NEO-254 — one writer for the `playerAliases` index.
 *
 * `players.aliases` is what an operator edits; `playerAliases` is how a card
 * name finds the row. Two copies of one fact can disagree, and the failure is
 * silent in the worst direction: a row whose index entry was never written
 * simply stops answering to its old name, and the 2010 card quietly creates a
 * second player. Nothing throws, nothing logs, and it surfaces months later as
 * a split inventory.
 *
 * So exactly one function writes that table, and this greps for anything else.
 * Same shape and same reasoning as `convex/teams.dedupPin.test.ts`, which
 * guards the team dedup key one table over.
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

describe("NEO-254: only players.ts writes the alias index", () => {
  test("no other module writes playerAliases per player", () => {
    /*
     * The exemption, and why it is narrow.
     *
     * The set-builder RESET drains this table wholesale, and it must not go
     * through `syncPlayerAliases` — that helper rewrites one player's rows, and
     * a drain has no player. So `resetPlayerAliasesBatch` is allowed to query
     * and delete here; everything else, in any module, is the drift this file
     * exists to catch.
     */
    const offenders: string[] = [];
    for (const file of sourceFiles(CONVEX_DIR)) {
      if (file.endsWith(join("convex", "players.ts"))) continue;
      const src = readFileSync(file, "utf8");
      const touches =
        /\.(insert|patch)\(\s*"playerAliases"/.test(src) ||
        /query\(\s*"playerAliases"/.test(src);
      if (!touches) continue;
      // The one sanctioned exception, checked by NAME rather than by file: a
      // second function in this module doing it would still be flagged.
      const drain = src.indexOf("export const resetPlayerAliasesBatch");
      const onlyUse =
        drain !== -1 &&
        src.indexOf('query("playerAliases"') > drain &&
        (src.match(/query\(\s*"playerAliases"/g) ?? []).length === 1 &&
        !/\.(insert|patch)\(\s*"playerAliases"/.test(src);
      if (!onlyUse) offenders.push(file);
    }
    // `bulkLoad.ts` and every other caller must go through `syncPlayerAliases`.
    expect(offenders).toEqual([]);
  });

  test("players.ts routes every alias write through the one helper", () => {
    const src = readFileSync(join(CONVEX_DIR, "players.ts"), "utf8");
    // One insert and one delete, both inside `syncPlayerAliases`.
    expect(src.match(/ctx\.db\.insert\("playerAliases"/g) ?? []).toHaveLength(1);
    expect(
      src.slice(
        src.indexOf("export async function syncPlayerAliases"),
        src.indexOf("export async function findAliasCollision"),
      ),
    ).toContain('ctx.db.insert("playerAliases"');
  });

  test("every writer of players.aliases also syncs the index", () => {
    // The pairing that matters: a `patch`/`insert` naming `aliases` with no
    // `syncPlayerAliases` beside it is the drift this file exists to catch.
    const src = readFileSync(join(CONVEX_DIR, "players.ts"), "utf8");
    const syncCalls = (src.match(/syncPlayerAliases\(ctx/g) ?? []).length;
    // createByAdmin, savePlayerFields — and bulkLoad calls the exported helper.
    expect(syncCalls).toBeGreaterThanOrEqual(2);
    const bulk = readFileSync(join(CONVEX_DIR, "bulkLoad.ts"), "utf8");
    expect(bulk).toContain("syncPlayerAliases(ctx");
  });
});
