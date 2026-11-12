---
name: preprocess-cold-import-cost-is-module-count
description: On Cloud Run gen2 a cold `import app.main` in services/preprocess is bounded by how many module files it opens, not CPU; measure with -X importtime module counts, defer SDKs to first use, and test background-import threads with a held gate
metadata:
  type: reference
---

gen2 reads image layers lazily, so a cold import costs roughly one disk wait per
module file. Measured for NEO-484 C6: `import app.main` was ~4 s CPU inside
15-127 s wall, and the local `python -X importtime -c "import app.main"` showed
3,399 modules, of which `anthropic` alone was ~2,300 (Vision + Storage + grpc +
api_core most of the rest). Deferring the three SDKs left 572 modules. Local
milliseconds understate the cloud cost badly; compare **module counts** (count
the `import time:` lines per top-level package), not local ms.

**How to apply:**
- Keep cloud SDKs out of module scope in `app/**`: import inside an accessor
  (`classify.anthropic_sdk()`, `orient.vision_sdk()`, the storage client in
  `jobs/gcs.py`), annotations under `TYPE_CHECKING`. `google.api_core.exceptions`
  pulls grpc too, so import it inside the `except`-using function.
  `tests/unit/test_import_contract.py` pins the list.
- Tests that monkeypatched `module.vision` / `module.anthropic` must patch the
  real package (`orient.vision_sdk()`), since the module attribute is gone.
- A background import thread started from a startup hook (`app.prewarm`) is
  safe: per-module import locks make a second importer wait and then see the
  finished module. In unit tests, hold that thread on a gate
  (`tests/unit/_prewarm_gate.hold_prewarm`) or it writes a stray line on the
  `timing` logger mid-test; assert "returns without waiting" by calling on a
  daemon thread with a deadline (`returns_within`), never inline, or a
  regression hangs the suite instead of failing it.
- Stress real concurrent SDK imports in a **fresh subprocess** (in-process the
  SDKs are already in `sys.modules` and nothing races), with a subprocess
  timeout so a deadlock is a red, not a hang.
