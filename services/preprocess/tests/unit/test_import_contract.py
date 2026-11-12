"""Import contract for `app.main` (NEO-484 C).

Importing the service must not import onnxruntime, nor rembg and the
pymatting/numba stack rembg dragged in (whose numba compile alone was ~100 s of
every heavy cold start). The FAST role never loads a model and must start in
seconds; the HEAVY role creates its ORT session in the startup hook, where the
`cold_start` line measures it as `session_load_s` rather than hiding it inside
`main_module_import_s`.

C6 adds the cloud SDKs. `anthropic`, `google.cloud.vision` and
`google.cloud.storage` (with the gRPC stack and `google.api_core` under them)
were most of a cold `import app.main` on gen2, where image layers are read
lazily: about 2,800 of its 3,400 modules, `anthropic` alone ~2,300. Each
consumer now imports its SDK on first use, and the startup hook imports them on
the `app.prewarm` thread. The import must not start that thread either: a
thread spawned during an import that then needs an import lock is the classic
import deadlock.

The check runs `import app.main` in a fresh interpreter, because this test
process has long since imported whatever other tests touched.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SERVICE_ROOT = Path(__file__).resolve().parents[2]

# Never imported by `import app.main`, on either role.
MODEL_RUNTIME = ("onnxruntime", "rembg", "pymatting", "numba")
# Imported on first use or by the prewarm thread (C6), never by the import.
CLOUD_SDKS = (
    "anthropic",
    "google.cloud.vision",
    "google.cloud.storage",
    "google.api_core",
    "grpc",
)
FORBIDDEN_AT_IMPORT = MODEL_RUNTIME + CLOUD_SDKS

_PROBE = """
import json, sys, threading
import app.main
found = sorted(m for m in {forbidden!r} if m in sys.modules)
found += sorted("thread:" + t.name for t in threading.enumerate() if t.name == "sdk-prewarm")
print(json.dumps(found))
"""


def _imported_after_main(role: str | None) -> list[str]:
    env = {k: v for k, v in os.environ.items() if k != "PREPROCESS_ROLE"}
    if role is not None:
        env["PREPROCESS_ROLE"] = role
    env["PYTHONPATH"] = str(SERVICE_ROOT)
    done = subprocess.run(
        [sys.executable, "-c", _PROBE.format(forbidden=FORBIDDEN_AT_IMPORT)],
        cwd=SERVICE_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout.strip().splitlines()[-1])


@pytest.mark.parametrize("role", [None, "heavy", "fast"])
def test_importing_app_main_imports_no_model_runtime(role):
    assert _imported_after_main(role) == []


@pytest.mark.parametrize(
    ("module", "statement"),
    [
        ("onnxruntime", "import onnxruntime"),
        ("anthropic", "from app.classify import anthropic_sdk; anthropic_sdk()"),
        ("google.cloud.vision", "from app.orient import vision_sdk; vision_sdk()"),
        ("google.cloud.storage", "import google.cloud.storage"),
    ],
)
def test_the_probe_can_see_an_import(module, statement):
    # Guard against a probe that could never fail: the same subprocess shape
    # does report each module once something imports it.
    env = {**os.environ, "PYTHONPATH": str(SERVICE_ROOT)}
    probe = f"import json, sys; {statement}; print(json.dumps({module!r} in sys.modules))"
    done = subprocess.run(
        [sys.executable, "-c", probe],
        cwd=SERVICE_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    if done.returncode != 0 and module == "onnxruntime":
        pytest.skip("onnxruntime is not installed in this environment")
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout.strip().splitlines()[-1]) is True
