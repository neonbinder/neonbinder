"""FAST-role frame-content identity (NEO-399): a tight scan with no stated size.

`scan_meta` settles a card-sized scan from the scanner's own resolution, and
`tiered.fast_tiered_crop` settles a frame whose top classical component fills
it. A tightly auto-cropped scan that carries no trustworthy resolution falls
between the two: the classical pass calls it `weak` (it finds nothing it is
sure of, because there is no background to find), `quad.quad_crop` finds no
supported outline (`no_quad` / `weak_edges`), and the frame used to escalate
to the HEAVY role, whose ~40 s BiRefNet pass then returned it untouched.

This stage answers the same identity question from the frame's content, on
the pixels alone, and only ever returns the input untouched. It is consulted
only when every earlier stage has already pointed this way:

  1. the frame is card-aspect (`tiered.FRAME_CARD_WINDOW`) and, tighter, within
     ASPECT_WINDOW of 2.5:3.5 (96% of real tight scans are);
  2. the classical verdict is `weak`: not `frame` (already settled), not
     `margin` (a card-shaped component with structure beyond it), and not a
     crop (classical found a card inside the frame);
  3. the quad stage declined with `no_quad` or `weak_edges`: it found no
     supported card outline inside the frame.

Then, side by side, profiles taken across the middle of each side (corners
excluded) must show a card's printed border running to the frame edge:

  ring            the band RING_SKIP..RING_END in from the edge is the ring
                  colour (`tiered.border_bg_lab`): a uniform border at least
                  RING_END deep, not artwork or texture. Rows inside RING_SKIP
                  are the scanner's own sliver (the dark line a few pixels
                  deep along the leading edge of a scan) and are never judged.
  no_content      no row out to CONTENT_SEARCH differs from the ring colour:
                  a blank frame, or a card too small for it.
  edge_in_margin  a line runs parallel to the side between RING_SKIP and the
                  content row (a card edge, or its shadow, inside the frame
                  means card plus bed), or the content starts abruptly across
                  the whole of every side at once (a card's cut edge on a
                  wood or mat bed, which printing inside a border never does).
  inset           the first content row is further in than INSET_MAX.

## The bound on extra margin

Jason's ruling (NEO-399): a little extra border is acceptable, never more
than a few pixels. What the checks guarantee, at the ~1000 px short side of a
400 dpi card scan:

  - A visible edge (shadow line, cut, colour step) is a coherent gradient
    line parallel to the side; `edge_in_margin` declines one anywhere from
    RING_SKIP inward, so the accepted extra margin is at most RING_SKIP
    (0.6% of the card's width, ~6 px). RING_SKIP is not smaller because
    real tight scans carry a 3-7 px scanner sliver on their leading edge.
  - An edge that leaves no trace at all (a border the exact colour and
    texture of the bed) is not in the pixels. What still bounds it is
    INSET_MAX: a uniform margin deepens every inset, so it is accepted only
    while the card's deepest printed inset plus the margin stays within
    INSET_MAX. For the intake backs (deepest inset ~5.3%) that is a few px;
    for a card whose printed border is shallow on every side it is more.
    No pixel rule closes this without declining the stage's whole coverage:
    real tight scans show no edge evidence at all on most sides.

Any doubt declines, and a decline is not an error: the frame escalates to the
HEAVY role exactly as it did before this stage existed. The constants were
calibrated together with `scripts/eval_frame_content.py`; re-run it rather
than adjusting one alone.

Public API: `frame_content_identity(image_bytes, *, classical_reason,
quad_reason) -> FrameContentResult`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np

from app.cropper import quad, tiered

logger = logging.getLogger(__name__)

# ── Preconditions ───────────────────────────────────────────────────────────

# The classical verdict and quad decline reasons this stage may follow.
CLASSICAL_REASONS: frozenset[str] = frozenset({"weak"})
QUAD_REASONS: frozenset[str] = frozenset({"no_quad", "weak_edges"})

# |short/long - 2.5/3.5| a frame may sit from card aspect (tighter than
# `tiered.FRAME_CARD_WINDOW`, which is the precondition for the classical
# identity question at all).
ASPECT_WINDOW = 0.006

# ── Profiles (fractions of the work frame's short side) ─────────────────────

SPAN = (0.12, 0.88)  # sampled stretch of each side; corners excluded
SAMPLES = 160  # sample points along each side
RING_SKIP = 0.006  # the scanner's sliver at the frame edge, never judged
RING_END = 0.015  # the band RING_SKIP..RING_END must be the ring colour
RING_DIST = 16.0  # LAB distance (L weighted 0.5) under which a pixel is ring colour
RING_MIN = 0.95  # fraction of a side's ring band that must be ring colour
CONTENT_DIST = 16.0  # LAB distance at which a pixel differs from the ring colour
CONTENT_ROW_MIN = 0.05  # fraction of a row that must differ for it to be content
CONTENT_SEARCH = 0.25  # how far in the content row is looked for
ONSET_ROWS = 2  # rows past the content row its onset is read over
ONSET_MAX = 0.6  # every side's content starting this abruptly => a cut edge
INSET_MAX = 0.06  # the content row may be no further in than this
EDGE_GAP = 0.004  # rows just outside the content row the edge search leaves out
EDGE_FLOOR = 3.0  # gradient a margin line must reach...
EDGE_RATIO = 3.0  # ...and this x the margin's median gradient
EDGE_COHERENCE = 0.15  # fraction of a row's samples on the line => an edge

DECLINE_REASONS: tuple[str, ...] = (
    "undecodable",
    "not_card_aspect",
    "classical_verdict",
    "quad_reason",
    "aspect",
    "ring",
    "no_content",
    "edge_in_margin",
    "inset",
    "error",
)

SIDES = ("top", "bottom", "left", "right")


@dataclass(frozen=True)
class FrameContentResult:
    """Outcome of `frame_content_identity`.

    `accepted` is True when the frame IS the card and should be returned
    untouched; `reason` is "ok" then, else the check that declined.
    `diagnostics` holds the measured numbers (per side, work-resolution rows
    and full-resolution px), never image data.
    """

    accepted: bool
    reason: str
    diagnostics: dict[str, Any] = field(default_factory=dict)


def _side_grid(img: np.ndarray, side: str, rows: int) -> np.ndarray:
    """`rows` rows of `img` inward from one side, as (row, sample[, ch]).

    Row 0 is the frame edge; samples run along the side over SPAN.
    """
    h, w = img.shape[:2]
    if side in ("top", "bottom"):
        cols = np.linspace(SPAN[0] * (w - 1), SPAN[1] * (w - 1), SAMPLES).round().astype(int)
        idx = np.arange(rows) if side == "top" else h - 1 - np.arange(rows)
        return img[idx][:, cols]
    ys = np.linspace(SPAN[0] * (h - 1), SPAN[1] * (h - 1), SAMPLES).round().astype(int)
    idx = np.arange(rows) if side == "left" else w - 1 - np.arange(rows)
    return img[ys][:, idx].swapaxes(0, 1)


def _measure_side(
    lab: np.ndarray, grad: np.ndarray, ring: np.ndarray, side: str, short: int
) -> dict[str, Any]:
    """Ring fraction, content row and strongest margin line for one side."""
    rows = max(4, int(CONTENT_SEARCH * short))
    dist = quad._lab_dist(_side_grid(lab, side, rows), ring)
    differs = (dist >= CONTENT_DIST).mean(axis=1)

    # Rows inside RING_SKIP are the scanner's sliver and are never judged.
    skip = max(1, int(np.ceil(RING_SKIP * short)))
    r1 = max(skip + 1, int(round(RING_END * short)))
    ring_frac = float((dist[skip:r1] < RING_DIST).mean())

    hits = np.nonzero(differs[skip:] >= CONTENT_ROW_MIN)[0]
    content = int(skip + hits[0]) if len(hits) else None
    # How much of the side differs just past the content row: printed
    # content starts ragged, a card's cut edge on a bed starts all at once.
    onset = 0.0
    if content is not None:
        onset = float(differs[content : content + ONSET_ROWS + 1].max())

    # The margin between the sliver and the content row: any coherent line
    # parallel to the side is a card edge or its shadow.
    edge_row, edge_coh = None, 0.0
    stop = (content if content is not None else rows) - int(np.ceil(EDGE_GAP * short))
    if stop - skip >= 1:
        # One row either side of the window so its first and last rows can
        # register as peaks too.
        vals = _side_grid(grad, side, stop + 1)[skip - 1 : stop + 1].astype(np.float32)
        floor = max(EDGE_FLOOR, EDGE_RATIO * float(np.median(vals[1:-1])))
        coh = quad._peak_rows(vals, np.ones_like(vals, dtype=bool), floor)[1:-1]
        k = int(np.argmax(coh))
        edge_row, edge_coh = skip + k, float(coh[k])
    return {
        "ring": round(ring_frac, 3),
        "content_row": content,
        "onset": round(onset, 3),
        "edge_row": edge_row,
        "edge": round(edge_coh, 3),
    }


def _measure(work: np.ndarray) -> tuple[dict[str, dict[str, Any]], np.ndarray]:
    lab = cv2.cvtColor(work, cv2.COLOR_BGR2LAB).astype(np.float32)
    ring = tiered.border_bg_lab(lab)
    grad = quad._gradient(work)
    short = min(work.shape[:2])
    return {s: _measure_side(lab, grad, ring, s, short) for s in SIDES}, ring


def _verdict(
    work: np.ndarray, scale: float, classical_reason: str, quad_reason: str
) -> FrameContentResult:
    h, w = work.shape[:2]
    short = min(h, w)
    aspect = short / max(h, w)
    diag: dict[str, Any] = {
        "aspect": round(aspect, 4),
        "classical": classical_reason,
        "quad": quad_reason,
    }

    def decline(reason: str) -> FrameContentResult:
        return FrameContentResult(False, reason, diag)

    if abs(aspect - tiered.CARD_ASPECT) > tiered.FRAME_CARD_WINDOW:
        return decline("not_card_aspect")
    if classical_reason not in CLASSICAL_REASONS:
        return decline("classical_verdict")
    if quad_reason not in QUAD_REASONS:
        return decline("quad_reason")

    sides, ring = _measure(work)
    diag["ring_lab"] = [round(float(v), 1) for v in ring]
    diag["sides"] = sides
    # Insets in full-resolution px, for logs and the evaluation.
    diag["inset_px"] = {
        s: (None if v["content_row"] is None else round(v["content_row"] / scale))
        for s, v in sides.items()
    }
    if abs(aspect - tiered.CARD_ASPECT) > ASPECT_WINDOW:
        return decline("aspect")
    if min(v["ring"] for v in sides.values()) < RING_MIN:
        return decline("ring")
    if any(v["content_row"] is None for v in sides.values()):
        return decline("no_content")
    # A line seen in the margin is the more specific finding, so it is named
    # ahead of a margin that is merely too deep.
    if max(v["edge"] for v in sides.values()) >= EDGE_COHERENCE:
        return decline("edge_in_margin")
    # Content that starts across the whole width of every side at once is a
    # card's cut edge on a bed (wood, a mat), not printing inside a border.
    if min(v["onset"] for v in sides.values()) >= ONSET_MAX:
        return decline("edge_in_margin")
    if max(v["content_row"] for v in sides.values()) > INSET_MAX * short:
        return decline("inset")
    return FrameContentResult(True, "ok", diag)


def frame_content_identity(
    image_bytes: bytes, *, classical_reason: str, quad_reason: str
) -> FrameContentResult:
    """Is this frame already the card, judged from its content?

    `classical_reason` is the second element of `tiered.fast_tiered_verdict`
    and `quad_reason` is `quad.quad_crop(...).reason` for the same bytes.
    Never raises: an undecodable image or an internal failure is a decline.
    """
    # The preconditions are the earlier stages' verdicts: checked before any
    # decode, so a frame they rule out costs nothing here.
    if classical_reason not in CLASSICAL_REASONS:
        return FrameContentResult(False, "classical_verdict", {"classical": classical_reason})
    if quad_reason not in QUAD_REASONS:
        return FrameContentResult(False, "quad_reason", {"quad": quad_reason})
    try:
        _full, work, scale = tiered._load(image_bytes)
    except Exception as exc:  # noqa: BLE001
        logger.warning("frame_content: cannot open image: %s", exc)
        return FrameContentResult(False, "undecodable")
    try:
        return _verdict(work, scale, classical_reason, quad_reason)
    except Exception:
        logger.exception("frame_content: check failed")
        return FrameContentResult(False, "error")
