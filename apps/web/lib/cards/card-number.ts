/**
 * Natural card-number ordering — "#2" before "#10", and "11" before "11b".
 *
 * A card number is not a number. It is a printed label: `1`, `11b`, `232C`,
 * `CC-JA`, `MIR-AJ`, `FS-1`. Sorting it as a string puts #10 before #2;
 * sorting it as an integer throws away everything after the digits, which is
 * exactly where a variation lives.
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
 *
 * ## NEO-200 — prefixed insert/parallel codes did not sort naturally
 *
 * The original implementation only tokenised a number that *started* with a
 * digit (`^(\d+)(.*)`); anything else — which is the normal shape for an
 * insert or parallel (`FS-1`, `CC-JA`, `MIR-AJ`) — fell straight through to
 * `localeCompare`, so a real "2024 Topps Chrome → Insert → Future Stars"
 * checklist sorted `FS-1, FS-10, FS-11, FS-2, FS-20, FS-3, FS-9` instead of
 * `FS-1, FS-2, FS-3, FS-9, FS-10, FS-11, FS-20`.
 *
 * The fix generalises the same idea to the whole string instead of only its
 * head: split into alternating runs of digits and non-digits ("tokens"), then
 * compare token by token — numerically where both sides are a digit run,
 * `localeCompare` where both are text. This is a superset of the old
 * behaviour (a card number that starts with digits and has no further digits
 * anywhere, e.g. `11b`, tokenises to the same two pieces the old regex
 * produced) and it now also handles a digit run anywhere else in the string:
 *
 *  - **Multi-segment codes** (`T206-1` vs `T206-10`): tokens are
 *    `["T", "206", "-", "1"]` vs `["T", "206", "-", "10"]` — the shared
 *    "T206-" prefix ties token-by-token and the final numeric token decides.
 *  - **A prefix with an internal digit** is exactly the case above; there is
 *    no separate "prefix" concept, just a sequence of tokens, so an internal
 *    digit run is compared numerically like any other.
 *  - **Mixed case** (`Rc-1` vs `rc-2`): the text tokens ("Rc-" / "rc-") are
 *    ordered with the same `localeCompare` the previous implementation used
 *    for a lettered code, so this is unchanged, not new behaviour.
 *  - **`FS-1` vs `FS-01`**: same numeric value, different printed width.
 *    These are NOT collapsed to equal — a comparator that returns 0 for two
 *    different strings makes `Array.prototype.sort` order them arbitrarily
 *    (unstable relative to whatever produced them), and callers upstream
 *    (`CardPairingModal.tsx`'s `compareCards`) rely on `compareCardNumbers`
 *    returning 0 *only* for equal card numbers to know a further tiebreak is
 *    needed. So: equal numeric value ties, then the shorter printed form
 *    (`1`) sorts before the zero-padded one (`01`) — the same "shorter comes
 *    first" rule already used for `11` vs `11b`.
 *
 * Two structural rules carry over unchanged from the original function:
 *
 *  - When the token sequences run out at different lengths with every shared
 *    token equal so far (`11` vs `11b`), the shorter one — the parent card —
 *    sorts first.
 *  - When the two token streams disagree in *kind* at the same position (one
 *    side has a digit run, the other has a text run, e.g. `1` vs `CC-JA`),
 *    the digit run sorts first — a numbered card sorts ahead of a lettered
 *    insert code, so the numeric run of a set reads top to bottom without
 *    codes interleaved. This is now evaluated at whichever token position the
 *    two strings first diverge, not only at position zero, so it keeps
 *    working if a shared prefix ties before the divergence.
 */

type CardNumberToken = { readonly kind: "digits" | "text"; readonly value: string };

function tokenizeCardNumber(value: string): CardNumberToken[] {
  const runs = value.match(/\d+|\D+/g) ?? [];
  return runs.map((run) => ({
    kind: /^\d+$/.test(run) ? "digits" : "text",
    value: run,
  }));
}

export function compareCardNumbers(a: string, b: string): number {
  if (a === b) return 0;

  const aTokens = tokenizeCardNumber(a);
  const bTokens = tokenizeCardNumber(b);
  const length = Math.max(aTokens.length, bTokens.length);

  for (let i = 0; i < length; i++) {
    const aToken = aTokens[i];
    const bToken = bTokens[i];

    // One side ran out of tokens with everything before this tied: the
    // shorter card number is the parent ("11" before "11b").
    if (!aToken) return -1;
    if (!bToken) return 1;

    if (aToken.kind !== bToken.kind) {
      // A digit run sorts ahead of a text run wherever the two diverge, so a
      // numbered card ("1") sorts ahead of a lettered insert code ("CC-JA")
      // even if they share a tied prefix first.
      return aToken.kind === "digits" ? -1 : 1;
    }

    if (aToken.kind === "digits") {
      const aNum = parseInt(aToken.value, 10);
      const bNum = parseInt(bToken.value, 10);
      if (aNum !== bNum) return aNum - bNum;
      // Same value, different printed width ("1" vs "01"): not equal, but
      // adjacent — shorter printed form first.
      if (aToken.value.length !== bToken.value.length) {
        return aToken.value.length - bToken.value.length;
      }
      continue;
    }

    const byText = aToken.value.localeCompare(bToken.value);
    if (byText !== 0) return byText;
  }

  // Every token compared equal (can only happen via a localeCompare that
  // treats two differently-cased runs as equivalent) but a !== b — fall back
  // to a stable, total ordering rather than reporting a tie for distinct
  // strings.
  return a < b ? -1 : 1;
}
