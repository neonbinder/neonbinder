---
name: dry-run-a-live-itest-against-fakes
description: services/preprocess live integration tests (real bucket, real Vision) can be dry-run before the resource exists by patching storage.Client, the RPC helper and the fixture loader from a scratch test that star-imports the module
metadata:
  type: reference
---

A live test under `tests/integration/` that needs a bucket or API that does not
exist yet (or must not be called yet) can still be shaken out end to end:

1. A scratch module patches first: `google.cloud.storage.Client` (an in-memory
   fake that also has `list_blobs`, `get_blob`, `delete` and upload without a
   precondition), the one RPC helper (e.g. `app.orient._text_detection`) and
   `tests.integration._loader.load_fixtures` (fixtures are bucket-only images;
   write a synthetic one with cv2).
2. A scratch `test_dry.py` imports that module, then
   `from tests.integration.<mod> import *` plus any underscore fixtures.
3. Set the module's own skip env vars, run with `--noconftest` and
   `PYTHONPATH=<scratch>:.` from `services/preprocess`.

`-rs` must show no skips, or a branch never ran. It proves poison, cleanup and
counter assertions execute; it never proves the real IAM or quota.

Shared fakes for several test files may live in one `test_*.py` and be imported
as `from tests.unit.test_x import Fake...` (tests/ and tests/unit/ are packages)
when the owner table gives you test files but no helper module.

Related: [[noconftest-when-a-sibling-breaks-conftest]].
