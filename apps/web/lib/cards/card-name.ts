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

import { foldDiacritics } from "../entities/normalize-name";

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
  // NEO-253: the fold itself comes from `lib/entities/normalize-name.ts`, which
  // is now the entity dedup key's home too. This function was the ONLY place in
  // the codebase that folded before that ticket, which is exactly how the
  // divergence stayed invisible: the pairing modal stopped flagging accents
  // while `players.nameNormalized` was still shredding them. The two keys are
  // still deliberately different past the fold (this one drops hyphens and
  // keeps word order; the dedup key keeps hyphens and sorts), but they must not
  // be able to disagree about what an accent IS.
  return foldDiacritics(name)
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

/**
 * NEO-251 — do the two marketplaces agree about the LIST of players on a card?
 *
 * `conflictingNames` above answers the same question about the card's TITLE.
 * This one exists because the title and the player list are not the same field
 * and do not fail the same way. BSC hands back a structured `players[]`;
 * SportLots hands back one subject string that `parseSlSubjects` splits into
 * 1–4 names. A card whose two sides carry the same title can still carry a
 * different roster — "Alec Bohm|Spencer Howard" parsed to two players against a
 * BSC row that lists only Bohm — and `players = bsc.players ?? sl.players`
 * throws the longer list away without saying so. Those names become
 * `playerIds`, which is what a listing title is generated from, so the
 * disagreement surfaces to a buyer rather than to the operator.
 *
 * Jason, 2026-09-05: "If both BSC and SL return a player name and they don't
 * match we should surface that as a contention like we already do."
 */

/** A roster disagreement, each marketplace's list exactly as it spelled it. */
export type PlayersDisagreement = {
  /** BSC's players for the card, verbatim. */
  bsc: string[];
  /** SportLots' players for the same card, likewise verbatim. */
  sportlots: string[];
};

/**
 * Reduce a LIST of names to its meaning, insensitive to order at BOTH levels.
 *
 * Two levels, because two different orderings are noise here and neither is
 * worth an operator's glance:
 *
 *  1. WITHIN a name. BSC files a multi-subject card as "Bohm, Alec" on some
 *     rows and "Alec Bohm" on others; SportLots is consistently given-name
 *     first. Sorting the tokens of one name makes those one key.
 *  2. ACROSS the list. The two sides enumerate co-subjects in whatever order
 *     their own page did, and no NB behaviour depends on that order at
 *     creation time — `commitCardChecklist` resolves each name independently.
 *
 * That is a deliberate DIVERGENCE from `nameKey`, where word order is kept
 * significant. `nameKey` compares two single strings, and there a reordering is
 * a real signal ("Mike Trout|Shohei Ohtani" vs "Shohei Ohtani|Mike Trout" on
 * one title is worth a look). Here the list is already split, so the same
 * reordering carries no information at all and would flag a large fraction of
 * every multi-subject card in a set. A warning nobody reads is the same as no
 * warning.
 *
 * Empty and whitespace-only entries drop out rather than contributing an empty
 * key: "no name" is not a player, and an adapter that emits one must not be
 * able to make two identical rosters compare unequal.
 */
export function playersKey(names: string[]): string {
  return names
    .map((name) => nameKey(name).split(" ").filter(Boolean).sort().join(" "))
    .filter((key) => key.length > 0)
    .sort()
    .join("|");
}

/**
 * The two player lists for one card, if and only if they disagree.
 *
 * A SUBSET counts as a disagreement, and that is the motivating case rather
 * than an edge one: SportLots' "Mike Yastrzemski|Carl Yastrzemski" against
 * BSC's bare "Mike Yastrzemski" is precisely the row NEO-199 was opened for,
 * one field over. Treating "BSC's list is contained in SportLots'" as
 * agreement would silence exactly the rows the control exists to catch, and
 * neither side is authoritative — NB owns the answer, and an operator settles
 * it.
 *
 * A side with NO players is not a disagreement. There is nothing to decide,
 * and the merge already falls through to whichever side has a list — the same
 * rule `conflictingNames` follows, for the same reason: a two-option control
 * on a row with one real option is noise.
 *
 * Names come back as the marketplace spelled them, not folded. The fold
 * decides whether to speak; the operator is then shown the real strings.
 */
export function conflictingPlayers(
  bscPlayers: string[] | undefined,
  slPlayers: string[] | undefined,
): PlayersDisagreement | undefined {
  const bsc = (bscPlayers ?? []).map((n) => n.trim()).filter(Boolean);
  const sportlots = (slPlayers ?? []).map((n) => n.trim()).filter(Boolean);
  if (bsc.length === 0 || sportlots.length === 0) return undefined;
  if (playersKey(bsc) === playersKey(sportlots)) return undefined;
  return { bsc, sportlots };
}
