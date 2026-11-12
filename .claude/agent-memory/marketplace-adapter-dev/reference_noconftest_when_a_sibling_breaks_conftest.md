---
name: noconftest-when-a-sibling-breaks-conftest
description: In a parallel build, another owner's deletion can break a shared autouse conftest fixture for every test; `pytest --noconftest` runs your own files meanwhile, but the real gate must be rerun once the conftest owner lands
metadata:
  type: reference
---

`services/preprocess/tests/unit/conftest.py` has an autouse fixture that
monkeypatches module attributes by name (`tiered._session`,
`rembg.new_session`). When a sibling builder deletes that attribute before the
conftest owner updates the fixture, **every** unit test errors at setup with
`AttributeError: ... has no attribute`, including tests that never touch it.

**How to apply:** don't edit the conftest if it isn't yours. Run your own files
with `pytest --noconftest -o addopts="" <files>` so they get a real signal,
make your tests stub what they need themselves (they can't count on the
autouse guard), and say in the report that the full `pytest tests/unit` gate
waits on the conftest owner. Rerun the full suite with the conftest once it
lands. Related: [[check-baseline-reds-in-main-not-by-stash]].
