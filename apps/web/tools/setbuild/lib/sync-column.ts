/**
 * NEO-339 — populate a Set Builder column the way the UI does, and the paused
 * marketplace check every step leans on.
 *
 * The UI's columns (`EntityColumn` on the `useEnsureSync` path) do exactly
 * this: on an EMPTY column call `selectorOptions.ensureSelectorOptions` for
 * (level, parent) and watch `selectorOptions.getSelectorSyncStatus` for the
 * outcome. `ensureColumn` makes the same two calls, after a read that skips a
 * populated column without asking the server (the action would skip it too:
 * `already_populated`). The Sets column's cold sync is the same call at
 * `level: "setName"` under the brand (`syncBrandSets`); "+ Custom" is
 * `selectorOptions.addCustomSelectorOption` (`addRow`).
 *
 * ## Paused marketplaces (plan §2.7)
 *
 * The spec runner is TOLD which marketplaces are paused (`PAUSED_PLATFORMS`,
 * mirrored from the same repo variable CI writes onto the preview), and it
 * never guesses. `checkPausedPlatforms` compares that declaration with what
 * the deployment itself reports (`marketplacePause.getPausedPlatforms`) and
 * throws `PausedMismatch` when they disagree; `ensureColumn` throws it too if a
 * sync reports a paused side the declaration did not name. Either way the run
 * stops before it builds a fixture for the wrong world.
 */

import { ConvexError } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import { KNOWN_SITES, SITE_TO_SIDE, type KnownSite } from "../../../convex/lib/marketplacePause";
import type { PlatformSide } from "../../../convex/platformSlots";
import { selectorValueKey } from "../../../convex/selectorSyncMatch";
import type { NbClient } from "../client/convex-client";
import {
  childrenOf,
  pickExactlyOne,
  resolveChild,
  ResolveError,
  type ResolvedBrandYear,
  type ResolvedSet,
  type RowId,
  type SelectorLevel,
  type SelectorRow,
} from "../spec/resolve";
import type { BrandYearPath, ManufacturerPolicy, SetPath } from "../spec/schema";

// ---------------------------------------------------------------------------
// Paused platforms
// ---------------------------------------------------------------------------

/** What the run believes is paused, agreed with the deployment. */
export interface PausedContext {
  /** Paused credential site keys (`sportlots`, `buysportscards`). */
  sites: ReadonlySet<KnownSite>;
  /** The same, as platform-slot sides (`sportlots`, `bsc`). */
  sides: ReadonlySet<PlatformSide>;
}

export const NOTHING_PAUSED: PausedContext = { sites: new Set(), sides: new Set() };

/** The declared pause and the deployment's disagree. Nothing was written. */
export class PausedMismatch extends Error {
  readonly declared: string[];
  readonly server: string[];
  constructor(declared: Iterable<string>, server: Iterable<string>, where?: string) {
    const d = [...declared].sort();
    const s = [...server].sort();
    super(
      `PAUSED_PLATFORMS says [${d.join(", ") || "none"}] but the deployment ` +
        `${where ? `${where} ` : ""}reports [${s.join(", ") || "none"}] paused. ` +
        `Mirror NEONBINDER_PAUSED_PLATFORMS onto this deployment (or fix the declaration) and run again.`,
    );
    this.name = "PausedMismatch";
    this.declared = d;
    this.server = s;
  }
}

/**
 * Parse a declared `PAUSED_PLATFORMS` value. Strict, unlike the server's
 * forgiving parse: an unknown key here is a typo in a fixture's world, and
 * the run must not start on it.
 */
export function parseDeclaredPaused(raw: string | undefined): PausedContext {
  const sites = new Set<KnownSite>();
  for (const entry of (raw ?? "").split(",")) {
    const key = entry.trim().toLowerCase();
    if (!key) continue;
    if (!(KNOWN_SITES as readonly string[]).includes(key)) {
      throw new Error(
        `PAUSED_PLATFORMS names an unknown platform "${key}". Known: ${KNOWN_SITES.join(", ")}.`,
      );
    }
    sites.add(key as KnownSite);
  }
  return pausedContextOf(sites);
}

