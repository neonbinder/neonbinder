/**
 * NEO-339 — resolve a spec's names to NB `selectorOptions` rows.
 *
 * A name resolves only to EXACTLY ONE row; anything else is a `ResolveError`
 * carrying every candidate, and the caller names one and runs again. Nothing is
 * picked by position (plan §4 "Runner rules").
 *
 * The fold is the store's own: `selectorValueKey` (lower-case + trim) is what
 * both stores and `addCustomSelectorOption` key a sibling's name on, so a name
 * this module calls equal is a name the server would call equal. When the fold
 * finds several rows (NEO-325 lets two siblings share a name), an exact string
 * match among them is still only an answer when it is the only one.
 *
 * Read-only: every call here is a public admin QUERY.
 */

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { selectorValueKey } from "../../../convex/selectorSyncMatch";
import type { NbClient } from "../client/convex-client";
import { ResolveError, type ResolveCandidate } from "../service";
import type { BrandYearPath, SetPath } from "./schema";

export { ResolveError } from "../service";
export type { ResolveCandidate } from "../service";

export type RowId = Id<"selectorOptions">;
export type SelectorRow = FunctionReturnType<typeof api.selectorOptions.getSelectorOptions>[number];
export type SelectorLevel = SelectorRow["level"];

/** How many candidates a "no match" error lists (near names only). */
export const MAX_NEAR_CANDIDATES = 25;

function candidateOf(row: { _id: string; value: string }, detail?: string): ResolveCandidate {
  return { id: String(row._id), name: row.value, ...(detail ? { detail } : {}) };
}

/**
 * The one row named `name` among `rows`, or a `ResolveError`. Pure.
 *
 * Zero matches lists the near names (a sibling whose folded name contains the
 * query, or the other way round), capped, so a typo is easy to fix without
 * dumping a whole column.
 */
export function pickExactlyOne<T extends { _id: string; value: string }>(
  rows: readonly T[],
  name: string,
  kind: string,
  at?: string,
  detailOf?: (row: T) => string | undefined,
): T {
  const key = selectorValueKey(name);
  const folded = rows.filter((r) => selectorValueKey(r.value) === key);
  if (folded.length === 1) return folded[0];
  if (folded.length > 1) {
    const exact = folded.filter((r) => r.value === name.trim());
    if (exact.length === 1) return exact[0];
    throw new ResolveError({
      kind,
      query: name,
      at,
      candidates: folded.map((r) => candidateOf(r, detailOf?.(r))),
    });
  }
  const near = key
    ? rows
        .filter((r) => {
          const k = selectorValueKey(r.value);
          return k.includes(key) || key.includes(k);
        })
        .slice(0, MAX_NEAR_CANDIDATES)
    : [];
  // Near names are suggestions, not matches: the message says nothing matched.
  throw new ResolveError({
    kind,
    query: name,
    at,
    candidates: near.map((r) => candidateOf(r, detailOf?.(r))),
    message: near.length === 0 ? undefined : noMatchMessage(kind, name, near.length),
  });
}

/** "No row named "X"; 1 similar name is listed as a candidate." */
export function noMatchMessage(kind: string, name: string, near: number): string {
  return near === 1
    ? `No ${kind} named "${name}"; 1 similar name is listed as a candidate.`
    : `No ${kind} named "${name}"; ${near} similar names are listed as candidates.`;
}

/** The children of `parentId` at `level` (the root level when no parent). */
export async function childrenOf(
  client: NbClient,
  level: SelectorLevel,
  parentId: RowId | undefined,
): Promise<SelectorRow[]> {
  return client.query(api.selectorOptions.getSelectorOptions, {
    level,
    ...(parentId ? { parentId } : {}),
  });
}

/** The one child of `parentId` at `level` named `name`. */
export async function resolveChild(
  client: NbClient,
  level: SelectorLevel,
  parentId: RowId | undefined,
  name: string,
  at?: string,
): Promise<SelectorRow> {
  const rows = await childrenOf(client, level, parentId);
  return pickExactlyOne(rows, name, LEVEL_KIND[level] ?? level, at);
}

