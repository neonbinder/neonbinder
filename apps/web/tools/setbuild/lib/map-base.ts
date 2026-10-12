/**
 * NEO-339 — map a set's Base to its marketplace sets, the way "Re-map Base"
 * does.
 *
 * The dialog (`BaseMappingForm` + `BaseSetPicker`) fetches the candidates with
 * `setReconciliation.fetchRawOptions` (level `insert` under the Base variant
 * type), ranks them with `listBaseCandidates`, and on confirm sends
 * `buildBaseMappingPayload` to `selectorOptions.setVariantTypePlatformData`
 * with the row's version token. This module makes the same calls through the
 * same shared functions (lib/set-build/base-candidates.ts). The one difference
 * is who picks: the spec names each side's pick by MARKETPLACE ID, and an id
 * that is not among the candidates the fetch returned is an open decision,
 * never a nearest match. Nothing here reads a name to decide anything; the
 * dialog's pre-selection is reported for the template only.
 *
 * Idempotent: a Base already mapped to the spec's ids is skipped before any
 * marketplace call. `BASE_MAPPING_STALE` (the row moved under the pick) is
 * retried once on a fresh read and a fresh fetch, as the dialog re-opens.
 */

import { api } from "../../../convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { slotEntries, slotFacet, primaryId, type PlatformSide, type SlotBearingRow } from "../../../convex/platformSlots";
import { variantTypeKind } from "../../../convex/variantRole";
import {
  buildBaseMappingPayload,
  listBaseCandidates,
  type BaseCandidates,
} from "../../../lib/set-build/base-candidates";
import type { PlatformItem } from "../../../lib/set-build/reconcile";
import type { NbClient } from "../client/convex-client";
import type { OpenBaseCandidates } from "../service";
import { childrenOf, ResolveError, type RowId, type SelectorRow } from "../spec/resolve";
import type { BaseMap } from "../spec/schema";
import { assertPausedSidesDeclared, errorCode, type PausedContext } from "./sync-column";

export type AncestorRow = FunctionReturnType<typeof api.selectorOptions.getAncestorChain>[number];
export type RawOptions = FunctionReturnType<typeof api.setReconciliation.fetchRawOptions>;

/**
 * The set has no variant type titled Base (run Sync Variant Types first), or
 * more than one. NEO-334: a variant type's title is its kind.
 */
export class NoBaseVariantType extends Error {
  readonly setId: RowId;
  constructor(setId: RowId, count: number) {
    super(
      count === 0
        ? `The set ${setId} has no Base variant type yet; sync its variant types first.`
        : `The set ${setId} has ${count} variant types titled Base; rename all but one.`,
    );
    this.name = "NoBaseVariantType";
    this.setId = setId;
  }
}

/** `fetchRawOptions` failed; the platforms are named, the adapter text is not. */
export class BaseFetchError extends Error {
  readonly platforms: string[];
  constructor(platforms: string[]) {
    super(
      `Fetching the Base candidates failed${platforms.length ? ` (${platforms.join(", ")})` : ""}. Nothing was changed.`,
    );
    this.name = "BaseFetchError";
    this.platforms = platforms;
  }
}

export interface BaseContext {
  setId: RowId;
  /** The Base variant type row: the one titled Base (NEO-334, `variantTypeKind`). */
  base: SelectorRow;
  chain: AncestorRow[];
  setNameAncestor: AncestorRow | undefined;
  manufacturer: string;
  parentFilters: {
    sport?: string;
    year?: string;
    manufacturer?: string;
    setName?: string;
    variantType?: string;
  };
}

/** The set's Base variant type, by its title's kind (`variantTypeKind`), exactly one. */
export async function findBaseVariantType(client: NbClient, setId: RowId): Promise<SelectorRow> {
  const types = await childrenOf(client, "variantType", setId);
  const bases = types.filter((t) => variantTypeKind(t) === "base");
  if (bases.length !== 1) throw new NoBaseVariantType(setId, bases.length);
  return bases[0];
}

export async function getBaseContext(client: NbClient, setId: RowId): Promise<BaseContext> {
  const base = await findBaseVariantType(client, setId);
  const chain = await client.query(api.selectorOptions.getAncestorChain, { id: base._id });
  const value = (level: AncestorRow["level"]) => chain.find((a) => a.level === level)?.value;
  const setNameAncestor = chain.find((a) => a.level === "setName");
  return {
    setId,
    base,
    chain,
    setNameAncestor,
    manufacturer: value("manufacturer") ?? "",
    // BaseMappingForm's `doSync` parentFilters, field for field.
    parentFilters: {
      sport: value("sport"),
      year: value("year"),
      manufacturer: value("manufacturer"),
      setName: setNameAncestor?.value,
      variantType: value("variantType"),
    },
  };
}

