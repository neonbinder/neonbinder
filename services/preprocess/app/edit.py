"""A collector's hand edit of a card photo: quarter turns and a turnable crop (NEO-481).

The edit is the `PhotoEdit` contract every part of NeonBinder builds to:

    turns   quarter turns clockwise, 0..3, applied last
    crop    None (the whole source), or a box in source pixels:
            cx, cy  its centre
            w, h    its size
            angle   degrees clockwise, in (-180, 180]; the box's own top edge
                    becomes the output's top
            srcW, srcH  the frame those numbers were measured in

The output is the content of the box (or the whole source), turned by `turns`.
`app.copy_photos` then fits it to the listing and thumbnail sizes.

**Coordinates are continuous.** The source's top-left corner is (0, 0) and its
bottom-right corner is (W, H), so pixel (i, j) covers [i, i+1) x [j, j+1) and
its centre is (i + 0.5, j + 0.5). Pillow's affine transform samples the same
way, which is what makes an upright, pixel-aligned box an exact crop.

**One geometry, two languages.** The web editor (`apps/web/lib/photo-edit/
geometry.ts`) draws the same box the service cuts. Both read the golden cases in
`apps/web/lib/photo-edit/golden.json` (parameters in, the box's corners in the
source and the output's sizes out), so the two cannot drift. Sizes round
half up (`floor(x + 0.5)`), the same in both: Python's `round` is banker's
rounding and JavaScript's `Math.round` is not, so neither is used.

**Quarter turns are exact.** A turn is a transpose, a pixel permutation with no
resampling, and so is a box whose angle is a multiple of 90 degrees and whose
edges fall on pixel boundaries. Only a box at any other angle is resampled
(bicubic).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from PIL import Image

# A box may overhang the frame by this much and still render: a client's clamp
# and the service's arithmetic can disagree in the last bit. Anything further
# out is refused rather than filled with a colour the card never had.
FRAME_TOLERANCE_PX = 0.5

# How far the source's aspect may differ from the edit's frame and still be the
# same picture at another size (a stored 1600 px copy of a 4000 px scan).
FRAME_ASPECT_TOLERANCE = 0.01

# An angle within this of a multiple of 90 degrees takes the exact path.
_RIGHT_ANGLE_EPSILON = 1e-9
# A box edge within this of a whole pixel counts as on the pixel grid.
_GRID_EPSILON = 1e-6

# Clockwise quarter turns as Pillow transposes (Pillow's ROTATE_90 is
# counter-clockwise).
_CLOCKWISE_TURNS = {
    1: Image.Transpose.ROTATE_270,
    2: Image.Transpose.ROTATE_180,
    3: Image.Transpose.ROTATE_90,
}


class EditError(ValueError):
    """An edit that cannot be rendered against this source. `code` is the wire code."""

    code = "INVALID_EDIT"


class EditFrameMismatchError(EditError):
    """The source is not the frame the edit was measured in, at any scale."""

    code = "EDIT_FRAME_MISMATCH"


class EditOutOfFrameError(EditError):
    """The box reaches outside the source."""

    code = "EDIT_OUT_OF_FRAME"


@dataclass(frozen=True)
class EditCrop:
    cx: float
    cy: float
    w: float
    h: float
    angle: float
    src_w: int
    src_h: int


@dataclass(frozen=True)
class PhotoEdit:
    turns: int
    crop: EditCrop | None


Point = tuple[float, float]


@dataclass(frozen=True)
class EditPlan:
    """Where an edit's output comes from, in the actual source's pixels.

    `corners` are the box's own top-left, top-right, bottom-right and
    bottom-left in the source, before `turns` (the whole frame when there is
    no crop), as `golden.json` states them. `out_w` x `out_h` is
    the output's size at source resolution, after `turns`, before any fitting
    to the listing sizes. These are exactly what `golden.json` pins.

    `box` is the box scaled into the actual source (None for the whole
    source), and `crop_w` x `crop_h` its rendered size before `turns`.
    """

    corners: tuple[Point, Point, Point, Point]
    out_w: int
    out_h: int
    crop_w: int
    crop_h: int
    box: EditCrop | None
    turns: int


def round_half_up(value: float) -> int:
    """`floor(x + 0.5)`: the rounding the web editor uses too."""
    return math.floor(value + 0.5)


def opening_turns(rotation_degrees: int | None) -> int:
    """The editor's opening `turns` for a scan with no edit yet (NEO-481 Q5).

    `rotation_degrees` is the pipeline's counter-clockwise rotation; turns are
    clockwise. Opening on this reproduces today's output from the auto crop.
    """
    ccw = (rotation_degrees or 0) % 360
    return round_half_up(((360 - ccw) % 360) / 90) % 4


def _rotate(dx: float, dy: float, angle_degrees: float) -> Point:
    """Rotate (dx, dy) clockwise on screen (y down) by `angle_degrees`."""
    rad = math.radians(angle_degrees)
    cos_a, sin_a = math.cos(rad), math.sin(rad)
    return (dx * cos_a - dy * sin_a, dx * sin_a + dy * cos_a)


def box_corners(box: EditCrop) -> tuple[Point, Point, Point, Point]:
    """The box's own top-left, top-right, bottom-right, bottom-left, in its frame."""
    half_w, half_h = box.w / 2, box.h / 2
    out: list[Point] = []
    for dx, dy in ((-half_w, -half_h), (half_w, -half_h), (half_w, half_h), (-half_w, half_h)):
        rx, ry = _rotate(dx, dy, box.angle)
        out.append((box.cx + rx, box.cy + ry))
    return (out[0], out[1], out[2], out[3])


