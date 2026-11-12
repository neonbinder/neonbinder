"""`tests/parity/_parity.py`: the parity job's checks, proven here first.

The parity suite only runs in CI's docker job; these tests make sure every
comparison it relies on reports a failure when it should, and only then.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import cv2
import numpy as np
import pytest
from PIL import Image

from app.cropper import birefnet
from tests.parity import _parity

gm = _parity.load_script("golden_masks")


# ── Configuration and sharding ──────────────────────────────────────────────


def _env(**kw):
    base = {
        "PARITY_STAGE": "oracle",
        "PARITY_FIXTURES_DIR": "/f",
        "PARITY_ORIGINAL_MODEL": "/m/x.onnx",
    }
    base.update(kw)
    return {k: v for k, v in base.items() if v is not None}


def test_config_reads_the_job_environment():
    cfg = _parity.config_from_env(_env(PARITY_SHARD_INDEX="1", PARITY_SHARD_COUNT="2"))
    assert cfg.stage == "oracle"
    assert cfg.fixtures_dir == Path("/f")
    assert cfg.original_model == Path("/m/x.onnx")
    assert (cfg.shard_index, cfg.shard_count) == (1, 2)
    base = _parity.config_from_env(_env(PARITY_STAGE="base", PARITY_ORIGINAL_MODEL=None))
    assert base.original_model is None and (base.shard_index, base.shard_count) == (0, 1)


@pytest.mark.parametrize(
    "env",
    [
        {"PARITY_STAGE": None},
        {"PARITY_STAGE": "both"},
        {"PARITY_FIXTURES_DIR": None},
        {"PARITY_ORIGINAL_MODEL": None},
        {"PARITY_SHARD_INDEX": "2", "PARITY_SHARD_COUNT": "2"},
        {"PARITY_SHARD_INDEX": "-1", "PARITY_SHARD_COUNT": "2"},
        {"PARITY_SHARD_COUNT": "0"},
        {"PARITY_SHARD_COUNT": "two"},
    ],
)
def test_config_refuses_an_incomplete_environment(env):
    with pytest.raises(_parity.ParityConfigError):
        _parity.config_from_env(_env(**env))


def test_shards_are_disjoint_and_cover_every_fixture():
    names = [f"f{i:02d}.jpg" for i in range(16)][::-1]
    shards = [_parity.shard(names, i, 2) for i in range(2)]
    assert [len(s) for s in shards] == [8, 8]
    assert set(shards[0]).isdisjoint(shards[1])
    assert sorted(shards[0] + shards[1]) == sorted(names)
    assert _parity.shard(names, 0, 1) == sorted(names)


def test_env_defaults_point_rembg_at_the_verified_original_offline():
    env = {
        "PARITY_STAGE": "oracle",
        "PARITY_ORIGINAL_MODEL": "/work/.parity/model/birefnet-general.onnx",
    }
    _parity.env_defaults(env)
    assert env["U2NET_HOME"] == "/work/.parity/model"
    assert env["NUMBA_DISABLE_JIT"] == "1"
    assert env["HF_HUB_OFFLINE"] == env["TRANSFORMERS_OFFLINE"] == "1"
    base = {"PARITY_STAGE": "base"}
    _parity.env_defaults(base)
    assert "U2NET_HOME" not in base and "NUMBA_DISABLE_JIT" not in base


# ── Goldens and fixtures ────────────────────────────────────────────────────


WORK, PAD = (60, 50), 6


def _plane(seed=0):
    """A padded alpha plane: 0 in the padding, 24 (just under the mask
    threshold) in the work frame's background, a solid card, a little noise."""
    h, w = WORK
    a = np.zeros((h + 2 * PAD, w + 2 * PAD), np.uint8)
    a[PAD : PAD + h, PAD : PAD + w] = 24
    a[PAD + 30 : PAD + 55, PAD + 25 : PAD + 45] = 255
    a[PAD + 40, PAD + 30 + seed] = 250
    return a


def _spots(n):
    """`n` work-frame background pixels, 7 px apart (single mask pixels each)."""
    pts = [(PAD + y, PAD + x) for y in range(3, 25, 7) for x in range(3, 46, 7)]
    assert len(pts) >= n
    return tuple(np.array(pts[:n]).T)


def _goldens(tmp_path: Path, fixtures: dict[str, bytes], key="k-golden"):
    gdir = tmp_path / "goldens"
    gdir.mkdir()
    entries = {}
    for i, (name, data) in enumerate(sorted(fixtures.items())):
        png = f"{Path(name).stem}.png"
        a = _plane(i)
        gm.write_png(a, gdir / png)
        entries[name] = {
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data),
            "work_shape": list(WORK),
            "pad": PAD,
            "padded_shape": [WORK[0] + 2 * PAD, WORK[1] + 2 * PAD],
            "alpha_png": png,
            "alpha": {key: gm.alpha_sha256(a)},
        }
    manifest = {
        "format": 1,
        "kind": "goldens",
        "fingerprints": {key: {}},
        "golden_fingerprint": key,
        "fixtures": entries,
        "tolerance": {"max_alpha_diff": 4, "max_alpha_pixel_frac": 0.01, "max_mask_pixels": 5},
    }
    return manifest, gdir


