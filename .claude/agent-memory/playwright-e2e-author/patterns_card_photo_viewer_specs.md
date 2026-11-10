---
name: card-photo-viewer-specs
description: NEO-481 card photo viewer spec handles - tile/viewer names, orientation proven by the served file's header (servedPhotoSize), held photos view-only, what cannot pass on a worktree deployment, and an img inside a named button is still locatable
metadata:
  type: reference
---

Every card photo opens one dialog, `Front of <label>` / `Back of <label>` (`support/photo-viewer.ts` `photoViewer`). Photo-box tiles are buttons `Open front of <line>` / `Open back of <line>` (the old `..., full size (opens a new tab)` links are gone); a line's thumbnail is `Open photos of <line>`. Add cards: `Open photo <file>` (loose/reading), `Open front of <tile>`, `Open saved photo of <card>`, `Crop by hand: <file>` on a failed photo. Box runs only: textbox `Price, <tile label>`; `p` focuses it on the FOCUSED card.

- **An `img` inside a button with an aria-label is still found**: `tile.getByRole("img", { name })` works (Playwright 1.63 does not prune presentational children). Its `src` is the `/copy-photo/<32hex>/thumb` address `expectPhotoServed` checks.
- **Orientation is not on the page**: tiles keep an `aspect-[5/7] object-contain` frame, so `boundingBox` never changes. Prove a turn/crop by the saved FILE: `servedPhotoSize` fetches the src and reads the JPEG/WebP/PNG header. `photoFile` is 50x70, never scaled, so a turn is exactly 70x50 and a crop is exactly the readout `Tilted N°, W by H pixels.` (sr-only live region, debounced).
- **Held (picked, unsaved) photos** open view-only: `expectHeldPhotoViewOnly` (reason, img, Close, no Save/tools, Escape closes only the viewer, focus back on the tile).
- **Undo is per viewer session**: it exists only after a Save in the same open viewer, and for a copy only once the render landed. Closing the viewer drops it.
- **A worktree deployment calls DEV preprocess**: until `/render-edit` ships there, every save ends in "We couldn't make that edit just now. Try again." (status still reads "Saved."). Run render-dependent steps on the PR preview; a warm 404 can even end "Touching it up…" before the first poll.
- **Concurrent builders in the same worktree**: Vite serves their half-saved files; a red "An error occurred. Please refresh the page." with a Vite log line "does not provide an export named X" is that, not the spec. An HMR remount or a `page reload src/main.tsx` in the Vite log mid-run loses page state (a "Set: pick one" screenshot on a long pipeline wait). For a long spec, rsync `apps/web` (minus node_modules, playwright) to a scratch dir, symlink node_modules, and serve THAT on a spare port, so nothing reloads under the run; no app code changes.
- **Two unnamed `status` lines in the viewer once cropping** (the angle note and the save line): a bare `viewer.getByRole("status")` is a strict-mode red. Find a line by its words, `getByRole("status").filter({ hasText: /^Saved\.$/ })`.
- **Failed-edit names on an Add cards tile carry the side**: `Keep the old one: the front of <label>`, `Try again: touch up the front of <label>`. A `toHaveCount(0)` on `Keep the old one: <label>` is vacuous; check the exact name against a red run's ARIA snapshot.
- **The worktree deployment has no auto crop**: `autoCrop` comes from the PR preprocess's `crop_box`; on dev preprocess every scan opens with "No auto crop here. Drag the box to fit the card.".
- **Crop handles (post a11y fix)**: radiogroup `Which side` with radios Front/Back; `application` `Crop box`; groups `Move steps`, `Size steps`, `Width and height steps`, `Tilt steps`; readout `Tilted N°, W by H pixels, X% from the left and Y% from the top.`. Openers keep their names; their state ("Touching it up…", "Edit didn't save", "Image unavailable") is the accessible DESCRIPTION, so assert it with `toHaveAccessibleDescription`, never in the name.

**Why:** NEO-481 replaced the photo links with buttons and made edits async; the first drafts asserted tile geometry and would have passed on any orientation.
**How to apply:** for any photo-edit assertion, read the served file; scope "Touching it up…" to the tile or viewer (the drawer tile shows its own chip).

Related: [[copy-photo-specs]], [[patterns_finally_cleanup_without_an_isvisible_branch]]
