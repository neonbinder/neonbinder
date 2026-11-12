"""`scripts/bake_birefnet.py`: pins, EXTENDED-only save, self-check, outputs.

onnxruntime is replaced by a fake that "optimises" by copying the file and
"infers" a value derived from the file's bytes, so each failure path can be
forced without a model.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np
import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "bake_birefnet.py"


def _load_script():
    spec = importlib.util.spec_from_file_location("bake_birefnet", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


bake = _load_script()

ORIGINAL = b"original-model-bytes"


class _Level:
    ORT_DISABLE_ALL = "DISABLE_ALL"
    ORT_ENABLE_BASIC = "BASIC"
    ORT_ENABLE_EXTENDED = "EXTENDED"
    ORT_ENABLE_ALL = "ALL"


class _Opts:
    def __init__(self):
        self.enable_cpu_mem_arena = True
        self.graph_optimization_level = None
        self.optimized_model_filepath = ""


class _Input:
    name = "input_image"


class FakeOrt:
    """Records every session; with `diverge`, the optimised file outputs differently."""

    __version__ = "9.9.9"
    GraphOptimizationLevel = _Level
    SessionOptions = _Opts

    def __init__(self, optimised_bytes: bytes = b"optimised", diverge: bool = False):
        self.sessions: list[tuple[str, _Opts]] = []
        self.optimised_bytes = optimised_bytes
        self.diverge = diverge
        ort = self

        class _Session:
            def __init__(self, path, sess_options=None, providers=None):
                assert providers == ["CPUExecutionProvider"]
                ort.sessions.append((path, sess_options))
                self.path = path
                if sess_options.optimized_model_filepath:
                    Path(sess_options.optimized_model_filepath).write_bytes(ort.optimised_bytes)

            def get_inputs(self):
                return [_Input()]

            def run(self, names, feed):
                x = feed["input_image"]
                assert x.shape == (1, 3, 1024, 1024) and x.dtype == np.float32
                out = np.full((1, 1, 4, 4), 0.25, np.float32)
                if ort.diverge and Path(self.path).read_bytes() == ort.optimised_bytes:
                    out[0, 0, 0, 0] = np.nextafter(np.float32(0.25), np.float32(1))
                return [out]

        self.InferenceSession = _Session


def _pin(monkeypatch, data: bytes = ORIGINAL, md5: str | None = None, sha: str | None = None):
    monkeypatch.setitem(
        bake.SOURCES,
        "birefnet-general",
        {
            "url": "https://example.invalid/model.onnx",
            "md5": md5 or hashlib.md5(data).hexdigest(),  # noqa: S324
            "sha256": sha or hashlib.sha256(data).hexdigest(),
        },
    )


def _fetch_writes(data: bytes):
    calls = []

    def fetch(url, dest):
        calls.append(url)
        Path(dest).write_bytes(data)

    fetch.calls = calls
    return fetch


def test_real_pins_are_rembgs_md5_and_the_s0a_sha256():
    general = bake.SOURCES["birefnet-general"]
    assert general["md5"] == "7a35a0141cbbc80de11d9c9a28f52697"
    assert general["sha256"] == "58f621f00f5d756097615970a88a791584600dcf7c45b18a0a6267535a1ebd3c"
    assert general["url"].endswith("/BiRefNet-general-epoch_244.onnx")
    assert set(bake.SOURCES) == {"birefnet-general", "birefnet-general-lite"}


def test_bake_writes_the_model_hash_and_provenance(tmp_path, monkeypatch):
    _pin(monkeypatch)
    ort = FakeOrt()
    fetch = _fetch_writes(ORIGINAL)
    prov = bake.bake("birefnet-general", tmp_path, ort, fetch=fetch)

    assert fetch.calls == ["https://example.invalid/model.onnx"]
    model = tmp_path / "birefnet-general.onnx"
    assert model.read_bytes() == b"optimised"
    digest = hashlib.sha256(b"optimised").hexdigest()
    assert (tmp_path / "birefnet-general.onnx.sha256").read_text() == (
        f"{digest}  birefnet-general.onnx\n"
    )
    on_disk = json.loads((tmp_path / "birefnet-general.onnx.provenance.json").read_text())
    assert on_disk == prov
    assert prov["format"] == 1
    assert prov["model"] == "birefnet-general"
    assert prov["onnxruntime"] == "9.9.9"
    assert prov["saved_at"] == "ORT_ENABLE_EXTENDED" and prov["load_at"] == "ORT_ENABLE_ALL"
    assert prov["source_sha256"] == hashlib.sha256(ORIGINAL).hexdigest()
    assert prov["source_md5"] == hashlib.md5(ORIGINAL).hexdigest()  # noqa: S324
    assert prov["sha256"] == digest
    # The original is deleted; nothing else is left beside the model.
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "birefnet-general.onnx",
        "birefnet-general.onnx.provenance.json",
        "birefnet-general.onnx.sha256",
    ]


def test_runtime_reads_the_bakes_outputs(tmp_path, monkeypatch):
    """The files the bake writes are the ones `app.cropper.birefnet` reads."""
    from app.cropper import birefnet

    _pin(monkeypatch)
    bake.bake("birefnet-general", tmp_path, FakeOrt(), fetch=_fetch_writes(ORIGINAL))
    monkeypatch.setenv("BIREFNET_HOME", str(tmp_path))
    monkeypatch.delenv("BIREFNET_MODEL", raising=False)
    assert birefnet.weights_sha256() == hashlib.sha256(b"optimised").hexdigest()
    assert bake.PROVENANCE_SUFFIX == birefnet.PROVENANCE_SUFFIX
    assert bake.SHA256_SUFFIX == birefnet.SHA256_SUFFIX
    assert bake.PROVENANCE_FORMAT == birefnet.PROVENANCE_FORMAT
    assert bake.LOAD_LEVEL == birefnet.GRAPH_OPTIMIZATION_LEVEL
    prov = birefnet._check_provenance(birefnet.model_path(), "9.9.9")
    assert prov["model"] == "birefnet-general"
    with pytest.raises(RuntimeError):
        birefnet._check_provenance(birefnet.model_path(), "1.0.0")


def test_saves_only_at_extended_and_checks_at_all(tmp_path, monkeypatch):
    _pin(monkeypatch)
    ort = FakeOrt()
    bake.bake("birefnet-general", tmp_path, ort, fetch=_fetch_writes(ORIGINAL))
    saves = [o for _p, o in ort.sessions if o.optimized_model_filepath]
    loads = [o for _p, o in ort.sessions if not o.optimized_model_filepath]
    assert [o.graph_optimization_level for o in saves] == ["EXTENDED"]
    assert [o.graph_optimization_level for o in loads] == ["ALL", "ALL"]
    assert all(o.enable_cpu_mem_arena is False for _p, o in ort.sessions)
    # The self-check ran the original and then the optimised file.
    paths = [Path(p).name for p, o in ort.sessions if not o.optimized_model_filepath]
    assert paths == ["birefnet-general.original.onnx", "birefnet-general.onnx"]


def test_saving_at_all_is_refused():
    with pytest.raises(bake.BakeError, match="ORT_ENABLE_ALL"):
        bake.session_options(FakeOrt(), "ORT_ENABLE_ALL", Path("/tmp/x.onnx"))
    # Loading at ALL (no save path) is the runtime setting and is fine.
    assert bake.session_options(FakeOrt(), "ORT_ENABLE_ALL").graph_optimization_level == "ALL"


@pytest.mark.parametrize("which", ["md5", "sha"])
def test_a_hash_mismatch_fails_and_writes_nothing(tmp_path, monkeypatch, which):
    _pin(monkeypatch, **{which: "0" * (32 if which == "md5" else 64)})
    ort = FakeOrt()
    with pytest.raises(bake.BakeError, match="md5" if which == "md5" else "sha256"):
        bake.bake("birefnet-general", tmp_path, ort, fetch=_fetch_writes(ORIGINAL))
    assert ort.sessions == []
    assert list(tmp_path.iterdir()) == []


def test_a_self_check_mismatch_fails_the_build(tmp_path, monkeypatch):
    _pin(monkeypatch)
    with pytest.raises(bake.BakeError, match="self-check"):
        bake.bake(
            "birefnet-general", tmp_path, FakeOrt(diverge=True), fetch=_fetch_writes(ORIGINAL)
        )
    assert list(tmp_path.iterdir()) == []


def test_an_empty_optimised_file_fails(tmp_path, monkeypatch):
    _pin(monkeypatch)
    with pytest.raises(bake.BakeError, match="did not write"):
        bake.bake(
            "birefnet-general",
            tmp_path,
            FakeOrt(optimised_bytes=b""),
            fetch=_fetch_writes(ORIGINAL),
        )


def test_a_local_source_skips_the_download(tmp_path, monkeypatch):
    _pin(monkeypatch)
    src = tmp_path / "src.onnx"
    src.write_bytes(ORIGINAL)
    home = tmp_path / "home"

    def no_fetch(*_a):
        raise AssertionError("must not download")

    bake.bake("birefnet-general", home, FakeOrt(), source=src, fetch=no_fetch)
    assert src.read_bytes() == ORIGINAL  # the caller's copy is left alone
    assert (home / "birefnet-general.onnx").is_file()


def test_unknown_model_is_refused(tmp_path):
    with pytest.raises(bake.BakeError, match="unknown model"):
        bake.bake("withoutbg", tmp_path, FakeOrt())


def test_main_reports_failure_with_exit_1(tmp_path, monkeypatch, capsys):
    pytest.importorskip("onnxruntime")
    src = tmp_path / "src.onnx"
    src.write_bytes(b"not the pinned model")
    rc = bake.main(
        ["--model", "birefnet-general", "--home", str(tmp_path / "h"), "--source", str(src)]
    )
    assert rc == 1
    assert "md5" in capsys.readouterr().err


def test_synthetic_input_is_fixed():
    a, b = bake.synthetic_input(), bake.synthetic_input()
    assert a.shape == (1, 3, 1024, 1024) and a.dtype == np.float32
    assert np.array_equal(a, b)
