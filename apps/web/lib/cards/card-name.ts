/**
 * NEO-189 / NEO-199 — do the two marketplaces agree about WHO IS ON a card?
 *
 * This lives in `lib/` rather than in the modal because BOTH sides of the wire
 * have to answer the question the SAME way, and there is only one path on which
 * they can: the auto-matched merge happens in `fetchCardChecklist`
 * (`convex/selectorOptions.ts`), the manual merge happens in
 * `CardPairingModal`, and an operator has no way to tell which of the two
 * produced the row in front of them. A second implementation would mean an
 * auto-matched conflict and a hand-linked one were different things, and the
 * one that is wrong would be the one nobody re-reads.
 *
 * The motivating case, from live 2021 Topps data: SportLots has
 * "Mike Yastrzemski|Carl Yastrzemski · SSSP" where BSC has a bare
 * "#227c Mike Yastrzemski". The card is CARL — a "Legend" short print whose
 * variation pictures a different player than the base card, which is a standard
 * modern convention (2021 Topps #52 is Archie Bradley; 52b/c/d are Mickey
 * Mantle). `cardName: bsc.cardName || sl.cardName` dropped the fact that it is
 * Carl, and the first anyone hears of it is a returned listing.
 *
 * Nothing here GUESSES which name is right. That is the rule the whole
 * variations feature runs on — `resolveVariationParents` reports
 * `unresolvedStems` rather than picking a parent, `suggestVariationPairings`
 * leaves un-confident pairs alone. This reports the disagreement; a human
 * settles it.
 */

/** A disagreement, with each marketplace's name exactly as it spelled it. */
export type NameDisagreement = {
  /** BSC's name for the card, verbatim. */
  bsc: string;
  /** SportLots' name for the same card, likewise verbatim. */
  sportlots: string;
};

/**
 * Reduce a marketplace name to its MEANING rather than its spelling.
 *
 * BSC joins multiple players with " / " and SportLots with "|"; one prints
 * "Ken Griffey Jr." and the other "Ken Griffey Jr"; BSC routinely strips the
 * accents SportLots keeps ("Jose" / "José Ramírez"). Flagging any of those as a
 * disagreement would bury the real ones under noise, and a warning nobody reads
 * is the same as no warning — on the auto-matched path especially, where a
 * 660-row set would arrive with hundreds of false flags on it. Diacritics are
 * folded, then everything that is not a letter or digit collapses to a single
 * space, so only the words themselves are compared.
 *
 * Word ORDER is deliberately still significant: two sources listing the same
 * players in a different order on a multi-player card is worth a glance, and
 * this control costs a glance, not a click.
 */
export function nameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The two names for one card, if and only if they disagree.
 *
 * Applies to EVERY merged pair, not only `isVariation` ones. Two reasons the
 * narrower variation-only scope was rejected:
 *
 *  1. The wrong-player-on-a-listing failure is not exclusive to variations. A
 *     fuzzy 0.92 Jaro-Winkler auto-match, or an operator clicking one row off
 *     in a 660-row column, merges two genuinely different players into one
 *     card — and the name disagreement is the ONLY signal that it happened.
 *     Suppressing it there throws away the cheapest mis-pair detector this
 *     screen has, and the fuzzy match is on the AUTO path, where no human saw
 *     the two rows next to each other at all.
 *  2. `isVariation` is exactly the field that is unreliable on the row that
 *     motivated this. BSC filed #227c with an EMPTY variation description;
 *     gating on a flag the defect report shows to be under-populated risks the
 *     fix not firing on its own motivating example.
 *
 * The cost of the wider scope is bounded because this is not a gate: a correct
 * pairing agrees on the name almost always, and a false positive costs one
 * glance.
 *
 * A side with no name at all is not a disagreement — there is nothing to
 * decide, and every merge already falls through to whichever side has one.
 */
export function conflictingNames(
  bscName: string | undefined,
  slName: string | undefined,
): NameDisagreement | undefined {
  const bsc = (bscName ?? "").trim();
  const sportlots = (slName ?? "").trim();
  if (!bsc || !sportlots) return undefined;
  if (nameKey(bsc) === nameKey(sportlots)) return undefined;
  return { bsc, sportlots };
}
