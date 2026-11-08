---
name: patterns-deps-batch-gotchas
description: Deps-batch gotchas from NEO-468 — truncated Dependabot changelogs, running the preprocess gate on macOS, convex-test Date pinning vs fake timers, grouped-PR partial park
metadata:
  type: reference
---

- **A grouped Dependabot PR body is cut off at about 65k characters**, so the changelogs of the last packages are missing. A `-1` from searching for "Updates `<pkg>`" is the sign. Read them with `gh api repos/<owner>/<repo>/releases`, or the repo's CHANGELOG.md through `gh api .../contents/CHANGELOG.md`.
- **The preprocess pytest gate does run on an arm64 Mac.** Use `uv venv --python 3.12` (uv has a managed 3.12 build) outside the repo. Install from a scratch copy of requirements.txt with `torch==2.5.1+cpu` changed to `torch==2.5.1`, and pass `--index-strategy unsafe-best-match`, because of the extra torch index. The full unit suite takes about 8 minutes, so run it in the background. Disclose the torch substitution in the PR.
- **convex-test 0.0.63 and later pin `Date.now()` for each transaction.** apps/web tests that move time with `vi.advanceTimersByTime` (photo sweeps, listing-drain leases, settledAt stamps) fail against it. It is a harness semantics change, not a flake. Park the bump until those tests are adapted.
- **Parking one package from a grouped PR** means leaving out `Closes #N` for the whole group. Dependabot rebases the group PR down to the parked package after the batch merges.
- `actionlint` run on a `git archive` baseline needs `git init` in the extracted folder, or it finds "no project".
- Many Action pins are already current on main when Dependabot catches the last few lines. Apply exactly its diff, then check that `diff` against `gh pr diff` comes out empty.

Related: [[patterns-convex-cli-gotchas]]
