/**
 * NEO-339 — "N names to check" (NEO-211): the rename suggestions a column of
 * the Set Builder shows after Sync, listed and answered the way
 * `SelectorSyncReviewModal` does.
 *
 * Nothing is staged on the server: `selectorOptions.getSelectorSyncSuggestions
 * { level, parentId }` derives, for every row in one column, each side's
 * primary-slot label that differs from NB's name and was not declined. This
 * module reads that query for the columns a set (or brand-year) shows and
 * answers through `selectorOptions.applySelectorSyncSuggestions`, the
 * dialog's own mutation:
 *
 * - **accept** renames NB's row to the label THE SERVER reads off the row (the
 *   mutation takes no label at all). The answer still names the label it
 *   accepts, and the label is checked against a fresh read just before the
 *   write, so what the operator confirmed is what lands: a label that moved
 *   since the listing is refused, never accepted unseen.
 * - **decline** stores the label as declined; the suggestion stops.
 * - undecided: no entry, nothing written.
 *
 * `baseVersion` is re-read at fix time (the listing's would be stale after any
 * write in between), decisions are sent per column in chunks of
 * `MAX_SUGGESTION_DECISIONS`, and every outcome the server counts (applied,
 * declined, stale, clashed, skipped) is passed back. An answer for a row or
 * side the query no longer suggests is a reported no-op (`moot`), like a
 * review answer for a name the review no longer asks about.
 *
 * Rows are addressed by NB name, exactly-one per level (`resolveChild`); a
 * marketplace label is never a key.
 */

import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { NbClient } from "../client/convex-client";
import { formatPath, ResolveError, type BrandYearPath, type NodePath, type SetPath } from "../service";
import { childrenOf, resolveChild, resolveTypeRowRef, type ResolvedBrandYear, type ResolvedSet, type RowId, type SelectorLevel } from "../spec/resolve";
import { variantTypeKind } from "../../../convex/variantRole";
import { setBuilderUrlForPath } from "./set-builder-link";

/** The mutation's per-call cap (`MAX_SUGGESTION_DECISIONS` in convex/selectorOptions.ts). */
export const MAX_SUGGESTION_DECISIONS = 200;

export type SuggestionSide = "bsc" | "sportlots";
export type SuggestionAction = "accept" | "decline";

type SuggestionRows = FunctionReturnType<typeof api.selectorOptions.getSelectorSyncSuggestions>;
type SuggestionDecision = FunctionArgs<typeof api.selectorOptions.applySelectorSyncSuggestions>["decisions"][number];
export type SuggestionCounts = FunctionReturnType<typeof api.selectorOptions.applySelectorSyncSuggestions>;

/**
 * A row under the path, by NB names. `{}` (or omitted) is the path's own row:
 * the set on a set path, the manufacturer on a brand-year path. On a set path,
 * `{ type }` is a variant type row (Base included), `{ type, name }` a row
 * under it, `{ type, name, parallel }` a parallel under that row.
 */
export interface NameRowRef {
  type?: string;
  name?: string;
  parallel?: string;
}

/** One row whose marketplace names differ from NB's. */
export interface NameSuggestionItem {
  /** The path to answer it on (`nb_fix`'s `path`). On a brand-year listing, a set row carries its own set path. */
  path: NodePath;
  /** The row under `path`; `{}` = the path's own row. */
  row: NameRowRef;
  /** `formatPath(path)` plus the row's names, for a person. */
  where: string;
  level: SelectorLevel;
  /** NB's name today. */
  currentValue: string;
  /** NB `selectorOptions` id. */
  rowId: string;
  /** The Set Builder opened on the row's column. */
  link: string;
  /** What each marketplace calls it. `foldEqual`: differs only in case, punctuation or spacing. */
  sides: Array<{ side: SuggestionSide; label: string; foldEqual: boolean }>;
  answers: SuggestionAction[];
}

/** One answer: accept or decline one side's label on one row. */
export interface NameFixAnswer {
  row?: NameRowRef;
  side: SuggestionSide;
  action: SuggestionAction;
  /** The label as the listing showed it. Checked against a fresh read before anything is sent. */
  label: string;
}

export interface NameFixResult {
  /** `names[i]`. */
  at: string;
  outcome: "applied" | "moot" | "refused";
  detail: string;
}

export interface NameFixReport {
  /** The server's own counts, summed over every call. */
  counts: SuggestionCounts;
  results: NameFixResult[];
  /** applySelectorSyncSuggestions calls sent. */
  calls: number;
}

