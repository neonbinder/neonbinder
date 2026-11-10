"""`app.cropper.birefnet`: rembg 2.0.78's BiRefNet steps, transcribed, plus the session.

No real model is loaded. Pre/post-processing is checked against values
derived by hand from rembg's arithmetic; byte-equality with rembg itself on
real model output is the parity suite's job (`tests/parity/`).
"""

from __future__ import annotations

import json
import logging
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app.cropper import birefnet

SERVICE_ROOT = Path(__file__).resolve().parents[2]
MEAN = (0.485, 0.456, 0.406)
STD = (0.229, 0.224, 0.225)


@pytest.fixture(autouse=True)
def _fresh_session(monkeypatch):
    monkeypatch.setattr(birefnet, "_session", None)


# ── Identity ────────────────────────────────────────────────────────────────


def test_identity_constants():
    assert birefnet.INFERENCE_IMPL == "birefnet-direct-ort/rembg-2.0.78-predict/v1"
    assert birefnet.PROVIDERS == ("CPUExecutionProvider",)
    spec = json.loads(birefnet.PRE_POST_SPEC)
    assert spec["pre"]["mean"] == list(MEAN)
    assert spec["pre"]["std"] == list(STD)
    assert spec["pre"]["resize"] == [1024, 1024]
    # Canonical: re-serialising gives the same string, so the cache key is stable.
    assert json.dumps(spec, sort_keys=True, separators=(",", ":")) == birefnet.PRE_POST_SPEC


# ── preprocess ──────────────────────────────────────────────────────────────


def _uniform(rgb: tuple[int, int, int], size=(37, 53)) -> Image.Image:
    return Image.new("RGB", size, rgb)


def test_preprocess_shape_and_dtype():
    t = birefnet.preprocess(_uniform((10, 20, 30)))
    assert t.shape == (1, 3, 1024, 1024)
    assert t.dtype == np.float32


def test_preprocess_uniform_image_uses_float64_arithmetic():
    rgb = (200, 101, 7)
    t = birefnet.preprocess(_uniform(rgb))
    for c in range(3):
        # rembg: uint8 / max -> float64, then (x - mean) / std in float64, then float32.
        expected = np.float32((np.float64(rgb[c]) / 200 - MEAN[c]) / STD[c])
        assert np.all(t[0, c] == expected), c


def test_preprocess_black_image_takes_the_epsilon_path():
    t = birefnet.preprocess(_uniform((0, 0, 0)))
    assert np.all(np.isfinite(t))
    for c in range(3):
        assert np.all(t[0, c] == np.float32((0.0 - MEAN[c]) / STD[c]))


def test_preprocess_divides_by_the_image_max_not_255():
    t = birefnet.preprocess(_uniform((100, 50, 25)))
    assert np.all(t[0, 0] == np.float32((1.0 - MEAN[0]) / STD[0]))


@pytest.mark.parametrize("size", [(3, 2), (1700, 1300), (1300, 1700), (1024, 1024)])
def test_preprocess_any_size_becomes_1024_square(size):
    rng = np.random.default_rng(0)
    arr = rng.integers(0, 256, (size[1], size[0], 3), dtype=np.uint8)
    t = birefnet.preprocess(Image.fromarray(arr))
    assert t.shape == (1, 3, 1024, 1024)
    assert t.dtype == np.float32


def test_preprocess_matches_rembg_arithmetic_on_a_random_image():
    rng = np.random.default_rng(1)
    img = Image.fromarray(rng.integers(0, 256, (61, 47, 3), dtype=np.uint8))
    resized = np.array(img.convert("RGB").resize((1024, 1024), Image.Resampling.LANCZOS))
    scaled = resized / max(np.max(resized), 1e-6)
    expected = np.stack([(scaled[:, :, c] - MEAN[c]) / STD[c] for c in range(3)])
    expected = expected[None].astype(np.float32)
    assert np.array_equal(birefnet.preprocess(img), expected)


@pytest.mark.parametrize("mode", ["RGBA", "L", "P"])
def test_preprocess_converts_other_modes_to_rgb(mode):
    rng = np.random.default_rng(2)
    rgb = Image.fromarray(rng.integers(0, 256, (20, 30, 3), dtype=np.uint8))
    other = rgb.convert(mode)
    assert np.array_equal(birefnet.preprocess(other), birefnet.preprocess(other.convert("RGB")))


