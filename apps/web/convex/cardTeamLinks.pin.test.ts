/**
 * NEO-358 — one writer for the `cardTeamLinks` index, the twin of
 * `cardPlayerLinks.pin.test.ts`.
 *
 * `cardChecklist.teamOnCardIds` is the truth; `cardTeamLinks` is the same fact
 * stored flat so a collector's "every Padres card" has an index. Two copies of
 * one fact can disagree, and silently: a card written without its rows simply
 * never shows up in that team's search.
 *
 * So exactly one module writes the table, every `teamOnCardIds` write reaches
 * its helper in the same function, and every card delete (all of them go
 * through `removeCardRow`) takes the rows with it. This greps for the drift.
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
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

const read = (name: string) => readFileSync(join(CONVEX_DIR, name), "utf8");
const isFile = (file: string, name: string) => file.endsWith(join("convex", name));

/**
 * The text of every `ctx.db.<method>(...)` call in `src`, with the offset of
 * its start, matched to its closing paren.
 */
function dbCalls(src: string, method: "patch" | "insert"): Array<{ at: number; text: string }> {
  const out: Array<{ at: number; text: string }> = [];
  const needle = `ctx.db.${method}(`;
  for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + 1)) {
    let depth = 0;
    let end = at + needle.length - 1;
    for (; end < src.length; end++) {
      const ch = src[end];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push({ at, text: src.slice(at, end + 1) });
  }
  return out;
}

