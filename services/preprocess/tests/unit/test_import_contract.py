"""Import contract for `app.main` (NEO-484 C).

Importing the service must not import onnxruntime, nor rembg and the
pymatting/numba stack rembg dragged in (whose numba compile alone was ~100 s of
every heavy cold start). The FAST role never loads a model and must start in
seconds; the HEAVY role creates its ORT session in the startup hook, where the
`cold_start` line measures it as `session_load_s` rather than hiding it inside
`main_module_import_s`.

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
FORBIDDEN_AT_IMPORT = ("onnxruntime", "rembg", "pymatting", "numba")

_PROBE = """
import json, sys
import app.main
print(json.dumps(sorted(m for m in {forbidden!r} if m in sys.modules)))
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


def test_the_probe_can_see_an_import():
    # Guard against a probe that could never fail: the same subprocess shape
    # does report onnxruntime once something imports it.
    env = {**os.environ, "PYTHONPATH": str(SERVICE_ROOT)}
    probe = "import json, sys, onnxruntime; print(json.dumps('onnxruntime' in sys.modules))"
    done = subprocess.run(
        [sys.executable, "-c", probe],
        cwd=SERVICE_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    if done.returncode != 0:
        pytest.skip("onnxruntime is not installed in this environment")
    assert json.loads(done.stdout.strip().splitlines()[-1]) is True
