"""Unit tests for cache B (app.devcache.birefnet): key, fingerprint, value.

The end-to-end behaviour inside `tiered.birefnet_mask` (hits skip inference,
post-processing still runs) is in `test_cropper_tiered.py`.
"""

from __future__ import annotations

import io
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app.cropper import birefnet
from app.devcache import birefnet as db
from app.devcache import store
from tests.unit.test_devcache_store import (
    RefusingClient,
    cache_on,
    install_cache,
    record_counts,
)

WEIGHTS = "0123456789abcdef" * 4
SERVICE_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A BIREFNET_HOME holding only the bake's hash file for the default model."""
    monkeypatch.setenv(birefnet.HOME_ENV, str(tmp_path))
    monkeypatch.delenv(birefnet.MODEL_ENV, raising=False)
    monkeypatch.delenv("OMP_NUM_THREADS", raising=False)
    (tmp_path / "birefnet-general.onnx.sha256").write_text(f"{WEIGHTS}  birefnet-general.onnx\n")
    return tmp_path


def _padded(seed: int = 7, shape=(40, 30, 3)) -> np.ndarray:
    return np.random.default_rng(seed).integers(0, 256, shape, dtype=np.uint8)


# ── Fingerprint ─────────────────────────────────────────────────────────────


class TestFingerprint:
    def test_fields_come_from_the_birefnet_module(self, home):
        fp = db.fingerprint()
        assert fp == {
            "impl": birefnet.INFERENCE_IMPL,
            "pre_post": birefnet.PRE_POST_SPEC,
            "model": "birefnet-general",
            "weights_sha256": WEIGHTS,
            "session_options": birefnet.session_options_spec(),
            "providers": ["CPUExecutionProvider"],
            "versions": {
                "onnxruntime": fp["versions"]["onnxruntime"],
                "Pillow": fp["versions"]["Pillow"],
                "numpy": fp["versions"]["numpy"],
            },
        }
        assert fp["impl"] == "birefnet-direct-ort/rembg-2.0.78-predict/v1"
        # rembg is no longer on the inference path, so its version is not a field.
        assert "rembg" not in json.dumps(fp["versions"])

    def test_versions_are_the_installed_distributions(self, home):
        from importlib import metadata

        assert db.fingerprint()["versions"] == {
            d: metadata.version(d) for d in ("onnxruntime", "Pillow", "numpy")
        }

    def test_canonical_json_is_sorted_and_compact(self, home):
        text = db.fingerprint_json()
        assert text == json.dumps(json.loads(text), sort_keys=True, separators=(",", ":"))

    def test_missing_hash_file_means_off(self, home):
        (home / "birefnet-general.onnx.sha256").unlink()
        assert db.fingerprint() is None
        with pytest.raises(store.CacheOff):
            db.cache_key(_padded())

    @pytest.mark.parametrize("text", ["", "not-a-hash", "abc123", "Z" * 64])
    def test_malformed_hash_file_means_off(self, home, text):
        (home / "birefnet-general.onnx.sha256").write_text(text)
        assert db.fingerprint() is None

    def test_missing_hash_file_is_off_in_lookup_with_no_counter(self, home, monkeypatch):
        (home / "birefnet-general.onnx.sha256").unlink()
        install_cache(monkeypatch, RefusingClient())
        seen = record_counts(monkeypatch)
        with cache_on():
            assert db.lookup(_padded()) == (None, None)
        assert seen == []

    def test_fingerprint_never_imports_onnxruntime(self, home):
        code = (
            "import sys, numpy as np\n"
            "from app.devcache import birefnet as db\n"
            "db.cache_key(np.zeros((4, 4, 3), np.uint8))\n"
            "print('onnxruntime' in sys.modules, 'rembg' in sys.modules)\n"
        )
        out = subprocess.run(
            [sys.executable, "-c", code],
            cwd=SERVICE_ROOT,
            capture_output=True,
            text=True,
            check=True,
        )
        assert out.stdout.strip() == "False False"


# ── Key invalidation ────────────────────────────────────────────────────────


