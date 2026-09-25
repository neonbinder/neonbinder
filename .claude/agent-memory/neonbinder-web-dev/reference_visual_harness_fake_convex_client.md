---
name: visual-harness-fake-convex-client
description: To screenshot a Convex-backed dialog when dev has no row that shows it, mount the real component inside the running Vite app (same-origin 1024x629 iframe) under a ConvexProvider whose client is a 3-method fake — and the Chrome MCP tab is `hidden`, so no rAF/ResizeObserver fires until a screenshot forces a frame
metadata:
  type: reference
---

Worked on NEO-306 (Make insert / Make parallel dialogs), no app files touched:

1. `resize_window` may not change the viewport (a large external display kept
   innerWidth 3440). Instead replace the page with
   `<iframe src="/admin/set-builder" style="width:1024px;height:629px">` — same
   origin, so Clerk auth carries over and the real sticky header is there.
   Capture with `computer zoom` region `[0,0,1024,629]`, `save_to_disk`.
2. Run imports in the IFRAME realm (`iframe.contentWindow.eval("(async()=>{…})()")`)
   so the component shares the app's React and `convex/react` instances. Take
   the exact `/node_modules/.vite/deps/*.js?v=…` URLs from the transformed
   source (`fetch('/src/main.tsx')`, match `from "…"`); never print them (the
   MCP blocks output containing query strings). `react-dom_client.js`'s
   `createRoot` is on `.default`. Add `?t=<now>` to component imports after an edit.
3. The fake client: `watchQuery(q, args) → { localQueryResult: () => fixture,
   onUpdate: () => () => {}, journal: () => undefined }`, keyed by
   `q[Symbol.for("functionName")]` ("module:fn"); `mutation`/`action` reject,
   so a stray confirm cannot write. `createRoot().render` is async: click the
   trigger in a LATER call.
4. Wrap the host in `position:relative; z-index:10` to reproduce the panel's
   stacking context (below `binder-header`'s z-20).
5. **The tab reports `document.visibilityState === "hidden"`**: no
   requestAnimationFrame and no ResizeObserver callbacks until a screenshot
   forces a frame. A layout value driven by RO looks stale; take one throwaway
   zoom, re-read, then capture. Not a code bug.

Also: opening an EMPTY selector column auto-starts its marketplace sync
(`ensure-sync`), a write to dev. Drill only into columns that already have rows
when the brief says view-only, and report it if one fires.

Related: [[e2e-viewport-is-the-ux-constraint]], [[reference_fresh_worktree_missing_env_local]]
