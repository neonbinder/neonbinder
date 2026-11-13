---
name: pdfjs-6-driver-quirks
description: pdf.js 6 dropped isEvalSupported (no eval path at all), has no PDFDocumentProxy.destroy, and its modern build fails in Node — use the legacy build for node tests/probes
metadata:
  type: reference
---

pdfjs-dist 6.x (pinned for NEO-496's PDF checklist reader, `lib/checklists/read-pdf-lines.ts`):

- `isEvalSupported` is gone from `DocumentInitParameters` (root tsc errors on it). The eval font path it guarded (CVE-2024-4367 class) was removed with it; `read-pdf-lines.test.ts` greps the shipped builds for `new Function(` / `eval(` so a bump that brings one back goes red. Don't re-add the option to satisfy an old plan line.
- Clean up with the loading task (`task.destroy()`); `PDFDocumentProxy.destroy` is not a function in v6.
- `TextItem` is not exported from `pdfjs-dist`'s root types; import it from `pdfjs-dist/types/src/display/api`.
- In Node (vitest, tsx probes) the modern `build/pdf.mjs` fails ("Please use the legacy build"); load `pdfjs-dist/legacy/build/pdf.mjs` and set `GlobalWorkerOptions.workerSrc` to the legacy worker's file URL. Same `getDocument`/`getTextContent` API as the browser build, so a node test does prove the x-gap column split.
- In the browser the worker comes from `import("pdfjs-dist/build/pdf.worker.min.mjs?url")` and is served from our own origin.

**How to apply:** inject the pdfjs module into the reader (it takes `{ pdfjs }`) rather than mocking imports. See [[browser-probe-a-lib-through-vite]].