# ── postprocess ─────────────────────────────────────────────────────────────


def _raw(ch0: np.ndarray, extra_channels: int = 0, fill: float = 0.0) -> np.ndarray:
    h, w = ch0.shape
    raw = np.full((1, 1 + extra_channels, h, w), fill, np.float32)
    raw[0, 0] = ch0
    return raw


def test_postprocess_reads_channel_0_only():
    ch0 = np.linspace(-6, 6, 64, dtype=np.float32).reshape(8, 8)
    a = birefnet.postprocess(_raw(ch0), (8, 8))
    b = birefnet.postprocess(_raw(ch0, extra_channels=2, fill=9.0), (8, 8))
    assert np.array_equal(np.array(a), np.array(b))


def test_postprocess_min_max_and_truncating_cast():
    # sigmoid(-x), sigmoid(0)=0.5, sigmoid(x) normalise to 0, 0.5, 1; 0.5*255 = 127.5 -> 127.
    # Two rows: rembg's `np.squeeze` would also drop a height of 1 (the model is 1024x1024).
    ch0 = np.array([[-4.0, 0.0, 4.0], [-4.0, 0.0, 4.0]], np.float32)
    mask = np.array(birefnet.postprocess(_raw(ch0), (3, 2)))
    assert mask.tolist() == [[0, 127, 255], [0, 127, 255]]


def test_postprocess_applies_the_sigmoid_before_min_max():
    # Pinned from rembg's arithmetic. Without the sigmoid, -1 would give 95, not 66.
    row = np.array([-4.0, -1.0, 0.0, 0.5, 1.0, 4.0], np.float32)
    mask = np.array(birefnet.postprocess(_raw(np.stack([row, row])), (6, 2)))
    assert mask[0].tolist() == [0, 66, 127, 159, 188, 255]


def test_postprocess_resizes_with_lanczos():
    ch0 = np.random.default_rng(5).standard_normal((16, 16)).astype(np.float32)
    same_size = birefnet.postprocess(_raw(ch0), (16, 16))
    expected = same_size.resize((40, 25), Image.Resampling.LANCZOS)
    got = birefnet.postprocess(_raw(ch0), (40, 25))
    assert np.array_equal(np.array(got), np.array(expected))
    bicubic = same_size.resize((40, 25), Image.Resampling.BICUBIC)
    assert not np.array_equal(np.array(got), np.array(bicubic))  # the check can tell


def test_postprocess_mode_and_size_is_width_height():
    ch0 = np.random.default_rng(3).standard_normal((16, 16)).astype(np.float32)
    mask = birefnet.postprocess(_raw(ch0), (40, 25))
    assert mask.mode == "L"
    assert mask.size == (40, 25)
    assert np.array(mask).shape == (25, 40)


def test_postprocess_constant_output_does_not_raise():
    mask = birefnet.postprocess(_raw(np.full((4, 4), 2.0, np.float32)), (6, 5))
    assert mask.mode == "L" and mask.size == (6, 5)


def test_postprocess_extreme_logits_do_not_raise():
    ch0 = np.array([[-1e4, 1e4], [-1e4, 1e4]], np.float32)
    assert np.array(birefnet.postprocess(_raw(ch0), (2, 2))).tolist() == [[0, 255], [0, 255]]


# ── predict_alpha ───────────────────────────────────────────────────────────


class _Input:
    def __init__(self, name: str):
        self.name = name


class _FakeSession:
    def __init__(self, out_hw=(1024, 1024)):
        self.calls: list[tuple[object, dict]] = []
        self.out_hw = out_hw

    def get_inputs(self):
        return [_Input("input_image"), _Input("ignored")]

    def run(self, names, feed):
        self.calls.append((names, feed))
        h, w = self.out_hw
        first = np.tile(np.linspace(-5, 5, w, dtype=np.float32), (h, 1))[None, None]
        second = np.zeros((1, 1, h, w), np.float32)  # outputs[1] must never be used
        return [first, second]


