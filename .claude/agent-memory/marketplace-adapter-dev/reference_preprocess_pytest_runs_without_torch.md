---
name: preprocess-pytest-runs-without-torch
description: services/preprocess tests/unit and the OpenAPI snapshot run on an Apple Silicon Mac in a plain venv that leaves out torch, transformers and accelerate, on any recent Python
metadata:
  type: reference
---

`services/preprocess` `tests/unit` needs no torch: `sam.py` imports it inside
functions and the unit suite never reaches them. So the suite runs on a Mac in a
plain `python3 -m venv` (verified on Python 3.14, 832 passed) with
`requirements.txt` minus `--extra-index-url`, `torch`, `transformers` and
`accelerate`, plus `pytest`, `pytest-mock`, `httpx`, `ruff`, `PyYAML` and
`python-dotenv` from `requirements-dev.txt`. Install takes about a minute, against
the README's Python 3.12 + torch route (needed only for SAM itself).

**How to apply:** put the venv in the scratchpad, run from `services/preprocess`.
CLAUDE.md's "pytest cannot run on an arm64 Mac" is not a reason to skip it. A new
route changes `tests/unit/openapi_snapshot.json`; regenerate it with this venv per
the docstring in `test_openapi_snapshot.py`, and the pinned fastapi and pydantic
give the same output CI compares against.
