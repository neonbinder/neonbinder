/**
 * NEO-339 — Sync Inserts / Sync Parallels for one variant type, the way the
 * Variants column does it (`VariantForm`).
 *
 * The form fetches with `setReconciliation.fetchRawOptions` (level `insert`
 * under the variant type, the Base's SportLots label as `baseSlPrefix`), and
 * then takes one of two paths:
 *
 *  - BOTH marketplaces returned rows → the Reconcile dialog. Its opening state
 *    is `seedReconciliationState` (the fetch, the rows already saved, and every
 *    id held elsewhere); its Save is `buildReconciledItems` → `storeReconciledOptions`,
 *    replayed until the store is done. This module seeds the same state, applies
 *    the spec's answers with `applyExplicitPairs` (the dialog's own reducer
 *    actions, matched by marketplace id only), and saves the same payload.
 *  - ONE side returned rows (the other empty, or paused) → the form stores
 *    every fetched set not held elsewhere, with no dialog and no operator
 *    question (`planSinglePlatformStore`), unless one of them is a name twin,
 *    which opens Reconcile instead. This module does exactly that, and says
 *    so: the spec's pairs are not consulted on that path, because the UI asks
 *    no question there.
 *
 * Only a CLEAN answer is saved. Anything `applyExplicitPairs` leaves over makes
 * the step an open decision and NOTHING is written (coordinator rule: on an
 * ambiguous pair the unnamed auto-matches are already disbanded back to
 * Pending, so a save then would silently drop them):
 *  - `unmatchedPairs`: a pair naming an id the fetch did not return, or no id;
 *  - `ambiguousPairs`: a pair whose exact ids two Ready sets carry;
 *  - `unmatchedPending`: a pending decision whose id is not in the fetch or not
 *    waiting in Pending (a re-run that already saved it is caught earlier, by
 *    `alreadySaved`, before any fetch). ONE exception, `leftMoot`: a `leave`
 *    whose id the dialog no longer shows at all (another row of the brand or
 *    set now holds it, or the marketplace stopped listing it) is a reported
 *    no-op, not an open decision. "Leave" means "no row for it here", and
 *    the dialog would create none: the outcome is identical, and the
 *    operator never sees a held set in Pending to decide about. An
 *    `own-set` for such an id stays open (it asked for a row that cannot
 *    now be made), and so does a `leave` for an id the spec also pairs;
 *  - `unaddressedPending`: EVERY marketplace set left in Pending that no
 *    decision names, on screen in the dialog or not. An auto-match the spec
 *    left out whose halves are both unanswered is offered as `proposedPairs`;
 *  - `unaddressedReady`: a saved row no pair names;
 *  - two Ready sets (or a Ready set and a saved row) saving under one name,
 *    which the dialog's Save refuses (`readyTitleClashes`).
 * `disbanded` alone is not a leftover: it is the spec not naming an auto-match.
 *
 * Idempotent: a variant type whose saved rows already carry every pair (same
 * name, same ids) and every own-set id is skipped before any marketplace call,
 * and a fetched result that would save nothing new is not saved.
 */

import { api } from "../../../convex/_generated/api";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import {
  primarySlot,
  slotIds,
  slotLabel,
  type PlatformSide,
  type SlotBearingRow,
} from "../../../convex/platformSlots";
import { variantTypeKind } from "../../../convex/variantRole";
import {
  applyExplicitPairs,
  buildReconciledItems,
  seedReconciliationState,
  type ExistingReconcileRow,
  type ExplicitPair,
  type ExplicitPairsOutcome,
  type ReadySet,
  type ReconciledResult,
} from "../../../lib/set-build/reconcile";
import {
  heldIdSets,
  heldRowsReturnedBy,
  parallelsInTree,
  storeHoldsOf,
  type HeldRow,
  type StoreHolds,
} from "../../../components/SetSelector/held-elsewhere";
import { readyTitleClashes } from "../../../components/SetSelector/ready-title-clashes";
import {
  coveredSidesFromFetch,
  planSinglePlatformStore,
  returnedIdsFromFetch,
  skippedSidesOf,
  storeItemsHitTwins,
} from "../../../components/SetSelector/selector-sync-feedback";
import {
  storeReconciledUntilDone,
  type ReconciledStoreResult,
} from "../../../components/SetSelector/store-reconciled-until-done";
import type { NbClient } from "../client/convex-client";
import type { OpenName, OpenReconcile } from "../service";
import { childrenOf, resolveVariantType, type RowId, type SelectorRow } from "../spec/resolve";
import type { ReconcilePair, ReconcilePending, ReconcileSync } from "../spec/schema";
import { assertPausedSidesDeclared, type PausedContext } from "./sync-column";

