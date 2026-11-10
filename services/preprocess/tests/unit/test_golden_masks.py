"""`scripts/golden_masks.py`: padding, host fingerprint, generate, hash and compare.

No model is loaded: `generate` runs with the direct back end's
`predict_alpha` replaced by a deterministic fake, which is all the script's
own logic needs.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest
from PIL import Image

SERVICE_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = SERVICE_ROOT / "scripts" / "golden_masks.py"


def _load_script():
    spec = importlib.util.spec_from_file_location("golden_masks", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


gm = _load_script()


def _work(h: int, w: int, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    work = np.empty((h, w, 3), np.uint8)
    work[:] = (30, 120, 200)
    inner = work[h // 4 : 3 * h // 4, w // 4 : 3 * w // 4]
    inner[:] = rng.integers(0, 256, inner.shape)
    work[0, :] = (31, 121, 199)  # a ring that is not uniform
    return work


# ── Padding ─────────────────────────────────────────────────────────────────


def _ring_sensitive(h: int, w: int) -> np.ndarray:
    """Colour rises with distance from the edge (plus noise), so the border
    median moves if the ring is one pixel thicker, thinner or shifted."""
    i = np.arange(h)[:, None]
    j = np.arange(w)[None, :]
    d = np.minimum(np.minimum(i, h - 1 - i), np.minimum(j, w - 1 - j))
    noise = np.random.default_rng(h * w).integers(0, 3, (h, w, 3))
    work = (d[..., None] * np.array([7, 5, 3]) + noise) % 256
    return work.astype(np.uint8)


def _app_padding(work: np.ndarray, monkeypatch) -> tuple[np.ndarray, int]:
    """The app's own padding: `tiered.pad_for_birefnet` when it exists, else the
    padded input the pre-NEO-484 `birefnet_mask` hands to rembg."""
    from app.cropper import tiered

    pad = getattr(tiered, "pad_for_birefnet", None)
    if pad is not None:
        return pad(work)

    seen: dict[str, np.ndarray] = {}

    def fake_remove(rgb, session=None, **_kw):
        seen["rgb"] = rgb.copy()
        out = np.zeros((*rgb.shape[:2], 4), np.uint8)
        return out

    fake_rembg = type(sys)("rembg")
    fake_rembg.remove = fake_remove
    monkeypatch.setitem(sys.modules, "rembg", fake_rembg)
    monkeypatch.setattr(tiered, "_get_session", lambda: object())
    tiered.birefnet_mask(work)
    h, w = work.shape[:2]
    return seen["rgb"], (seen["rgb"].shape[0] - h) // 2


@pytest.mark.parametrize("shape", [(1200, 857), (857, 1200), (40, 31), (5, 7)])
def test_padding_matches_the_app(shape, monkeypatch):
    work = _ring_sensitive(*shape)
    ours, p = gm.pad_for_birefnet(work)
    theirs, their_p = _app_padding(work, monkeypatch)
    assert p == their_p
    assert ours.dtype == np.uint8
    assert np.array_equal(ours, theirs)


def test_padding_is_rgb_with_the_border_median_colour():
    work = np.zeros((100, 70, 3), np.uint8)
    work[:] = (10, 20, 30)  # BGR
    padded, p = gm.pad_for_birefnet(work)
    assert p == int(0.12 * 100)
    assert padded.shape == (100 + 2 * p, 70 + 2 * p, 3)
    assert tuple(padded[0, 0]) == (30, 20, 10)  # RGB


def test_padding_truncates_a_half_median(monkeypatch):
    # Left half 11, right half 12: a balanced ring whose median is 11.5. The app
    # truncates it (int), so the pad colour is 11, never 12.
    work = np.empty((40, 40, 3), np.uint8)
    work[:, :20] = 11
    work[:, 20:] = 12
    padded, _p = gm.pad_for_birefnet(work)
    assert tuple(padded[0, 0]) == (11, 11, 11)
    theirs, _ = _app_padding(work, monkeypatch)
    assert np.array_equal(padded, theirs)


def test_padded_input_refuses_an_app_padding_that_disagrees(monkeypatch):
    from app.cropper import tiered

    def other(work):
        padded, p = gm.pad_for_birefnet(work)
        padded = padded.copy()
        padded[0, 0, 0] ^= 1
        return padded, p

    monkeypatch.setattr(tiered, "pad_for_birefnet", other, raising=False)
    with pytest.raises(gm.InputMismatchError):
        gm._padded_input(_work(50, 40))


# ── Host fingerprint ────────────────────────────────────────────────────────

CPUINFO = """\
processor\t: 0
vendor_id\t: GenuineIntel
model name\t: Intel(R) Xeon(R) CPU @ 2.20GHz
flags\t\t: fpu sse4_1 avx f16c fma avx2 avx512f avx512bw avx512vl avx512_vnni amx_tile

