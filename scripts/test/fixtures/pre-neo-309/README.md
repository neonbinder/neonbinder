# Pre-NEO-309 fixtures — frozen, not maintained, never run outside a test

`cleanup-cloudrun-revisions.sh` and `check-revision-images.sh` in this
directory are byte-for-byte copies of `scripts/<name>.sh` as they stood at
`3f791aa^` (immediately before NEO-309's fix), taken with:

```
git show 3f791aa^:scripts/cleanup-cloudrun-revisions.sh > scripts/test/fixtures/pre-neo-309/cleanup-cloudrun-revisions.sh
git show 3f791aa^:scripts/check-revision-images.sh      > scripts/test/fixtures/pre-neo-309/check-revision-images.sh
```

They exist only so `scripts/cleanup-cloudrun-revisions.test.mjs` and
`scripts/check-revision-images.test.mjs` can prove the NEO-309 bug (both
scripts used to hand >128KiB of `gcloud` JSON to `python3` through an
environment variable, which exceeds Linux's `MAX_ARG_STRLEN` and fails with
E2BIG) is real and that the fix actually fixes it — **without** depending on
git history, which is unavailable on a shallow CI checkout and would silently
go stale the moment `HEAD` moved past the fix (that happened once already:
these tests originally did `git show HEAD:...`, and went green-for-the-wrong-
reason as soon as the fix landed and became `HEAD` itself).

Do not:
- update these files to track future changes to the real scripts — they are
  a fixed historical snapshot, not a mirror;
- run them for any purpose other than the two test files above;
- lint or fix them — they are deliberately the buggy version.

If the bug they demonstrate is ever refactored away entirely (e.g. the
scripts stop shelling out to `python3` altogether), delete this directory and
the tests that reference it rather than updating it.