export type RawOptions = FunctionReturnType<typeof api.setReconciliation.fetchRawOptions>;
type AncestorRow = FunctionReturnType<typeof api.selectorOptions.getAncestorChain>[number];
type BaseVariant = NonNullable<FunctionReturnType<typeof api.selectorOptions.getBaseVariantBySet>>;

/** `fetchRawOptions` failed, or both sides came back empty with errors. Nothing written. */
export class ReconcileFetchError extends Error {
  readonly platforms: string[];
  constructor(platforms: string[], what = "variants") {
    super(
      `Fetching ${what} failed${platforms.length ? ` (${platforms.join(", ")})` : ""}. Nothing was changed.`,
    );
    this.name = "ReconcileFetchError";
    this.platforms = platforms;
  }
}

/** The store kept reporting more to do past its page cap. What it stored stays stored. */
export class ReconcileStoreIncomplete extends Error {
  constructor(message: string | undefined) {
    super(message ?? "Some sets were not stored. Run the step again to store the rest.");
    this.name = "ReconcileStoreIncomplete";
  }
}

// ---------------------------------------------------------------------------
// Context: everything the form reads before it fetches
// ---------------------------------------------------------------------------

export interface ReconcileContext {
  setId: RowId;
  variantType: SelectorRow;
  chain: AncestorRow[];
  parentFilters: {
    sport?: string;
    year?: string;
    manufacturer?: string;
    setName?: string;
    variantType?: string;
  };
  setName: string;
  manufacturer: string;
  baseVariant: BaseVariant | null;
  /** The rows already saved under the variant type (`existingRows`). */
  existingRows: SelectorRow[];
  /** Parallels grouped under this type's inserts (held, NEO-300). */
  groupedParallels: HeldRow[];
  /** SportLots ids the brand's other sets hold (held, NEO-305). */
  brandHeldRows: HeldRow[];
  /** Ids the set's OTHER variant types hold (held, NEO-312). */
  used: { bsc: string[]; sportlots: string[] };
}

/** The variant type titled `typeTitle` under the set, and what its form loads. */
export async function loadReconcileContext(
  client: NbClient,
  setId: RowId,
  typeTitle: string,
  at?: string,
): Promise<ReconcileContext> {
  const variantType = await resolveVariantType(client, setId, typeTitle, at);
  if (variantTypeKind(variantType) === "base") {
    throw new Error(
      `"${variantType.value}" is the set's Base; it has no rows to sync (map it with base.map instead).`,
    );
  }
  const vt = variantType._id;
  const [chain, baseVariant, existingRows, insertTree, brandHolders, usedIdentifiers] =
    await Promise.all([
      client.query(api.selectorOptions.getAncestorChain, { id: vt }),
      client.query(api.selectorOptions.getBaseVariantBySet, { setId }),
      childrenOf(client, "insert", vt),
      client.query(api.selectorOptions.getInsertTreeByVariantType, { variantTypeId: vt }),
      client.query(api.setParallelConversion.getBrandSlHolders, { variantTypeId: vt }),
      client.query(api.selectorOptions.getUsedInsertIdentifiersBySet, {
        setId,
        excludeVariantTypeId: vt,
      }),
    ]);
  const value = (level: AncestorRow["level"]) => chain.find((a) => a.level === level)?.value;
  return {
    setId,
    variantType,
    chain,
    // VariantForm's `doSync` parentFilters, field for field.
    parentFilters: {
      sport: value("sport"),
      year: value("year"),
      manufacturer: value("manufacturer"),
      setName: value("setName"),
      variantType: value("variantType"),
    },
    setName: value("setName") ?? "",
    manufacturer: value("manufacturer") ?? "",
    baseVariant,
    existingRows,
    groupedParallels: parallelsInTree(insertTree),
    brandHeldRows: brandHolders.rows.map((r) => ({
      key: r.key,
      name: r.name,
      bsc: [],
      sportlots: r.sportlots,
    })),
    used: {
      bsc: usedIdentifiers.bscPlatformValues,
      sportlots: usedIdentifiers.slPlatformValues,
    },
  };
}

