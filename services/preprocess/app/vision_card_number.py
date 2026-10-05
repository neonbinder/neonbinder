"""A card number read from the orient step's Vision response, only when definitive.

NEO-327. Haiku misreads stylised card numbers (an outlined "No. 20" comes
back as 90), while Vision OCR has its own accuracy problems and was moved off
for that reason. The product rule (Jason, 2026-10-05): use OCR only when its
answer is absolutely definitive, otherwise Haiku. So this module answers
rarely and is never allowed to guess. Every doubt returns None, and None
means "use Haiku's number"; losing coverage is the safe direction.

It reads the `text_detection` response `detect_orientation` already paid for.
No extra Vision call is made.

The rule. A number is returned only when ALL of these hold:

1. Exactly one explicit card-number prefix in the whole image: a word
   `No.` / `No` / `#` (any case; `No` + a separate `.` word counts as one)
   followed on the same text line by a word matching `CARD_NUMBER_PATTERN`,
   or a single word such as `No.20` / `#20`. A second such pair anywhere
   (a bio's "the No. 1 pick" beside the real "No. 20") is ambiguous: None.
2. The follower is the NEAREST word after the prefix on its line, starts
   within `MAX_GAP_HEIGHTS` prefix heights of the prefix's end, runs in the
   same direction, and shares the line (vertical overlap of at least
   `MIN_LINE_OVERLAP`). Anything else between them: None.
3. The prefix sits in the outer `EDGE_BAND` of the image's text extent
   (the box around every word Vision found), on either axis. Card numbers
   live by an edge or corner; a mid-paragraph "No. 1" does not.
4. When Vision reports symbol confidences, every symbol in the prefix and
   the number is at least `MIN_SYMBOL_CONFIDENCE`. When it reports none
   (all zero, the protobuf default), the geometric rules above stand alone.

The side gate (never on an image the classifier calls front) lives with the
caller, `app.cropper`, which holds both results.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

# A card number token: "20", "RC-12", "RC12", "12A", "91TF-41", "US175".
CARD_NUMBER_PATTERN = re.compile(r"^(?:[A-Z]{0,4}-?\d{1,4}[A-Z]{0,2}|\d{1,3}[A-Z]{1,4}-\d{1,4})$")
_PREFIX_PATTERN = re.compile(r"^(?:no\.?|#)$", re.IGNORECASE)
_BARE_NO_PATTERN = re.compile(r"^no$", re.IGNORECASE)
_JOINED_PATTERN = re.compile(r"^(?:no\.?|#)(?P<number>.+)$", re.IGNORECASE)

MIN_SYMBOL_CONFIDENCE = 0.9
MAX_GAP_HEIGHTS = 1.5
MIN_LINE_OVERLAP = 0.5
EDGE_BAND = 0.2
# Same-direction test: cosine between the two words' baselines.
_MIN_DIRECTION_COS = 0.9


@dataclass(frozen=True)
class OcrWord:
    """One Vision word: its text, box corners [TL, TR, BR, BL] in text-local
    order (image pixels), and the lowest symbol confidence (None when Vision
    reported no confidences)."""

    text: str
    vertices: tuple[tuple[float, float], ...]
    confidence: float | None


def words_from_response(response) -> list[OcrWord]:
    """Words from a Vision `text_detection` response.

    Prefers `full_text_annotation` (it carries per-symbol confidence); falls
    back to the word-level `text_annotations[1:]` without confidence.
    """
    words: list[OcrWord] = []
    full = getattr(response, "full_text_annotation", None)
    pages = list(getattr(full, "pages", []) or []) if full is not None else []
    for page in pages:
        for block in page.blocks:
            for paragraph in block.paragraphs:
                for word in paragraph.words:
                    symbols = list(word.symbols)
                    text = "".join(s.text for s in symbols)
                    vertices = _vertices(word.bounding_box)
                    if not text or vertices is None:
                        continue
                    confidences = [float(s.confidence) for s in symbols]
                    confidence = min(confidences) if any(confidences) else None
                    words.append(OcrWord(text, vertices, confidence))
    if words:
        return words
    for annotation in list(getattr(response, "text_annotations", []) or [])[1:]:
        text = getattr(annotation, "description", "")
        vertices = _vertices(getattr(annotation, "bounding_poly", None))
        if text and vertices is not None:
            words.append(OcrWord(text, vertices, None))
    return words


def _vertices(poly) -> tuple[tuple[float, float], ...] | None:
    points = list(getattr(poly, "vertices", []) or [])
    if len(points) < 4:
        return None
    return tuple((float(p.x), float(p.y)) for p in points[:4])


def _sub(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    return (a[0] - b[0], a[1] - b[1])


def _dot(a: tuple[float, float], b: tuple[float, float]) -> float:
    return a[0] * b[0] + a[1] * b[1]


def _unit(v: tuple[float, float]) -> tuple[float, float] | None:
    length = math.hypot(*v)
    if length == 0:
        return None
    return (v[0] / length, v[1] / length)


@dataclass(frozen=True)
class _Frame:
    """A word's text-local frame: origin at its top-left, u along the
    baseline, n downward across the line."""

    origin: tuple[float, float]
    u: tuple[float, float]
    n: tuple[float, float]
    width: float
    height: float


def _frame(word: OcrWord) -> _Frame | None:
    tl, tr, _br, bl = word.vertices
    u = _unit(_sub(tr, tl))
    n = _unit(_sub(bl, tl))
    if u is None or n is None:
        return None
    return _Frame(tl, u, n, math.hypot(*_sub(tr, tl)), math.hypot(*_sub(bl, tl)))


def _project(frame: _Frame, word: OcrWord) -> tuple[float, float, float, float]:
    us = [_dot(_sub(p, frame.origin), frame.u) for p in word.vertices]
    ns = [_dot(_sub(p, frame.origin), frame.n) for p in word.vertices]
    return min(us), max(us), min(ns), max(ns)


def _next_on_line(words: list[OcrWord], index: int) -> int | None:
    """Index of the nearest word after `words[index]` on its text line, or
    None when nothing qualifies within the gap limit."""
    frame = _frame(words[index])
    if frame is None or frame.height == 0:
        return None
    best: tuple[float, int] | None = None
    for j, other in enumerate(words):
        if j == index:
            continue
        other_frame = _frame(other)
        if other_frame is None or _dot(other_frame.u, frame.u) < _MIN_DIRECTION_COS:
            continue
        u_min, _u_max, n_min, n_max = _project(frame, other)
        overlap = min(n_max, frame.height) - max(n_min, 0.0)
        if overlap < MIN_LINE_OVERLAP * min(frame.height, max(n_max - n_min, 1e-6)):
            continue
        gap = u_min - frame.width
        if gap < -0.2 * frame.height:
            continue
        if best is None or gap < best[0]:
            best = (gap, j)
    if best is None or best[0] > MAX_GAP_HEIGHTS * frame.height:
        return None
    return best[1]


def _in_edge_band(word: OcrWord, extent: tuple[float, float, float, float]) -> bool:
    x0, y0, x1, y1 = extent
    cx = sum(p[0] for p in word.vertices) / 4
    cy = sum(p[1] for p in word.vertices) / 4
    width, height = x1 - x0, y1 - y0
    near_x = width > 0 and min(cx - x0, x1 - cx) <= EDGE_BAND * width
    near_y = height > 0 and min(cy - y0, y1 - cy) <= EDGE_BAND * height
    return near_x or near_y


def _confident(*words: OcrWord) -> bool:
    return all(w.confidence is None or w.confidence >= MIN_SYMBOL_CONFIDENCE for w in words)


def _normalise(token: str) -> str | None:
    number = token.strip().upper()
    return number if CARD_NUMBER_PATTERN.match(number) else None


def card_number_from_words(words: list[OcrWord]) -> str | None:
    """The definitive card number in `words`, or None (see module rule)."""
    if not words:
        return None
    xs = [p[0] for w in words for p in w.vertices]
    ys = [p[1] for w in words for p in w.vertices]
    extent = (min(xs), min(ys), max(xs), max(ys))

    # Each candidate: (number, the words that must be confident, prefix word).
    candidates: list[tuple[str | None, tuple[OcrWord, ...], OcrWord]] = []
    for i, word in enumerate(words):
        text = word.text.strip()
        joined = _JOINED_PATTERN.match(text)
        if joined and not _PREFIX_PATTERN.match(text):
            number = _normalise(joined.group("number"))
            if number is not None:
                candidates.append((number, (word,), word))
            continue
        if not _PREFIX_PATTERN.match(text):
            continue
        follower = _next_on_line(words, i)
        parts: tuple[OcrWord, ...] = (word,)
        if follower is not None and _BARE_NO_PATTERN.match(text) and words[follower].text == ".":
            parts = (word, words[follower])
            follower = _next_on_line(words, follower)
        if follower is None:
            # A bare "No" is ordinary English ("No one..."); only an explicit
            # "No." or "#" with nothing after it on the line counts as a
            # prefix that failed to resolve.
            if not _BARE_NO_PATTERN.match(text):
                candidates.append((None, parts, word))
            continue
        number = _normalise(words[follower].text)
        if number is None and _BARE_NO_PATTERN.match(text) and len(parts) == 1:
            continue
        candidates.append((number, (*parts, words[follower]), word))

    if len(candidates) != 1:
        return None
    number, used, prefix = candidates[0]
    if number is None or not _confident(*used) or not _in_edge_band(prefix, extent):
        return None
    return number


def vision_card_number(response) -> str | None:
    """The definitive card number in a Vision `text_detection` response."""
    return card_number_from_words(words_from_response(response))
