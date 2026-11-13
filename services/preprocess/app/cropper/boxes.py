"""The box a crop stage cut, in the `PhotoEdit` geometry (NEO-481).

`/process-entry` reports the winning stage's box as `crop_box`, so the photo
editor can open on the auto crop and a collector's first save reproduces it.
The box is in the pixels of the image the cascade was given (the EXIF-uprighted
original), with the convention of `app.edit`: centre, size, and an angle in
degrees clockwise whose box's own top edge is the crop's top. It describes the
crop BEFORE the orientation turn; the editor's `turns` carry that.

Strategies return bytes, not geometry, so each one that cuts a box reports it
here through `record`, and `cropper.crop` reads it with `recording`. A stage
that reports nothing (a test double, a client's own crop) simply has no box.

A recorded box can be approximate: a perspective warp (`quad`, the tiered quad
route) is described by the rectangle that best fits its four corners, and a
crop's padding can overhang the frame. `fit_inside` shrinks such a box about
its centre until it lies inside the frame, so a reported box always renders.
"""

from __future__ import annotations

import math
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, replace

import numpy as np

# A box this much smaller than measured is not the stage's crop any more: it is
# dropped rather than reported.
MIN_FIT_SCALE = 0.8

# An overhang this small is float noise, not a box past the frame: such a box
# is reported exactly as measured, so a whole-frame box stays the whole frame
# and renders without resampling.
FIT_EPSILON_PX = 1e-9


@dataclass(frozen=True)
class CropBox:
    cx: float
    cy: float
    w: float
    h: float
    angle: float
    src_w: int
    src_h: int


def normalize_angle(degrees: float) -> float:
    """The same angle in (-180, 180]."""
    angle = math.fmod(degrees, 360.0)
    if angle <= -180.0:
        angle += 360.0
    elif angle > 180.0:
        angle -= 360.0
    return angle


def full_frame(src_w: int, src_h: int) -> CropBox:
    """The whole image: what an identity stage (and the passthrough) returns."""
    return CropBox(
        cx=src_w / 2,
        cy=src_h / 2,
        w=float(src_w),
        h=float(src_h),
        angle=0.0,
        src_w=src_w,
        src_h=src_h,
    )


def from_axis_rect(
    left: float, top: float, right: float, bottom: float, src_w: int, src_h: int
) -> CropBox | None:
    """An upright rectangle, as PIL's `crop((left, top, right, bottom))` takes it."""
    if right - left <= 0 or bottom - top <= 0:
        return None
    return CropBox(
        cx=(left + right) / 2,
        cy=(top + bottom) / 2,
        w=float(right - left),
        h=float(bottom - top),
        angle=0.0,
        src_w=src_w,
        src_h=src_h,
    )


def from_rotated_rect(
    cx: float, cy: float, w: float, h: float, angle_cw: float, src_w: int, src_h: int
) -> CropBox | None:
    """A rectangle whose width runs `angle_cw` degrees clockwise from the x axis.

    That is OpenCV's `minAreaRect` angle, and the angle `getRotationMatrix2D`
    takes to bring such a rectangle upright.
    """
    if w <= 0 or h <= 0:
        return None
    return CropBox(
        cx=float(cx),
        cy=float(cy),
        w=float(w),
        h=float(h),
        angle=normalize_angle(float(angle_cw)),
        src_w=src_w,
        src_h=src_h,
    )


def from_quad(quad: np.ndarray, src_w: int, src_h: int) -> CropBox | None:
    """The rectangle best fitting four corners ordered clockwise from the top-left.

    The order is `tiered.order_quad`'s, and the one a perspective warp maps onto
    an upright canvas: corner 0 to its top-left, corner 1 to its top-right. So
    the top edge runs from corner 0 to corner 1.
    """
    q = np.asarray(quad, dtype=np.float64).reshape(4, 2)
    top = q[1] - q[0]
    width = (np.linalg.norm(q[1] - q[0]) + np.linalg.norm(q[2] - q[3])) / 2
    height = (np.linalg.norm(q[3] - q[0]) + np.linalg.norm(q[2] - q[1])) / 2
    centre = q.mean(axis=0)
    angle = math.degrees(math.atan2(float(top[1]), float(top[0])))
    return from_rotated_rect(
        float(centre[0]), float(centre[1]), float(width), float(height), angle, src_w, src_h
    )


def turned_ccw(box: CropBox) -> CropBox:
    """The box once its crop is turned a quarter counter-clockwise.

    Croppers turn a landscape crop to portrait this way. The crop's right edge
    becomes its top, so the box's top edge now points a quarter further
    clockwise and its sides trade places.
    """
    return replace(box, w=box.h, h=box.w, angle=normalize_angle(box.angle + 90.0))


def fit_inside(box: CropBox | None) -> CropBox | None:
    """The box shrunk about its centre until it lies inside its frame.

    None when there is no box, its centre is outside the frame, or it would have
    to shrink below `MIN_FIT_SCALE` of its measured size.
    """
    if box is None:
        return None
    values = (box.cx, box.cy, box.w, box.h, box.angle)
    if not all(math.isfinite(v) for v in values) or box.w <= 0 or box.h <= 0:
        return None
    lo_x, hi_x = 0.0, float(box.src_w)
    lo_y, hi_y = 0.0, float(box.src_h)
    if not (lo_x < box.cx < hi_x and lo_y < box.cy < hi_y):
        return None
    rad = math.radians(box.angle)
    cos_a, sin_a = math.cos(rad), math.sin(rad)
    scale = 1.0
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        dx = sx * box.w / 2 * cos_a - sy * box.h / 2 * sin_a
        dy = sx * box.w / 2 * sin_a + sy * box.h / 2 * cos_a
        for offset, centre, lo, hi in ((dx, box.cx, lo_x, hi_x), (dy, box.cy, lo_y, hi_y)):
            if centre + offset > hi + FIT_EPSILON_PX:
                scale = min(scale, (hi - centre) / offset)
            elif centre + offset < lo - FIT_EPSILON_PX:
                scale = min(scale, (centre - lo) / -offset)
    if scale < MIN_FIT_SCALE:
        return None
    if scale >= 1.0:
        return box
    return replace(box, w=box.w * scale, h=box.h * scale)


# ── Recording ───────────────────────────────────────────────────────────────


class _Recorder:
    __slots__ = ("box",)

    def __init__(self) -> None:
        self.box: CropBox | None = None


_current: ContextVar[_Recorder | None] = ContextVar("crop_box_recorder", default=None)


@contextmanager
def recording() -> Iterator[_Recorder]:
    """Collect the box the stage run inside this block reports, if any."""
    recorder = _Recorder()
    token = _current.set(recorder)
    try:
        yield recorder
    finally:
        _current.reset(token)


def record(box: CropBox | None) -> None:
    """Report the box a stage just cut. A no-op outside `recording`."""
    recorder = _current.get()
    if recorder is not None:
        recorder.box = box