/**
 * What the Base row is mapped to now: the BSC id in its `setName`-tagged slot
 * (or an untagged legacy primary — the slot `setVariantTypePlatformData`
 * would refresh), and the SportLots primary.
 */
export function currentBaseMapping(row: SlotBearingRow): { bsc?: string; sportlots?: string } {
  const bscSlots = slotEntries(row, "bsc");
  const bsc =
    bscSlots.find((e) => slotFacet(row, "bsc", e.slot) === "setName")?.id ??
    bscSlots.find((e) => slotFacet(row, "bsc", e.slot) === undefined)?.id;
  const sportlots = primaryId(row, "sportlots");
  return { ...(bsc ? { bsc } : {}), ...(sportlots ? { sportlots } : {}) };
}

export interface BaseCandidateList {
  context: BaseContext;
  fetch: RawOptions;
  candidates: BaseCandidates;
  pausedSides: PlatformSide[];
}

/**
 * Every candidate the dialog would offer for the set's Base, with what it
 * would pre-select. Read-only on NB data.
 */
export async function listCandidates(
  client: NbClient,
  setIdOrContext: RowId | BaseContext,
): Promise<BaseCandidateList> {
  const context =
    typeof setIdOrContext === "string" ? await getBaseContext(client, setIdOrContext) : setIdOrContext;
  const fetch = await client.action(api.setReconciliation.fetchRawOptions, {
    level: "insert",
    parentId: context.base._id,
    parentFilters: context.parentFilters,
  });
  if (!fetch.success) {
    throw new BaseFetchError([...new Set((fetch.errors ?? []).map((e) => e.platform))]);
  }
  const candidates = listBaseCandidates(fetch, context.setNameAncestor, context.manufacturer);
  return { context, fetch, candidates, pausedSides: fetch.pausedSides ?? [] };
}

/** The candidates of one side as an open decision (the template's fill-in list). */
export function openBaseCandidates(
  list: BaseCandidates,
  side: "buysportscards" | "sportlots",
  at: string,
  path: string,
): OpenBaseCandidates {
  const candidates =
    side === "sportlots"
      ? list.sl.map((c) => ({ id: c.platformValue, name: c.value, score: c.score }))
      : list.bsc.map((c) => ({
          id: c.item.platformValue,
          name: c.label,
          ...(c.score !== null ? { score: c.score } : {}),
        }));
  return { at, path, side, candidates };
}

/**
 * The ONE candidate item carrying `id` on a side, or why not. Two candidates
 * with the same id and the same label are the same pick (the payload reads
 * only those two); with different labels they are a choice the spec cannot
 * make by id alone.
 */
export function pickCandidate(
  list: BaseCandidates,
  side: "bsc" | "sportlots",
  id: string,
): { ok: true; item: PlatformItem } | { ok: false; reason: "not-offered" | "ambiguous" } {
  const items: PlatformItem[] =
    side === "sportlots"
      ? list.sl.filter((c) => c.platformValue === id).map((c) => ({ value: c.value, platformValue: c.platformValue }))
      : list.bsc.filter((c) => c.item.platformValue === id).map((c) => c.item);
  if (items.length === 0) return { ok: false, reason: "not-offered" };
  const labels = new Set(items.map((i) => i.value));
  if (labels.size > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, item: items[0] };
}

export type MapBaseResult =
  | {
      outcome: "mapped";
      sides: { bsc?: string; sportlots?: string };
      /** A `BASE_MAPPING_STALE` refusal was retried on a fresh read. */
      retriedStale: boolean;
    }
  | {
      outcome: "skipped";
      reason: "already-mapped" | "paused";
      sides: { bsc?: string; sportlots?: string };
      /** The side(s) the pause dropped or the whole step skipped for. */
      pausedSides?: PlatformSide[];
    }
  | {
      /** An id the spec names is not among the fetched candidates (or names two). Nothing written. */
      outcome: "open";
      open: OpenBaseCandidates[];
    };

export interface ConfirmMappingOptions {
  paused?: PausedContext;
  /** Where in the spec, e.g. `steps[3].base.map`. */
  at?: string;
  /** `formatPath` of the set, for the open decision. */
  path?: string;
}