def _scaled_box(crop: EditCrop, source_w: int, source_h: int) -> EditCrop:
    """The box in the actual source's pixels, scaled uniformly from its own frame."""
    scale_w = source_w / crop.src_w
    scale_h = source_h / crop.src_h
    if abs(scale_w - scale_h) > FRAME_ASPECT_TOLERANCE * max(scale_w, scale_h):
        raise EditFrameMismatchError(
            f"source is {source_w}x{source_h}, not a scale of the edit's "
            f"{crop.src_w}x{crop.src_h} frame"
        )
    scale = scale_w
    return EditCrop(
        cx=crop.cx * scale,
        cy=crop.cy * scale,
        w=crop.w * scale,
        h=crop.h * scale,
        angle=crop.angle,
        src_w=source_w,
        src_h=source_h,
    )


def plan_edit(edit: PhotoEdit, source_w: int, source_h: int) -> EditPlan:
    """Work out an edit's geometry against a source of this size.

    Raises `EditError` (or a subclass) for an edit that cannot be rendered:
    turns outside 0..3, a box of no size, a source that is not the edit's
    frame, or a box reaching outside the source.
    """
    if edit.turns not in (0, 1, 2, 3):
        raise EditError("turns must be 0, 1, 2 or 3")
    if source_w < 1 or source_h < 1:
        raise EditError("source has no pixels")

    box: EditCrop | None = None
    if edit.crop is None:
        corners = ((0.0, 0.0), (float(source_w), 0.0), (float(source_w), float(source_h)))
        corners = (*corners, (0.0, float(source_h)))
        crop_w, crop_h = source_w, source_h
    else:
        values = (edit.crop.cx, edit.crop.cy, edit.crop.w, edit.crop.h, edit.crop.angle)
        if not all(math.isfinite(v) for v in values):
            raise EditError("crop values must be finite")
        if edit.crop.w <= 0 or edit.crop.h <= 0:
            raise EditError("crop must have a size")
        if edit.crop.src_w < 1 or edit.crop.src_h < 1:
            raise EditError("crop frame must have a size")
        if not -180 < edit.crop.angle <= 180:
            raise EditError("crop angle must be in (-180, 180]")
        box = _scaled_box(edit.crop, source_w, source_h)
        corners = box_corners(box)
        for x, y in corners:
            if not (
                -FRAME_TOLERANCE_PX <= x <= source_w + FRAME_TOLERANCE_PX
                and -FRAME_TOLERANCE_PX <= y <= source_h + FRAME_TOLERANCE_PX
            ):
                raise EditOutOfFrameError("crop reaches outside the source")
        crop_w = max(1, round_half_up(box.w))
        crop_h = max(1, round_half_up(box.h))

    turns = edit.turns
    out_w, out_h = (crop_h, crop_w) if turns % 2 else (crop_w, crop_h)
    return EditPlan(
        corners=(corners[0], corners[1], corners[2], corners[3]),
        out_w=out_w,
        out_h=out_h,
        crop_w=crop_w,
        crop_h=crop_h,
        box=box,
        turns=turns,
    )