class TestKey:
    def test_same_input_same_key(self, home):
        assert db.cache_key(_padded()) == db.cache_key(_padded().copy())

    def test_a_non_contiguous_view_keys_by_its_values(self, home):
        a = _padded(shape=(40, 60, 3))
        view = a[:, ::2]
        assert db.cache_key(view) == db.cache_key(np.ascontiguousarray(view))

    def test_one_pixel_changes_the_key(self, home):
        a = _padded()
        b = a.copy()
        b[0, 0, 0] ^= 1
        assert db.cache_key(a) != db.cache_key(b)

    def test_same_bytes_another_shape_changes_the_key(self, home):
        a = _padded(shape=(40, 30, 3))
        assert db.cache_key(a) != db.cache_key(a.reshape(30, 40, 3))

    def test_same_bytes_another_dtype_changes_the_key(self, home):
        a = _padded(shape=(40, 30, 4))
        assert db.cache_key(a) != db.cache_key(a.view(np.int8))

    @pytest.mark.parametrize(
        "target,name,value",
        [
            (birefnet, "INFERENCE_IMPL", "birefnet-direct-ort/rembg-2.0.78-predict/v2"),
            (birefnet, "PRE_POST_SPEC", birefnet.PRE_POST_SPEC.replace("LANCZOS", "BILINEAR")),
            (birefnet, "PROVIDERS", ("CPUExecutionProvider", "OtherProvider")),
            (db, "MASK_CACHE_FORMAT", 2),
            (db, "KEY_NAMESPACE", "nb-devcache/other"),
        ],
    )
    def test_every_identity_field_changes_the_key(self, home, monkeypatch, target, name, value):
        before = db.cache_key(_padded())
        monkeypatch.setattr(target, name, value)
        assert db.cache_key(_padded()) != before

    def test_model_change_misses(self, home, monkeypatch):
        before = db.cache_key(_padded())
        monkeypatch.setenv(birefnet.MODEL_ENV, "birefnet-general-lite")
        (home / "birefnet-general-lite.onnx.sha256").write_text(WEIGHTS)
        assert db.cache_key(_padded()) != before

    def test_weights_change_misses(self, home):
        before = db.cache_key(_padded())
        (home / "birefnet-general.onnx.sha256").write_text("f" * 64)
        assert db.cache_key(_padded()) != before

    def test_session_options_change_misses(self, home, monkeypatch):
        before = db.cache_key(_padded())
        monkeypatch.setenv("OMP_NUM_THREADS", "2")
        assert db.cache_key(_padded()) != before

    @pytest.mark.parametrize("dist", ["onnxruntime", "Pillow", "numpy"])
    def test_each_version_change_misses(self, home, monkeypatch, dist):
        before = db.cache_key(_padded())
        real = db._versions()
        monkeypatch.setattr(db, "_versions", lambda: {**real, dist: "0.0.0-other"})
        assert db.cache_key(_padded()) != before

    def test_a_disallowed_model_is_a_key_error_not_a_crash(self, home, monkeypatch):
        monkeypatch.setenv(birefnet.MODEL_ENV, "withoutbg")
        install_cache(monkeypatch, RefusingClient())
        seen = record_counts(monkeypatch)
        with cache_on():
            assert db.lookup(_padded()) == (None, None)
        assert seen == ["birefnet_cache_errors"]


# ── Value: lossless PNG ─────────────────────────────────────────────────────


class TestValue:
    @pytest.mark.parametrize("shape", [(1, 1), (37, 53), (1300, 977)])
    def test_png_round_trip_is_exact(self, shape):
        alpha = np.random.default_rng(shape[0]).integers(0, 256, shape, dtype=np.uint8)
        payload = db.encode_alpha(alpha)
        back = db.decode_alpha(payload, shape)
        assert back.dtype == np.uint8
        assert np.array_equal(back, alpha)

    def test_every_alpha_value_survives(self):
        alpha = np.arange(256, dtype=np.uint8).reshape(16, 16)
        assert np.array_equal(db.decode_alpha(db.encode_alpha(alpha), (16, 16)), alpha)

    def test_payload_is_a_png(self):
        payload = db.encode_alpha(np.zeros((3, 4), np.uint8))
        assert payload[:8] == b"\x89PNG\r\n\x1a\n"

    @pytest.mark.parametrize("alpha", [np.zeros((3, 4, 1), np.uint8), np.zeros((3, 4), np.float32)])
    def test_encode_refuses_anything_but_uint8_hw(self, alpha):
        with pytest.raises(ValueError):
            db.encode_alpha(alpha)

    def test_decode_refuses_the_wrong_shape(self):
        payload = db.encode_alpha(np.zeros((3, 4), np.uint8))
        with pytest.raises(ValueError):
            db.decode_alpha(payload, (4, 3))

    @pytest.mark.parametrize("fmt,mode", [("PNG", "RGB"), ("JPEG", "L"), ("PNG", "I;16")])
    def test_decode_refuses_other_images(self, fmt, mode):
        out = io.BytesIO()
        Image.new(mode, (4, 3)).save(out, format=fmt)
        with pytest.raises(ValueError):
            db.decode_alpha(out.getvalue(), (3, 4))

    def test_lookup_round_trip_through_the_store(self, home, monkeypatch):
        fake = install_cache(monkeypatch)
        seen = record_counts(monkeypatch)
        padded = _padded()
        alpha = np.random.default_rng(1).integers(0, 256, padded.shape[:2], dtype=np.uint8)
        with cache_on():
            value, slot = db.lookup(padded)
            assert value is None
            db.remember(slot, alpha)
            hit, slot2 = db.lookup(padded)
        assert slot2 is None
        assert np.array_equal(hit, alpha)
        assert sorted(fake.objects()) == [f"birefnet/{db.cache_key(padded)}"]
        assert seen == ["birefnet_cache_misses", "birefnet_cache_hits"]

    def test_a_cached_plane_of_the_wrong_shape_is_corrupt(self, home, monkeypatch):
        fake = install_cache(monkeypatch)
        padded = _padded()
        gen = fake.seed(
            f"birefnet/{db.cache_key(padded)}",
            store.encode(db.encode_alpha(np.zeros((5, 5), np.uint8))),
        )
        seen = record_counts(monkeypatch)
        with cache_on():
            value, slot = db.lookup(padded)
        assert value is None
        assert slot.replace_generation == gen
        assert seen == ["birefnet_cache_errors"]

    def test_remember_refuses_a_bad_plane_as_a_write_failure(self, home, monkeypatch):
        fake = install_cache(monkeypatch)
        seen = record_counts(monkeypatch)
        with cache_on():
            _value, slot = db.lookup(_padded())
            db.remember(slot, np.zeros((2, 2), np.float64))
        assert fake.ops("write") == []
        assert seen == ["birefnet_cache_misses", "cache_write_failures"]
