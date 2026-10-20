// Prefix-only auto-grouping for inserts that look like parallels of one
// another. Marketplaces return rows like "Baseball Stars Autographs",
// "Baseball Stars Autographs Gold", "Baseball Stars Autographs Red"
// as flat siblings; this detects the shorter row as the base insert
// and the longer rows as parallels of it.

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type DetectionInput<TId extends string> = {
  _id: TId;
  value: string;
};

export type DetectionResult<TId extends string> = {
  // For each parent insert id, the inserts that should become parallels under it.
  suggestions: Map<TId, TId[]>;
  // Inserts that have no detected parent (and weren't claimed as a parent themselves).
  ungroupedSelfStanding: Set<TId>;
  // Inserts identified as parents (have at least one suggested child).
  parents: Set<TId>;
  // NEO-339 — rows suggested as a child that root a family of their own
  // (see below), not held back: row id → the parent they were suggested under.
  familyRoots: Map<TId, TId>;
  // NEO-339 — the `holdFamilyRoots` rows actually held back: id → the parent
  // the plain rule would have put them under.
  heldFamilyRoots: Map<TId, TId>;
};

export type DetectionOptions<TId extends string> = {
  /**
   * Family roots the caller has EVIDENCE stand apart from their prefix
   * parent (the two rows' previewed checklists share no card number:
   * `groupWithFamilyRootEvidence` in lib/set-build/family-roots.ts, which the
   * set-build draft runs and the modal runs on "Check card numbers"). Each
   * stays top level and its own family groups under it. Absent, the plain
   * prefix rule decides every row.
   */
  holdFamilyRoots?: ReadonlySet<TId>;
};

// Detect groupings using common-prefix matching.
//
// `excludeAsChild` lets the caller pass ids that must not be selected as
// children — typically inserts that already have parallels beneath them
// (turning them into parallels would orphan their existing parallels).
//
// Algorithm:
// 1. Normalize each insert's display value.
// 2. Sort by normalized length ascending so shorter (potential parent)
//    names are scanned first.
// 3. For each insert B (longer), find the longest A whose normalized name
//    is a strict prefix of B's followed by a separator. If found, B is a
//    candidate child of A.
// 4. Anything with no parent and no children stays in `ungroupedSelfStanding`.
//
// NEO-339 — A FAMILY ROOT, HELD BACK ONLY ON EVIDENCE. Step 3 puts "Future
// Stars Autographs" AND its SuperFractor, Red and Orange under "Future
// Stars", though the autographs are their own insert (other card numbers).
// The name cannot tell that case from "X Orange" / "X Orange Wave", which
// are both parallels of X, so the prefix rule stays the rule. A row suggested
// as a child that another candidate extends by a word ("Future Stars
// Autographs Red" extends "Future Stars Autographs") is reported in
// `familyRoots`; a caller with evidence (previewed cards sharing no number)
// names it in `holdFamilyRoots`, and only then does it stay top level, its
// own family grouping under it by the same longest-prefix step. One family is
// one level: a row whose best parent is a held root is never a root itself
// ("X Autographs Gold Wave" goes under "X Autographs"). With no
// `holdFamilyRoots` the suggestions are exactly the plain rule's.
export function detectGroupings<TId extends string>(
  inserts: ReadonlyArray<DetectionInput<TId>>,
  excludeAsChild: ReadonlySet<TId> = new Set(),
  opts: DetectionOptions<TId> = {},
): DetectionResult<TId> {
  const hold = opts.holdFamilyRoots ?? new Set<TId>();
  const normalized = inserts.map((it) => ({
    _id: it._id,
    norm: normalizeName(it.value),
  }));
  // Rows another candidate (one that may become a child) extends by a word.
  const extended = new Set<TId>();
  for (const a of normalized) {
    if (!a.norm) continue;
    const prefix = a.norm + " ";
    for (const b of normalized) {
      if (b._id === a._id || excludeAsChild.has(b._id)) continue;
      if (b.norm.startsWith(prefix)) {
        extended.add(a._id);
        break;
      }
    }
  }

  // Sort by length ascending for stable parent-before-child evaluation.
  const byLength = [...normalized].sort((a, b) => a.norm.length - b.norm.length);

  const suggestions = new Map<TId, TId[]>();
  const parents = new Set<TId>();
  const claimedAsChild = new Set<TId>();
  const familyRoots = new Map<TId, TId>();
  const heldFamilyRoots = new Map<TId, TId>();

  for (const child of byLength) {
    if (excludeAsChild.has(child._id)) continue;

    // Find the longest other normalized name that is a strict prefix.
    let bestParent: TId | null = null;
    let bestLen = -1;
    for (const candidate of byLength) {
      if (candidate._id === child._id) continue;
      if (candidate.norm.length >= child.norm.length) continue;
      const prefix = candidate.norm + " ";
      if (!child.norm.startsWith(prefix)) continue;
      // Don't choose a parent that is itself already a child of someone
      // — keeps the tree at depth 1 (insert → parallels, no chains).
      if (claimedAsChild.has(candidate._id)) continue;
      if (candidate.norm.length > bestLen) {
        bestLen = candidate.norm.length;
        bestParent = candidate._id;
      }
    }

    if (bestParent) {
      // A family root (see above): held back only when the caller has
      // evidence; reported either way. Inside a held family, never a root.
      const root = extended.has(child._id) && !heldFamilyRoots.has(bestParent);
      if (root && hold.has(child._id)) {
        heldFamilyRoots.set(child._id, bestParent);
        continue;
      }
      if (root) familyRoots.set(child._id, bestParent);
      const list = suggestions.get(bestParent) ?? [];
      list.push(child._id);
      suggestions.set(bestParent, list);
      parents.add(bestParent);
      claimedAsChild.add(child._id);
    }
  }

  const ungroupedSelfStanding = new Set<TId>();
  for (const it of normalized) {
    if (parents.has(it._id)) continue;
    if (claimedAsChild.has(it._id)) continue;
    ungroupedSelfStanding.add(it._id);
  }

  return { suggestions, ungroupedSelfStanding, parents, familyRoots, heldFamilyRoots };
}