/** The Base's primary SportLots label, sent as `baseSlPrefix` (matching aid only). */
function baseSlPrefixOf(base: BaseVariant | null): string | undefined {
  if (!base) return undefined;
  const row = base as unknown as SlotBearingRow;
  const slot = primarySlot(row, "sportlots");
  return slot ? slotLabel(row, "sportlots", slot) : undefined;
}

export async function fetchVariantOptions(client: NbClient, ctx: ReconcileContext): Promise<RawOptions> {
  const prefix = baseSlPrefixOf(ctx.baseVariant);
  return client.action(api.setReconciliation.fetchRawOptions, {
    level: "insert",
    parentId: ctx.variantType._id,
    parentFilters: ctx.parentFilters,
    ...(prefix ? { baseSlPrefix: prefix } : {}),
  });
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type ReconcileOutcome =
  | {
      outcome: "saved";
      mode: "dialog" | "single-platform";
      /** Items sent to the store. */
      sent: number;
      /** Rows the store reports linked (`optionsCount`). */
      stored: number;
      /** What the store withheld or refused; non-null means an operator must look. */
      holds: StoreHolds | null;
      unlinkedTotal: number;
      /** The spec's pairs/pending were not consulted (single-platform path asks nothing). */
      specNotConsulted?: boolean;
      pausedSides: PlatformSide[];
      /** `leave` entries whose id the dialog no longer shows (held elsewhere, or no longer listed): no-ops. */
      leftMoot?: MootLeave[];
    }
  | {
      outcome: "skipped";
      reason: "already-saved" | "unchanged" | "nothing-fetched" | "all-held";
      pausedSides: PlatformSide[];
      leftMoot?: MootLeave[];
    }
  | {
      outcome: "open";
      reconcile: OpenReconcile;
      names: OpenName[];
      pausedSides: PlatformSide[];
    };

/** A `leave` that had nothing to leave: the id was not in the dialog when the step ran. */
export interface MootLeave {
  side: "bsc" | "sportlots";
  id: string;
  /** `held`: the fetch returned it and another NB row holds it; `not-listed`: the fetch did not return it. */
  why: "held" | "not-listed";
}

/**
 * Split `applyExplicitPairs`' unmatched pending decisions into the open ones
 * and the moot `leave`s (see the file comment). Pure.
 */
export function splitMootLeaves(
  outcome: ExplicitPairsOutcome,
  fetched: { bsc: ReadonlySet<string>; sportlots: ReadonlySet<string> },
): { outcome: ExplicitPairsOutcome; moot: MootLeave[] } {
  const moot: MootLeave[] = [];
  const unmatchedPending = outcome.unmatchedPending.filter(({ entry, reason }) => {
    if (entry.decision !== "leave" || reason !== "not-in-fetch") return true;
    moot.push({ side: entry.side, id: entry.id, why: fetched[entry.side].has(entry.id) ? "held" : "not-listed" });
    return false;
  });
  return { outcome: { ...outcome, unmatchedPending }, moot };
}

export interface ReconcileOptions {
  paused?: PausedContext;
  /** Where in the spec, e.g. `steps[3].variants[1]`. */
  at?: string;
  /** `formatPath` of the set, for the open decision. */
  path?: string;
}

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const A = new Set(a);
  const B = new Set(b);
  return A.size === B.size && [...A].every((x) => B.has(x));
};

