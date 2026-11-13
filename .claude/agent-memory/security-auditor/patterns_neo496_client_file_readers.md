---
name: patterns-neo496-client-file-readers
description: Hand-written in-browser .xlsx/.pdf readers (NEO-496) — a byte-counted inflate cap does not bound derived strings; lazy "open…close" element regexes go quadratic on unclosed tags; how to bench them from a scratch copy
metadata:
  type: feedback
---

Shape that held (NEO-496 publisher checklist upload): parse in the browser,
send whole sections in batches to `requireAdmin` mutations, re-check every row
and measure bytes with `getConvexSize` server-side after the gate, uploader-only
batch/finish, projections only, signed-out subscribed reads return null.

Checks to repeat on any client-side archive/document reader:

- **An inflate cap counts XML bytes, not what the reader builds from them.**
  A shared-string table lets one 400k-char string be referenced by every cell;
  each cell's `.replace(/\s+/g, " ")` makes a fresh copy. Measured: a ~2 KB
  .xlsx reached 4 GB heap at 200 rows x 50 cells and OOM'd at 1000. Fix: cap
  each cell / shared string length (slice before cleaning) and total retained
  characters, not just inflated bytes.
- **`<tag…>([\s\S]*?)</tag>` with /g is quadratic on many unclosed opens**
  inside one element (each failed attempt scans to the end). Measured 80k
  unclosed `<c>` in one row = 4.9 s, doubling n = 4x. Fix: tempered token
  (`(?:[^<]|<(?!\/?c[\s/>]))*`) or an indexOf cursor. Same shape: `<t>` runs,
  `<is>`, `<rPh>`.
- Lookups of untrusted keys in object literals (`ENTITIES[ref]`,
  `groups?.[sectionName]`) hit `constructor`/`toString`; use Map or Object.hasOwn.
- pdf.js: check `isEvalSupported` gone / no `new Function(` in the shipped
  builds, `disableFontFace`, `enableXfa:false`, worker via Vite `?url`, and that
  cMapUrl/standardFontDataUrl/wasmUrl default null (no third-party fetch). pdf.js
  has no FlateDecode bomb cap and readers rarely add a timeout: recommend one.
- pdfjs-dist pulls `@napi-rs/canvas` native optional binaries (no install
  script); they load only when pdf.js runs in Node (unit-test probes). Check
  publish age of the resolved version.
- Bench from a scratch copy (`git show HEAD:path > scratch/x.mts`, symlink
  node_modules, run with the repo's tsx); a `.ts` copy outside the package is
  treated as CJS and top-level await fails.

Per-user scrub (`forgetUploader`, same ticket): an anonymising sentinel is safe
when it sits outside the only auth provider's subject namespace (Clerk `user_…`;
`auth.config.ts` has one provider, machine tokens also resolve to a `user_`
subject) and every owner check compares the stored id to the CALLER's id, so a
sentinel row becomes nobody's and falls to its expiry job. Re-check both if a
second auth provider is added. A privacy line "we delete the data tied to it"
backed only by an operator-run internal mutation is true only while the
deletion runbook names it (no NB deletion sweep exists).

Related: [[patterns-neo478-operator-checklist-ingest]], [[patterns-neo149-zip-ingest]].
