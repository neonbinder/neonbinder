---
name: unstyled-launch-is-a-failed-stylesheet
description: A CI red whose failure PNG shows raw HTML (giant SVG logo, Times font, 8px body margin) is ONE launch whose global CSS request failed through the localhost:3000 bypass proxy — not the flow, not the PR
metadata:
  type: reference
---

**Signature.** Failure screenshot is unstyled browser-default HTML: the logo SVG
fills the top half, serif text, every node starts at `x=8` (the body's default
margin, i.e. no Tailwind preflight), the document is thousands of px tall
(hierarchy `root` bounds start far negative) and Radix portals (dialogs,
modals) sit IN FLOW at the very bottom of the page instead of overlaid, so a
modal's footer lands below y≈629 and every assert on it fails as "not visible".

**Prove it is one launch, in one grep.** Every set-selector flow taps
`Search sports...` first; its bounds in `maestro.log` are a styling fingerprint.
Styled: `bounds=[88,369][380,407]`. Unstyled: `bounds=[8,147][193,168]`. Grep
every runner's `debug/*/maestro.log` for both — one unstyled hit among dozens of
styled ones on the same runner and same preview URL rules out the build.

**Why.** CI drives `http://localhost:3000`, a bare Node `http.createServer`
proxy (apps/web/.github/actions/maestro-runner/action.yml) to the Vercel
preview. It has no retry and answers an upstream error with 502; the global CSS
comes from one `<link rel=stylesheet>` (main.tsx imports globals.css + Radix
styles; no lazy routes), and Chrome does not retry it while the JS still runs.
The proxy's stderr (`proxy error: ...`) is NOT in the job log after its step
ends, so the HTTP status cannot be recovered from artifacts.

**How to apply.** Not caused by the PR unless the diff touches CSS,
`index.html`, `src/main.tsx`, `vite.config.ts` or `vercel.json`. Verdict: full
rerun (never `--failed`). Do not touch the flow. See [[present-in-failure-dump-means-late-arrival]]
for the other "visible in the PNG" class, which this is not.
