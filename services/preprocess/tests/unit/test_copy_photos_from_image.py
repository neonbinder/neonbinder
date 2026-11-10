"""Unit tests for `copy_photos.derive_copy_photos_from_image` (NEO-481).

The hand-edit renderer makes its sizes from an already decoded image and
carries the source's density, scaled so the physical size survives the
resize. `derive_copy_photos` itself (the /process-entry path) is unchanged and
still writes no density of its own.
"""

from __future__ import annotations

import io

import pytest
from PIL import Image, ImageCms

from app import copy_photos
from app.copy_photos import (
    derive_copy_photos,
    derive_copy_photos_from_image,
    read_dpi,
    to_plain_rgb,
    usable_icc_profile,
)

SRGB = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


def _open(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    img.load()
    return img


def test_sizes_carry_the_density_scaled_to_each_size():
    image = Image.new("RGB", (2000, 2800), "navy")

    derived = derive_copy_photos_from_image(image, icc_profile=SRGB, dpi=(700, 700))

    big, small = _open(derived.image), _open(derived.thumb)
    assert big.size == (1143, 1600)
    assert big.info["dpi"] == pytest.approx((700 * 1143 / 2000,) * 2, abs=1)
    assert small.info["dpi"] == pytest.approx((700 * 257 / 2000,) * 2, abs=1)
    assert big.info["icc_profile"] == SRGB == small.info["icc_profile"]


def test_no_density_writes_none_of_its_own():
    derived = derive_copy_photos_from_image(Image.new("RGB", (50, 70)), icc_profile=None, dpi=None)

    assert "icc_profile" not in _open(derived.image).info
    assert _open(derived.image).info.get("dpi") in (None, (1, 1))


def test_the_input_image_is_left_alone():
    image = Image.new("RGB", (2000, 2800))

    derive_copy_photos_from_image(image, icc_profile=None, dpi=None)

    assert image.size == (2000, 2800)


def test_the_bytes_path_still_writes_no_density():
    buf = io.BytesIO()
    Image.new("RGB", (2000, 2800), "navy").save(buf, format="JPEG", dpi=(600, 600))

    derived = derive_copy_photos(buf.getvalue())

    assert _open(derived.image).info.get("dpi") in (None, (1, 1))


@pytest.mark.parametrize(
    ("info", "expected"),
    [
        ({"dpi": (300, 300)}, (300.0, 300.0)),
        ({"dpi": (299.9994, 299.9994)}, (299.9994, 299.9994)),
        ({}, None),
        ({"dpi": (0, 0)}, None),
        ({"dpi": "300"}, None),
        ({"dpi": (300,)}, None),
    ],
)
def test_read_dpi(info, expected):
    image = Image.new("RGB", (4, 4))
    image.info.update(info)

    assert read_dpi(image) == expected


def test_profile_rule_matches_derive():
    rgb = Image.new("RGB", (4, 4))
    rgb.info["icc_profile"] = SRGB
    cmyk = Image.new("CMYK", (4, 4))
    cmyk.info["icc_profile"] = SRGB
    huge = Image.new("RGB", (4, 4))
    huge.info["icc_profile"] = b"x" * (copy_photos.MAX_ICC_PROFILE_BYTES + 1)

    assert usable_icc_profile(rgb) == SRGB
    assert usable_icc_profile(cmyk) is None
    assert usable_icc_profile(huge) is None


def test_plain_rgb_flattens_alpha_and_drops_metadata():
    rgba = Image.new("RGBA", (4, 4), (0, 0, 0, 0))
    rgba.info["comment"] = b"secret"

    out = to_plain_rgb(rgba)

    assert out.mode == "RGB"
    assert out.getpixel((0, 0)) == (255, 255, 255)
    assert out.info == {}
