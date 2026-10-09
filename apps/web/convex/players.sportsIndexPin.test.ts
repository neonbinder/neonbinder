/**
 * NEO-313 — one writer for `playerSports`.
 *
 * `playerSports` says "this player ALSO belongs to that sport", and carries a
 * denormalised copy of `players.nameNormalized` so the lookup leg in
 * `sameNamePlayers` is one compound read. Two copies of one fact can
 * disagree: a rename that skipped the copy would leave Bo Jackson answering to
 * his old name in baseball and not his new one. And membership is an
 * operator decision, never an automated one.
 *
 * So exactly one function writes the table, and this greps for anything else.
 * Same shape as `players.aliasIndexPin.test.ts`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const CONVEX_DIR = __dirname;

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

describe("NEO-313: only players.ts writes playerSports", () => {
  test("no other module touches the table, except the reset drain", () => {
    // The E2E reset drains the table wholesale and has no player, so it
    // cannot go through `syncPlayerSports`. Exempt by NAME and POSITION.
    const offenders: string[] = [];
    for (const file of sourceFiles(CONVEX_DIR)) {
      if (file.endsWith(join("convex", "players.ts"))) continue;
      const src = readFileSync(file, "utf8");
      const touches =
        /\.(insert|patch)\(\s*"playerSports"/.test(src) ||
        /query\(\s*"playerSports"/.test(src);
      if (!touches) continue;
      const drain = src.indexOf("export const resetPlayerSportsBatch");
      const onlyUse =
        drain !== -1 &&
        src.indexOf('query("playerSports"') > drain &&
        (src.match(/query\(\s*"playerSports"/g) ?? []).length === 1 &&
        !/\.(insert|patch)\(\s*"playerSports"/.test(src);
      if (!onlyUse) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("players.ts inserts in one place, inside syncPlayerSports", () => {
    const src = readFileSync(join(CONVEX_DIR, "players.ts"), "utf8");
    expect(src.match(/ctx\.db\.insert\("playerSports"/g) ?? []).toHaveLength(1);
    const writer = src.slice(
      src.indexOf("export async function syncPlayerSports"),
      src.indexOf("export async function addPlayerSport"),
    );
    expect(writer).toContain('ctx.db.insert("playerSports"');
    // The rename rewrite of the denormalised name lives in the writer too.
    expect(writer).toContain("nameNormalized: player.nameNormalized");
  });

  test("a rename in savePlayerFields rewrites the denormalised name through the writer", () => {
    const src = readFileSync(join(CONVEX_DIR, "players.ts"), "utf8");
    const start = src.indexOf("export const savePlayerFields = mutation(");
    const body = src.slice(start, src.indexOf("\n});", start));
    expect(body).toContain("patch.nameNormalized !== existing.nameNormalized");
    expect(body).toContain("await syncPlayerSports(ctx, args.id,");
  });

  test("the writer re-derives the per-sport alias rows when the sport set changes", () => {
    const src = readFileSync(join(CONVEX_DIR, "players.ts"), "utf8");
    const writer = src.slice(
      src.indexOf("export async function syncPlayerSports"),
      src.indexOf("export async function addPlayerSport"),
    );
    expect(writer).toContain("if (setChanged) await syncPlayerAliases(ctx, { playerId });");
  });

  test("NEO-318: the writer patches the derived alsoSportIds copy through ctx.db.patch(playerId", () => {
    const src = readFileSync(join(CONVEX_DIR, "players.ts"), "utf8");
    const writer = src.slice(
      src.indexOf("export async function syncPlayerSports"),
      src.indexOf("export async function addPlayerSport"),
    );
    expect(writer).toContain("alsoSportIds");
    expect(writer).toContain("ctx.db.patch(playerId");
  });
});

describe("NEO-318: players.alsoSportIds has one writer", () => {
  test("no non-test convex module other than players.ts and schema.ts mentions alsoSportIds", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(CONVEX_DIR)) {
      if (file.endsWith(join("convex", "players.ts"))) continue;
      if (file.endsWith(join("convex", "schema.ts"))) continue;
      if (readFileSync(file, "utf8").includes("alsoSportIds")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("none of the players insert blocks seed the copy", () => {
    const blocks: string[] = [];
    for (const file of sourceFiles(CONVEX_DIR)) {
      const src = readFileSync(file, "utf8");
      let from = 0;
      for (;;) {
        const at = src.indexOf('insert("players"', from);
        if (at === -1) break;
        blocks.push(src.slice(at, src.indexOf("});", at) + 3));
        from = at + 1;
      }
    }
    // Guard against the scan silently matching nothing.
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.filter((b) => b.includes("alsoSportIds"))).toEqual([]);
  });

  test("no players insert block spreads a whole object (a spread would copy a stale alsoSportIds)", () => {
    // The alsoSportIds check above only sees the literal. `...source` or
    // `...existing` in an insert would carry a whole doc's copy across with no
    // mention of the field. Today's inserts do use the safe shape
    // `...(cond ? { field } : {})`, which names exactly the fields it adds, so
    // that one form is allowed and every other spread is an offender.
    const blocks: string[] = [];
    for (const file of sourceFiles(CONVEX_DIR)) {
      const src = readFileSync(file, "utf8");
      let from = 0;
      for (;;) {
        const at = src.indexOf('insert("players"', from);
        if (at === -1) break;
        blocks.push(src.slice(at, src.indexOf("});", at) + 3));
        from = at + 1;
      }
    }
    expect(blocks.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const block of blocks) {
      for (const m of block.matchAll(/\.\.\./g)) {
        const rest = block.slice(m.index! + 3);
        const conditionalLiteral =
          rest.startsWith("(") &&
          /^\((?:(?!\.\.\.)(?:[^?]|\?\.))*?\?\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}\s*:\s*\{\}\s*\)/.test(rest);
        if (!conditionalLiteral) offenders.push(block.slice(m.index!, m.index! + 60));
      }
    }
    expect(offenders).toEqual([]);
  });
});