/**
 * The saved rows already say everything the spec asks: every pair is a row
 * with that name and exactly those ids, every own-set id is a row holding
 * only that id. Needs at least one such answer (an all-"leave" spec proves
 * nothing without a fetch).
 */
export function alreadySaved(existing: readonly SelectorRow[], sync: ReconcileSync): boolean {
  const ownSets = sync.pending.filter((p) => p.decision === "own-set");
  if (sync.pairs.length + ownSets.length === 0 || existing.length === 0) return false;
  const rows = existing.map((r) => ({
    value: r.value,
    bsc: slotIds(r, "bsc"),
    sportlots: slotIds(r, "sportlots"),
  }));
  const pairsDone = sync.pairs.every((p) =>
    rows.some(
      (r) => r.value === p.name && sameSet(r.bsc, p.bsc ?? []) && sameSet(r.sportlots, p.sportlots ?? []),
    ),
  );
  const ownDone = ownSets.every((p) =>
    rows.some((r) =>
      p.side === "bsc"
        ? sameSet(r.bsc, [p.id]) && r.sportlots.length === 0
        : sameSet(r.sportlots, [p.id]) && r.bsc.length === 0,
    ),
  );
  return pairsDone && ownDone;
}

/** Items the store would write anything for: new sets, renames, changed ids. */
export function itemsChangeAnything(
  items: ReconciledResult["items"],
  existing: readonly SelectorRow[],
): boolean {
  const byId = new Map(existing.map((r) => [String(r._id), r]));
  return items.some((item) => {
    if (!item.existingId) return true;
    const row = byId.get(String(item.existingId));
    if (!row) return true;
    if (row.value !== item.value) return true;
    if (!sameSet(slotIds(row, "bsc"), item.platformData.bsc ?? [])) return true;
    if (!sameSet(slotIds(row, "sportlots"), item.platformData.sportlots ?? [])) return true;
    const prefix = (row.metadata as { cardNumberPrefix?: string } | undefined)?.cardNumberPrefix;
    return (item.metadata?.cardNumberPrefix ?? undefined) !== (prefix ?? undefined);
  });
}

export function existingRowsForSeed(rows: readonly SelectorRow[]): ExistingReconcileRow[] {
  return rows.map((r) => ({
    existingId: r._id,
    value: r.value,
    platformData: { bsc: slotIds(r, "bsc"), sportlots: slotIds(r, "sportlots") },
    metadata: r.metadata as ExistingReconcileRow["metadata"],
  }));
}

/** The dialog's `handleReconciliationConfirm` items, field for field. */
function toStoreItems(items: ReconciledResult["items"]) {
  return items.map((item) => ({
    value: item.value,
    platformData: item.platformData,
    platformLabels: item.platformLabels,
    metadata: item.metadata,
    existingId: item.existingId,
    ...(item.identityOnly ? { identityOnly: true } : {}),
  }));
}

type StoreArgs = FunctionArgs<typeof api.setReconciliation.storeReconciledOptions>;

/** `storeReconciledOptions`, replayed until done (`storeReconciledUntilDone`, the forms' loop). */
function store(client: NbClient, args: StoreArgs) {
  return storeReconciledUntilDone<StoreArgs>(
    async (a) => (await client.mutation(api.setReconciliation.storeReconciledOptions, a)) as ReconciledStoreResult,
    args,
  );
}

// ---------------------------------------------------------------------------
// Open decisions from an explicit-pairs pass
// ---------------------------------------------------------------------------

export interface DialogDecisionInput {
  outcome: ExplicitPairsOutcome;
  /** The spec's pairs and pending, as given (their indexes name `at`). */
  pairs: readonly ReconcilePair[];
  pending: readonly ReconcilePending[];
  savedSiblings: Parameters<typeof readyTitleClashes>[2];
  at: string;
  path: string;
  type: string;
}

