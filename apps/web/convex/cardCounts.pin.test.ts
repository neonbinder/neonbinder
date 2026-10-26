/**
 * NEO-358 — every card insert, delete and move, and every write of a card's
 * variation parent, keeps `selectorOptions.cardCount` and
 * `nonVariationCardCount` through a `CardCountLedger` that is flushed.
 *
 * A stored count is a second copy of a fact the checklist already holds, so it
 * drifts the moment one writer forgets it. The ledger's own arithmetic is
 * tested in `cardCounts.test.ts`; this greps for the writer that forgot:
 *
 *  - the two card inserts (`insertCardRow`, `addCustomCard`) add to a ledger;
 *  - the one card delete (`removeCardRow`) removes from one;
 *  - the one card move (`moveCards`) moves the counts with the cards;
 *  - every `variationOfCardId` patch records the change;
 *  - and every function that does any of these either FLUSHES its ledger or
 *    takes one as a parameter (a helper whose caller flushes);
 *  - the subtree counts (Jason, 2026-10-24): the card delete remembers its
 *    row's chain before the row can go, every selector-row RE-PARENT moves
 *    the row's subtree count through a flushed ledger, and every selector-row
 *    INSERT is born with `newRowSubtreeCounts(<its own level>)` (NEO-364:
 *    zeroed counts from the set down, nothing on a sport, year or brand).
 *
 * The one exemption is the E2E reset drain (`resetCardChecklistBatch`), which
 * drains the selector rows the counts live on too.
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
const rel = (file: string) => file.split(`convex${"/"}`).pop()!;

/** Every `ctx.db.<method>(...)` call in `src`, matched to its closing paren. */
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
  const re = /^(?:export )?(?:const \w+ = (?:mutation|query|action|internalMutation|internalQuery|internalAction)\(|(?:async )?function \w+)/gm;
  return [...src.matchAll(re)].map((m) => m.index!);
}

function enclosing(src: string, at: number): { name: string; body: string } {
  let start = 0;
  let next = src.length;
  for (const s of functionStarts(src)) {
    if (s <= at) start = s;
    else {
      next = s;
      break;
    }
  }
  const body = src.slice(start, next);
  return { name: (/(?:const|function) (\w+)/.exec(body) ?? ["", "?"])[1], body };
}

/** Flushes a ledger, or takes one from a caller that does. */
const keepsLedger = (body: string) =>
  /\.flush\(ctx\)/.test(body) || /ledger: CardCountLedger/.test(body);