processor\t: 1
model name\t: Some Other CPU
flags\t\t: fpu sse4_1
"""


def test_parse_cpuinfo_takes_the_first_processor():
    info = gm.parse_cpuinfo(CPUINFO)
    assert info["cpu_model"] == "Intel(R) Xeon(R) CPU @ 2.20GHz"
    assert {"avx2", "avx512f", "amx_tile"} <= info["flags"]
    assert "Some" not in info["cpu_model"]


def test_parse_cpuinfo_without_a_model_name():
    assert gm.parse_cpuinfo("")["cpu_model"] == "unknown"
    assert gm.parse_cpuinfo("")["flags"] == set()


def test_isa_lists_relevant_flags_in_a_fixed_order():
    flags = ["avx512f", "fpu", "avx2", "fma", "sse4_1"]
    assert gm.isa_from("x86_64", flags) == "x86_64+sse4_1+fma+avx2+avx512f"
    assert gm.isa_from("x86_64", reversed(flags)) == "x86_64+sse4_1+fma+avx2+avx512f"
    assert gm.isa_from("arm64", []) == "arm64"


@pytest.mark.parametrize(
    ("proc_version", "environ", "expected"),
    [
        (
            "Linux version 4.19.0-gvisor #1 SMP Sun Jan 10 15:06:54 PST 2016",
            {"K_SERVICE": "s"},
            "gen1",
        ),
        ("Linux version 4.19.0-gVisor #1 SMP", {"CLOUD_RUN_JOB": "j"}, "gen1"),
        ("Linux version 4.4.0 #1 SMP Sun Jan 10 15:06:54 PST 2016", {"K_SERVICE": "s"}, "gen1"),
        ("Linux version 6.1.112+ (builder@host) #1 SMP", {"K_SERVICE": "s"}, "gen2"),
        ("Linux version 6.1.112+ (builder@host) #1 SMP", {"CLOUD_RUN_JOB": "j"}, "gen2"),
        ("Linux version 6.8.0-45-generic", {}, "local"),
        ("", {}, "local"),
        ("Linux version 4.4.01", {}, "local"),
    ],
)
def test_exec_env(proc_version, environ, expected):
    assert gm.exec_env_from(proc_version, environ) == expected


def test_fingerprint_key_ignores_key_order():
    a = {"isa": "x", "cpu_flags": "f", "versions": {"numpy": "2", "Pillow": "12"}}
    b = {"versions": {"Pillow": "12", "numpy": "2"}, "cpu_flags": "f", "isa": "x"}
    assert gm.fingerprint_key(a) == gm.fingerprint_key(b)
    assert gm.fingerprint_key(a) != gm.fingerprint_key({**a, "cpu_flags": "g"})
    assert len(gm.fingerprint_key(a)) == 16


def test_host_fingerprint_keys_on_the_source_model():
    model = {"name": "birefnet-general", "source": {"sha256": "s" * 64, "md5": "m" * 32}}
    fp = gm.host_fingerprint(model)
    assert set(fp) == {
        "isa",
        "exec_env",
        "cpu_model",
        "cpu_flags",
        "omp_num_threads",
        "versions",
        "model",
    }
    assert fp["model"] == {"name": "birefnet-general", "sha256": "s" * 64, "md5": "m" * 32}
    assert set(fp["versions"]) == {"onnxruntime", "Pillow", "numpy", "opencv-python-headless"}


GEN1_CPUINFO = """\
processor\t: 0
vendor_id\t: GenuineIntel
cpu family\t: 6
flags\t\t: fpu sse4_1 avx fma avx2 avx512f
"""


def _fake_host(monkeypatch, cpuinfo: str, proc_version: str, nproc: int, **env: str) -> None:
    files = {"/proc/cpuinfo": cpuinfo, "/proc/version": proc_version}
    monkeypatch.setattr(gm, "_read", lambda path: files.get(path, ""))
    monkeypatch.setattr(gm, "_nproc", lambda: nproc)
    monkeypatch.delenv("K_SERVICE", raising=False)
    monkeypatch.delenv("CLOUD_RUN_JOB", raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)


MODEL = {"name": "birefnet-general", "source": {"sha256": "s" * 64, "md5": "m" * 32}}


def test_gen1_host_without_a_model_name(monkeypatch):
    _fake_host(monkeypatch, GEN1_CPUINFO, "Linux version 4.19.0-gvisor #1", 8, K_SERVICE="s")
    fp = gm.host_fingerprint(MODEL)
    assert fp["exec_env"] == "gen1"
    assert fp["cpu_model"] == "unknown"
    assert fp["cpu_flags"] == gm.cpu_flags_digest(
        ["fpu", "sse4_1", "avx", "fma", "avx2", "avx512f"]
    )
    assert fp["isa"].endswith("+sse4_1+avx+fma+avx2+avx512f")


def test_flags_tell_unnamed_cpus_apart(monkeypatch):
    _fake_host(monkeypatch, GEN1_CPUINFO, "Linux version 4.19.0-gvisor #1", 8, K_SERVICE="s")
    a = gm.fingerprint_key(gm.host_fingerprint(MODEL))
    _fake_host(
        monkeypatch,
        GEN1_CPUINFO.replace("avx512f", "avx512f avx512_vnni"),
        "Linux version 4.19.0-gvisor #1",
        8,
        K_SERVICE="s",
    )
    assert gm.fingerprint_key(gm.host_fingerprint(MODEL)) != a


def test_nproc_is_recorded_but_not_keyed(monkeypatch):
    keys = set()
    for nproc in (5, 8, 9):
        _fake_host(monkeypatch, CPUINFO, "Linux version 6.1.112+ #1", nproc, CLOUD_RUN_JOB="j")
        fp = gm.host_fingerprint(MODEL)
        assert "nproc" not in fp
        keys.add(gm.fingerprint_key(fp))
        assert gm.host_facts()["nproc"] == nproc
    assert len(keys) == 1


def test_cpu_flags_digest():
    assert gm.cpu_flags_digest(["b", "a", "a"]) == gm.cpu_flags_digest(["a", "b"])
    assert gm.cpu_flags_digest(["a"]) != gm.cpu_flags_digest(["a", "b"])
    assert len(gm.cpu_flags_digest(["a"])) == 12
    assert gm.cpu_flags_digest([]) == ""


def test_alpha_sha256_includes_the_shape():
    a = np.zeros((2, 6), np.uint8)
    assert gm.alpha_sha256(a) != gm.alpha_sha256(a.reshape(3, 4))
    assert gm.alpha_sha256(a) == gm.alpha_sha256(a.copy())


# ── generate ────────────────────────────────────────────────────────────────


def _fake_alpha(rgb: np.ndarray) -> np.ndarray:
    return (rgb.astype(np.uint16).sum(axis=2) % 256).astype(np.uint8)


@pytest.fixture
def fixtures_dir(tmp_path: Path) -> Path:
    d = tmp_path / "fixtures"
    d.mkdir()
    for i, (h, w) in enumerate([(90, 64), (64, 90), (50, 50)]):
        bgr = _work(h, w, seed=i)
        cv2.imwrite(str(d / f"card-{i}.png"), bgr)
    (d / "notes.yaml").write_text("not an image\n")
    return d


@pytest.fixture
def direct_env(tmp_path: Path, monkeypatch):
    """A fake baked model so `model_info('direct')` has a file to hash."""
    from app.cropper import birefnet

    home = tmp_path / "birefnet"
    home.mkdir()
    (home / "birefnet-general.onnx").write_bytes(b"not really a model")
    (home / "birefnet-general.onnx.provenance.json").write_text(
        json.dumps({"format": 1, "source_sha256": "a" * 64, "source_md5": "b" * 32})
    )
    monkeypatch.setenv("BIREFNET_HOME", str(home))
    monkeypatch.delenv("BIREFNET_MODEL", raising=False)
    monkeypatch.setattr(birefnet, "predict_alpha", _fake_alpha)
    return home


def _generate(fixtures_dir: Path, out: Path, **kw) -> dict:
    return gm.generate("direct", str(fixtures_dir), str(out), **kw)


def test_generate_writes_pngs_and_a_format_1_manifest(fixtures_dir, tmp_path, direct_env):
    out = tmp_path / "run"
    manifest = _generate(fixtures_dir, out)
    on_disk = json.loads((out / "manifest.json").read_text())
    assert on_disk == json.loads(json.dumps(manifest))
    assert on_disk["format"] == 1 and on_disk["kind"] == "run"
    assert sorted(on_disk["fixtures"]) == ["card-0.png", "card-1.png", "card-2.png"]
    key = on_disk["golden_fingerprint"]
    assert list(on_disk["fingerprints"]) == [key]
    assert on_disk["fingerprints"][key]["model"]["sha256"] == "a" * 64  # source, from provenance
    run = on_disk["runs"][0]
    assert run["impl"] == "direct"
    assert run["inference_impl"].startswith("birefnet-direct-ort/")
    assert "numpy" in run["packages"]
    assert isinstance(run["host"]["nproc"], int)
    assert "nproc" not in on_disk["fingerprints"][key]
    assert on_disk["padding"] == {"birefnet_pad": 0.12, "ring_frac": 0.03, "work_long": 1200}

    from app.cropper import tiered

    for name, fx in on_disk["fixtures"].items():
        data = (fixtures_dir / name).read_bytes()
        _full, work, _scale = tiered._load(data)
        padded, p = gm.pad_for_birefnet(work)
        alpha = gm.read_png(out / fx["alpha_png"])
        assert np.array_equal(alpha, _fake_alpha(padded))
        assert fx["alpha"][key] == gm.alpha_sha256(alpha)
        assert fx["pad"] == p
        assert fx["padded_shape"] == list(padded.shape[:2])
        assert fx["work_shape"] == list(work.shape[:2])


def test_generate_only_and_expect(fixtures_dir, tmp_path, direct_env):
    m = _generate(fixtures_dir, tmp_path / "one", only={"card-1"})
    assert list(m["fixtures"]) == ["card-1.png"]
    with pytest.raises(SystemExit):
        _generate(fixtures_dir, tmp_path / "x", expect=16)


def test_generate_rejects_a_wrong_alpha_shape(fixtures_dir, tmp_path, direct_env, monkeypatch):
    from app.cropper import birefnet

    monkeypatch.setattr(birefnet, "predict_alpha", lambda rgb: _fake_alpha(rgb)[1:])
    with pytest.raises(SystemExit):
        _generate(fixtures_dir, tmp_path / "bad")


def test_out_template(monkeypatch):
    monkeypatch.setenv("CLOUD_RUN_TASK_INDEX", "3")
    out = gm.resolve_out("gs://b/s0a/{exec_env}/t{task}-{run}", "gen2")
    assert out.startswith("gs://b/s0a/gen2/t3-")
    assert len(out.rsplit("-", 1)[1]) == 8


def test_importing_the_script_loads_neither_birefnet_nor_onnxruntime():
    code = (
        "import importlib.util, sys\n"
        f"spec = importlib.util.spec_from_file_location('gm', {str(SCRIPT)!r})\n"
        "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n"
        "m.build_parser()\n"
        "bad = [n for n in ('onnxruntime', 'app.cropper.birefnet', 'rembg') if n in sys.modules]\n"
        "print(bad); sys.exit(1 if bad else 0)\n"
    )
    proc = subprocess.run(
        [sys.executable, "-c", code], cwd=SERVICE_ROOT, capture_output=True, text=True
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


# ── hash ────────────────────────────────────────────────────────────────────


def _retag(run: Path, key: str, fp_extra: dict) -> None:
    """Rewrite a run as if it came from another host (a different fingerprint)."""
    m = json.loads((run / "manifest.json").read_text())
    old = m["golden_fingerprint"]
    m["fingerprints"] = {key: {**m["fingerprints"][old], **fp_extra}}
    m["golden_fingerprint"] = key
    m["runs"][0]["fingerprint"] = key
    for fx in m["fixtures"].values():
        fx["alpha"] = {key: fx["alpha"][old]}
    (run / "manifest.json").write_text(json.dumps(m))


def _bump_pixels(run: Path, fixture: str, n: int, by: int) -> None:
    m = json.loads((run / "manifest.json").read_text())
    fx = m["fixtures"][fixture]
    alpha = gm.read_png(run / fx["alpha_png"]).copy()
    flat = alpha.reshape(-1)
    v = flat[:n].astype(int)
    # Each pixel moves by exactly `by`, up when it can, down when it would overflow.
    flat[:n] = np.where(v + by <= 255, v + by, v - by).astype(np.uint8)
    gm.write_png(alpha, run / fx["alpha_png"])
    fx["alpha"][m["golden_fingerprint"]] = gm.alpha_sha256(alpha)
    (run / "manifest.json").write_text(json.dumps(m))


@pytest.fixture
def two_hosts(fixtures_dir, tmp_path, direct_env):
    a, b = tmp_path / "gen1", tmp_path / "gen2"
    _generate(fixtures_dir, a)
    _generate(fixtures_dir, b)
    _retag(a, "1" * 16, {"exec_env": "gen1"})
    _retag(b, "2" * 16, {"exec_env": "gen2"})
    return a, b


def test_hash_merges_runs_per_fingerprint(two_hosts, tmp_path):
    a, b = two_hosts
    _bump_pixels(b, "card-2.png", 3, 2)
    out = tmp_path / "goldens"
    tol = {"max_alpha_diff": 4, "max_pixel_frac": 0.001, "max_pixels": 6}
    merged = gm.hash_runs([a, b], out, tolerance=tol)
    on_disk = json.loads((out / "manifest.json").read_text())
    assert on_disk["kind"] == "goldens"
    assert on_disk["golden_fingerprint"] == "1" * 16
    assert set(on_disk["fingerprints"]) == {"1" * 16, "2" * 16}
    assert on_disk["tolerance"] == tol
    assert len(on_disk["runs"]) == 2
    fx = merged["fixtures"]["card-2.png"]
    assert set(fx["alpha"]) == {"1" * 16, "2" * 16}
    assert fx["alpha"]["1" * 16] != fx["alpha"]["2" * 16]
    # The PNGs copied are the goldens-from run's (the first by default).
    for name, f in merged["fixtures"].items():
        assert gm.alpha_sha256(gm.read_png(out / f["alpha_png"])) == f["alpha"]["1" * 16], name


def test_hash_goldens_from_another_run(two_hosts, tmp_path):
    a, b = two_hosts
    merged = gm.hash_runs([a, b], tmp_path / "g", goldens_from=b)
    assert merged["golden_fingerprint"] == "2" * 16


def test_hash_refuses_a_png_that_does_not_match_its_manifest(two_hosts, tmp_path):
    a, b = two_hosts
    alpha = gm.read_png(b / "card-0.png").copy()
    alpha[0, 0] ^= 0xFF
    gm.write_png(alpha, b / "card-0.png")
    with pytest.raises(gm.InputMismatchError):
        gm.hash_runs([a, b], tmp_path / "g")


def test_hash_refuses_one_fingerprint_with_two_answers(two_hosts, tmp_path):
    a, b = two_hosts
    _retag(b, "1" * 16, {"exec_env": "gen1"})
    _bump_pixels(b, "card-1.png", 1, 1)
    with pytest.raises(gm.InputMismatchError, match="not deterministic"):
        gm.hash_runs([a, b], tmp_path / "g")


def test_hash_refuses_different_inputs(two_hosts, tmp_path):
    a, b = two_hosts
    m = json.loads((b / "manifest.json").read_text())
    m["fixtures"]["card-0.png"]["sha256"] = "0" * 64
    (b / "manifest.json").write_text(json.dumps(m))
    with pytest.raises(gm.InputMismatchError, match="sha256"):
        gm.hash_runs([a, b], tmp_path / "g")


# ── compare ─────────────────────────────────────────────────────────────────


def test_compare_identical_runs_is_exact(two_hosts):
    a, b = two_hosts
    report = gm.compare_dirs(a, [b])
    assert report["verdict"] == "exact"
    assert report["worst"] == {"max_alpha_diff": 0, "pixels": 0, "pixel_frac": 0.0}
    assert report["pairs"][0]["same_fingerprint"] is False
    assert gm.main(["compare", str(a), str(b)]) == 0


def test_compare_measures_and_derives_the_tolerance(two_hosts, capsys):
    a, b = two_hosts
    _bump_pixels(b, "card-0.png", 5, 3)
    report = gm.compare_dirs(a, [b])
    stats = report["pairs"][0]["fixtures"]["card-0.png"]
    assert stats["pixels"] == 5
    assert stats["max_alpha_diff"] == 3
    padded = json.loads((a / "manifest.json").read_text())["fixtures"]["card-0.png"]
    total = padded["padded_shape"][0] * padded["padded_shape"][1]
    assert stats["pixel_frac"] == pytest.approx(5 / total)
    assert report["pairs"][0]["fixtures"]["card-1.png"]["identical"] is True
    assert report["derived_tolerance"]["max_pixels"] == 10
    assert report["derived_tolerance"]["max_alpha_diff"] == 2 * stats["max_alpha_diff"]
    # No tolerance anywhere: a difference is "outside" (exit 1) unless --report-only.
    assert report["verdict"] == "outside"
    assert gm.main(["compare", str(a), str(b)]) == 1
    assert gm.main(["compare", str(a), str(b), "--report-only"]) == 0
    assert gm.main(["compare", str(a), str(b), "--tolerance", "8,0.5,100"]) == 0
    assert gm.main(["compare", str(a), str(b), "--tolerance", "8,0.5,4"]) == 1
    capsys.readouterr()


def test_compare_flags_a_tolerance_over_the_stop_line(two_hosts):
    a, b = two_hosts
    _bump_pixels(b, "card-0.png", 60, 3)
    report = gm.compare_dirs(a, [b])
    assert report["derived_over_stop_line"]["max_pixels"] is True
    assert report["ask_jason"] is True


def test_compare_uses_the_goldens_tolerance(two_hosts, tmp_path):
    a, b = two_hosts
    goldens = tmp_path / "goldens"
    gm.hash_runs([a], goldens, tolerance=gm.parse_tolerance("8,0.5,100"))
    _bump_pixels(b, "card-2.png", 2, 1)
    assert gm.compare_dirs(goldens, [b])["verdict"] == "within"


def test_compare_input_mismatch_exits_2(two_hosts, capsys):
    a, b = two_hosts
    m = json.loads((b / "manifest.json").read_text())
    m["fixtures"]["card-2.png"]["pad"] += 1
    (b / "manifest.json").write_text(json.dumps(m))
    assert gm.main(["compare", str(a), str(b)]) == 2
    assert "pad" in capsys.readouterr().err


def test_compare_missing_fixture_exits_2(two_hosts, capsys):
    a, b = two_hosts
    m = json.loads((b / "manifest.json").read_text())
    del m["fixtures"]["card-2.png"]
    (b / "manifest.json").write_text(json.dumps(m))
    assert gm.main(["compare", str(a), str(b)]) == 2
    capsys.readouterr()


def test_parse_tolerance():
    assert gm.parse_tolerance("8, 0.002, 100") == {
        "max_alpha_diff": 8,
        "max_pixel_frac": 0.002,
        "max_pixels": 100,
    }
    with pytest.raises(Exception):  # noqa: B017 - argparse's type error
        gm.parse_tolerance("8,0.002")


def test_write_and_read_png_round_trip(tmp_path):
    alpha = np.random.default_rng(3).integers(0, 256, (17, 23), dtype=np.uint8)
    gm.write_png(alpha, tmp_path / "a.png")
    assert np.array_equal(gm.read_png(tmp_path / "a.png"), alpha)
    Image.fromarray(np.zeros((2, 2, 3), np.uint8)).save(tmp_path / "rgb.png")
    with pytest.raises(gm.InputMismatchError):
        gm.read_png(tmp_path / "rgb.png")
