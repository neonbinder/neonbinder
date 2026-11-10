"""Unit tests for POST /render-edit (NEO-481).

Two forms share the route. The scan form reads a scan's extracted original
and writes one edit version's three write-once objects; the bytes form takes
a stored photo and returns its two sizes, writing nothing. Covers auth, both
forms' happy paths, the write-once version, the original aging out, the
refusals, the profile and density carried through, never enlarging, and the
re-read (which never fails a render that already wrote its objects).

Storage is the shared in-memory fake from `_fake_gcs` driven through the real
`ObjectStore`; Vision and Anthropic are stubbed. No network, no credentials.
"""

from __future__ import annotations

import base64
import io
import json
import random

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageCms

from app import cropper
from app.classify import ClassifyResult
from app.dhash import compute_dhash
from app.imaging import MAX_IMAGE_PIXELS
from app.jobs.gcs import ObjectStore
from app.main import app
from app.orient import OrientationResult
from tests.unit._fake_gcs import FakeStorageClient

client = TestClient(app)

BUCKET = "test-placeholder-bucket"
USER = "user_2abcDEF123"
JOB = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
PREFIX = f"placeholders/{USER}/{JOB}/"
HEADERS = {"x-internal-key": "test-key"}
CROP_KEY = f"{PREFIX}output/edits/0003/2.jpg"
IMAGE_KEY = f"{PREFIX}output/edits/0003/2/image.jpg"
THUMB_KEY = f"{PREFIX}output/edits/0003/2/thumb.jpg"
SRGB = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


