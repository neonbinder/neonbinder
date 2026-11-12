"""Step A: the PR's preprocess image as shipped (PARITY_STAGE=base).

rembg's stack is gone, the baked model is the pinned one and read-only, the
service runs as a non-root user, the direct session loads, and SAM still has
everything it needs now that rembg's transitive packages left the image.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import pwd
import stat
from pathlib import Path

import pytest

from tests.parity import _parity


@pytest.fixture(scope="module")
def bake():
    return _parity.load_script("bake_birefnet")


@pytest.fixture(scope="module")
def baked():
    from app.cropper import birefnet

    path = Path(birefnet.model_path())
    assert path.is_file(), f"no baked model at {path}"
    return birefnet, path


@pytest.mark.parametrize("module", _parity.ABSENT_FROM_IMAGE)
def test_rembg_stack_is_absent(module):
    assert importlib.util.find_spec(module) is None, f"{module} is still installed"


def test_rembg_era_settings_are_gone():
    assert "U2NET_HOME" not in os.environ
    assert "REMBG_MODEL" not in os.environ
    assert not Path("/opt/u2net-cache").exists()
    assert os.environ.get("BIREFNET_HOME") == "/opt/birefnet"
    assert os.environ.get("REQUIRE_BAKED_WEIGHTS") == "1"


def test_runs_as_the_unprivileged_app_user():
    assert os.geteuid() != 0
    assert pwd.getpwuid(os.geteuid()).pw_name == "appuser"


def test_baked_model_is_the_pinned_source_optimised_by_this_onnxruntime(bake, baked):
    from importlib import metadata

    birefnet, path = baked
    model = birefnet.model_name()
    pin = bake.SOURCES[model]
    prov = json.loads(Path(str(path) + birefnet.PROVENANCE_SUFFIX).read_text())

    assert prov["format"] == birefnet.PROVENANCE_FORMAT
    assert prov["model"] == model
    assert prov["onnxruntime"] == metadata.version("onnxruntime")
    assert prov["saved_at"] == "ORT_ENABLE_EXTENDED"
    assert prov["load_at"] == birefnet.GRAPH_OPTIMIZATION_LEVEL == "ORT_ENABLE_ALL"
    assert prov["source_url"] == pin["url"]
    assert prov["source_md5"] == pin["md5"]
    assert prov["source_sha256"] == pin["sha256"]
    assert prov["self_check"]["level"] == "ORT_ENABLE_ALL"

    sha = hashlib.sha256()
    size = 0
    with open(path, "rb") as fh:
        while chunk := fh.read(8 << 20):
            sha.update(chunk)
            size += len(chunk)
    assert prov["sha256"] == sha.hexdigest()
    assert prov["bytes"] == size
    assert Path(str(path) + birefnet.SHA256_SUFFIX).read_text() == (
        f"{sha.hexdigest()}  {path.name}\n"
    )
    assert birefnet.weights_sha256() == sha.hexdigest()


def test_baked_model_directory_holds_only_the_bake_outputs(baked):
    birefnet, path = baked
    assert sorted(p.name for p in path.parent.iterdir()) == sorted(
        [path.name, path.name + birefnet.SHA256_SUFFIX, path.name + birefnet.PROVENANCE_SUFFIX]
    )


@pytest.mark.parametrize("root", ["/opt/birefnet", "/opt/hf-cache"])
def test_model_caches_are_root_owned_and_read_only(root):
    checked = 0
    for dirpath, _dirnames, filenames in os.walk(root):
        for p in [dirpath, *(os.path.join(dirpath, n) for n in filenames)]:
            st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode):
                continue  # the HF cache links snapshots to blobs; the targets are checked
            assert st.st_uid == 0, f"{p} is owned by uid {st.st_uid}"
            assert st.st_mode & 0o222 == 0, f"{p} has write bits ({oct(st.st_mode)})"
            assert not os.access(p, os.W_OK), f"{p} is writable"
            checked += 1
    assert checked > 1, f"nothing under {root}"


def test_direct_session_loads_on_the_cpu_provider(baked):
    birefnet, _path = baked
    loaded = birefnet.load_session()
    assert loaded["model"] == birefnet.model_name()
    assert birefnet.get_session().get_providers() == ["CPUExecutionProvider"]


def test_sam_runs_end_to_end(config):
    """SAM loads from the read-only cache and produces masks on a real fixture."""
    from app.cropper import sam

    names = sorted(p.name for p in config.fixtures_dir.iterdir() if p.is_file())
    assert names, f"no fixtures in {config.fixtures_dir}"
    data = (config.fixtures_dir / names[0]).read_bytes()

    model, processor = sam._load_model()
    image, _scale = sam._open_and_resize(data)
    masks = sam._generate_masks(image, model, processor)
    assert masks, "SAM produced no candidate masks"
    result = sam.sam_crop(data)
    assert result is None or result[:2] == b"\xff\xd8"