def test_predict_alpha_feeds_the_first_input_and_reads_outputs_0(monkeypatch):
    fake = _FakeSession()
    monkeypatch.setattr(birefnet, "_session", fake)
    rgb = np.random.default_rng(4).integers(0, 256, (90, 140, 3), dtype=np.uint8)
    alpha = birefnet.predict_alpha(rgb)

    assert len(fake.calls) == 1
    names, feed = fake.calls[0]
    assert names is None
    assert list(feed) == ["input_image"]
    assert np.array_equal(feed["input_image"], birefnet.preprocess(Image.fromarray(rgb)))
    assert alpha.dtype == np.uint8
    assert alpha.shape == (90, 140)
    expected = np.array(birefnet.postprocess(fake.run(None, {})[0], (140, 90)))
    assert np.array_equal(alpha, expected)
    assert alpha[:, 0].max() < alpha[:, -1].min()  # the ramp survived: outputs[0], not [1]


def test_predict_alpha_logs_one_timing_line(monkeypatch):
    monkeypatch.setattr(birefnet, "_session", _FakeSession())
    records: list[str] = []
    handler = logging.Handler()
    handler.emit = lambda record: records.append(record.getMessage())
    birefnet.timing_logger.addHandler(handler)
    try:
        birefnet.predict_alpha(np.zeros((4, 4, 3), np.uint8))
    finally:
        birefnet.timing_logger.removeHandler(handler)
    lines = [ln for ln in records if "birefnet_run" in ln]
    assert len(lines) == 1
    body = json.loads(lines[0])
    assert body["msg"] == "birefnet_run"
    assert set(body) == {"msg", "n", "pre_ms", "ort_ms", "post_ms"}
    assert isinstance(body["n"], int) and body["n"] >= 1


@pytest.mark.parametrize(
    "bad",
    [
        np.zeros((4, 4), np.uint8),
        np.zeros((4, 4, 4), np.uint8),
        np.zeros((4, 4, 3), np.float32),
    ],
)
def test_predict_alpha_rejects_non_rgb_uint8(bad, monkeypatch):
    monkeypatch.setattr(birefnet, "_session", _FakeSession())
    with pytest.raises(ValueError):
        birefnet.predict_alpha(bad)


# ── Model selection ─────────────────────────────────────────────────────────


def test_model_name_default_and_allowlist(monkeypatch):
    monkeypatch.delenv("BIREFNET_MODEL", raising=False)
    assert birefnet.model_name() == "birefnet-general"
    monkeypatch.setenv("BIREFNET_MODEL", "birefnet-general-lite")
    assert birefnet.model_name() == "birefnet-general-lite"
    monkeypatch.setenv("BIREFNET_MODEL", "withoutbg")
    with pytest.raises(ValueError):
        birefnet.model_name()


def test_model_path(monkeypatch):
    monkeypatch.delenv("BIREFNET_MODEL", raising=False)
    monkeypatch.delenv("BIREFNET_HOME", raising=False)
    assert birefnet.model_path() == "/opt/birefnet/birefnet-general.onnx"
    monkeypatch.setenv("BIREFNET_HOME", "/x/y")
    assert birefnet.model_path() == "/x/y/birefnet-general.onnx"


@pytest.fixture
def home(tmp_path, monkeypatch) -> Path:
    monkeypatch.setenv("BIREFNET_HOME", str(tmp_path))
    monkeypatch.delenv("BIREFNET_MODEL", raising=False)
    (tmp_path / "birefnet-general.onnx").write_bytes(b"model")
    return tmp_path


def test_weights_sha256(home):
    f = home / "birefnet-general.onnx.sha256"
    assert birefnet.weights_sha256() is None  # missing: B off
    f.write_text("A" * 64 + "\n")
    assert birefnet.weights_sha256() == "a" * 64
    f.write_text("b" * 64 + "  birefnet-general.onnx\n")  # sha256sum output
    assert birefnet.weights_sha256() == "b" * 64
    f.write_text("not-a-digest\n")
    assert birefnet.weights_sha256() is None
    f.write_text("")
    assert birefnet.weights_sha256() is None


# ── Session ─────────────────────────────────────────────────────────────────


