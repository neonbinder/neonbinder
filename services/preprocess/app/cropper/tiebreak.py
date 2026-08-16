"""Ask Haiku which of two near-identical crops is better.

**Why this exists.** The cascade scores candidates on card-aspect error and,
within `CASCADE_ASPECT_SIGNIFICANCE_BAND`, prefers the outermost. That rule is
right most of the time and wrong in a way geometry cannot see: "the whole card
is present and nothing else" is a visual judgement, and every proxy tried for
it has failed somewhere. Aspect error is blind to a crop sitting inside the
card. Area cannot tell card from background. Edge support rewards busy edges,
so a crop slicing through artwork outscores one bounded by quiet card border —
measured, it picked correctly on 1 of 5 known cases.

**Why it is only a tie-breaker.** Haiku is not reliable enough to lead. On the
same five cases it scored 4/5, and its miss chose a crop with the bottom line
of copyright text sliced through — the one failure mode that cannot be undone
downstream. So it is never allowed to overrule a decisive geometric signal; it
speaks only where the geometry has already declared the candidates equally
card-shaped AND they differ materially in what they kept. On the corpus that
is 10.6% of images (24 of 227); without the materiality test it would be 66%,
which is not a tie-break at all.

**It fails safe.** Any error, timeout, unparseable reply or unrecognised
choice returns None, and the caller keeps the geometric winner. Disabled
unless `CROP_TIEBREAK_ENABLED=1`.
"""

from __future__ import annotations

import base64
import io
import logging
import os
from io import BytesIO

from PIL import Image

logger = logging.getLogger(__name__)

ENABLED_ENV = "CROP_TIEBREAK_ENABLED"

DEFAULT_MODEL = "claude-haiku-4-5-20251001"

# Candidates whose kept-area differs by less than this are not worth asking
# about — they are the same crop give or take a few pixels, and the geometric
# rule resolves them fine. This is what keeps the call rare: 10.6% of the
# corpus at 0.10, against 66% with no materiality test at all.
MIN_AREA_DIFFERENCE = 0.10

# The judgement is about framing, not detail, so a small image is plenty and
# keeps the request cheap.
MAX_SIDE_PX = 700

MAX_TOKENS = 64

# Letters used to label candidates in the prompt.
LABELS = "ABCDEFG"

PROMPT = """These are candidate crops of the SAME trading card, produced by different algorithms.

Pick the ONE that is the best crop, judging in this priority order:

1. The ENTIRE card must be present. Any clipping — a printed border shaved, a
   corner cut, text running off an edge — disqualifies a candidate outright,
   however tidy it otherwise looks. These get printed full bleed to the cut
   line, so a lost edge cannot be recovered.
2. Among candidates that keep the whole card, prefer the least surrounding
   background (scanner bed, desk, other cards).
3. Prefer the card square to the frame rather than tilted.

Answer with ONLY the letter of your choice."""


def is_enabled() -> bool:
    """Off unless explicitly switched on. See the module docstring."""
    return os.environ.get(ENABLED_ENV) == "1"


def _area(image_bytes: bytes) -> float:
    try:
        with Image.open(BytesIO(image_bytes)) as img:
            return float(img.width * img.height)
    except Exception:  # noqa: BLE001
        return 0.0


def differ_materially(candidates: list[tuple[str, bytes]]) -> bool:
    """Do these candidates disagree enough for the choice to matter?

    Compares kept area, which is the axis they actually differ on once the
    band has already declared them equally card-shaped.
    """
    areas = [_area(blob) for _label, blob in candidates]
    if len(areas) < 2:
        return False
    largest = max(areas)
    if largest <= 0:
        return False
    return (largest - min(areas)) / largest > MIN_AREA_DIFFERENCE


def _shrink(image_bytes: bytes) -> str:
    with Image.open(BytesIO(image_bytes)) as img:
        img = img.convert("RGB")
        img.thumbnail((MAX_SIDE_PX, MAX_SIDE_PX), Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        img.save(buffer, format="JPEG", quality=80)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def pick_best(
    candidates: list[tuple[str, bytes]],
    *,
    client: object | None = None,
    model: str = DEFAULT_MODEL,
) -> str | None:
    """Return the winning candidate's label, or None to keep the geometric pick.

    Candidates are presented as lettered images with their strategy names
    withheld, so a standing preference for a particular cropper cannot pass
    itself off as judgement.
    """
    if len(candidates) < 2:
        return None

    try:
        import anthropic

        ai_client = client or anthropic.Anthropic()

        content: list[dict] = []
        for index, (_label, blob) in enumerate(candidates):
            content.append({"type": "text", "text": f"Candidate {LABELS[index]}:"})
            content.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": _shrink(blob),
                    },
                }
            )
        content.append({"type": "text", "text": PROMPT})

        response = ai_client.messages.create(  # type: ignore[attr-defined]
            model=model,
            max_tokens=MAX_TOKENS,
            messages=[{"role": "user", "content": content}],
        )
        text = (response.content[0].text or "").strip()
    except Exception as exc:  # noqa: BLE001
        logger.warning("tiebreak: Haiku call failed (%s) — keeping geometric pick", exc)
        return None

    if not text:
        return None
    choice = text[0].upper()
    valid = LABELS[: len(candidates)]
    if choice not in valid:
        logger.info("tiebreak: unparseable reply %r — keeping geometric pick", text[:40])
        return None

    winner = candidates[valid.index(choice)][0]
    logger.info("tiebreak: Haiku chose %s from %d candidates", winner, len(candidates))
    return winner
