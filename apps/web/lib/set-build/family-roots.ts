/**
 * NEO-339 — Group Parallels' one card-number rule, shared by the modal and the
 * set-building draft (`tools/setbuild/runner/draft.ts`).
 *
 * The prefix rule (`detectGroupings`) puts "Future Stars Autographs" and its
 * SuperFractor, Red and Orange under "Future Stars", though the autographs are
 * an insert of their own. A name cannot tell that apart from "X Orange" /
 * "X Orange Wave" (both parallels of X), so only card numbers can: when a
 * family root's cards share no number with its parent's, it is its own root
 * (Jason, 2026-10-19), and its family groups under it. With no evidence, the
 * plain prefix rule stands.
 *
 * What counts as evidence is decided here, once:
 *   - each row's cards come from a read-only checklist preview
 *     (`selectorOptions.previewCardChecklist`);
 *   - a row that already holds cards, a row that cannot be previewed, a failed
 *     preview, or a preview with no cards is no evidence;
 *   - numbers are folded as a parallel build matches them (`cardKey` in
 *     convex/lib/parallelCardLink.ts: trimmed, upper-cased), and only OVERLAP
 *     is read: no number is ever taken as a key (CLAUDE.md invariant 7).
 * Callers differ only in how they reach a preview: the draft previews rows
 * that do not exist yet (cold), the modal previews saved rows.
 *
 * Pure and env-free: no React, no `convex/react`, no `process.env`, and only
 * relative imports (type imports aside), so a Node script can load it.
 */

import {
  buildInitialState,
  type InitialGrouping,
  type InsertTree,
  type RowId,
} from "./grouping";

/** As much of `previewCardChecklist`'s result as the card numbers need. */
export type PreviewNumbers = {
  matched: ReadonlyArray<{ card: { cardNumber: string } }>;
  bscOnly: ReadonlyArray<{ cardNumber: string }>;
  slOnly: ReadonlyArray<{ cardNumber: string }>;
};

/** Every card number a preview lists, matched, BSC-only and SportLots-only alike. */
export function previewCardNumbers(p: PreviewNumbers): string[] {
  return [
    ...p.matched.map((m) => m.card.cardNumber),
    ...p.bscOnly.map((c) => c.cardNumber),
    ...p.slOnly.map((c) => c.cardNumber),
  ];
}

const foldNumber = (n: string) => n.trim().toUpperCase();

/**
 * Whether two checklists share at least one card number, folded the way a
 * parallel build matches them (trimmed, upper-cased). Overlap only. Pure.
 */
export function sharesACardNumber(a: readonly string[], b: readonly string[]): boolean {
  const seen = new Set(a.map(foldNumber).filter(Boolean));
  return b.some((n) => seen.has(foldNumber(n)));
}

/**
 * The decision: true when both rows' cards are known and share no number (the
 * root is its own), false when they share one, undefined when either side has
 * no cards to compare (an empty list is no evidence: nothing to share is not
 * "shares nothing").
 */
export function cardsStandApart(
  parentNumbers: readonly string[] | undefined,
  rootNumbers: readonly string[] | undefined,
): boolean | undefined {
  const known = (n: readonly string[] | undefined) =>
    n !== undefined && n.some((x) => foldNumber(x) !== "");
  if (!known(parentNumbers) || !known(rootNumbers)) return undefined;
  return !sharesACardNumber(parentNumbers!, rootNumbers!);
}

/** How a caller reaches one row's cards. */
export type RowCardSource<R> = {
  /** Cards the row already holds; a row with none yet answers 0. */
  cardsHeld: (row: R) => Promise<number>;
  /** Its preview, or undefined when it cannot be previewed or the preview failed. */
  preview: (row: R) => Promise<PreviewNumbers | undefined>;
};

/** One row's previewed card numbers, or undefined when it gives no evidence. */
export async function rowCardNumbers<R>(row: R, source: RowCardSource<R>): Promise<string[] | undefined> {
  if ((await source.cardsHeld(row)) > 0) return undefined;
  const preview = await source.preview(row);
  return preview ? previewCardNumbers(preview) : undefined;
}

/**
 * Whether a family root stands apart from its parent: the parent is read
 * first, and the root is not read at all when the parent gives no evidence.
 */
export async function familyRootStandsApart<R>(
  parent: R | undefined,
  root: R | undefined,
  source: RowCardSource<R>,
): Promise<boolean | undefined> {
  if (parent === undefined || root === undefined) return undefined;
  const parentNumbers = await rowCardNumbers(parent, source);
  if (parentNumbers === undefined) return undefined;
  const rootNumbers = await rowCardNumbers(root, source);
  return cardsStandApart(parentNumbers, rootNumbers);
}

export type FamilyRootGrouping = InitialGrouping & {
  /** The roots held top level, in the order they were weighed, with the parent each was suggested under. */
  held: Array<{ root: RowId; parent: RowId }>;
};

/**
 * `buildInitialState` with every reported family root weighed by
 * `standsApart(root, parent)`: a root it answers `true` for is held top level
 * (`holdFamilyRoots`) and the tree is rebuilt, which can report new roots
 * inside the remaining families; each row is weighed once. `false` or
 * `undefined` leaves the plain prefix rule. The same loop for the modal and
 * the draft, so both open on the same grouping for the same evidence.
 */
export async function groupWithFamilyRootEvidence(
  tree: InsertTree,
  standsApart: (root: RowId, parent: RowId) => Promise<boolean | undefined>,
): Promise<FamilyRootGrouping> {
  const hold = new Set<RowId>();
  const weighed = new Set<RowId>();
  const held: Array<{ root: RowId; parent: RowId }> = [];
  let init = buildInitialState(tree, { holdFamilyRoots: hold });
  for (;;) {
    let changed = false;
    for (const [root, parent] of init.familyRoots) {
      if (weighed.has(root)) continue;
      weighed.add(root);
      if ((await standsApart(root, parent)) !== true) continue;
      hold.add(root);
      held.push({ root, parent });
      changed = true;
    }
    if (!changed) break;
    init = buildInitialState(tree, { holdFamilyRoots: hold });
  }
  return { ...init, held };
}