/** One column of the cascade: the rows at `level` under `parentId`, with how to name each. */
interface Column {
  level: SelectorLevel;
  parentId: RowId;
  /** Only this row of the column (a set path's own set row; a brand-year's own manufacturer row). */
  only?: RowId;
  /** The drill ids down to the column's parent (the link opens the column). */
  ids: readonly string[];
  /** Where an item of this column is answered, given its NB name. */
  address: (value: string) => { path: NodePath; row: NameRowRef };
}

const BRAND_FIELDS = (p: BrandYearPath): BrandYearPath => ({ sport: p.sport, year: p.year, manufacturer: p.manufacturer });

/** `Baseball/2024/Topps/Topps Chrome › Inserts › Future Stars`. */
export function describeNameRow(path: NodePath, row: NameRowRef): string {
  const tail = [row.type, row.name, row.parallel].filter((s): s is string => typeof s === "string" && s !== "");
  return [formatPath(path), ...tail].join(" › ");
}

function emptyCounts(): SuggestionCounts {
  return { applied: 0, declined: 0, stale: 0, clashed: 0, skipped: 0 };
}

async function suggestionsOf(client: NbClient, c: Pick<Column, "level" | "parentId">): Promise<SuggestionRows> {
  return client.query(api.selectorOptions.getSelectorSyncSuggestions, { level: c.level, parentId: c.parentId });
}

/**
 * Every column a set shows names in: the set's own row (in the brand's Sets
 * column), its variant types, each non-Base type's rows, and each row's
 * parallels. Reads one `getSelectorOptions` per variant type to find the rows.
 */
async function setColumns(client: NbClient, path: SetPath, set: ResolvedSet): Promise<Column[]> {
  const setIds = [set.sportId, set.yearId, set.manufacturerId];
  const typeIds = [...setIds, set.setId];
  const columns: Column[] = [
    { level: "setName", parentId: set.manufacturerId, only: set.setId, ids: setIds, address: () => ({ path, row: {} }) },
    { level: "variantType", parentId: set.setId, ids: typeIds, address: (type) => ({ path, row: { type } }) },
  ];
  const types = await childrenOf(client, "variantType", set.setId);
  for (const t of types) {
    if (variantTypeKind(t) === "base") continue;
    columns.push({
      level: "insert",
      parentId: t._id,
      ids: [...typeIds, t._id],
      address: (name) => ({ path, row: { type: t.value, name } }),
    });
    for (const r of await childrenOf(client, "insert", t._id)) {
      columns.push({
        level: "parallel",
        parentId: r._id,
        ids: [...typeIds, t._id, r._id],
        address: (parallel) => ({ path, row: { type: t.value, name: r.value, parallel } }),
      });
    }
  }
  return columns;
}

/** A brand-year's columns: the manufacturer's own row, and the brand's Sets (each answered on its set path). */
function brandYearColumns(path: BrandYearPath, brand: ResolvedBrandYear): Column[] {
  const brandPath = BRAND_FIELDS(path);
  return [
    {
      level: "manufacturer",
      parentId: brand.yearId,
      only: brand.manufacturerId,
      ids: [brand.sportId, brand.yearId],
      address: () => ({ path: brandPath, row: {} }),
    },
    {
      level: "setName",
      parentId: brand.manufacturerId,
      ids: [brand.sportId, brand.yearId, brand.manufacturerId],
      address: (set) => ({ path: { ...brandPath, set }, row: {} }),
    },
  ];
}

/**
 * Every "name to check" on a set (its own row and every row under it) or a
 * brand-year (the manufacturer's row and its sets). Read-only: queries only.
 */
export async function listNameSuggestions(
  client: NbClient,
  path: NodePath,
  resolved: ResolvedSet | ResolvedBrandYear,
): Promise<NameSuggestionItem[]> {
  const columns =
    "setId" in resolved && "set" in path
      ? await setColumns(client, path as SetPath, resolved)
      : brandYearColumns(path, resolved);
  const out: NameSuggestionItem[] = [];
  for (const c of columns) {
    for (const s of await suggestionsOf(client, c)) {
      if (c.only && s.existingId !== c.only) continue;
      const at = c.address(s.currentValue);
      out.push({
        path: at.path,
        row: at.row,
        where: describeNameRow(at.path, at.row),
        level: c.level,
        currentValue: s.currentValue,
        rowId: String(s.existingId),
        link: setBuilderUrlForPath([...c.ids, s.existingId], client.target.appOrigin),
        sides: s.suggestions.map((x) => ({ side: x.side, label: x.label, foldEqual: x.foldEqual })),
        answers: ["accept", "decline"],
      });
    }
  }
  return out;
}