def test_session_options_spec(monkeypatch):
    monkeypatch.delenv("OMP_NUM_THREADS", raising=False)
    assert birefnet.session_options_spec() == {
        "enable_cpu_mem_arena": False,
        "graph_optimization_level": "ORT_ENABLE_ALL",
        "intra_op_num_threads": 0,
        "inter_op_num_threads": 0,
        "logger_severity": 3,
    }
    monkeypatch.setenv("OMP_NUM_THREADS", "3")
    spec = birefnet.session_options_spec()
    assert spec["intra_op_num_threads"] == 3 and spec["inter_op_num_threads"] == 3


def test_built_options_match_the_spec(monkeypatch):
    ort = pytest.importorskip("onnxruntime")
    monkeypatch.setenv("OMP_NUM_THREADS", "2")
    opts = birefnet._build_session_options(ort)
    assert opts.enable_cpu_mem_arena is False
    assert opts.graph_optimization_level == ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    assert opts.intra_op_num_threads == 2
    assert opts.inter_op_num_threads == 2
    assert opts.optimized_model_filepath == ""  # never re-saved at runtime


def _provenance(home: Path, **fields) -> None:
    ort = pytest.importorskip("onnxruntime")
    body = {"format": 1, "model": "birefnet-general", "onnxruntime": ort.__version__}
    body.update(fields)
    (home / "birefnet-general.onnx.provenance.json").write_text(json.dumps(body))


def _capture_factory(monkeypatch, delay: float = 0.0) -> list[tuple]:
    calls: list[tuple] = []

    def factory(path, sess_options, providers):
        time.sleep(delay)
        calls.append((path, sess_options, providers))
        return _FakeSession()

    monkeypatch.setattr(birefnet, "_new_inference_session", factory)
    return calls


def test_get_session_builds_once_with_the_spec(home, monkeypatch):
    ort = pytest.importorskip("onnxruntime")
    _provenance(home)
    calls = _capture_factory(monkeypatch)
    assert birefnet.is_session_loaded() is False
    s = birefnet.get_session()
    assert birefnet.get_session() is s
    assert birefnet.is_session_loaded() is True
    assert len(calls) == 1
    path, opts, providers = calls[0]
    assert path == str(home / "birefnet-general.onnx")
    assert providers == ["CPUExecutionProvider"]
    assert opts.enable_cpu_mem_arena is False
    assert opts.graph_optimization_level == ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    assert opts.optimized_model_filepath == ""


def test_get_session_is_created_once_under_concurrency(home, monkeypatch):
    _provenance(home)
    calls = _capture_factory(monkeypatch, delay=0.05)
    results: list[object] = []
    threads = [
        threading.Thread(target=lambda: results.append(birefnet.get_session())) for _ in range(8)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(calls) == 1
    assert len(results) == 8 and all(r is results[0] for r in results)


@pytest.mark.parametrize(
    "fields",
    [
        {"onnxruntime": "0.0.1"},
        {"model": "birefnet-general-lite"},
        {"format": 2},
    ],
)
def test_get_session_refuses_a_mismatched_provenance(home, monkeypatch, fields):
    _provenance(home, **fields)
    calls = _capture_factory(monkeypatch)
    with pytest.raises(RuntimeError):
        birefnet.get_session()
    assert calls == []
    assert birefnet.is_session_loaded() is False


def test_get_session_refuses_a_missing_provenance(home, monkeypatch):
    pytest.importorskip("onnxruntime")
    calls = _capture_factory(monkeypatch)
    with pytest.raises(RuntimeError, match="provenance"):
        birefnet.get_session()
    assert calls == []


def test_load_session_reports(home, monkeypatch):
    ort = pytest.importorskip("onnxruntime")
    _provenance(home)
    _capture_factory(monkeypatch)
    report = birefnet.load_session()
    assert set(report) == {"session_load_s", "model", "ort"}
    assert report["model"] == "birefnet-general"
    assert report["ort"] == ort.__version__
    assert report["session_load_s"] >= 0
    assert birefnet.load_session()["session_load_s"] < 0.5  # already resident


def test_importing_birefnet_does_not_import_onnxruntime():
    code = (
        "import sys\n"
        "import app.cropper.birefnet as b\n"
        "b.session_options_spec(); b.model_name(); b.weights_sha256(); b.PRE_POST_SPEC\n"
        "sys.exit(1 if 'onnxruntime' in sys.modules else 0)\n"
    )
    proc = subprocess.run(
        [sys.executable, "-c", code], cwd=SERVICE_ROOT, capture_output=True, text=True
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
