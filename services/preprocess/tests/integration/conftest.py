"""Integration test config.

- Loads `.env.local` from repo root so ANTHROPIC_API_KEY is available.
- Skips all tests in this directory unless RUN_INTEGRATION_TESTS=1.
- Vision API uses ADC. Run `gcloud auth application-default login` beforehand
  (impersonating the preprocess runtime SA once it exists; until then your
  Owner creds on neonbinder-dev are sufficient).
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(REPO_ROOT / ".env.local", override=False)


@pytest.fixture(autouse=True)
def _gate_integration():
    if os.environ.get("RUN_INTEGRATION_TESTS") != "1":
        pytest.skip(
            "integration tests are gated. set RUN_INTEGRATION_TESTS=1 to run "
            "(requires Vision ADC + ANTHROPIC_API_KEY in .env.local)"
        )
