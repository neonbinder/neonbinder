/**
 * NEO-408 — what the reference-seed loader (`scripts/reference-seed/cli.mjs`)
 * needs to know about its target, read from the deployment directly.
 *
 * Until now the loader took two full snapshot exports per load (one before
 * the import, for the eight tables' numbers and a few row counts; one after,
 * to verify the counts). A snapshot export is a Convex job outside our
 * functions, and on 2026-10-31 two fresh previews' first export never
 * returned while the deployment answered reads and writes in 100 ms
 * (NEO-392 log). These functions replace both exports:
 *
 * - `preflight`: each table's NUMBER (so the loader can re-encode the
 *   bundle's ids onto it) and whether it holds any row. A table the
 *   deployment does not have gets no number, and the loader refuses to go
 *   on without one.
 * - `tableStats`: per-table row counts, and how many rows name a sport id
 *   that is not a sport row, read a page at a time. The loader names the
 *   fields that hold sport ids (`sportIdFields`); each field's value is one
 *   id or an array of ids. The field names stay the loader's knowledge, so
 *   this module names no table's columns.
 *
 * All of them are internal: reachable only with the deployment's own deploy
 * credentials (`npx convex run` without `--identity`), never from a client.
 * They write nothing.
 */

import { v } from "convex/values";
import type { TableNames } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalAction, internalQuery } from "./_generated/server";
import { MAX_TABLE_NUMBER, findTableNumbers, tableNumberOf } from "./lib/convexIdCodec";

/** Rows per `tableStats` page: well under the 16 MiB read budget at ~1 KiB a row. */
export const STATS_PAGE = 4000;

const SPORT_TABLE = "selectorOptions";

/** Table numbers probed per `scanTableNumbers` call: one `normalizeId` syscall per number per pending table. */
export const SCAN_CHUNK = 4096;

export const emptiness = internalQuery({
  args: { tables: v.array(v.string()) },
  returns: v.object({
    nonEmpty: v.record(v.string(), v.boolean()),
    // Table numbers read off a first row, where there is one.
    known: v.record(v.string(), v.number()),
  }),
  handler: async (ctx, args) => {
    const nonEmpty: Record<string, boolean> = {};
    const known: Record<string, number> = {};
    for (const table of args.tables) {
      const first = await ctx.db.query(table as TableNames).first();
      nonEmpty[table] = first !== null;
      if (first) {
        const n = tableNumberOf(first._id);
        if (n !== null) known[table] = n;
      }
    }
    return { nonEmpty, known };
  },
});

export const scanTableNumbers = internalQuery({
  args: { tables: v.array(v.string()), from: v.number(), to: v.number() },
  returns: v.record(v.string(), v.number()),
  handler: async (ctx, args) => {
    const to = Math.min(args.to, args.from + SCAN_CHUNK);
    const found = findTableNumbers(
      args.tables,
      (table, id) => ctx.db.normalizeId(table as TableNames, id) !== null,
      new Map(),
      args.from,
      to,
    );
    return Object.fromEntries(found);
  },
});

type Preflight = { tableNumbers: Record<string, number>; nonEmpty: Record<string, boolean> };

export const preflight = internalAction({
  args: { tables: v.array(v.string()) },
  returns: v.object({
    tableNumbers: v.record(v.string(), v.number()),
    nonEmpty: v.record(v.string(), v.boolean()),
  }),
  handler: async (ctx, args): Promise<Preflight> => {
    const e: { nonEmpty: Record<string, boolean>; known: Record<string, number> } = await ctx.runQuery(
      internal.referenceSeed.emptiness,
      { tables: args.tables },
    );
    const tableNumbers: Record<string, number> = { ...e.known };
    let pending = args.tables.filter((t) => !(t in tableNumbers));
    for (let from = 1; from < MAX_TABLE_NUMBER && pending.length > 0; from += SCAN_CHUNK) {
      const found: Record<string, number> = await ctx.runQuery(internal.referenceSeed.scanTableNumbers, {
        tables: pending,
        from,
        to: Math.min(MAX_TABLE_NUMBER, from + SCAN_CHUNK),
      });
      Object.assign(tableNumbers, found);
      pending = pending.filter((t) => !(t in tableNumbers));
    }
    return { tableNumbers, nonEmpty: e.nonEmpty };
  },
});

export const sportIds = internalQuery({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query(SPORT_TABLE)
      .withIndex("by_level", (q) => q.eq("level", "sport"))
      .collect();
    return rows.map((r) => r._id as string);
  },
});

export const countPage = internalQuery({
  args: {
    table: v.string(),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
    sportIds: v.optional(v.array(v.string())),
    sportIdFields: v.optional(v.array(v.string())),
  },
  returns: v.object({
    count: v.number(),
    badSport: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const sports = args.sportIds ? new Set(args.sportIds) : null;
    // No catch: a read that fails must fail the caller, or a verify that
    // expects an empty table would pass on an error (audit, NEO-408).
    const page = await ctx.db.query(args.table as TableNames).paginate({ cursor: args.cursor, numItems: args.numItems });
    let badSport = 0;
    if (sports) {
      for (const row of page.page as Array<Record<string, unknown>>) {
        for (const field of args.sportIdFields ?? []) {
          const value = row[field];
          for (const s of Array.isArray(value) ? value : [value]) {
            if (typeof s === "string" && !sports.has(s)) badSport++;
          }
        }
      }
    }
    return { count: page.page.length, badSport, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

type TableStats = { sportRows: number; rows: Record<string, number>; badSport: Record<string, number> };
type CountPage = { count: number; badSport: number; isDone: boolean; continueCursor: string };

export const tableStats = internalAction({
  args: { tables: v.array(v.string()), checkSports: v.boolean(), sportIdFields: v.optional(v.array(v.string())) },
  returns: v.object({
    sportRows: v.number(),
    rows: v.record(v.string(), v.number()),
    badSport: v.record(v.string(), v.number()),
  }),
  // Explicit types: the action calls queries from its own module, and
  // without them TypeScript's inference of `internal` turns circular.
  handler: async (ctx, args): Promise<TableStats> => {
    const sports: string[] | null = args.checkSports ? await ctx.runQuery(internal.referenceSeed.sportIds, {}) : null;
    const rows: Record<string, number> = {};
    const badSport: Record<string, number> = {};
    for (const table of args.tables) {
      let count = 0;
      let bad = 0;
      let cursor: string | null = null;
      for (;;) {
        const page: CountPage = await ctx.runQuery(
          internal.referenceSeed.countPage,
          {
            table,
            cursor,
            numItems: STATS_PAGE,
            // The sport table's own rows are the sport ids; only its dependants are checked.
            sportIds: sports && table !== SPORT_TABLE ? sports : undefined,
            sportIdFields: args.sportIdFields,
          },
        );
        count += page.count;
        bad += page.badSport;
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
      rows[table] = count;
      badSport[table] = bad;
    }
    return { sportRows: sports?.length ?? 0, rows, badSport };
  },
});