def test_complete_goldens_pass_and_each_gap_is_named(tmp_path):
    manifest, gdir = _goldens(tmp_path, {"a.jpg": b"a", "b.jpg": b"b"})
    assert _parity.goldens_problems(manifest, gdir) == []

    broken = json.loads(json.dumps(manifest))
    broken["kind"] = "run"
    broken["tolerance"] = None
    broken["fixtures"]["a.jpg"]["alpha"] = {"other": "x"}
    (gdir / "b.png").unlink()
    problems = "\n".join(_parity.goldens_problems(broken, gdir))
    assert "kind" in problems and "tolerance" in problems
    assert "a.jpg: no alpha" in problems and "b.jpg: golden PNG" in problems
    assert _parity.goldens_problems({**manifest, "golden_fingerprint": "nope"}, gdir)
    assert _parity.goldens_problems({**manifest, "fixtures": {}}, gdir)


def test_the_fixture_directory_must_equal_the_manifest_byte_for_byte(tmp_path):
    manifest, _ = _goldens(tmp_path, {"a.jpg": b"a", "b.jpg": b"b"})
    fx = tmp_path / "fx"
    fx.mkdir()
    (fx / "a.jpg").write_bytes(b"a")
    (fx / "b.jpg").write_bytes(b"b")
    assert _parity.fixture_problems(manifest, fx) == []

    (fx / "b.jpg").write_bytes(b"replaced")
    (fx / "c.jpg").write_bytes(b"new")
    (fx / "a.jpg").unlink()
    problems = "\n".join(_parity.fixture_problems(manifest, fx))
    assert "a.jpg: in the manifest but not" in problems
    assert "c.jpg: in" in problems and "not in the manifest" in problems
    assert "b.jpg: sha256" in problems
    assert _parity.fixture_problems(manifest, tmp_path / "missing")


def test_input_problems_name_each_disagreement():
    fx = {"work_shape": [10, 20], "pad": 3, "padded_shape": [16, 26]}
    assert _parity.input_problems(fx, (10, 20), 3, (16, 26)) == []
    assert len(_parity.input_problems(fx, (10, 21), 4, (16, 27))) == 3


# ── L1 ──────────────────────────────────────────────────────────────────────


def test_array_problems_is_byte_equality():
    a = np.arange(12, dtype=np.float32).reshape(3, 4)
    assert _parity.array_problems("x", a, a.copy()) == []
    b = a.copy()
    b[1, 1] = np.nextafter(b[1, 1], np.float32(100))
    assert "1 of 12 values differ" in _parity.array_problems("x", b, a)[0]
    assert "dtype" in _parity.array_problems("x", a.astype(np.float64), a)[0]
    assert "shape" in _parity.array_problems("x", a.reshape(4, 3), a)[0]


# ── L2 ──────────────────────────────────────────────────────────────────────


def _l2_setup(tmp_path):
    manifest, gdir = _goldens(tmp_path, {"a.jpg": b"a"})
    fx = manifest["fixtures"]["a.jpg"]
    golden = gm.read_png(gdir / fx["alpha_png"])
    return manifest, fx, golden


def test_golden_check_is_exact_on_a_recorded_fingerprint(tmp_path):
    manifest, fx, golden = _l2_setup(tmp_path)
    ok = _parity.golden_check(gm, golden.copy(), fx, manifest, "k-golden", golden)
    assert (ok.mode, ok.problems) == ("exact", [])
    one_off = golden.copy()
    one_off[0, 0] ^= 1
    bad = _parity.golden_check(gm, one_off, fx, manifest, "k-golden", golden)
    assert bad.mode == "exact" and bad.problems


def _check(manifest, fx, golden, alpha):
    return _parity.golden_check(gm, alpha, fx, manifest, "k-ci", golden)


def test_golden_check_uses_the_tolerance_on_an_unrecorded_host(tmp_path):
    manifest, fx, golden = _l2_setup(tmp_path)  # T=4, F=0.01, N=5 mask px
    near = golden.copy()
    near[0, :2] += 3  # padding: 2 alpha px, no mask px
    ok = _check(manifest, fx, golden, near)
    assert ok.mode == "tolerance" and ok.problems == []
    assert (ok.stats["alpha_pixels"], ok.stats["mask_pixels"]) == (2, 0)

    five = golden.copy()
    five[_spots(5)] += 2  # 24 -> 26 crosses the threshold: 5 mask px at |d| 2
    ok = _check(manifest, fx, golden, five)
    assert ok.problems == [] and ok.stats["mask_pixels"] == 5

    six = golden.copy()
    six[_spots(6)] += 2  # only N is exceeded
    res = _check(manifest, fx, golden, six)
    assert res.stats["mask_pixels"] == 6 and res.stats["max_alpha_diff"] == 2
    assert res.problems and "outside tolerance" in res.problems[0]

    spread = golden.copy()
    spread[0, :50] += 1  # 50 / 4464 alpha px > F; no mask px
    res = _check(manifest, fx, golden, spread)
    assert res.stats["mask_pixels"] == 0 and res.problems

    deep = golden.copy()
    deep[0, 0] = 9  # 1 px, |d| 9 > T
    assert _check(manifest, fx, golden, deep).problems

    wrong_shape = np.zeros((41, 30), np.uint8)
    assert _parity.golden_check(gm, wrong_shape, fx, manifest, "k-ci", golden).problems


