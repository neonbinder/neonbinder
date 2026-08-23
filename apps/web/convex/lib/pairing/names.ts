/**
 * Fuzzy player- and team-name matching — port of the helpers in cardPool.ts
 * (via the preprocess service's audited Python port, `app/pairing/names.py`).
 *
 * Card fronts and card backs almost never print a player's name identically.
 * Fronts favour a surname in isolation ("BUEHLER"), or an initialled first
 * name ("P. MAHOMES"); backs carry the full legal name with suffixes ("Ken
 * Griffey Jr."). Matching them needs a normalisation pass plus a small ladder
 * of increasingly permissive comparisons, each of which reports whether it
 * was an *exact* hit — the caller scores exact and fuzzy hits differently.
 *
 * Everything here is pure and string-only. It knows nothing about pooling.
 */

/**
 * Generational and ordinal suffixes, stripped so "Ken Griffey Jr." and
 * "Ken Griffey" compare equal. The optional trailing `\.?` absorbs the period
 * in "Jr." *before* punctuation stripping runs — see `normalizePlayerName`
 * for why that ordering is load-bearing.
 *
 * NOTE the lone `v` in the alternation: it is a Roman-numeral suffix (as in
 * "Robert Griffin V"), but `\b(...|v)\b` will strip a standalone lowercase
 * `v` from ANYWHERE in the name, so "Bobby V" normalises to "bobby". That
 * quirk is ported verbatim from the original TypeScript rather than silently
 * corrected — the scoring thresholds downstream were tuned against this exact
 * behaviour, and a quiet divergence here would show up as unexplained pairing
 * drift.
 *
 * The `i` flag mirrors the source's `gi` flags. It is technically redundant
 * because the input is lowercased first, but it is kept so the constant reads
 * the same as the original and stays correct if a caller ever passes raw
 * text.
 */
const NAME_SUFFIX_RE = /\b(jr|sr|ii|iii|iv|v)\b\.?/gi;

/**
 * Punctuation dropped outright: periods in initials ("P. Mahomes"), hyphens
 * in double-barrelled surnames, and apostrophes ("O'Neal"). OCR reads these
 * inconsistently between a front's display type and a back's body copy.
 */
const PUNCTUATION_RE = /[.\-']/g;

/** Collapses the runs of whitespace that suffix/punctuation removal leaves behind. */
const WHITESPACE_RE = /\s+/g;

/**
 * Minimum characters a truncated first name must have before it may
 * prefix-match a longer one ("Rob" → "Robert"). One character is deliberately
 * excluded here because the single-initial rule above it already handles that
 * case with its own, stricter reasoning; allowing 1 here as well would make
 * every "A. Smith" match every "Adam Smith" *and* every "Andrew Smith"
 * through this branch.
 */
export const MIN_PREFIX_CHARS = 2;

/**
 * Whether two names refer to the same person, and how confidently.
 *
 * `exact` is only true for a post-normalisation string equality. Every other
 * rung of the ladder (surname-only, initials, prefixes, containment) reports
 * `match: true, exact: false`, which the scorer weights lower.
 */
export interface NameMatch {
  match: boolean;
  exact: boolean;
}

/** Reusable "no match" singleton — the ladder bails out to this from four places. */
export const NO_MATCH: NameMatch = Object.freeze({ match: false, exact: false });

/**
 * Lowercase, strip suffixes, strip punctuation, collapse whitespace.
 *
 * **The order matters and is not the obvious one.** Suffix stripping runs
 * BEFORE punctuation stripping. `NAME_SUFFIX_RE` matches an optional trailing
 * period, so it removes "Jr." whole while the period is still present. Strip
 * punctuation first and "Jr." has already become "Jr", which still matches —
 * but "Jr." at the very end of a string relies on the period for its `\b`
 * boundary in several real inputs, and reversing the two steps regresses
 * exactly the case the suffix rule exists for. Ported in source order.
 */
export function normalizePlayerName(name: string): string {
  const lowered = name.toLowerCase();
  const withoutSuffix = lowered.replace(NAME_SUFFIX_RE, "");
  const withoutPunctuation = withoutSuffix.replace(PUNCTUATION_RE, "");
  return withoutPunctuation.replace(WHITESPACE_RE, " ").trim();
}

/** Last whitespace-separated token of an already-normalized name. */
export function lastName(normalized: string): string {
  const parts = normalized.split(" ");
  return parts[parts.length - 1];
}

/**
 * Compare two player names through the full permissiveness ladder.
 *
 * Rungs, in order — the first one to fire wins:
 *
 * 1. Exact string equality after normalisation.
 * 2. Surnames differ → definitively not a match. Everything below assumes
 *    the surnames already agree.
 * 3. One first name is a single initial that prefixes the other
 *    ("P. Mahomes" ↔ "Patrick Mahomes").
 * 4. One side is surname-only ("BUEHLER" ↔ "Walker Buehler"). With no first
 *    name available to contradict the surname hit, this is a match. Before
 *    this rung existed it fell through the two-part gate below and returned
 *    nothing, which is what made surname-only fronts unpairable.
 * 5. One first name prefixes the other with at least `MIN_PREFIX_CHARS`
 *    ("Rob" ↔ "Robert"). Otherwise the first names genuinely disagree and
 *    this is not a match, surname agreement notwithstanding.
 */
export function playerNamesMatch(a: string, b: string): NameMatch {
  const na = normalizePlayerName(a);
  const nb = normalizePlayerName(b);

  // 1 — exact after normalisation.
  if (na === nb) {
    return { match: true, exact: true };
  }

  // 2 — surnames must agree for anything below to be considered.
  if (lastName(na) !== lastName(nb)) {
    return NO_MATCH;
  }

  const partsA = na.split(" ");
  const partsB = nb.split(" ");
  const firstA = partsA[0];
  const firstB = partsB[0];

  // 3 — abbreviated first name: "p" matches "patrick".
  if (firstA.length === 1 && firstB.startsWith(firstA)) {
    return { match: true, exact: false };
  }
  if (firstB.length === 1 && firstA.startsWith(firstB)) {
    return { match: true, exact: false };
  }

  // 4 — surname-only on either side.
  if (partsA.length === 1 || partsB.length === 1) {
    return { match: true, exact: false };
  }

  // 5 — truncated first name, e.g. "Rob" vs "Robert".
  const [shorter, longer] =
    firstA.length <= firstB.length ? [firstA, firstB] : [firstB, firstA];
  if (shorter.length >= MIN_PREFIX_CHARS && longer.startsWith(shorter)) {
    return { match: true, exact: false };
  }

  // Surnames agreed but the first names are genuinely different people.
  return NO_MATCH;
}

/**
 * Compare two team names by equality, then by containment either way.
 *
 * Containment carries the load here: a front usually prints only the
 * nickname ("Chiefs") while a back spells out the full club ("Kansas City
 * Chiefs"). No normalisation beyond case-folding and trimming — team names
 * do not carry suffixes or initials, and stripping punctuation would fuse
 * distinct names more often than it would help.
 */
export function teamNamesMatch(a: string, b: string): NameMatch {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();

  if (na === nb) {
    return { match: true, exact: true };
  }
  if (nb.includes(na) || na.includes(nb)) {
    return { match: true, exact: false };
  }

  return NO_MATCH;
}
