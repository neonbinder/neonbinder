/**
 * Natural card-number ordering — "#2" before "#10", and "11" before "11b".
 *
 * A card number is not a number. It is a printed label: `1`, `11b`, `232C`,
 * `CC-JA`, `MIR-AJ`. Sorting it as a string puts #10 before #2; sorting it as
 * an integer throws away everything after the digits, which is exactly where a
 * variation lives.
 *
 * ## Why this lives in lib/ rather than being copied
 *
 * It had three homes: `convex/selectorOptions.ts`, `components/SetSelector/
 * CardChecklist.tsx`, and — once the pairing modal started streaming — very
 * nearly a third in `CardPairingModal.tsx`. The component copy carried a note
 * explaining the duplication as unavoidable because "convex/ is a separate
 * deploy/typecheck unit and the frontend shouldn't pull server modules in for
 * twelve lines."
 *
 * That reasoning is right about convex/ and wrong about the conclusion: `lib/`
 * is neither side's server code, and convex already imports from it (see
 * lib/cards/variations.ts). One home, imported by both, pulls no server module
 * into the browser and removes the drift.
 *
 * Drift here is not cosmetic. The checklist and the pairing modal show the same
 * cards, and if their orderings disagree the operator reviews a set in one
 * order and then finds it saved in another.
 */
export function compareCardNumbers(a: string, b: string): number {
  const aMatch = a.match(/^(\d+)(.*)/);
  const bMatch = b.match(/^(\d+)(.*)/);
  if (aMatch && bMatch) {
    const aNum = parseInt(aMatch[1], 10);
    const bNum = parseInt(bMatch[1], 10);
    if (aNum !== bNum) return aNum - bNum;
    // Same stem: the suffix orders the card and its variations, so "11" sorts
    // before "11b" before "11c".
    return aMatch[2].localeCompare(bMatch[2]);
  }
  // A numbered card sorts ahead of a lettered insert code ("CC-JA"), so the
  // numeric run of a set reads top to bottom without codes interleaved.
  if (aMatch && !bMatch) return -1;
  if (!aMatch && bMatch) return 1;
  return a.localeCompare(b);
}