/**
 * The column and row an answer addresses, exactly-one at every level. Throws
 * `ResolveError` (with candidates) for a name that is not exactly one row, and
 * for a row shape the path cannot hold.
 */
async function resolveNameRow(
  client: NbClient,
  path: NodePath,
  resolved: ResolvedSet | ResolvedBrandYear,
  ref: NameRowRef,
  at: string,
): Promise<{ level: SelectorLevel; parentId: RowId; rowId: RowId }> {
  const isSet = "setId" in resolved;
  const named = (s: string | undefined) => typeof s === "string" && s.trim() !== "";
  if (!named(ref.type) && !named(ref.name) && !named(ref.parallel)) {
    return isSet
      ? { level: "setName", parentId: resolved.manufacturerId, rowId: (resolved as ResolvedSet).setId }
      : { level: "manufacturer", parentId: resolved.yearId, rowId: resolved.manufacturerId };
  }
  if (!isSet) {
    throw new ResolveError({
      kind: "row",
      query: describeNameRow(path, ref),
      at,
      candidates: [],
      message: `${formatPath(path)} is a brand-year: a set's own name is answered on its set path, and rows under a set on that set's path.`,
    });
  }
  const set = resolved as ResolvedSet;
  if (!named(ref.type) || (named(ref.parallel) && !named(ref.name))) {
    throw new ResolveError({
      kind: "row",
      query: describeNameRow(path, ref),
      at,
      candidates: [],
      message: "A row is named by its variant type, then its row name, then its parallel: give type (and name before parallel).",
    });
  }
  const type = await resolveChild(client, "variantType", set.setId, ref.type!, `${at}.row.type`);
  if (!named(ref.name)) return { level: "variantType", parentId: set.setId, rowId: type._id };
  // The tool's one row resolution: top-level first, then a grouped row by its own name.
  const { row, parent } = await resolveTypeRowRef(
    client,
    type._id,
    { name: ref.name!, ...(named(ref.parallel) ? { parallel: ref.parallel! } : {}) },
    { name: `${at}.row.name`, parallel: `${at}.row.parallel` },
  );
  return parent ? { level: "parallel", parentId: parent._id, rowId: row._id } : { level: "insert", parentId: type._id, rowId: row._id };
}

const columnKey = (level: string, parentId: string) => `${level}\u0000${parentId}`;

/**
 * Resolve every answer before anything is written. A name that does not
 * resolve throws here, so a batch with one bad name writes nothing.
 */
export async function resolveNameAnswers(
  client: NbClient,
  path: NodePath,
  resolved: ResolvedSet | ResolvedBrandYear,
  answers: readonly NameFixAnswer[],
): Promise<Array<{ at: string; answer: NameFixAnswer; level: SelectorLevel; parentId: RowId; rowId: RowId }>> {
  const out = [];
  for (let i = 0; i < answers.length; i++) {
    const at = `names[${i}]`;
    const where = await resolveNameRow(client, path, resolved, answers[i].row ?? {}, at);
    out.push({ at, answer: answers[i], ...where });
  }
  return out;
}

/**
 * Answer name suggestions through `applySelectorSyncSuggestions`, per column,
 * with `baseVersion` read just before the write. Resolves every answer first
 * (`resolveNameAnswers`), so a bad name writes nothing.
 */
/**
 * A failure that is not a refusal part-way through the names' writes. Carries
 * every answer settled before it, and the ones whose save was sent but whose
 * outcome was not read back (`unconfirmed`: their `at`), so nothing written is
 * unreported.
 */
export class NameFixAborted extends Error {
  readonly results: NameFixResult[];
  readonly unconfirmed: string[];
  readonly cause: unknown;
  constructor(results: NameFixResult[], unconfirmed: string[], cause: unknown) {
    super(cause instanceof Error ? cause.message.split("\n")[0] : String(cause));
    this.name = "NameFixAborted";
    this.results = results;
    this.unconfirmed = unconfirmed;
    this.cause = cause;
  }
}