/**
 * Turn `applyExplicitPairs`' leftovers into open decisions. Pure. Every
 * non-empty leftover list yields at least one entry, so "no entries" is
 * exactly "a clean outcome the step may save".
 */
export function dialogOpenDecisions(input: DialogDecisionInput): {
  reconcile: OpenReconcile;
  names: OpenName[];
} {
  const { outcome, at, path, type } = input;
  const names: OpenName[] = [];

  outcome.unmatchedPairs.forEach(({ pair, missing }) => {
    const i = indexOfPair(input, pair);
    if (missing.length === 0) {
      names.push({ at: `${at}.sync.pairs[${i}]`, kind: "reconcile-pair", name: pair.name, candidates: [] });
    }
    for (const m of missing) {
      names.push({
        at: `${at}.sync.pairs[${i}].${m.side}`,
        kind: "reconcile-id",
        name: m.id,
        candidates: [],
      });
    }
  });
  for (const pair of outcome.ambiguousPairs) {
    const holders = outcome.state.ready.filter(
      (s) => sameSet(s.bsc.map((x) => x.platformValue), pair.bsc ?? []) &&
        sameSet(s.sl.map((x) => x.platformValue), pair.sportlots ?? []),
    );
    names.push({
      at: `${at}.sync.pairs[${indexOfPair(input, pair)}]`,
      kind: "reconcile-pair",
      name: pair.name,
      candidates: holders.map((s) => ({ id: s.existingId ? String(s.existingId) : s.key, name: s.title })),
    });
  }
  for (const { entry, reason } of outcome.unmatchedPending) {
    names.push({
      at: `${at}.sync.pending[${input.pending.indexOf(entry)}]`,
      kind: reason === "not-in-fetch" ? "reconcile-id" : "reconcile-pending",
      name: entry.id,
      candidates: [],
    });
  }

  // Every unaddressed pending set, on screen or not (coordinator rule: a
  // partial answer is never saved).
  const open = outcome.unaddressedPending;
  const openIds = {
    bsc: new Set(open.filter((p) => p.side === "bsc").map((p) => p.item.platformValue)),
    sportlots: new Set(open.filter((p) => p.side === "sportlots").map((p) => p.item.platformValue)),
  };
  // An auto-match the spec left out, both of whose halves now wait unanswered:
  // offered as the pair the matcher proposed, and taken out of `pending`.
  const proposedPairs: OpenReconcile["proposedPairs"] = [];
  for (const set of outcome.disbanded) {
    const bsc = set.bsc.map((i) => i.platformValue);
    const sl = set.sl.map((i) => i.platformValue);
    if (bsc.every((id) => openIds.bsc.has(id)) && sl.every((id) => openIds.sportlots.has(id))) {
      proposedPairs.push({ name: set.title, buysportscards: bsc, sportlots: sl });
      for (const id of bsc) openIds.bsc.delete(id);
      for (const id of sl) openIds.sportlots.delete(id);
    }
  }
  const pending: OpenReconcile["pending"] = open
    .filter((p) => openIds[p.side].has(p.item.platformValue))
    .map((p) => ({
      side: p.side === "bsc" ? "buysportscards" : "sportlots",
      id: p.item.platformValue,
      name: p.item.value,
    }));

  // A saved row no pair names: the spec must say what it is.
  for (const set of outcome.unaddressedReady) {
    names.push({
      at: `${at}.sync.pairs`,
      kind: "reconcile-saved-row",
      name: set.title,
      candidates: [
        {
          id: set.existingId ? String(set.existingId) : set.key,
          name: set.title,
          detail: idsDetail(set),
        },
      ],
    });
  }

  // Save's same-title block.
  for (const clash of readyTitleClashes(outcome.state.ready, new Map(), input.savedSiblings)) {
    const sets = outcome.state.ready.filter((s) => clash.readyKeys.includes(s.key));
    names.push({
      at: `${at}.sync.pairs`,
      kind: "reconcile-title",
      name: clash.title,
      candidates: sets.map((s) => ({
        id: s.existingId ? String(s.existingId) : s.key,
        name: s.title,
        detail: [
          ...s.bsc.map((i) => `bsc ${i.platformValue}`),
          ...s.sl.map((i) => `sportlots ${i.platformValue}`),
          ...(clash.existingCount > 0 ? [`${clash.existingCount} saved row(s) already named this`] : []),
        ].join(", "),
      })),
    });
  }

  return { reconcile: { at: `${at}.sync`, path, type, proposedPairs, pending }, names };
}

