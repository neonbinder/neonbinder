"""Functional /process smoke that is safe on the FAST container (NEO-315).

The fast-service smokes used to be a /health ping only, which proves the
container boots and nothing about the request path. This test sends one real
/process request that must come back 200 with the full response envelope, so
it exercises auth, upload handling, a real Google Vision `text_detection`
call, rotate, and a real Anthropic classify on the deployed revision.

Why crop-only mode (`precropped` and no `image`): that mode is
`cropper._try_precropped_only` — validator, Vision orient, rotate, classify —
and has no fallback into the strategy cascade at all, so it can never reach
BiRefNet or SAM, whatever the image. The FAST container must never run a
model (see preprocess-deploy.yml's fast-lane comment). An `image` +
`precropped` request is NOT safe for this: when the precropped candidate is
rejected it falls through to the full cascade on the original, and the
plain-white `synthetic_card_image` IS rejected there (grayscale stddev ~7,
under the validator's 10 floor).

The fixture below is built to pass the crop-only gates: card aspect (750x1050
is exactly 2.5:3.5), well above the size floor, a strong border and colour
panel (stddev far above 10), and large, plain sans-serif words so Vision's
word count clears the absolute text floor of 1. `cropped_source ==
"precropped"` in the response proves the crop-only path served it, and
`text_count >= 1` proves Vision answered (the floor would have 422'd it
otherwise).

Runs everywhere: heavy smokes (`pytest tests/smoke`) include it, and the fast
smokes select it alone with `-m fast_safe`.
"""

from __future__ import annotations

import io

import httpx
import pytest
from PIL import Image, ImageDraw, ImageFont

EXPECTED_KEYS = {
    "players",
    "player",
    "team",
    "card_number",
    "side",
    "rotation_degrees",
    "orient_confidence",
    "text_count",
    "cropped_source",
    "cropped_image_b64",
}


@pytest.fixture(scope="module")
def readable_card_crop() -> bytes:
    """A card-shaped, already-cropped image with large legible text."""
    w, h = 750, 1050
    img = Image.new("RGB", (w, h), color="white")
    draw = ImageDraw.Draw(img)
    draw.rectangle((0, 0, w - 1, h - 1), outline="black", width=18)
    draw.rectangle((50, 50, w - 51, 560), fill=(40, 90, 170))
    # Pillow's bundled scalable default font: no TTF lookup, no platform font.
    font = ImageFont.load_default(size=64)
    for y, text in ((600, "SMOKE TEST"), (700, "PLAYER NAME"), (800, "TEAM XYZ"), (900, "NO. 42")):
        draw.text((60, y), text, fill="black", font=font)
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=90)
    return out.getvalue()


@pytest.mark.fast_safe
class TestFastFunctionalProcess:
    def test_crop_only_process_returns_full_envelope(
        self,
        client: httpx.Client,
        internal_key: str,
        auth_headers: dict[str, str],
        readable_card_crop: bytes,
    ) -> None:
        response = client.post(
            "/process",
            headers={**auth_headers, "x-internal-key": internal_key},
            files={"precropped": ("smoke-crop.jpg", readable_card_crop, "image/jpeg")},
        )
        # A 502 here is an upstream (Vision / Anthropic) failure on the
        # deployed revision; a 422 means the fixture no longer clears the
        # crop-only gates (fix the fixture, not the assertion).
        assert response.status_code == 200, f"{response.status_code} {response.text}"
        body = response.json()
        assert set(body.keys()) == EXPECTED_KEYS, f"unexpected keys {sorted(body.keys())}"
        assert body["cropped_source"] == "precropped", body["cropped_source"]
        assert body["cropped_image_b64"] is None
        assert body["side"] in {"front", "back"}, f"bad side {body['side']!r}"
        assert body["rotation_degrees"] in {0, 90, 180, 270}
        assert 0.0 <= body["orient_confidence"] <= 1.0
        assert isinstance(body["text_count"], int) and body["text_count"] >= 1
        assert isinstance(body["players"], list)