/** Offsets where a top-level function or registered Convex function starts. */
function functionStarts(src: string): number[] {
  const starts: number[] = [];
  const re = /^(?:export )?(?:const \w+ = (?:internal)?(?:[mM]utation|[qQ]uery|[aA]ction|internalMutation|internalQuery|internalAction)\(|(?:async )?function \w+)/gm;
  for (const m of src.matchAll(re)) starts.push(m.index!);
  return starts;
}

/** The enclosing top-level function's text for an offset. */
function enclosing(src: string, at: number): { name: string; body: string } {
  const starts = functionStarts(src);
  let start = 0;
  let next = src.length;
  for (const s of starts) {
    if (s <= at) start = s;
    else {
      next = s;
      break;
    }
  }
  const body = src.slice(start, next);
  const name = (/(?:const|function) (\w+)/.exec(body) ?? ["", "?"])[1];
  return { name, body };
}

describe("NEO-358: only cardTeamLinks.ts writes the card → team index", () => {
  test("no other module inserts into cardTeamLinks, and only sanctioned readers query it", () => {
    /*
     * Readers outside the module, and why each is allowed:
     *   - collectionCatalog.ts: the collector's "cards of this team / this
     *     franchise" search READS the index (and is pinned read-only below);
     *   - selectorOptions.ts: the E2E reset drain, `resetCardTeamLinksBatch`,
     *     exempt by NAME and POSITION.
     */
    const offenders: string[] = [];
    for (const file of sourceFiles(CONVEX_DIR)) {
      if (isFile(file, "cardTeamLinks.ts")) continue;
      const src = readFileSync(file, "utf8");
      if (/\.insert\(\s*"cardTeamLinks"/.test(src)) {
        offenders.push(`${file}: insert`);
        continue;
      }
      const queries = src.match(/query\(\s*"cardTeamLinks"/g) ?? [];
      if (queries.length === 0) continue;
      if (isFile(file, "collectionCatalog.ts")) continue;
      if (isFile(file, "selectorOptions.ts")) {
        const drain = src.indexOf("export const resetCardTeamLinksBatch");
        if (
          drain !== -1 &&
          queries.length === 1 &&
          src.indexOf('query("cardTeamLinks"') > drain
        ) {
          continue;
        }
      }
      offenders.push(`${file}: query`);
    }
    expect(offenders).toEqual([]);
  });

  test("collectionCatalog.ts only READS the index", () => {
    const src = read("collectionCatalog.ts");
    expect(src).not.toMatch(/insert\(\s*"cardTeamLinks"/);
    expect(src).not.toMatch(/syncCardTeamLinks|deleteCardTeamLinks/);
  });

  test("the module itself has one insert, inside syncCardTeamLinks", () => {
    const src = read("cardTeamLinks.ts");
    expect(src.match(/ctx\.db\.insert\("cardTeamLinks"/g) ?? []).toHaveLength(1);
    const writer = src.slice(
      src.indexOf("export async function syncCardTeamLinks"),
      src.indexOf("export async function deleteCardTeamLinks"),
    );
    expect(writer).toContain('ctx.db.insert("cardTeamLinks"');
  });
});

describe("NEO-358: every teamOnCardIds writer and every card delete reaches the helper", () => {
  test("every patch that writes teamOnCardIds is followed by syncCardTeamLinks in the same function", () => {
    // The structural rule: any `ctx.db.patch(...)` whose argument writes
    // `teamOnCardIds` (by key, `teamOnCardIds:`, or by a spread of a patch
    // built elsewhere in the function) sits in a function that also calls
    // `syncCardTeamLinks(` AFTER it. A new writer that forgets fails here.
    const writers: string[] = [];
    const offenders: string[] = [];
    for (const file of sourceFiles(CONVEX_DIR)) {
      const src = readFileSync(file, "utf8");
      for (const call of dbCalls(src, "patch")) {
        if (!/teamOnCardIds\b/.test(call.text)) continue;
        const fn = enclosing(src, call.at);
        writers.push(`${file.split("convex/").pop()}:${fn.name}`);
        const after = src.slice(call.at, src.indexOf(fn.body) + fn.body.length);
        if (!after.includes("syncCardTeamLinks(")) {
          offenders.push(`${file}:${fn.name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // The population this rule actually saw, so a silently-empty grep fails.
    // `updateCard` patches a filtered spread and the commit chunk a spread of
    // `contentPatch`; both are pinned by name below.
    expect(new Set(writers)).toEqual(
      new Set([
        "cardChecklist.ts:backfillTeamToOnCardIds",
        "cardChecklist.ts:applyBscTeamResolution",
        "selectorOptions.ts:cascadeSelectorOptionTeams",
        "selectorOptions.ts:commitCardChecklistChunk",
      ]),
    );
  });

  test("updateCard syncs the index after its patch, for a written teamOnCardIds", () => {
    const src = read("selectorOptions.ts");
    const start = src.indexOf("export const updateCard = mutation(");
    const body = src.slice(start, src.indexOf("\n});", start));
    const patch = body.indexOf("ctx.db.patch(id,");
    expect(patch).toBeGreaterThan(0);
    expect(body.slice(patch)).toMatch(
      /Array\.isArray\(filtered\.teamOnCardIds\)[\s\S]*syncCardTeamLinks\(/,
    );
  });

  test("the commit chunk's accepted change and operator fill both sync", () => {
    const src = read("selectorOptions.ts");
    const start = src.indexOf("export const commitCardChecklistChunk = internalMutation(");
    const body = src.slice(start, src.indexOf("\n});", start));
    const patch = body.indexOf("...contentPatch,");
    expect(patch).toBeGreaterThan(0);
    expect(body.slice(patch, patch + 4000)).toMatch(
      /const teamsWritten = operatorFill \?\? teamIdsWritten;[\s\S]*syncCardTeamLinks\(ctx, existing\._id, teamsWritten\)/,
    );
  });

  test("both card inserts sync the new card's rows", () => {
    // insertCardRow (commit chunk + parallel build).
    const create = read("cardRowCreate.ts");
    const fn = create.slice(create.indexOf("export async function insertCardRow"));
    const insertAt = fn.search(/ctx\.db\.insert\(\s*"cardChecklist"/);
    expect(insertAt).toBeGreaterThan(0);
    expect(fn.slice(insertAt)).toMatch(
      /syncCardTeamLinks\(ctx, id, card\.teamOnCardIds, \{ fresh: true \}\)/,
    );
    // addCustomCard.
    const src = read("selectorOptions.ts");
    const lines = src.split("\n");
    const site = lines.findIndex((line) => /ctx\.db\.insert\("cardChecklist"/.test(line));
    expect(site).toBeGreaterThan(0);
    expect(lines.slice(site, site + 120).join("\n")).toContain(
      "syncCardTeamLinks(ctx, id, teamOnCardIds, { fresh: true })",
    );
  });

  test("removeCardRow deletes the card's rows, and nothing else calls deleteCardTeamLinks", () => {
    const helper = read("cardRowDelete.ts");
    const fn = helper.slice(helper.indexOf("export async function removeCardRow"));
    const indexDelete = fn.indexOf("deleteCardTeamLinks(ctx, card._id)");
    expect(indexDelete).toBeGreaterThan(0);
    expect(fn.indexOf("ctx.db.delete(card._id)")).toBeGreaterThan(indexDelete);
    const callers = sourceFiles(CONVEX_DIR).filter(
      (file) =>
        !isFile(file, "cardTeamLinks.ts") &&
        !isFile(file, "cardRowDelete.ts") &&
        /deleteCardTeamLinks\(/.test(readFileSync(file, "utf8")),
    );
    expect(callers).toEqual([]);
  });
});