export function pausedContextOf(sites: Iterable<KnownSite>): PausedContext {
  const s = new Set(sites);
  return { sites: s, sides: new Set([...s].map((site) => SITE_TO_SIDE[site])) };
}

/**
 * Read the deployment's pause and require it to equal the declaration.
 * `declared` is the raw `PAUSED_PLATFORMS` value; unset means "nothing paused".
 */
export async function checkPausedPlatforms(
  client: NbClient,
  declared: string | undefined,
): Promise<PausedContext> {
  const expected = parseDeclaredPaused(declared);
  const server = await client.query(api.marketplacePause.getPausedPlatforms, {});
  const serverSet = new Set(server.map((s) => s.trim().toLowerCase()));
  const same =
    serverSet.size === expected.sites.size && [...expected.sites].every((s) => serverSet.has(s));
  if (!same) throw new PausedMismatch(expected.sites, serverSet);
  return expected;
}

/** Throw unless every side a server result reports paused was declared paused. */
export function assertPausedSidesDeclared(
  reported: readonly PlatformSide[] | undefined,
  paused: PausedContext,
  where: string,
): void {
  const undeclared = (reported ?? []).filter((side) => !paused.sides.has(side));
  if (undeclared.length > 0) {
    throw new PausedMismatch(paused.sides, new Set([...paused.sides, ...undeclared]), where);
  }
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** `getSelectorSyncStatus`' row: null = idle (clear). */
export type SyncStatus = FunctionReturnType<typeof api.selectorOptions.getSelectorSyncStatus>;

/** A column sync that ended in `error`. `message` is the server's user-safe text. */
export class ColumnSyncError extends Error {
  readonly level: SelectorLevel;
  readonly parentId: RowId | undefined;
  constructor(level: SelectorLevel, parentId: RowId | undefined, message: string | undefined) {
    super(
      `Syncing the ${level} column${parentId ? ` under ${parentId}` : ""} failed` +
        (message ? `: ${message}` : "."),
    );
    this.name = "ColumnSyncError";
    this.level = level;
    this.parentId = parentId;
  }
}

export interface ColumnResult {
  level: SelectorLevel;
  parentId: RowId | undefined;
  /**
   * `skipped` — the column already had rows, nothing was asked;
   * `synced` — the sync ran and finished (`notice` says what it left, if anything);
   * `not-run` — the server ran nothing (`reason`: no_marketplace_ids, paused, no_variant_role).
   */
  outcome: "skipped" | "synced" | "not-run";
  /** The server's `reason` (`already_populated`, `synced`, `paused`, …). */
  reason: string;
  rows: SelectorRow[];
  /** The status row's `done` notice, when the sync left one. */
  notice?: string;
  skippedSides: PlatformSide[];
  pausedSides: PlatformSide[];
}

export interface EnsureColumnOptions {
  /** A forced re-sync (the column's "Sync <X>" button). Default false. */
  force?: boolean;
  /** When given, a sync reporting an undeclared paused side throws `PausedMismatch`. */
  paused?: PausedContext;
  /** How long to wait for the status row to leave `syncing` after the action returns. */
  statusTimeoutMs?: number;
}

/** Default wait for the status row once the (awaited) action has returned. */
export const STATUS_SETTLE_TIMEOUT_MS = 120_000;

/**
 * Populate (level, parent) the way an empty column does. Idempotent: a
 * populated column is read and skipped without a server-side sync.
 */
export async function ensureColumn(
  client: NbClient,
  level: SelectorLevel,
  parentId: RowId | undefined,
  opts: EnsureColumnOptions = {},
): Promise<ColumnResult> {
  if (!opts.force) {
    const rows = await childrenOf(client, level, parentId);
    if (rows.length > 0) {
      return {
        level,
        parentId,
        outcome: "skipped",
        reason: "already_populated",
        rows,
        skippedSides: [],
        pausedSides: [],
      };
    }
  }

  const res = await client.action(api.selectorOptions.ensureSelectorOptions, {
    level,
    ...(parentId ? { parentId } : {}),
    ...(opts.force ? { force: true } : {}),
  });
  if (opts.paused) {
    assertPausedSidesDeclared(res.pausedSides, opts.paused, `(${level} sync)`);
  }

  // The action awaits its own sync and settles the status row before it
  // returns; the wait covers a concurrent session's sync of the same column
  // (a root level's status row is shared by every session).
  const status = await client.waitFor(
    api.selectorOptions.getSelectorSyncStatus,
    { level, ...(parentId ? { parentId } : {}) },
    (s) => s === null || s.status !== "syncing",
    {
      timeoutMs: opts.statusTimeoutMs ?? STATUS_SETTLE_TIMEOUT_MS,
      label: `the ${level} column's sync status`,
    },
  );
  if (res.reason === "error" || status?.status === "error") {
    throw new ColumnSyncError(level, parentId, status?.message);
  }

  const rows = await childrenOf(client, level, parentId);
  return {
    level,
    parentId,
    outcome: res.ran ? "synced" : res.reason === "already_populated" ? "skipped" : "not-run",
    reason: res.reason,
    rows,
    ...(status?.status === "done" && status.message ? { notice: status.message } : {}),
    skippedSides: res.skippedSides,
    pausedSides: res.pausedSides,
  };
}

/** The Sets column's cold sync for one brand (Sync Sets). */
export async function syncBrandSets(
  client: NbClient,
  manufacturerId: RowId,
  opts: EnsureColumnOptions = {},
): Promise<ColumnResult> {
  return ensureColumn(client, "setName", manufacturerId, opts);
}

/** The set's Sync Variant Types. */
export async function syncVariantTypes(
  client: NbClient,
  setId: RowId,
  opts: EnsureColumnOptions = {},
): Promise<ColumnResult> {
  return ensureColumn(client, "variantType", setId, opts);
}

// ---------------------------------------------------------------------------
// + Custom
// ---------------------------------------------------------------------------

/** `addCustomSelectorOption` refused the value (invalid, shared, or exists elsewhere). */
export class AddRowRefused extends Error {
  readonly code: string;
  readonly data: unknown;
  constructor(code: string, value: string, data: unknown) {
    super(
      code === "CUSTOM_EXISTS_ELSEWHERE"
        ? `"${value}" already exists under another parent; the spec must not create a duplicate.`
        : code === "CUSTOM_NAME_SHARED"
          ? `"${value}" matches several rows here; name exactly one.`
          : code === "CUSTOM_VALUE_INVALID"
            ? `"${value}" is not a valid name here.`
            : `Adding "${value}" was refused (${code}).`,
    );
    this.name = "AddRowRefused";
    this.code = code;
    this.data = data;
  }
}

/** A ConvexError's structured `code`, read without `instanceof` (BaseMappingForm's rule). */
export function errorCode(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const data = (e as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const { code } = data as { code?: unknown };
  return typeof code === "string" ? code : null;
}

export interface AddRowResult {
  id: RowId;
  created: boolean;
}

/**
 * "+ Custom": add `value` under `parentId` at `level`, or return the row that
 * already carries that name. Checks first (exactly-one), so a re-run adds
 * nothing; the server is idempotent on the same name too.
 */
export async function addRow(
  client: NbClient,
  level: SelectorLevel,
  parentId: RowId | undefined,
  value: string,
): Promise<AddRowResult> {
  const rows = await childrenOf(client, level, parentId);
  const named = foldedMatches(rows, value);
  if (named.length === 1) return { id: named[0]._id, created: false };
  if (named.length > 1) pickExactlyOne(rows, value, level); // throws ResolveError with every candidate
  try {
    const id = await client.mutation(api.selectorOptions.addCustomSelectorOption, {
      level,
      value,
      ...(parentId ? { parentId } : {}),
    });
    return { id, created: true };
  } catch (err) {
    const code = errorCode(err);
    if (code) throw new AddRowRefused(code, value, err instanceof ConvexError ? err.data : undefined);
    throw err;
  }
}

/** Siblings whose name folds to `value` (`selectorValueKey`, the store's fold). */
function foldedMatches(rows: readonly SelectorRow[], value: string): SelectorRow[] {
  const key = selectorValueKey(value);
  return rows.filter((r) => selectorValueKey(r.value) === key);
}

// ---------------------------------------------------------------------------
// Paths: sync each column on the way down, then resolve exactly-one
// ---------------------------------------------------------------------------

export interface EnsurePathOptions {
  paused?: PausedContext;
  /** The step's manufacturer policy; absent = `fail`. */
  manufacturer?: ManufacturerPolicy;
  /** Where in the spec, for errors (`steps[2].path`). */
  at?: string;
}

export interface EnsuredBrandYear extends ResolvedBrandYear {
  /** The manufacturer row was added through "+ Custom" by this call. */
  manufacturerCreated: boolean;
  columns: ColumnResult[];
}

export interface EnsuredSet extends ResolvedSet {
  manufacturerCreated: boolean;
  columns: ColumnResult[];
}

function field(at: string | undefined, name: string): string {
  return at ? `${at}.${name}` : name;
}

/**
 * Sports → Years → Manufacturers: populate each column, then resolve the
 * path's name in it. A manufacturer missing after its column synced is
 * created only when the spec says `whenMissing: "create"`.
 */
export async function ensureBrandYearPath(
  client: NbClient,
  path: BrandYearPath,
  opts: EnsurePathOptions = {},
): Promise<EnsuredBrandYear> {
  const columns: ColumnResult[] = [];
  const col = { paused: opts.paused };

  columns.push(await ensureColumn(client, "sport", undefined, col));
  const sport = await resolveChild(client, "sport", undefined, path.sport, field(opts.at, "sport"));

  columns.push(await ensureColumn(client, "year", sport._id, col));
  const year = await resolveChild(client, "year", sport._id, path.year, field(opts.at, "year"));

  columns.push(await ensureColumn(client, "manufacturer", year._id, col));
  let manufacturerCreated = false;
  let manufacturer: SelectorRow;
  try {
    manufacturer = await resolveChild(
      client,
      "manufacturer",
      year._id,
      path.manufacturer,
      field(opts.at, "manufacturer"),
    );
  } catch (err) {
    const missing =
      err instanceof ResolveError && foldedMatches(columns[2].rows, path.manufacturer).length === 0;
    if (!missing || opts.manufacturer?.whenMissing !== "create") throw err;
    const added = await addRow(client, "manufacturer", year._id, path.manufacturer);
    manufacturerCreated = added.created;
    manufacturer = await resolveChild(
      client,
      "manufacturer",
      year._id,
      path.manufacturer,
      field(opts.at, "manufacturer"),
    );
  }

  return {
    sportId: sport._id,
    yearId: year._id,
    manufacturerId: manufacturer._id,
    rows: { sport, year, manufacturer },
    manufacturerCreated,
    columns,
  };
}

/**
 * `ensureBrandYearPath`, then the brand's Sets cold sync, the set resolved
 * exactly-one, and (when `syncVariantTypes`) its Sync Variant Types.
 */
export async function ensureSetPath(
  client: NbClient,
  path: SetPath,
  opts: EnsurePathOptions & { syncVariantTypes?: boolean } = {},
): Promise<EnsuredSet> {
  const brand = await ensureBrandYearPath(client, path, opts);
  const columns = [...brand.columns];
  columns.push(await syncBrandSets(client, brand.manufacturerId, { paused: opts.paused }));
  const set = await resolveChild(client, "setName", brand.manufacturerId, path.set, field(opts.at, "set"));
  if (opts.syncVariantTypes) {
    columns.push(await syncVariantTypes(client, set._id, { paused: opts.paused }));
  }
  return {
    ...brand,
    setId: set._id,
    rows: { ...brand.rows, set },
    columns,
  };
}