/** The noun a `ResolveError` uses for a level. */
export const LEVEL_KIND: Partial<Record<SelectorLevel, string>> = {
  sport: "sport",
  year: "year",
  manufacturer: "manufacturer",
  setName: "set",
  variantType: "variant type",
  insert: "row",
  parallel: "parallel",
};

export interface ResolvedBrandYear {
  sportId: RowId;
  yearId: RowId;
  manufacturerId: RowId;
  rows: { sport: SelectorRow; year: SelectorRow; manufacturer: SelectorRow };
}

export interface ResolvedSet extends ResolvedBrandYear {
  setId: RowId;
  rows: ResolvedBrandYear["rows"] & { set: SelectorRow };
}

/** `steps[3].path` → `steps[3].path.sport`, or the bare field name. */
function at(base: string | undefined, field: string): string {
  return base ? `${base}.${field}` : field;
}

/** Resolve Sport › Year › Manufacturer, exactly-one at each level. */
export async function resolveBrandYear(
  client: NbClient,
  path: BrandYearPath,
  where?: string,
): Promise<ResolvedBrandYear> {
  const sport = await resolveChild(client, "sport", undefined, path.sport, at(where, "sport"));
  const year = await resolveChild(client, "year", sport._id, path.year, at(where, "year"));
  const manufacturer = await resolveChild(
    client,
    "manufacturer",
    year._id,
    path.manufacturer,
    at(where, "manufacturer"),
  );
  return {
    sportId: sport._id,
    yearId: year._id,
    manufacturerId: manufacturer._id,
    rows: { sport, year, manufacturer },
  };
}

/** Resolve Sport › Year › Manufacturer › Set, exactly-one at each level. */
export async function resolveSetPath(
  client: NbClient,
  path: SetPath,
  where?: string,
): Promise<ResolvedSet> {
  const brand = await resolveBrandYear(client, path, where);
  const set = await resolveChild(client, "setName", brand.manufacturerId, path.set, at(where, "set"));
  return { ...brand, setId: set._id, rows: { ...brand.rows, set } };
}

/** The set's variant type titled `title` (Base included), exactly-one. */
export async function resolveVariantType(
  client: NbClient,
  setId: RowId,
  title: string,
  where?: string,
): Promise<SelectorRow> {
  return resolveChild(client, "variantType", setId, title, where);
}

/**
 * A row under a variant type, exactly-one, by its own name. A top-level row
 * (`insert` level) answers first, exactly as before. Only when no top-level
 * row carries the name are the rows Group Parallels moved under an insert
 * read (`parallel` level, from the type's insert tree): a grouped row keeps
 * its own name, so "Future Stars Autographs" grouped under "Future Stars"
 * still resolves to itself, never to the parent its name begins with. Two
 * grouped rows with the name are a `ResolveError` naming each one's parent.
 */
export async function resolveVariantRow(
  client: NbClient,
  variantTypeId: RowId,
  name: string,
  where?: string,
): Promise<SelectorRow> {
  const inserts = await childrenOf(client, "insert", variantTypeId);
  const key = selectorValueKey(name);
  if (inserts.some((r) => selectorValueKey(r.value) === key)) return pickExactlyOne(inserts, name, "row", where);
  const tree = await client.query(api.selectorOptions.getInsertTreeByVariantType, { variantTypeId });
  const parentName = new Map<string, string>();
  const rows: SelectorRow[] = [...inserts];
  for (const node of tree) {
    for (const p of node.parallels) {
      rows.push(p as SelectorRow);
      parentName.set(String(p._id), node.insert.value);
    }
  }
  return pickExactlyOne(rows, name, "row", where, (r) => {
    const parent = parentName.get(String(r._id));
    return parent ? `parallel of ${parent}` : "insert";
  });
}

/**
 * Resolve a path without throwing on the FIRST missing level: how far it gets
 * and why it stopped. For `plan`, which reports rather than stops.
 */
export async function tryResolveSetPath(
  client: NbClient,
  path: SetPath,
  where?: string,
): Promise<{ ok: true; value: ResolvedSet } | { ok: false; error: ResolveError }> {
  try {
    return { ok: true, value: await resolveSetPath(client, path, where) };
  } catch (err) {
    if (err instanceof ResolveError) return { ok: false, error: err };
    throw err;
  }
}
