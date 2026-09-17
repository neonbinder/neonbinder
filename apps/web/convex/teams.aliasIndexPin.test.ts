/**
 * NEO-284 — one writer for the `teamAliases` index.
 *
 * `teams.aliases` is what an operator edits; `teamAliases` is how a checklist
 * string finds the row. Two copies of one fact can disagree, and the failure
 * is silent in the worst direction: a row whose index entry was never written
 * simply stops answering to its old name.
 *
 * So exactly one function writes that table, and this greps for anything
 * else. Twin of `convex/players.aliasIndexPin.test.ts`.
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

describe("NEO-284: only teams.ts writes the alias index", () => {
  test("no other module writes teamAliases per team", () => {
    /*
     * The exemption, and why it is narrow.
     *
     * The set-builder RESET drains this table wholesale, and it must not go
     * through `syncTeamAliases` — that helper rewrites one team's rows, and a
     * drain has no team. So `resetTeamAliasesBatch` is allowed to query and
     * delete here; everything else, in any module, is the drift this file
     * exists to catch.
     */
    const offenders: string[] = [];
    for (const file of sourceFiles(CONVEX_DIR)) {
      if (file.endsWith(join("convex", "teams.ts"))) continue;
      // `convex/lib/teamRow.ts` reads (never writes) `teamAliases` in
      // `findTeamsByAlias` — every consumer of the union (including
      // `teams.ts`'s own `search`) goes through it rather than querying the
      // table directly, so this is the one other module allowed to READ it.
      // An insert/patch here would still be the drift this file exists to
      // catch, so only the write half of the grep is skipped for it.
      const isTeamRow = file.endsWith(join("convex", "lib", "teamRow.ts"));

      const src = readFileSync(file, "utf8");
      const writes = /\.(insert|patch)\(\s*"teamAliases"/.test(src);
      const reads = /query\(\s*"teamAliases"/.test(src);
      if (writes) {
        offenders.push(file);
        continue;
      }
      if (!reads) continue;
      if (isTeamRow) continue;
      // The one sanctioned exception, checked by NAME rather than by file: a
      // second function in this module doing it would still be flagged.
      const drain = src.indexOf("export const resetTeamAliasesBatch");
      const onlyUse =
        drain !== -1 &&
        src.indexOf('query("teamAliases"') > drain &&
        (src.match(/query\(\s*"teamAliases"/g) ?? []).length === 1;
      if (!onlyUse) offenders.push(file);
    }
    // Every other caller must go through `syncTeamAliases` to write, or
    // `findTeamsByAlias`/`findTeamsByFullName` in `lib/teamRow.ts` to read.
    expect(offenders).toEqual([]);
  });

  test("teams.ts routes every alias write through the one helper", () => {
    const src = readFileSync(join(CONVEX_DIR, "teams.ts"), "utf8");
    // One insert and one delete, both inside `syncTeamAliases`.
    expect(src.match(/ctx\.db\.insert\("teamAliases"/g) ?? []).toHaveLength(1);
    expect(
      src.slice(
        src.indexOf("export async function syncTeamAliases"),
        src.indexOf("export async function findTeamAliasCollision"),
      ),
    ).toContain('ctx.db.insert("teamAliases"');
  });

  test("every writer of teams.aliases also syncs the index", () => {
    // The pairing that matters: a `patch`/`insert` naming `aliases` with no
    // `syncTeamAliases` beside it is the drift this file exists to catch.
    const src = readFileSync(join(CONVEX_DIR, "teams.ts"), "utf8");
    const syncCalls = (src.match(/syncTeamAliases\(ctx/g) ?? []).length;
    // findOrCreate (insert branch), saveTeamFields.
    expect(syncCalls).toBeGreaterThanOrEqual(2);
  });

  test("reads in lib/teamRow.ts and teams.ts search are allowed and do not trip the pin", () => {
    const teamRowSrc = readFileSync(
      join(CONVEX_DIR, "lib", "teamRow.ts"),
      "utf8",
    );
    expect(teamRowSrc).toMatch(/query\(\s*"teamAliases"/);
    expect(teamRowSrc).not.toMatch(/\.(insert|patch)\(\s*"teamAliases"/);
  });
});
