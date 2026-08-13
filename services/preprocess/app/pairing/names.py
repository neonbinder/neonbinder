"""Fuzzy player- and team-name matching — port of the helpers in cardPool.ts.

Card fronts and card backs almost never print a player's name identically.
Fronts favour a surname in isolation ("BUEHLER"), or an initialled first name
("P. MAHOMES"); backs carry the full legal name with suffixes ("Ken Griffey
Jr."). Matching them needs a normalisation pass plus a small ladder of
increasingly permissive comparisons, each of which reports whether it was an
*exact* hit — the caller scores exact and fuzzy hits differently.

Everything here is pure and string-only. It knows nothing about pooling.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Generational and ordinal suffixes, stripped so "Ken Griffey Jr." and
# "Ken Griffey" compare equal. The optional trailing "\.?" absorbs the period
# in "Jr." *before* punctuation stripping runs — see `normalize_player_name`
# for why that ordering is load-bearing.
#
# NOTE the lone `v` in the alternation: it is a Roman-numeral suffix (as in
# "Robert Griffin V"), but `\b(...|v)\b` will strip a standalone lowercase `v`
# from ANYWHERE in the name, so "Bobby V" normalises to "bobby". That quirk is
# ported verbatim from the TypeScript rather than silently corrected — the
# scoring thresholds downstream were tuned against this exact behaviour, and a
# quiet divergence here would show up as unexplained pairing drift.
#
# `re.I` mirrors the source's `gi` flags. It is technically redundant because
# the input is lowercased first, but it is kept so the constant reads the same
# as the original and stays correct if a caller ever passes raw text.
NAME_SUFFIX_RE = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b\.?", re.I)

# Punctuation dropped outright: periods in initials ("P. Mahomes"), hyphens in
# double-barrelled surnames, and apostrophes ("O'Neal"). Vision reads these
# inconsistently between a front's display type and a back's body copy.
PUNCTUATION_RE = re.compile(r"[.\-']")

# Collapses the runs of whitespace that suffix/punctuation removal leaves behind.
WHITESPACE_RE = re.compile(r"\s+")

# Minimum characters a truncated first name must have before it may prefix-match
# a longer one ("Rob" → "Robert"). One character is deliberately excluded here
# because the single-initial rule above it already handles that case with its
# own, stricter reasoning; allowing 1 here as well would make every "A. Smith"
# match every "Adam Smith" *and* every "Andrew Smith" through this branch.
MIN_PREFIX_CHARS = 2


@dataclass(frozen=True)
class NameMatch:
    """Whether two names refer to the same person, and how confidently.

    `exact` is only true for a post-normalisation string equality. Every other
    rung of the ladder (surname-only, initials, prefixes, containment) reports
    `match=True, exact=False`, which the scorer weights lower.
    """

    match: bool
    exact: bool


#: Reusable "no match" singleton — the ladder bails out to this from four places.
NO_MATCH = NameMatch(match=False, exact=False)


def normalize_player_name(name: str) -> str:
    """Lowercase, strip suffixes, strip punctuation, collapse whitespace.

    **The order matters and is not the obvious one.** Suffix stripping runs
    BEFORE punctuation stripping. `NAME_SUFFIX_RE` matches an optional trailing
    period, so it removes "Jr." whole while the period is still present. Strip
    punctuation first and "Jr." has already become "Jr", which still matches —
    but "Jr." at the very end of a string relies on the period for its `\\b`
    boundary in several real inputs, and reversing the two steps regresses
    exactly the case the suffix rule exists for. Ported in source order.
    """
    lowered = name.lower()
    without_suffix = NAME_SUFFIX_RE.sub("", lowered)
    without_punctuation = PUNCTUATION_RE.sub("", without_suffix)
    return WHITESPACE_RE.sub(" ", without_punctuation).strip()


def last_name(normalized: str) -> str:
    """Last whitespace-separated token of an already-normalized name."""
    return normalized.split(" ")[-1]


def player_names_match(a: str, b: str) -> NameMatch:
    """Compare two player names through the full permissiveness ladder.

    Rungs, in order — the first one to fire wins:

    1. Exact string equality after normalisation.
    2. Surnames differ → definitively not a match. Everything below assumes
       the surnames already agree.
    3. One first name is a single initial that prefixes the other
       ("P. Mahomes" ↔ "Patrick Mahomes").
    4. One side is surname-only ("BUEHLER" ↔ "Walker Buehler"). With no first
       name available to contradict the surname hit, this is a match. Before
       this rung existed it fell through the two-part gate below and returned
       nothing, which is what made surname-only fronts unpairable.
    5. One first name prefixes the other with at least `MIN_PREFIX_CHARS`
       ("Rob" ↔ "Robert"). Otherwise the first names genuinely disagree and
       this is not a match, surname agreement notwithstanding.
    """
    na = normalize_player_name(a)
    nb = normalize_player_name(b)

    # 1 — exact after normalisation.
    if na == nb:
        return NameMatch(match=True, exact=True)

    # 2 — surnames must agree for anything below to be considered.
    if last_name(na) != last_name(nb):
        return NO_MATCH

    parts_a = na.split(" ")
    parts_b = nb.split(" ")
    first_a = parts_a[0]
    first_b = parts_b[0]

    # 3 — abbreviated first name: "p" matches "patrick".
    if len(first_a) == 1 and first_b.startswith(first_a):
        return NameMatch(match=True, exact=False)
    if len(first_b) == 1 and first_a.startswith(first_b):
        return NameMatch(match=True, exact=False)

    # 4 — surname-only on either side.
    if len(parts_a) == 1 or len(parts_b) == 1:
        return NameMatch(match=True, exact=False)

    # 5 — truncated first name, e.g. "Rob" vs "Robert".
    shorter, longer = (first_a, first_b) if len(first_a) <= len(first_b) else (first_b, first_a)
    if len(shorter) >= MIN_PREFIX_CHARS and longer.startswith(shorter):
        return NameMatch(match=True, exact=False)

    # Surnames agreed but the first names are genuinely different people.
    return NO_MATCH


def team_names_match(a: str, b: str) -> NameMatch:
    """Compare two team names by equality, then by containment either way.

    Containment carries the load here: a front usually prints only the
    nickname ("Chiefs") while a back spells out the full club ("Kansas City
    Chiefs"). No normalisation beyond case-folding and trimming — team names
    do not carry suffixes or initials, and stripping punctuation would fuse
    distinct names more often than it would help.
    """
    na = a.lower().strip()
    nb = b.lower().strip()

    if na == nb:
        return NameMatch(match=True, exact=True)
    if na in nb or nb in na:
        return NameMatch(match=True, exact=False)

    return NO_MATCH
