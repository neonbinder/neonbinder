"""OpenAPI schema snapshot test.

Fails if the service's public API surface changes without the committed
snapshot being updated in the same PR. Forces schema changes to be reviewed
intentionally rather than sneaking through.

When the change is intentional:
    python -c "import json; from app.main import app; \\
        json.dump(app.openapi(), open('tests/unit/openapi_snapshot.json','w'), \\
                  indent=2, sort_keys=True)"
Then review the diff and commit.
"""

from __future__ import annotations

import json
from pathlib import Path

from app.main import app

SNAPSHOT_PATH = Path(__file__).parent / "openapi_snapshot.json"


def test_openapi_schema_matches_snapshot():
    assert (
        SNAPSHOT_PATH.exists()
    ), f"Missing snapshot at {SNAPSHOT_PATH}. Generate it per the docstring in this file."

    current = json.loads(json.dumps(app.openapi(), sort_keys=True))
    committed = json.loads(SNAPSHOT_PATH.read_text())

    assert current == committed, (
        "OpenAPI schema has drifted from the committed snapshot. "
        "If the change is intentional, regenerate the snapshot per the "
        "docstring in this file."
    )