export async function applyNameAnswers(
  client: NbClient,
  path: NodePath,
  resolved: ResolvedSet | ResolvedBrandYear,
  answers: readonly NameFixAnswer[],
): Promise<NameFixReport> {
  const counts = emptyCounts();
  const results: NameFixResult[] = [];
  if (answers.length === 0) return { counts, results, calls: 0 };
  const targets = await resolveNameAnswers(client, path, resolved, answers);

  // An (row, side) answered more than once in one call is never settled by
  // order: every answer for it is refused.
  const perKey = new Map<string, number>();
  for (const t of targets) {
    const k = `${t.rowId}\u0000${t.answer.side}`;
    perKey.set(k, (perKey.get(k) ?? 0) + 1);
  }

  const byColumn = new Map<string, { level: SelectorLevel; parentId: RowId; items: typeof targets }>();
  for (const t of targets) {
    if ((perKey.get(`${t.rowId}\u0000${t.answer.side}`) ?? 0) > 1) {
      results.push({
        at: t.at,
        outcome: "refused",
        detail: `${describeNameRow(path, t.answer.row ?? {})}: the ${sideWord(t.answer.side)} name is answered more than once in this call. Answer it once.`,
      });
      continue;
    }
    const k = columnKey(t.level, t.parentId);
    const col = byColumn.get(k) ?? { level: t.level, parentId: t.parentId, items: [] };
    col.items.push(t);
    byColumn.set(k, col);
  }

  let calls = 0;
  /** Sent in a save whose outcome has not been read back yet. */
  let inFlight: string[] = [];
  try {
    for (const col of byColumn.values()) {
      const fresh = await suggestionsOf(client, col);
      const byRow = new Map(fresh.map((s) => [String(s.existingId), s]));
      const sending: Array<{ t: (typeof targets)[number]; decision: SuggestionDecision }> = [];
      for (const t of col.items) {
        const label = describeNameRow(path, t.answer.row ?? {});
        const row = byRow.get(String(t.rowId));
        const s = row?.suggestions.find((x) => x.side === t.answer.side);
        if (!row || !s) {
          results.push({
            at: t.at,
            outcome: "moot",
            detail: `${label}: nothing to check on the ${sideWord(t.answer.side)} side any more (the names agree, or it was already answered).`,
          });
          continue;
        }
        if (s.label !== t.answer.label) {
          results.push({
            at: t.at,
            outcome: "refused",
            detail: `${label}: the ${sideWord(t.answer.side)} name is now “${s.label}”, not “${t.answer.label}”. List again and answer the name it shows now.`,
          });
          continue;
        }
        sending.push({
          t,
          decision: { existingId: row.existingId, baseVersion: row.baseVersion, side: t.answer.side, action: t.answer.action },
        });
      }

      for (let i = 0; i < sending.length; i += MAX_SUGGESTION_DECISIONS) {
        const chunk = sending.slice(i, i + MAX_SUGGESTION_DECISIONS);
        inFlight = sending.slice(0, i + chunk.length).map((c) => c.t.at);
        const r = await client.mutation(api.selectorOptions.applySelectorSyncSuggestions, {
          level: col.level,
          parentId: col.parentId,
          decisions: chunk.map((c) => c.decision),
        });
        calls++;
        for (const k of Object.keys(counts) as Array<keyof SuggestionCounts>) counts[k] += r[k] ?? 0;
      }
      if (sending.length === 0) continue;

      // The mutation returns counts, not per-decision outcomes: read the column
      // again and see which suggestions are gone. A suggestion that is still
      // offered was not saved (stale, a name clash, or refused).
      const after = new Map((await suggestionsOf(client, col)).map((s) => [String(s.existingId), s]));
      for (const { t } of sending) {
        const label = describeNameRow(path, t.answer.row ?? {});
        const still = after.get(String(t.rowId))?.suggestions.some((x) => x.side === t.answer.side && x.label === t.answer.label);
        results.push(
          still
            ? {
                at: t.at,
                outcome: "refused",
                detail: `${label}: not saved. The row changed while this ran, or “${t.answer.label}” is already another row's name here. List again.`,
              }
            : {
                at: t.at,
                outcome: "applied",
                detail:
                  t.answer.action === "accept"
                    ? `${label}: renamed to “${t.answer.label}”.`
                    : `${label}: kept NB's name; the ${sideWord(t.answer.side)} name “${t.answer.label}” will not be suggested again.`,
              },
        );
      }
      inFlight = [];
    }
  } catch (err) {
    const order = new Map(targets.map((t, i) => [t.at, i]));
    results.sort((a, b) => (order.get(a.at) ?? 0) - (order.get(b.at) ?? 0));
    throw new NameFixAborted(results, inFlight, err);
  }

  const order = new Map(targets.map((t, i) => [t.at, i]));
  results.sort((a, b) => (order.get(a.at) ?? 0) - (order.get(b.at) ?? 0));
  return { counts, results, calls };
}

/** The side as the review dialog names it. */
function sideWord(side: SuggestionSide): string {
  return side === "bsc" ? "BSC" : "SportLots";
}
