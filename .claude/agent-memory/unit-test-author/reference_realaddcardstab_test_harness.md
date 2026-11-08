---
name: realaddcardstab-test-harness
description: Gotchas writing RealAddCardsTab tests (mocked Dropzone, status roles, runExtract fetch stub shape)
metadata:
  type: reference
---

- `RealAddCardsTab.test.tsx` mocks `Dropzone` and records props in `mocks.dropzone`; drive a drop with `mocks.dropzone.at(-1).onFiles(files)`. The mock has no file input, so focus assertions need an `<input type="file">` added to the mock.
- An `<output>` element has role `status`, so a "Page address" readout and the workspace's own "N saved." tally both show up in `getAllByRole("status")`; filter them before asserting a run line is empty.
- `mocks.upload` resolves `{ ok, jobId, kind: "zip" | "images", uploaded, failed, total }`; omit `kind` and the tab treats it as photos.
- `runExtract` tests (placeholderPipeline.test.ts) stub `fetch` with `{ entries: [{index,name,accepted,content_type,size_bytes,reason}], accepted_count, rejected_count }`; spy `console.warn` to assert logs carry reasons and no file names.
- JS `toLowerCase` vs Python `casefold` differ (e.g. "ß"), so `compareNaturalNames` is not byte-identical to `_natural_sort_key` for non-ASCII names.