_RIGHT_ANGLE_TRANSPOSES: dict[int, Image.Transpose | None] = {
    0: None,
    1: Image.Transpose.ROTATE_90,
    2: Image.Transpose.ROTATE_180,
    -1: Image.Transpose.ROTATE_270,
}


def _right_angle_quarters(angle: float) -> int | None:
    """Quarters clockwise (-1, 0, 1 or 2) when the angle is a right angle, else None."""
    quarters = angle / 90
    nearest = round_half_up(quarters)
    if abs(quarters - nearest) * 90 > _RIGHT_ANGLE_EPSILON:
        return None
    return nearest if nearest in _RIGHT_ANGLE_TRANSPOSES else None


def _on_grid(value: float) -> bool:
    return abs(value - round_half_up(value)) <= _GRID_EPSILON


def _exact_crop(image: Image.Image, plan: EditPlan) -> Image.Image | None:
    """The box's content without resampling, or None when that is not possible."""
    box = plan.box
    assert box is not None
    quarters = _right_angle_quarters(box.angle)
    if quarters is None:
        return None
    xs = [x for x, _y in box_corners(box)]
    ys = [y for _x, y in box_corners(box)]
    left, top, right, bottom = min(xs), min(ys), max(xs), max(ys)
    if not all(_on_grid(v) for v in (left, top, right, bottom)):
        return None
    region = tuple(round_half_up(v) for v in (left, top, right, bottom))
    if region[0] < 0 or region[1] < 0 or region[2] > image.width or region[3] > image.height:
        return None
    cropped = image.crop(region)
    # The box points `quarters` clockwise; turn its content back upright.
    transpose = _RIGHT_ANGLE_TRANSPOSES[quarters]
    if transpose is not None:
        cropped = cropped.transpose(transpose)
    if cropped.size != (plan.crop_w, plan.crop_h):  # pragma: no cover - grid implies equal
        return None
    return cropped


def _affine_crop(image: Image.Image, plan: EditPlan) -> Image.Image:
    """The box's content, resampled (bicubic) onto an upright canvas."""
    box = plan.box
    assert box is not None
    rad = math.radians(box.angle)
    cos_a, sin_a = math.cos(rad), math.sin(rad)
    # Output pixel (u, v) in continuous coordinates is box-local
    # (u * kx - w/2, v * ky - h/2), rotated clockwise by the angle about the
    # centre. kx and ky stretch the rounded canvas over the exact box.
    kx = box.w / plan.crop_w
    ky = box.h / plan.crop_h
    origin_x = box.cx - cos_a * box.w / 2 + sin_a * box.h / 2
    origin_y = box.cy - sin_a * box.w / 2 - cos_a * box.h / 2
    coefficients = (cos_a * kx, -sin_a * ky, origin_x, sin_a * kx, cos_a * ky, origin_y)
    return image.transform(
        (plan.crop_w, plan.crop_h),
        Image.Transform.AFFINE,
        coefficients,
        resample=Image.Resampling.BICUBIC,
    )


def render_edit(image: Image.Image, edit: PhotoEdit) -> Image.Image:
    """Apply an edit to a decoded, upright source. Raises `EditError`.

    The image should already be RGB (`app.copy_photos` flattens anything
    else): an affine resample of a palette image would fall back to nearest.
    """
    plan = plan_edit(edit, image.width, image.height)
    out = image
    if plan.box is not None:
        exact = _exact_crop(image, plan)
        out = exact if exact is not None else _affine_crop(image, plan)
    if plan.turns:
        out = out.transpose(_CLOCKWISE_TURNS[plan.turns])
    return out