/** Where a pair sits in the spec: `applyExplicitPairs` hands back the objects it was given. */
function indexOfPair(input: DialogDecisionInput, pair: ExplicitPair): number {
  return (input.pairs as readonly ExplicitPair[]).indexOf(pair);
}

function idsDetail(set: ReadySet): string {
  return [
    ...set.bsc.map((i) => `bsc ${i.platformValue}`),
    ...set.sl.map((i) => `sportlots ${i.platformValue}`),
  ].join(", ");
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

/**
 * Sync one variant type's rows with the spec's answers. See the file comment
 * for the two paths and what becomes an open decision.
 */
export async function reconcileVariants(
  client: NbClient,
  setId: RowId,
  typeTitle: string,
  sync: ReconcileSync,
  opts: ReconcileOptions = {},
): Promise<ReconcileOutcome> {
  const at = opts.at ?? "variants";
  const path = opts.path ?? String(setId);
  const ctx = await loadReconcileContext(client, setId, typeTitle, `${at}.type`);

  if (alreadySaved(ctx.existingRows, sync)) {
    return { outcome: "skipped", reason: "already-saved", pausedSides: [] };
  }

  const result = await fetchVariantOptions(client, ctx);
  const pausedSides = result.pausedSides ?? [];
  if (opts.paused) assertPausedSidesDeclared(pausedSides, opts.paused, `(${typeTitle} sync)`);
  const platformsOf = (errs: RawOptions["errors"]) => [...new Set(errs.map((e) => e.platform))];

  if (!result.success) throw new ReconcileFetchError(platformsOf(result.errors));
  if (result.bscOptions.length === 0 && result.slOptions.length === 0 && result.errors.length > 0) {
    throw new ReconcileFetchError(platformsOf(result.errors));
  }

  const groupedHeld = heldRowsReturnedBy(ctx.groupedParallels, result);
  const brandHeld = heldRowsReturnedBy(ctx.brandHeldRows, result);
  const bothSides = result.bscOptions.length > 0 && result.slOptions.length > 0;

  if (!bothSides) {
    const plan = planSinglePlatformStore(result.errors, skippedSidesOf(result));
    if (plan.kind === "blocked") throw new ReconcileFetchError(plan.failedLabels);
    const held = heldIdSets([...groupedHeld, ...brandHeld]);
    for (const id of ctx.used.bsc) held.bsc.add(id);
    for (const id of ctx.used.sportlots) held.sportlots.add(id);
    const items = [
      ...result.bscOptions
        .filter((o) => !held.bsc.has(o.platformValue))
        .map((o) => ({ value: o.value, platformData: { bsc: o.platformValue } })),
      ...result.slOptions
        .filter((o) => !held.sportlots.has(o.platformValue))
        .map((o) => ({ value: o.value, platformData: { sportlots: o.platformValue } })),
    ];
    if (!storeItemsHitTwins(items, result.twinIds)) {
      if (items.length === 0) {
        return {
          outcome: "skipped",
          reason: groupedHeld.length + brandHeld.length > 0 ? "all-held" : "nothing-fetched",
          pausedSides,
        };
      }
      const existingIds = {
        bsc: new Set(ctx.existingRows.flatMap((r) => slotIds(r, "bsc"))),
        sportlots: new Set(ctx.existingRows.flatMap((r) => slotIds(r, "sportlots"))),
      };
      const allPresent = items.every((i) =>
        "bsc" in i.platformData
          ? existingIds.bsc.has(i.platformData.bsc)
          : existingIds.sportlots.has((i.platformData as { sportlots: string }).sportlots),
      );
      if (allPresent) return { outcome: "skipped", reason: "unchanged", pausedSides };
      const drained = await store(client, {
        level: "insert",
        parentId: ctx.variantType._id,
        reconciledItems: items,
        coveredSides: plan.coveredSides,
        returnedIds: returnedIdsFromFetch(result),
      });
      if (!drained.converged) throw new ReconcileStoreIncomplete(drained.stored.message);
      return {
        outcome: "saved",
        mode: "single-platform",
        sent: items.length,
        stored: drained.stored.optionsCount ?? items.length,
        holds: storeHoldsOf(drained.stored, items),
        unlinkedTotal: drained.stored.unlinkedTotal ?? 0,
        ...(sync.pairs.length + sync.pending.length > 0 ? { specNotConsulted: true } : {}),
        pausedSides,
      };
    }
    // A twin in what would be stored: the form opens Reconcile on this fetch.
  }

  // ── The Reconcile dialog ────────────────────────────────────────────────
  const seed = seedReconciliationState({
    fetch: {
      autoMatched: result.autoMatched,
      unmatchedBsc: result.unmatchedBsc,
      unmatchedSl: result.unmatchedSl,
    },
    existingRows: existingRowsForSeed(ctx.existingRows),
    heldElsewhere: { rows: groupedHeld },
    heldInBrand: { rows: brandHeld },
    usedIds: { bsc: ctx.used.bsc, sportlots: ctx.used.sportlots },
  });
  const returned = returnedIdsFromFetch(result);
  const fetchedIds = {
    bsc: new Set([
      ...result.bscOptions.map((o) => o.platformValue),
      ...result.unmatchedBsc.map((o) => o.platformValue),
      ...result.autoMatched.map((m) => m.bsc.platformValue),
    ]),
    sportlots: new Set([
      ...result.slOptions.map((o) => o.platformValue),
      ...result.unmatchedSl.map((o) => o.platformValue),
      ...result.autoMatched.map((m) => m.sl.platformValue),
    ]),
  };
  const split = splitMootLeaves(applyExplicitPairs(seed.state, sync.pairs, sync.pending, { fetched: fetchedIds }), fetchedIds);
  const outcome = split.outcome;
  const leftMoot = split.moot.length > 0 ? { leftMoot: split.moot } : {};

  const decisions = dialogOpenDecisions({
    outcome,
    pending: sync.pending,
    savedSiblings: seed.savedSiblings,
    at,
    path,
    type: ctx.variantType.value,
    pairs: sync.pairs,
  });
  const anyOpen =
    decisions.names.length > 0 ||
    decisions.reconcile.pending.length > 0 ||
    decisions.reconcile.proposedPairs.length > 0;
  if (anyOpen) {
    return { outcome: "open", reconcile: decisions.reconcile, names: decisions.names, pausedSides };
  }

  const items = buildReconciledItems(outcome.state.ready);
  if (!itemsChangeAnything(items, ctx.existingRows)) {
    return { outcome: "skipped", reason: "unchanged", pausedSides, ...leftMoot };
  }
  const covered = coveredSidesFromFetch(result.errors, skippedSidesOf(result));
  const storeItems = toStoreItems(items);
  const drained = await store(client, {
    level: "insert",
    parentId: ctx.variantType._id,
    reconciledItems: storeItems,
    ...(covered ? { coveredSides: covered } : {}),
    returnedIds: returned,
  });
  if (!drained.converged) throw new ReconcileStoreIncomplete(drained.stored.message);
  return {
    outcome: "saved",
    mode: "dialog",
    sent: storeItems.length,
    stored: drained.stored.optionsCount ?? storeItems.length,
    holds: storeHoldsOf(drained.stored, storeItems),
    unlinkedTotal: drained.stored.unlinkedTotal ?? 0,
    pausedSides,
    ...leftMoot,
  };
}
