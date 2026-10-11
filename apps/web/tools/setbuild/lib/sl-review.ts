/**
 * NEO-339 — "Sort SportLots sets for {brand}": the SportLots-only review a
 * brand's Sync Sets leaves, applied the way `SlSetReviewModal` saves it.
 *
 * The dialog reads `slSetReview.getSlSetReview`, runs the picked set's Sync
 * Variant Types (`ensureSelectorOptions` at `variantType`, forced, once per set
 * per opening), lists that set's types with `slSetReview.getVariantTypesOfSet`,
 * and on Save sends `buildSlReviewDecisions` (lib/set-build/sl-review.ts) to
 * `slSetReview.applySlSetReview`. This module makes the same calls through the
 * same payload builder.
 *
 * The spec answers every line by SportLots id. Save sends a decision for EVERY
 * line it reaches (an untouched line is "its own set"), so a line the spec
 * does not answer is an open decision and nothing is saved: the tool never
 * files a line by default. A spec id the review does not hold, a set name
 * that is not exactly one of the brand's sets, and a variant type that is not
 * exactly one of the set's types are open decisions too. Lines the save
 * refuses for their name stay in the review and come back as open decisions
 * with the server's reason.
 *
 * Idempotent: a brand with no review (already saved, or SportLots paused so no
 * review was made) is skipped.
 */

import { api } from "../../../convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import type { PlatformSide } from "../../../convex/platformSlots";
import {
  buildSlReviewDecisions,
  MAX_REVIEW_DECISIONS,
  type SlReviewLineAnswer,
} from "../../../lib/set-build/sl-review";
import type { NbClient } from "../client/convex-client";
import type { OpenName, OpenSlReview } from "../service";
import { pickExactlyOne, ResolveError, type RowId } from "../spec/resolve";
import type { SlDecision } from "../spec/schema";
import { assertPausedSidesDeclared, type PausedContext } from "./sync-column";

export type SlReview = NonNullable<FunctionReturnType<typeof api.slSetReview.getSlSetReview>>;
export type SlReviewEntry = SlReview["entries"][number];
export type ApplySlReviewResult = FunctionReturnType<typeof api.slSetReview.applySlSetReview>;

export type SlReviewOutcome =
  | { outcome: "skipped"; reason: "no-review" }
  | {
      /** Nothing was saved (variant-type syncs the answers needed may have run). */
      outcome: "open";
      slReview: OpenSlReview;
      names: OpenName[];
    }
  | {
      outcome: "applied";
      /** Lines filed (own sets + under a type) across every call. */
      applied: number;
      /** Lines still in the review after the last call. */
      remaining: number;
      calls: number;
      results: ApplySlReviewResult[];
      /** Lines the save refused for their name; still in the review. */
      refused: OpenSlReview | null;
      /** Sets whose variant types this run synced (forced) to file lines under them. */
      syncedSets: RowId[];
    };

export interface SlReviewOptions {
  paused?: PausedContext;
  /** Where in the spec, e.g. `steps[4].slReview`. */
  at?: string;
  /** `formatPath` of the brand-year, for the open decision. */
  path?: string;
}

/** The brand's SportLots review, or null when nothing waits. */
export async function readSlReview(client: NbClient, manufacturerId: RowId): Promise<SlReview | null> {
  const review = await client.query(api.slSetReview.getSlSetReview, { manufacturerId });
  return review && review.entries.length > 0 ? review : null;
}

/** Review lines as an open decision, with the server's display-only suggestion. */
export function openSlRows(
  review: SlReview,
  entries: readonly SlReviewEntry[],
  at: string,
  path: string,
): OpenSlReview {
  const setName = new Map(review.ofSets.map((s) => [String(s._id), s.value]));
  return {
    at,
    path,
    rows: entries.map((e) => ({
      slId: e.slId,
      name: e.label,
      ...(e.suggestedOfSetId && setName.has(String(e.suggestedOfSetId))
        ? { suggestion: setName.get(String(e.suggestedOfSetId)) }
        : {}),
    })),
  };
}

const ownSet = (d: SlDecision): d is Extract<SlDecision, { placement: "own-set" }> =>
  "placement" in d;

/**
 * The spec's answers checked against the review without writing: one per
 * line, every id a line of the review, every set exactly one of the brand's.
 */
export function checkSlDecisions(
  review: SlReview,
  decisions: readonly SlDecision[],
  at: string,
  path: string,
): {
  unanswered: SlReviewEntry[];
  names: OpenName[];
  /** slId → the set id the decision files it under (own set: absent). */
  setOf: Map<string, RowId>;
} {
  const names: OpenName[] = [];
  const bySlId = new Map<string, number[]>();
  decisions.forEach((d, i) => bySlId.set(d.slId, [...(bySlId.get(d.slId) ?? []), i]));
  const inReview = new Set(review.entries.map((e) => e.slId));

  for (const [slId, idx] of bySlId) {
    if (idx.length > 1) {
      names.push({
        at: `${at}.decisions[${idx[1]}]`,
        kind: "sl-review-line",
        name: slId,
        candidates: [],
      });
    }
    if (!inReview.has(slId)) {
      names.push({
        at: `${at}.decisions[${idx[0]}].slId`,
        kind: "sl-review-id",
        name: slId,
        candidates: [],
      });
    }
  }

  const setOf = new Map<string, RowId>();
  decisions.forEach((d, i) => {
    if (ownSet(d)) return;
    try {
      const set = pickExactlyOne(review.ofSets, d.set, "set", `${at}.decisions[${i}].set`);
      setOf.set(d.slId, set._id);
    } catch (err) {
      if (!(err instanceof ResolveError)) throw err;
      names.push({ at: err.at ?? `${at}.decisions[${i}].set`, kind: err.kind, name: d.set, candidates: err.candidates });
    }
  });

  const unanswered = review.entries.filter((e) => !bySlId.has(e.slId));
  return { unanswered, names, setOf };
}