describe("NEO-358: card inserts, deletes and moves keep the counts", () => {
  test("insertCardRow REQUIRES a ledger and adds the card it inserts", () => {
    const src = read("cardRowCreate.ts");
    const fn = src.slice(src.indexOf("export async function insertCardRow"));
    const signature = fn.slice(0, fn.indexOf("): Promise<"));
    expect(signature).toMatch(/ledger: CardCountLedger,/);
    expect(signature).not.toMatch(/ledger\?:/);
    const insertAt = fn.search(/ctx\.db\.insert\("cardChecklist"/);
    expect(insertAt).toBeGreaterThan(0);
    expect(fn.slice(insertAt)).toContain("ledger.addCard(row)");
  });

  test("addCustomCard adds its card and flushes", () => {
    const src = read("selectorOptions.ts");
    const lines = src.split("\n");
    const site = lines.findIndex((line) => /ctx\.db\.insert\("cardChecklist"/.test(line));
    expect(site).toBeGreaterThan(0);
    const window = lines.slice(site, site + 120).join("\n");
    expect(window).toContain("ledger.addCard({ selectorOptionId: args.selectorOptionId })");
    expect(window).toContain("await ledger.flush(ctx)");
  });

  test("removeCardRow removes the card from its row's counts, and takes the ledger it must", () => {
    const src = read("cardRowDelete.ts");
    const fn = src.slice(src.indexOf("export async function removeCardRow"));
    expect(fn).toMatch(/ledger: CardCountLedger,\n\): Promise<RemovedCardRow>/);
    expect(fn).toContain("ledger.removeCard(card)");
    // NEO-358 — the row's chain is learned while it exists, so a caller that
    // ends the emptied row before flushing still moves the counts above it.
    expect(fn).toContain("await ledger.rememberChain(ctx, card.selectorOptionId)");
    // Promoting a deleted parent's variations moves the base count too.
    expect(fn).toContain("orphanVariationsOf(ctx, card._id, ledger)");
  });

  test("moveCards moves the counts with the cards and flushes", () => {
    const src = read("setShapeMove.ts");
    const fn = enclosing(src, src.indexOf("export async function moveCards")).body;
    expect(fn).toContain("countLedger.removeCard(card)");
    expect(fn).toContain("countLedger.addCard({");
    expect(fn).toContain("await countLedger.flush(ctx)");
  });

  test("every function that inserts or deletes a card keeps a ledger", () => {
    // `moveCards` keeps (and flushes) its own, pinned above, so its callers
    // need none.
    const offenders: string[] = [];
    const seen: string[] = [];
    for (const file of sourceFiles(CONVEX_DIR)) {
      const src = readFileSync(file, "utf8");
      for (const call of ["insertCardRow(", "removeCardRow("]) {
        for (let at = src.indexOf(call); at !== -1; at = src.indexOf(call, at + 1)) {
          // Skip the declaration itself and imports/comments mentioning it.
          const lineStart = src.lastIndexOf("\n", at) + 1;
          const line = src.slice(lineStart, src.indexOf("\n", at));
          if (!/await /.test(line)) continue;
          const fn = enclosing(src, at);
          seen.push(`${rel(file)}:${fn.name}`);
          if (!keepsLedger(fn.body)) offenders.push(`${rel(file)}:${fn.name}`);
        }
      }
      // Every card insert outside the two pinned above.
      for (const ins of dbCalls(src, "insert")) {
        if (!/^ctx\.db\.insert\(\s*"cardChecklist"/.test(ins.text)) continue;
        const fn = enclosing(src, ins.at);
        seen.push(`${rel(file)}:${fn.name}`);
        if (!keepsLedger(fn.body) && !/ledger\.addCard/.test(fn.body)) {
          offenders.push(`${rel(file)}:${fn.name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // The population this rule saw, so a silently-empty grep fails.
    expect(new Set(seen)).toEqual(
      new Set([
        "cardRowCreate.ts:insertCardRow",
        "selectorOptions.ts:addCustomCard",
        "selectorOptions.ts:deleteCard",
        "selectorOptions.ts:commitCardChecklistChunk",
        "selectorOptions.ts:commitCardChecklistFinalize",
        "parallelChecklistBuild.ts:deleteParallelCardsPage",
        "parallelChecklistBuild.ts:insertParallelCardsPage",
        "wipeVariantTypeSubtree.ts:wipeCardsPage",
      ]),
    );
  });

  test("every patch of variationOfCardId records the change and keeps a ledger", () => {
    // Jason, 2026-10-23: the base count moves whenever a card gains or loses
    // its variation parent, even when no card is inserted or deleted.
    const offenders: string[] = [];
    const seen: string[] = [];
    for (const file of sourceFiles(CONVEX_DIR)) {
      const src = readFileSync(file, "utf8");
      for (const call of dbCalls(src, "patch")) {
        if (!/variationOfCardId\b/.test(call.text)) continue;
        const fn = enclosing(src, call.at);
        seen.push(`${rel(file)}:${fn.name}`);
        const after = src.slice(call.at, call.at + call.text.length + 600);
        if (!/variationChanged\(/.test(after) || !keepsLedger(fn.body)) {
          offenders.push(`${rel(file)}:${fn.name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(new Set(seen)).toEqual(
      new Set([
        "cardRowDelete.ts:orphanVariationsOf",
        "selectorOptions.ts:setCardVariationParent",
        "selectorOptions.ts:commitCardChecklistFinalize",
      ]),
    );
  });

  test("a born-variation card is counted as one: insertCardRow counts the row it wrote", () => {
    // The parallel build carries `variationOfCardId` onto a copy through
    // `carried`; `addCard(row)` reads the inserted row, not the input card.
    const src = read("cardRowCreate.ts");
    expect(src).toContain("ledger.addCard(row)");
    expect(src).toMatch(/const row = \{\s*\.\.\.built\.row,/);
  });

  test("every selector-row re-parent moves its subtree count and flushes", () => {
    // A row moved under a new parent takes every card beneath it along: the
    // old ancestors lose them, the new ones gain them. A `parentId` written
    // without `moveSubtree` leaves both chains wrong.
    const offenders: string[] = [];
    const seen: string[] = [];
    for (const file of sourceFiles(CONVEX_DIR)) {
      const src = readFileSync(file, "utf8");
      for (const call of dbCalls(src, "patch")) {
        // The key `parentId:`, not a value named `parentId`.
        if (!/[{,]\s*parentId\s*:/.test(call.text)) continue;
        const fn = enclosing(src, call.at);
        seen.push(`${rel(file)}:${fn.name}`);
        const after = src.slice(call.at, call.at + call.text.length + 400);
        if (!/\.moveSubtree\(ctx, /.test(after) || !/\.flush\(ctx\)/.test(fn.body)) {
          offenders.push(`${rel(file)}:${fn.name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(new Set(seen)).toEqual(
      new Set([
        "brandRehome.ts:rehomeSetRowsToBrand",
        "selectorOptions.ts:applyParallelGroupings",
      ]),
    );
    expect(seen.length).toBe(4);
  });

  test("every selector-row insert is born with its level's subtree counts", () => {
    // A row from the set down born without them reads as UNKNOWN, so it is
    // never hidden however empty it is, until the backfill reaches it. A
    // sport, year or brand is born with none (NEO-364): the helper decides by
    // level, so the argument must be the row's own level.
    const offenders: string[] = [];
    const seen: string[] = [];
    for (const file of sourceFiles(CONVEX_DIR)) {
      const src = readFileSync(file, "utf8");
      for (const ins of dbCalls(src, "insert")) {
        if (!/^ctx\.db\.insert\(\s*"selectorOptions"/.test(ins.text)) continue;
        const fn = enclosing(src, ins.at);
        seen.push(`${rel(file)}:${fn.name}`);
        const born =
          /^ctx\.db\.insert\(\s*"selectorOptions",\s*\{\s*\.\.\.newRowSubtreeCounts\(([^)]*)\),\s*level(?::\s*([^,]+))?,/.exec(
            ins.text,
          );
        // `level` shorthand passes `level`; `level: "x"` passes `"x"`.
        if (!born || born[1].trim() !== (born[2]?.trim() ?? "level")) {
          offenders.push(`${rel(file)}:${fn.name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // The population this rule saw, so a silently-empty grep fails.
    expect(seen.length).toBe(10);
  });

  test("the reset drain is the only card delete outside removeCardRow", () => {
    const src = read("selectorOptions.ts");
    const drain = src.indexOf("export const resetCardChecklistBatch");
    expect(drain).toBeGreaterThan(0);
    // No card-named delete anywhere but the helper (the drain deletes `row`).
    const named: string[] = [];
    for (const file of sourceFiles(CONVEX_DIR)) {
      for (const m of readFileSync(file, "utf8").matchAll(/db\.delete\(([^)]*)\)/g)) {
        if (/card/i.test(m[1])) named.push(`${rel(file)}: ${m[0]}`);
      }
    }
    expect(named).toEqual(["cardRowDelete.ts: db.delete(card._id)"]);
  });
});