def test_golden_check_refuses_a_golden_png_that_is_not_the_manifests(tmp_path):
    manifest, fx, golden = _l2_setup(tmp_path)
    tampered = golden.copy()
    tampered[5, 5] ^= 0xFF
    res = _parity.golden_check(gm, tampered, fx, manifest, "k-ci", tampered)
    assert res.problems and "golden PNG" in res.problems[0]


def test_alpha_plus_one_fails_both_modes(tmp_path):
    manifest, fx, golden = _l2_setup(tmp_path)
    plus = _parity.alpha_plus_one(golden)
    assert plus.dtype == np.uint8 and int(plus.max()) <= 255
    assert _parity.golden_check(gm, plus, fx, manifest, "k-golden", golden).problems
    assert _parity.golden_check(gm, plus, fx, manifest, "k-ci", golden).problems


# ── Quads ───────────────────────────────────────────────────────────────────


def _card_scene(shift=(0.0, 0.0)):
    """A work image and an alpha plane holding one rotated card-shaped blob."""
    from app.cropper import tiered

    h, w = 600, 450
    p = int(tiered.BIREFNET_PAD * max(h, w))  # what tiered.birefnet_mask crops back by
    work = np.full((h, w, 3), 200, np.uint8)
    rect = ((225 + shift[0], 300 + shift[1]), (250, 350), 7.0)
    box = cv2.boxPoints(rect).astype(np.int32)
    cv2.fillConvexPoly(work, box, (40, 60, 90))
    alpha = np.zeros((h + 2 * p, w + 2 * p), np.uint8)
    cv2.fillConvexPoly(alpha, box + p, 255)
    return work, alpha, p


def test_components_for_alpha_runs_tiereds_own_mask_and_analysis():
    work, alpha, _p = _card_scene()
    comps = _parity.components_for_alpha(alpha, work)
    assert len(comps) == 1 and comps[0]["route"] == "quad"
    assert _parity.quad_problems(comps, comps) == []


def test_quad_problems_flag_a_moved_corner_and_a_changed_shape():
    work, alpha, _p = _card_scene()
    want = _parity.components_for_alpha(alpha, work)
    _w2, moved_alpha, _ = _card_scene(shift=(4.0, 0.0))
    moved = _parity.components_for_alpha(moved_alpha, work)
    assert "corner moved" in _parity.quad_problems(moved, want)[0]
    assert "components" in _parity.quad_problems([], want)[0]
    assert "route" in _parity.quad_problems([{**want[0], "route": "diecut"}], want)[0]


# ── Reference copies and the canaries they carry ────────────────────────────


def _image(seed=7, shape=(700, 520, 3)):
    return Image.fromarray(np.random.default_rng(seed).integers(0, 256, shape, dtype=np.uint8))


def test_reference_preprocess_equals_birefnet_preprocess_and_its_canaries_differ():
    img = _image()
    real = birefnet.preprocess(img)
    assert _parity.array_problems("pre", _parity.reference_preprocess(img), real) == []
    bilinear = _parity.reference_preprocess(img, resample=Image.Resampling.BILINEAR)
    assert _parity.array_problems("pre", bilinear, real)
    shifted = _parity.reference_preprocess(img, mean_shift=1e-7)
    assert _parity.array_problems("pre", shifted, real)


def test_reference_postprocess_equals_birefnet_postprocess_and_its_canaries_differ():
    raw = np.random.default_rng(8).normal(0, 4, (1, 1, 1024, 1024)).astype(np.float32)
    size = (531, 777)
    real = np.array(birefnet.postprocess(raw, size))
    assert _parity.array_problems("post", _parity.reference_postprocess(raw, size), real) == []
    assert _parity.array_problems(
        "post", _parity.reference_postprocess(raw, size, sigmoid=False), real
    )
    assert _parity.array_problems("post", _parity.reference_postprocess(raw, size, scale=254), real)


def test_absent_list_covers_the_packages_rembg_dragged_in():
    assert {"rembg", "pymatting", "numba", "scipy", "skimage", "pooch"} <= set(
        _parity.ABSENT_FROM_IMAGE
    )
