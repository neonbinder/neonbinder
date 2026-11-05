---
name: patterns-neo446-rejected-names-and-copies
description: Showing zip entry names on a job row - what `_name_rejection` does not block, why sorting unvalidated names is safe, and counting full-size raster copies when a pixel ceiling moves
metadata:
  type: project
---

NEO-446 stores a few rejected zip entry names on the job row and returns them
from an owner-scoped public query. Reusable checks:

- **A name that passed `_name_rejection` is not display-safe.** It blocks ASCII
  controls, DEL, U+0085, U+2028/9, bidi embeddings/overrides and isolates. It
  passes U+200B-U+200F (including LRM/RLM), U+061C, other C1 controls, U+FEFF, tag
  characters and plain RTL letters, which reorder the sentence around them. Any
  name placed inside product copy needs its own `\p{C}` refusal plus an isolate
  (`<bdi>` or FSI/PDI). React escaping answers XSS only. Same gap class as
  [[patterns-neo335-wizard-team-answers]].
- **Filter on the reason, and list the showable ones.** The allowlist shape in
  `extractRejections.ts` (unknown reason means count only) held, because
  `_metadata_rejection` checks the name before any other reason.
- **Sorting unvalidated names is bounded by the central-directory ceiling.** Only
  run a sort key on raw names if it cannot raise (`int()` past 4300 digits) and
  cannot compare unlike types. Worst case measured about 40 MB and under 0.5 s.
- **A non-sentinel archive error can escape.** Bad UTF-8 in a flagged name raises
  `UnicodeDecodeError` from `ZipFile()`, past the `BadZipFile, OSError` catch, so a
  hostile archive reads as a retryable 502. Check on any `_open_archive` change.
- **When a pixel ceiling moves, count live rasters, not one raster.** `_load`
  peaks near three full-size copies. So does `_prepare_for_anthropic`, because the
  name `img` outlives its `with` block and closing only releases the file. Multiply
  by container concurrency. A flat image costs an attacker a few hundred KB.
- **Write-once keys assume a stable ordinal.** Changing entry order breaks "same
  key means same image" across a deploy for a restarted job.

Related: [[patterns-neo149-zip-ingest]], [[patterns-neo170-workpool-pipeline]],
[[patterns-preprocess-service]].