/** The spec's map reduced by the pause: which sides to write, or a skip. */
export function plannedSides(
  map: BaseMap,
  pausedSides: ReadonlySet<PlatformSide>,
): { sides: { bsc?: string; sportlots?: string }; paused: PlatformSide[] } | { skip: PlatformSide[] } {
  const hit: PlatformSide[] = [];
  if (pausedSides.has("bsc")) hit.push("bsc");
  if (map.sportlots && pausedSides.has("sportlots")) hit.push("sportlots");
  if (hit.length === 0) {
    return { sides: { bsc: map.bsc, ...(map.sportlots ? { sportlots: map.sportlots } : {}) }, paused: [] };
  }
  if (map.whenPaused === "skip") return { skip: hit };
  // bsc-only: the SportLots half is dropped; a paused BSC cannot be mapped at all.
  if (hit.includes("bsc")) {
    throw new Error(
      "The spec maps the Base on BSC with whenPaused \"bsc-only\", but BSC itself is paused. " +
        "Use whenPaused \"skip\" for a run where BSC is paused.",
    );
  }
  return { sides: { bsc: map.bsc }, paused: hit };
}

function alreadyMapped(row: SlotBearingRow, want: { bsc?: string; sportlots?: string }): boolean {
  const now = currentBaseMapping(row);
  return (
    (want.bsc === undefined || now.bsc === want.bsc) &&
    (want.sportlots === undefined || now.sportlots === want.sportlots)
  );
}

/**
 * Map the set's Base to exactly the spec's ids.
 *
 * 1. The declared pause decides the sides (`whenPaused`), before any fetch.
 * 2. Already mapped to those ids → `skipped`, no marketplace call.
 * 3. Fetch; the server's `pausedSides` must agree with the declaration.
 * 4. Each id must be ONE offered candidate, else `open` (nothing written).
 * 5. Write `buildBaseMappingPayload` with the row's version; on
 *    `BASE_MAPPING_STALE`, re-read, re-check, re-fetch and write once more.
 */
export async function confirmMapping(
  client: NbClient,
  setId: RowId,
  map: BaseMap,
  opts: ConfirmMappingOptions = {},
): Promise<MapBaseResult> {
  const at = opts.at ?? "base.map";
  const path = opts.path ?? String(setId);
  const declared = opts.paused?.sides ?? new Set<PlatformSide>();
  const planned = plannedSides(map, declared);
  if ("skip" in planned) {
    return {
      outcome: "skipped",
      reason: "paused",
      sides: {},
      pausedSides: planned.skip,
    };
  }
  const want = planned.sides;

  let retriedStale = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const context = await getBaseContext(client, setId);
    if (alreadyMapped(context.base, want)) {
      return {
        outcome: "skipped",
        reason: "already-mapped",
        sides: want,
        ...(planned.paused.length ? { pausedSides: planned.paused } : {}),
      };
    }

    const list = await listCandidates(client, context);
    if (opts.paused) assertPausedSidesDeclared(list.pausedSides, opts.paused, "(Base candidates)");

    const open: OpenBaseCandidates[] = [];
    const sel: { bsc?: PlatformItem; sl?: PlatformItem } = {};
    if (want.bsc !== undefined) {
      const pick = pickCandidate(list.candidates, "bsc", want.bsc);
      if (pick.ok) sel.bsc = pick.item;
      else open.push(openBaseCandidates(list.candidates, "buysportscards", `${at}.bsc`, path));
    }
    if (want.sportlots !== undefined) {
      const pick = pickCandidate(list.candidates, "sportlots", want.sportlots);
      if (pick.ok) sel.sl = pick.item;
      else open.push(openBaseCandidates(list.candidates, "sportlots", `${at}.sportlots`, path));
    }
    if (open.length > 0) return { outcome: "open", open };

    const payload = buildBaseMappingPayload(sel, {
      variantTypeId: context.base._id,
      lastUpdated: context.base.lastUpdated,
    });
    if (!payload) {
      // Unreachable: `want.bsc` is always set on this path.
      throw new ResolveError({ kind: "base-id", query: map.bsc, candidates: [], at });
    }
    try {
      await client.mutation(api.selectorOptions.setVariantTypePlatformData, payload);
      return {
        outcome: "mapped",
        sides: want,
        retriedStale,
      };
    } catch (err) {
      if (errorCode(err) === "BASE_MAPPING_STALE" && attempt === 0) {
        retriedStale = true;
        continue;
      }
      throw err;
    }
  }
  // The second attempt either returned or threw.
  throw new Error("Base mapping: the row kept changing under the write (BASE_MAPPING_STALE twice).");
}