/**
 * Sync Variant Types for a set the way the dialog does on pick (forced), and
 * return its types. A failed sync over a set that already has types still
 * lets the dialog pick one, so it does here; with no types it throws.
 */
export async function syncSetTypesForReview(
  client: NbClient,
  setId: RowId,
  paused?: PausedContext,
): Promise<FunctionReturnType<typeof api.slSetReview.getVariantTypesOfSet>> {
  const res = await client.action(api.selectorOptions.ensureSelectorOptions, {
    level: "variantType",
    parentId: setId,
    force: true,
  });
  if (paused) assertPausedSidesDeclared(res.pausedSides as PlatformSide[], paused, "(variant types for the SportLots review)");
  const types = await client.query(api.slSetReview.getVariantTypesOfSet, { setId });
  if (res.reason === "error" && types.length === 0) {
    throw new Error(`Syncing the variant types of set ${setId} failed, and it has none to file under.`);
  }
  return types;
}

/** Apply the spec's SportLots review answers for one brand. */
export async function applySlReview(
  client: NbClient,
  manufacturerId: RowId,
  decisions: readonly SlDecision[],
  opts: SlReviewOptions = {},
): Promise<SlReviewOutcome> {
  const at = opts.at ?? "slReview";
  const path = opts.path ?? String(manufacturerId);
  let review = await readSlReview(client, manufacturerId);
  if (!review) return { outcome: "skipped", reason: "no-review" };

  // 1. Everything that can be checked without a write.
  const checked = checkSlDecisions(review, decisions, at, path);
  if (checked.unanswered.length > 0 || checked.names.length > 0) {
    return {
      outcome: "open",
      slReview: openSlRows(review, checked.unanswered, at, path),
      names: checked.names,
    };
  }

  // 2. The dialog syncs each picked set's variant types, then lists them.
  const syncedSets: RowId[] = [];
  const typeOf = new Map<string, RowId>();
  const names: OpenName[] = [];
  const typesBySet = new Map<string, Awaited<ReturnType<typeof syncSetTypesForReview>>>();
  for (const setId of new Set(checked.setOf.values())) {
    typesBySet.set(String(setId), await syncSetTypesForReview(client, setId, opts.paused));
    syncedSets.push(setId);
  }
  decisions.forEach((d, i) => {
    if (ownSet(d)) return;
    const setId = checked.setOf.get(d.slId)!;
    const types = typesBySet.get(String(setId)) ?? [];
    try {
      const type = pickExactlyOne(types, d.variantType, "variant type", `${at}.decisions[${i}].variantType`, (t) => t.role);
      typeOf.set(d.slId, type._id);
    } catch (err) {
      if (!(err instanceof ResolveError)) throw err;
      names.push({ at: err.at ?? `${at}.decisions[${i}].variantType`, kind: err.kind, name: d.variantType, candidates: err.candidates });
    }
  });
  if (names.length > 0) {
    return { outcome: "open", slReview: openSlRows(review, [], at, path), names };
  }

  const answers = new Map<string, SlReviewLineAnswer>();
  for (const d of decisions) {
    answers.set(
      d.slId,
      ownSet(d)
        ? {}
        : { setId: checked.setOf.get(d.slId), typeId: typeOf.get(d.slId), ...(d.name ? { typedName: d.name } : {}) },
    );
  }

  // 3. Save, ≤ MAX_REVIEW_DECISIONS lines a call, until the review is empty
  //    or a call stops making progress (refused lines stay in the review).
  const results: ApplySlReviewResult[] = [];
  let applied = 0;
  let remaining = review.entries.length;
  const maxCalls = Math.ceil(review.entries.length / MAX_REVIEW_DECISIONS) + 2;
  while (review && results.length < maxCalls) {
    const unanswered = review.entries.filter((e) => !answers.has(e.slId));
    if (unanswered.length > 0) {
      // Lines that appeared mid-run (another session's sync): never filed by default.
      return { outcome: "open", slReview: openSlRows(review, unanswered, at, path), names: [] };
    }
    const payload = buildSlReviewDecisions(review.entries, (e) => answers.get(e.slId)!);
    const result = await client.action(api.slSetReview.applySlSetReview, {
      manufacturerId,
      decisions: payload,
    });
    results.push(result);
    applied += result.sets + result.underType.insert + result.underType.parallel + result.underType.none;
    const before = remaining;
    remaining = result.remaining;
    review = await readSlReview(client, manufacturerId);
    if (!review || remaining === 0) break;
    if (remaining >= before && !result.incomplete) break;
  }

  const refusedLines = results.length > 0 ? results[results.length - 1].refused : [];
  return {
    outcome: "applied",
    applied,
    remaining,
    calls: results.length,
    results,
    refused:
      refusedLines.length > 0
        ? {
            at,
            path,
            rows: refusedLines.map((r) => ({
              slId: r.slId,
              name: r.label,
              suggestion: `refused "${r.name}" (${r.reason}${r.clashWith ? `: ${r.clashWith.value}` : ""})`,
            })),
          }
        : null,
    syncedSets,
  };
}