@pytest.fixture(autouse=True)
def _set_internal_key(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_KEY", "test-key")


@pytest.fixture(autouse=True)
def _set_bucket(monkeypatch):
    monkeypatch.setenv("GCS_PLACEHOLDER_BUCKET", BUCKET)


@pytest.fixture()
def fake_gcs(monkeypatch) -> FakeStorageClient:
    fake = FakeStorageClient()
    monkeypatch.setattr("app.main._object_store", ObjectStore(client=fake))
    return fake


@pytest.fixture(autouse=True)
def _forbid_reads(monkeypatch):
    """No test reaches Vision or Anthropic unless it stubs them itself."""

    def _boom(*_args, **_kwargs):
        raise AssertionError("unexpected third-party read")

    monkeypatch.setattr(cropper, "detect_orientation", _boom)
    monkeypatch.setattr(cropper, "classify_card", _boom)


def _quadrants(size: tuple[int, int]) -> Image.Image:
    """Red top-left, green top-right, blue bottom-right, white bottom-left."""
    w, h = size
    img = Image.new("RGB", size)
    img.paste((255, 0, 0), (0, 0, w // 2, h // 2))
    img.paste((0, 255, 0), (w // 2, 0, w, h // 2))
    img.paste((0, 0, 255), (w // 2, h // 2, w, h))
    img.paste((255, 255, 255), (0, h // 2, w // 2, h))
    return img


def _jpeg(img: Image.Image, **save) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=95, **save)
    return buf.getvalue()


def _seed_original(fake: FakeStorageClient, data: bytes, ext: str = "jpg") -> None:
    fake.seed(BUCKET, f"{PREFIX}extracted/0003.{ext}", data, f"image/{ext}")


def _scan_body(**overrides) -> dict:
    body = {
        "job_id": JOB,
        "user_id": USER,
        "entry_index": 3,
        "version": 2,
        "edit": {"turns": 0, "crop": None},
    }
    body.update(overrides)
    return body


def _post_scan(body: dict, headers=HEADERS):
    return client.post("/render-edit", json=body, headers=headers)


def _post_bytes(image: bytes, edit: dict | str, content_type="image/jpeg", headers=HEADERS):
    edit_field = edit if isinstance(edit, str) else json.dumps(edit)
    return client.post(
        "/render-edit",
        files={"image": ("photo.jpg", image, content_type)},
        data={"edit": edit_field},
        headers=headers,
    )


def _open(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    img.load()
    return img


def _colour_at(img: Image.Image, fx: float, fy: float) -> tuple[int, int, int]:
    return img.convert("RGB").getpixel((int(fx * img.width), int(fy * img.height)))


def _near(colour: tuple[int, int, int], want: tuple[int, int, int], tol: int = 40) -> bool:
    return all(abs(a - b) <= tol for a, b in zip(colour, want, strict=True))


RED, GREEN, BLUE, WHITE = (255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 255)


# ── Auth and dispatch ───────────────────────────────────────────────────────


class TestAuthAndDispatch:
    def test_missing_key_is_401(self, fake_gcs):
        assert _post_scan(_scan_body(), headers={}).status_code == 401

    def test_wrong_key_is_401_on_the_bytes_form_too(self, fake_gcs):
        response = _post_bytes(_jpeg(_quadrants((40, 60))), {"turns": 1, "crop": None}, headers={})
        assert response.status_code == 401

    def test_another_content_type_is_415(self, fake_gcs):
        response = client.post(
            "/render-edit", content=b"x", headers={**HEADERS, "content-type": "text/plain"}
        )
        assert response.status_code == 415
        assert response.json()["error_code"] == "UNSUPPORTED_MEDIA_TYPE"

    def test_a_body_that_is_not_json_is_an_invalid_edit(self, fake_gcs):
        response = client.post(
            "/render-edit",
            content=b"{nope",
            headers={**HEADERS, "content-type": "application/json"},
        )
        assert response.status_code == 422
        assert response.json()["error_code"] == "INVALID_EDIT"


# ── Scan form ───────────────────────────────────────────────────────────────


class TestScanForm:
    def test_writes_the_three_objects_and_returns_their_metadata(self, fake_gcs):
        _seed_original(fake_gcs, _jpeg(_quadrants((3000, 4200))))
        crop = {
            "cx": 1500,
            "cy": 2100,
            "w": 2000,
            "h": 2800,
            "angle": 0,
            "srcW": 3000,
            "srcH": 4200,
        }

        response = _post_scan(_scan_body(edit={"turns": 0, "crop": crop}))

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["version"] == 2
        assert body["content_type"] == "image/jpeg"
        assert body["crop"] == {
            "width": 2000,
            "height": 2800,
            "size_bytes": len(fake_gcs.read(BUCKET, CROP_KEY)),
            "data_b64": None,
        }
        assert (body["image"]["width"], body["image"]["height"]) == (1143, 1600)
        assert (body["thumb"]["width"], body["thumb"]["height"]) == (257, 360)
        assert body["image"]["data_b64"] is None and body["thumb"]["data_b64"] is None
        assert body["image"]["size_bytes"] == len(fake_gcs.read(BUCKET, IMAGE_KEY))
        assert body["thumb"]["size_bytes"] == len(fake_gcs.read(BUCKET, THUMB_KEY))
        assert body["classified"] is False and body["dhash"] is None
        # The crop is written last: it marks the version complete.
        assert fake_gcs.writes == [IMAGE_KEY, THUMB_KEY, CROP_KEY]

    def test_the_crop_is_what_the_box_holds(self, fake_gcs):
        _seed_original(fake_gcs, _jpeg(_quadrants((400, 600))))
        # The right half only: green on top, blue below.
        crop = {"cx": 300, "cy": 300, "w": 200, "h": 600, "angle": 0, "srcW": 400, "srcH": 600}

        assert _post_scan(_scan_body(edit={"turns": 0, "crop": crop})).status_code == 200

        out = _open(fake_gcs.read(BUCKET, CROP_KEY))
        assert out.size == (200, 600)
        assert _near(_colour_at(out, 0.5, 0.25), GREEN)
        assert _near(_colour_at(out, 0.5, 0.75), BLUE)

    def test_a_quarter_turn_right_moves_the_top_left_to_the_top_right(self, fake_gcs):
        _seed_original(fake_gcs, _jpeg(_quadrants((400, 600))))

        _post_scan(_scan_body(edit={"turns": 1, "crop": None}))

        out = _open(fake_gcs.read(BUCKET, CROP_KEY))
        assert out.size == (600, 400)
        assert _near(_colour_at(out, 0.75, 0.25), RED)
        assert _near(_colour_at(out, 0.25, 0.25), WHITE)

    def test_the_original_is_read_upright(self, fake_gcs):
        """A streamed original can still carry its EXIF tag. The edit was drawn
        on the uprighted frame (the same one /process-entry crops), so that is
        the frame read here."""
        stored = _quadrants((400, 600)).transpose(Image.Transpose.ROTATE_90)
        exif = Image.Exif()
        exif[0x0112] = 6  # display turned 90 clockwise
        _seed_original(fake_gcs, _jpeg(stored, exif=exif.tobytes()))
        crop = {"cx": 200, "cy": 300, "w": 400, "h": 600, "angle": 0, "srcW": 400, "srcH": 600}

        response = _post_scan(_scan_body(edit={"turns": 0, "crop": crop}))

        assert response.status_code == 200, response.text
        out = _open(fake_gcs.read(BUCKET, CROP_KEY))
        assert out.size == (400, 600)
        assert _near(_colour_at(out, 0.25, 0.25), RED)

    def test_the_frame_may_be_sent_in_snake_case(self, fake_gcs):
        """Convex sends `src_w`/`src_h`; the response's `crop_box` says
        `srcW`/`srcH`. The request takes either."""
        _seed_original(fake_gcs, _jpeg(_quadrants((400, 600))))
        crop = {"cx": 300, "cy": 300, "w": 200, "h": 600, "angle": 0, "src_w": 400, "src_h": 600}

        assert _post_scan(_scan_body(edit={"turns": 0, "crop": crop})).status_code == 200

        assert _open(fake_gcs.read(BUCKET, CROP_KEY)).size == (200, 600)

    def test_a_png_original_is_found(self, fake_gcs):
        buf = io.BytesIO()
        _quadrants((40, 60)).save(buf, format="PNG")
        _seed_original(fake_gcs, buf.getvalue(), ext="png")

        assert _post_scan(_scan_body()).status_code == 200

    def test_profile_and_density_are_carried(self, fake_gcs):
        _seed_original(fake_gcs, _jpeg(_quadrants((3200, 4000)), icc_profile=SRGB, dpi=(600, 600)))

        _post_scan(_scan_body())

        crop = _open(fake_gcs.read(BUCKET, CROP_KEY))
        image = _open(fake_gcs.read(BUCKET, IMAGE_KEY))
        thumb = _open(fake_gcs.read(BUCKET, THUMB_KEY))
        for out in (crop, image, thumb):
            assert out.info.get("icc_profile") == SRGB
            assert "exif" not in out.info
        assert crop.info["dpi"] == pytest.approx((600, 600), abs=1)
        # 4000 px tall down to 1600, so the same card measures the same inches.
        assert image.info["dpi"] == pytest.approx((240, 240), abs=1)
        assert thumb.info["dpi"] == pytest.approx((600 * 288 / 3200, 600 * 288 / 3200), abs=1)

    def test_a_small_original_is_never_enlarged(self, fake_gcs):
        _seed_original(fake_gcs, _jpeg(_quadrants((300, 420))))

        body = _post_scan(_scan_body()).json()

        assert (body["image"]["width"], body["image"]["height"]) == (300, 420)
        assert (body["thumb"]["width"], body["thumb"]["height"]) == (257, 360)

    def test_the_answer_names_no_object(self, fake_gcs):
        _seed_original(fake_gcs, _jpeg(_quadrants((40, 60))))

        text = _post_scan(_scan_body()).text

        assert "placeholders/" not in text and "edits/" not in text


class TestScanFormWriteOnce:
    def test_a_rendered_version_is_refused_and_nothing_is_written(self, fake_gcs):
        _seed_original(fake_gcs, _jpeg(_quadrants((40, 60))))
        fake_gcs.seed(BUCKET, CROP_KEY, b"earlier", "image/jpeg")
        fake_gcs.writes.clear()

        response = _post_scan(_scan_body())

        assert response.status_code == 409
        assert response.json()["error_code"] == "VERSION_EXISTS"
        assert fake_gcs.writes == []
        assert fake_gcs.read(BUCKET, CROP_KEY) == b"earlier"

    def test_a_version_cut_short_before_its_crop_is_finished(self, fake_gcs):
        """An attempt that died after its sizes but before its crop left the
        version incomplete. The same request renders the same bytes, so a
        retry keeps those sizes and writes the crop."""
        _seed_original(fake_gcs, _jpeg(_quadrants((40, 60))))
        first = _post_scan(_scan_body())
        image = fake_gcs.read(BUCKET, IMAGE_KEY)
        del fake_gcs.buckets[BUCKET][CROP_KEY]
        fake_gcs.writes.clear()

        again = _post_scan(_scan_body())

        assert again.status_code == 200
        assert fake_gcs.writes == [CROP_KEY]
        assert fake_gcs.read(BUCKET, IMAGE_KEY) == image
        assert again.json()["image"] == first.json()["image"]

    def test_losing_the_race_for_the_crop_is_version_exists(self, fake_gcs, monkeypatch):
        _seed_original(fake_gcs, _jpeg(_quadrants((40, 60))))
        store = ObjectStore(client=fake_gcs)
        real_create = store.create

        def _create(ref, data, *, content_type):
            if ref.name == CROP_KEY:  # another request wrote it after our check
                fake_gcs.seed(BUCKET, CROP_KEY, b"theirs", "image/jpeg")
            real_create(ref, data, content_type=content_type)

        store.create = _create
        monkeypatch.setattr("app.main._object_store", store)

        response = _post_scan(_scan_body())

        assert response.status_code == 409
        assert fake_gcs.read(BUCKET, CROP_KEY) == b"theirs"

    def test_another_version_is_its_own_object(self, fake_gcs):
        _seed_original(fake_gcs, _jpeg(_quadrants((40, 60))))
        assert _post_scan(_scan_body()).status_code == 200

        assert _post_scan(_scan_body(version=3)).status_code == 200

        assert f"{PREFIX}output/edits/0003/3.jpg" in fake_gcs.names(BUCKET)


class TestScanFormRefusals:
    def test_an_original_that_aged_out_is_entry_not_found(self, fake_gcs):
        response = _post_scan(_scan_body())

        assert response.status_code == 404
        assert response.json()["error_code"] == "ENTRY_NOT_FOUND"
        assert fake_gcs.writes == []

    @pytest.mark.parametrize(
        ("field", "value"),
        [("user_id", "user_../x"), ("job_id", "not-a-uuid")],
    )
    def test_bad_identifiers_are_400(self, fake_gcs, field, value):
        response = _post_scan(_scan_body(**{field: value}))

        assert response.status_code == 400
        assert response.json()["error_code"] == "INVALID_IDENTIFIER"

    def test_unconfigured_bucket_is_a_retryable_503(self, fake_gcs, monkeypatch):
        monkeypatch.delenv("GCS_PLACEHOLDER_BUCKET")

        response = _post_scan(_scan_body())

        assert response.status_code == 503
        assert response.headers["Retry-After"]

    @pytest.mark.parametrize(
        "overrides",
        [
            {"version": 0},
            {"version": 10000},
            {"version": "2"},
            {"entry_index": -1},
            {"edit": {"turns": 4, "crop": None}},
            {"edit": {"turns": 0}},
            {"edit": {"turns": 0, "crop": {"cx": 1, "cy": 1, "w": 0, "h": 1, "angle": 0}}},
            {
                "edit": {
                    "turns": 0,
                    "crop": {"cx": 1, "cy": 1, "w": 1, "h": 1, "angle": 200, "srcW": 4, "srcH": 4},
                }
            },
            {
                "edit": {
                    "turns": 0,
                    "crop": {"cx": 1, "cy": 1, "w": 1, "h": 1, "angle": 0, "srcW": 4.5, "srcH": 4},
                }
            },
        ],
    )
    def test_a_malformed_request_is_invalid_edit(self, fake_gcs, overrides):
        response = _post_scan(_scan_body(**overrides))

        assert response.status_code == 422
        body = response.json()
        assert body["error_code"] == "INVALID_EDIT"
        # Names the field, never echoes the value sent.
        assert body["detail"].startswith("invalid fields: ")
        assert "4.5" not in body["detail"] and "200" not in body["detail"]

    def test_a_box_past_the_frame_is_refused_and_nothing_is_written(self, fake_gcs):
        _seed_original(fake_gcs, _jpeg(_quadrants((400, 600))))
        crop = {"cx": 390, "cy": 300, "w": 100, "h": 100, "angle": 0, "srcW": 400, "srcH": 600}

        response = _post_scan(_scan_body(edit={"turns": 0, "crop": crop}))

        assert response.status_code == 422
        assert response.json()["error_code"] == "EDIT_OUT_OF_FRAME"
        assert fake_gcs.writes == []

    def test_a_box_drawn_on_another_frame_is_refused(self, fake_gcs):
        _seed_original(fake_gcs, _jpeg(_quadrants((400, 600))))
        crop = {"cx": 100, "cy": 100, "w": 50, "h": 50, "angle": 0, "srcW": 600, "srcH": 400}

        response = _post_scan(_scan_body(edit={"turns": 0, "crop": crop}))

        assert response.status_code == 422
        assert response.json()["error_code"] == "EDIT_FRAME_MISMATCH"
        assert "600" not in response.text and "400" not in response.text

    def test_an_original_over_the_pixel_ceiling_is_a_terminal_413(self, fake_gcs, monkeypatch):
        monkeypatch.setattr("app.imaging.MAX_IMAGE_PIXELS", 100)
        _seed_original(fake_gcs, _jpeg(_quadrants((40, 60))))

        response = _post_scan(_scan_body())

        assert response.status_code == 413
        assert response.json()["error_code"] == "ENTRY_TOO_MANY_PIXELS"
        assert "40" not in response.json()["detail"] and "60" not in response.json()["detail"]
        assert MAX_IMAGE_PIXELS > 100

    def test_an_undecodable_original_is_a_terminal_422(self, fake_gcs):
        _seed_original(fake_gcs, b"\xff\xd8\xff not really a jpeg")

        response = _post_scan(_scan_body())

        assert response.status_code == 422
        assert response.json()["error_code"] == "IMAGE_UNDECODABLE"
        assert fake_gcs.writes == []

    def test_a_storage_failure_is_a_502(self, fake_gcs, monkeypatch):
        _seed_original(fake_gcs, _jpeg(_quadrants((40, 60))))
        store = ObjectStore(client=fake_gcs)

        def _broken(*_args, **_kwargs):
            raise RuntimeError("gcs down")

        store.create = _broken
        monkeypatch.setattr("app.main._object_store", store)

        assert _post_scan(_scan_body()).status_code == 502


# ── The re-read ─────────────────────────────────────────────────────────────


def _stub_reads(monkeypatch, seen: list[bytes]) -> None:
    def _orient(data):
        seen.append(data)
        return OrientationResult(rotation_degrees=90, confidence=0.75, text_count=31)

    def _classify(data):
        seen.append(data)
        return ClassifyResult(
            players=["Ken Griffey Jr."],
            team="Mariners",
            card_number="1",
            side="front",
            raw_text="",
        )

    monkeypatch.setattr(cropper, "detect_orientation", _orient)
    monkeypatch.setattr(cropper, "classify_card", _classify)


class TestReRead:
    def test_classify_reads_the_new_crop_and_hashes_the_original(self, fake_gcs, monkeypatch):
        original = _jpeg(_quadrants((400, 600)))
        _seed_original(fake_gcs, original)
        seen: list[bytes] = []
        _stub_reads(monkeypatch, seen)

        body = _post_scan(_scan_body(classify=True, edit={"turns": 1, "crop": None})).json()

        assert body["classified"] is True
        assert body["players"] == ["Ken Griffey Jr."]
        assert body["player"] == "Ken Griffey Jr."
        assert (body["team"], body["card_number"], body["side"]) == ("Mariners", "1", "front")
        assert (body["text_count"], body["orient_confidence"]) == (31, 0.75)
        assert body["dhash"] == f"{compute_dhash(original):016x}"
        stored_crop = fake_gcs.read(BUCKET, CROP_KEY)
        assert seen == [stored_crop, stored_crop], "both reads see the turned crop, as stored"

    def test_the_read_never_turns_the_photo(self, fake_gcs, monkeypatch):
        """Vision suggests a turn; the edit's turns stand."""
        _seed_original(fake_gcs, _jpeg(_quadrants((400, 600))))
        _stub_reads(monkeypatch, [])

        _post_scan(_scan_body(classify=True))

        assert _open(fake_gcs.read(BUCKET, CROP_KEY)).size == (400, 600)

    def test_a_failed_read_still_returns_the_render(self, fake_gcs, monkeypatch):
        original = _jpeg(_quadrants((400, 600)))
        _seed_original(fake_gcs, original)

        def _down(_data):
            raise RuntimeError("vision unavailable")

        monkeypatch.setattr(cropper, "detect_orientation", _down)

        response = _post_scan(_scan_body(classify=True))

        assert response.status_code == 200
        body = response.json()
        assert body["classified"] is False
        assert body["players"] == [] and body["card_number"] is None and body["side"] is None
        assert body["dhash"] == f"{compute_dhash(original):016x}"
        assert CROP_KEY in fake_gcs.names(BUCKET)

    def test_no_classify_means_no_third_party_call(self, fake_gcs):
        # `_forbid_reads` turns any call into a failure.
        _seed_original(fake_gcs, _jpeg(_quadrants((40, 60))))

        assert _post_scan(_scan_body(classify=False)).json()["classified"] is False


# ── Bytes form ──────────────────────────────────────────────────────────────


class TestBytesForm:
    def test_returns_both_sizes_and_writes_nothing(self, fake_gcs):
        stored = _jpeg(_quadrants((1143, 1600)))

        response = _post_bytes(stored, {"turns": 1, "crop": None})

        assert response.status_code == 200, response.text
        body = response.json()
        image = _open(base64.b64decode(body["image"]["data_b64"]))
        thumb = _open(base64.b64decode(body["thumb"]["data_b64"]))
        assert image.size == (1600, 1143) == (body["image"]["width"], body["image"]["height"])
        assert thumb.size == (360, 257)
        assert body["image"]["size_bytes"] == len(base64.b64decode(body["image"]["data_b64"]))
        assert _near(_colour_at(image, 0.75, 0.25), RED), "turned clockwise"
        assert body["version"] is None and body["crop"] is None
        assert body["classified"] is False
        assert fake_gcs.writes == []

    def test_a_trim_of_a_stored_photo(self, fake_gcs):
        stored = _jpeg(_quadrants((1143, 1600)))
        crop = {"cx": 285, "cy": 400, "w": 500, "h": 700, "angle": 0, "srcW": 1143, "srcH": 1600}

        body = _post_bytes(stored, {"turns": 0, "crop": crop}).json()

        image = _open(base64.b64decode(body["image"]["data_b64"]))
        assert image.size == (500, 700), "trimmed, and never enlarged"
        assert _near(_colour_at(image, 0.5, 0.5), RED)

    def test_profile_is_carried(self, fake_gcs):
        stored = _jpeg(_quadrants((400, 600)), icc_profile=SRGB)

        body = _post_bytes(stored, {"turns": 2, "crop": None}).json()

        assert _open(base64.b64decode(body["image"]["data_b64"])).info["icc_profile"] == SRGB

    def test_a_png_is_accepted(self, fake_gcs):
        buf = io.BytesIO()
        _quadrants((40, 60)).save(buf, format="PNG")

        assert (
            _post_bytes(buf.getvalue(), {"turns": 0, "crop": None}, "image/png").status_code == 200
        )

    def test_the_edit_may_carry_a_stored_edits_extra_fields(self, fake_gcs):
        edit = {"turns": 0, "crop": None, "version": 4, "editedAt": 1}

        assert _post_bytes(_jpeg(_quadrants((40, 60))), edit).status_code == 200

    def test_a_missing_image_is_400(self, fake_gcs):
        # Some other file part keeps the request multipart.
        response = client.post(
            "/render-edit",
            files={"other": ("x.txt", b"x", "text/plain")},
            data={"edit": json.dumps({"turns": 0, "crop": None})},
            headers=HEADERS,
        )

        assert response.status_code == 400
        assert response.json()["error_code"] == "MISSING_IMAGE"

    @pytest.mark.parametrize("edit", ["{nope", json.dumps({"turns": 9, "crop": None}), "[]"])
    def test_a_bad_edit_is_invalid_edit(self, fake_gcs, edit):
        response = _post_bytes(_jpeg(_quadrants((40, 60))), edit)

        assert response.status_code == 422
        assert response.json()["error_code"] == "INVALID_EDIT"

    def test_another_image_type_is_415(self, fake_gcs):
        response = _post_bytes(b"GIF89a", {"turns": 0, "crop": None}, "image/gif")

        assert response.status_code == 415
        assert response.json()["error_code"] == "UNSUPPORTED_MEDIA_TYPE"
        assert "gif" not in response.json()["detail"]

    @pytest.mark.parametrize("size", [(4097, 100), (100, 4097), (6000, 8000)])
    def test_a_photo_bigger_than_a_stored_photo_can_be_is_413(self, fake_gcs, monkeypatch, size):
        """Stored photos are at most 1600 px, but R2's signed PUT bounds
        bytes, not pixels: a flat JPEG of a few MB can decode to 64 MP. The
        ceiling is read from the header, before any full decode."""
        decodes: list[int] = []
        monkeypatch.setattr(
            "app.main.apply_exif_orientation", lambda b: decodes.append(1) or (b, 1)
        )
        flat = _jpeg(Image.new("RGB", size, "white"))

        response = _post_bytes(flat, {"turns": 0, "crop": None})

        assert response.status_code == 413
        assert response.json()["error_code"] == "IMAGE_TOO_LARGE"
        assert str(size[0]) not in response.text and str(size[1]) not in response.text
        assert decodes == [], "refused before the first full decode"

    def test_a_photo_at_the_edge_ceiling_renders(self, fake_gcs):
        flat = _jpeg(Image.new("RGB", (4096, 100), "white"))

        response = _post_bytes(flat, {"turns": 0, "crop": None})

        assert response.status_code == 200
        assert response.json()["image"]["width"] == 1600

    def test_a_bomb_past_pillows_limit_is_413_too(self, fake_gcs, monkeypatch):
        """A header Pillow will not even size reads as over the ceiling."""
        from app.imaging import RasterTooLargeError

        def _bomb(_b):
            raise RasterTooLargeError("too big")

        monkeypatch.setattr("app.main.check_raster_size", lambda _b: None)
        monkeypatch.setattr("app.main.read_raster_size", _bomb)

        response = _post_bytes(_jpeg(_quadrants((40, 60))), {"turns": 0, "crop": None})

        assert response.status_code == 413
        assert response.json()["error_code"] == "IMAGE_TOO_LARGE"

    def test_an_empty_image_is_400(self, fake_gcs):
        response = _post_bytes(b"", {"turns": 0, "crop": None})

        assert response.status_code == 400

    def test_undecodable_bytes_are_422(self, fake_gcs):
        response = _post_bytes(b"\xff\xd8\xff garbage", {"turns": 1, "crop": None})

        assert response.status_code == 422
        assert response.json()["error_code"] == "IMAGE_UNDECODABLE"

    def test_a_box_past_the_frame_is_refused(self, fake_gcs):
        crop = {"cx": 30, "cy": 30, "w": 40, "h": 40, "angle": 0, "srcW": 40, "srcH": 60}

        response = _post_bytes(_jpeg(_quadrants((40, 60))), {"turns": 0, "crop": crop})

        assert response.status_code == 422
        assert response.json()["error_code"] == "EDIT_OUT_OF_FRAME"

    def test_noise_too_big_for_the_photo_cap_is_photo_too_large(self, fake_gcs, monkeypatch):
        rng = random.Random(1)
        noise = Image.frombytes("RGB", (300, 300), rng.randbytes(300 * 300 * 3))
        monkeypatch.setattr("app.copy_photos.MAX_COPY_PHOTO_BYTES", 1000)

        response = _post_bytes(_jpeg(noise), {"turns": 0, "crop": None})

        assert response.status_code == 422
        assert response.json()["error_code"] == "PHOTO_TOO_LARGE"
