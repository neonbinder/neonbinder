/**
 * NEO-220 — "how much work is in this pairing session?", as a pure function.
 *
 * The card pairing screen writes nothing until Confirm, so every dismissal path
 * (Escape, footer Cancel) is a silent discard of however long the operator has
 * spent linking, keeping and renaming. The confirm step in front of that
 * discard has to name a NUMBER — "Discard 14 pairings?" is a decision an
 * operator can make; "Discard your changes?" is one they have to guess at — and
 * a number that is wrong in the safe direction (0 when work exists) turns the
 * guard off entirely.
 *
 * So the count lives here rather than inline in the component: it is the one
 * piece of that guard worth pinning with tests of its own, and it must be
 * derivable from reducer state alone.
 *
 * ## What counts as an edit
 *
 *  - A MANUAL PAIR (`confidence === 0`) — the operator linked two columns.
 *  - A KEPT CARD, either side — a deliberate rescue from the discard-by-default
 *    rule, and the single most expensive thing to redo (a "Keep all" over a
 *    200-row column is one gesture the operator will not enjoy repeating).
 *  - A SETTLED NAME CONFLICT — `chosen` moved off the "bsc" default, or the
 *    operator typed their own name (`custom` present). BSC-and-untouched is the
 *    seeded default, so it is not evidence of anything.
 *  - An UNLINKED AUTO-PAIR — the server matched it, the operator took it apart.
 *    Invisible to every other signal: after the unlink both halves sit in the
 *    unmatched columns looking exactly like cards that never matched. Hence
 *    `seedMatchedKeys`, which the reducer carries for this and only this.
 *
 * Deliberately NOT counted: which sections are collapsed, filter text, or the
 * selection highlight. None of them survive Confirm, so none of them are work.
 *
 * Generic over the card type and given a `keyOf` rather than importing
 * `candidateKey`: the modal owns the card shape, and the import would point
 * back at the 2000-line component this module exists to stay out of.
 */

export type PairingNameConflictLike = {
  chosen: "bsc" | "sportlots" | "custom";
  custom?: string;
};

export type PairingMatchedLike<Card> = {
  card: Card;
  confidence: number;
  nameConflict?: PairingNameConflictLike;
};

export type PairingEditState<Card> = {
  matched: ReadonlyArray<PairingMatchedLike<Card>>;
  keptBsc: ReadonlyArray<unknown>;
  keptSl: ReadonlyArray<unknown>;
  /**
   * Keys of the pairs that arrived ALREADY matched — the seed plus everything
   * `ABSORB` has folded in since. Never removed, so a pair that leaves
   * `matched` is detectable by its absence rather than by a flag on a row that
   * no longer exists.
   */
  seedMatchedKeys: ReadonlySet<string>;
};

/** How many operator decisions this session would throw away. */
export function countPairingEdits<Card>(
  state: PairingEditState<Card>,
  keyOf: (card: Card) => string,
): number {
  let edits = state.keptBsc.length + state.keptSl.length;
  const stillMatched = new Set<string>();

  for (const pair of state.matched) {
    stillMatched.add(keyOf(pair.card));
    if (pair.confidence === 0) edits += 1;
    const conflict = pair.nameConflict;
    if (conflict && (conflict.chosen !== "bsc" || conflict.custom !== undefined)) {
      edits += 1;
    }
  }

  for (const key of state.seedMatchedKeys) {
    if (!stillMatched.has(key)) edits += 1;
  }

  return edits;
}
