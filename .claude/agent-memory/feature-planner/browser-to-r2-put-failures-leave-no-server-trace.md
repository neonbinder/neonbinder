---
name: browser-to-r2-put-failures-leave-no-server-trace
description: Diagnosing a red photo-save status in CopyPhotosField — the browser PUTs straight to R2, so the only server evidence is a copyPhotos:startUpload with no finishUpload; the alert text tells the catch branch apart from a remount; the status code is not recorded
metadata:
  type: project
---

A copy-photo save is three legs: `copyPhotos:startUpload` (Convex action, mints two
presigned PUT URLs), two browser `fetch` PUTs straight to R2 (no Convex entry at all),
then `copyPhotos:finishUpload`. When the widget's `status` goes "Saving…" → "" instead
of "… saved.", read the `role="alert"` line in `error-context.md` first:

- "That photo didn't upload. Check your connection and try again." = every try of the
  PUT failed, with a non-2xx or a network error (`useConvexCopyPhotos.addPhoto`).
- The server's own refusals ("too big", "a lot of photos for one hour", "ran out of
  time") are `ConvexError` copy from `copyPhotos.ts`.

Then pair every `startUpload` with the `finishUpload` within ~2 s in the run's
`convex-logs-*` artifact: an orphan `startUpload` is the failed browser PUT. Eight paired
plus one orphan in one job is the signature of a single bad R2 answer, not a widget race.

**Why:** a seller spec went red on exactly this, and the widget itself was correct: status
cleared and alert set in its own catch; the line key is carried by copy id, so a save
never remounts the field.

**How to apply:** do not read "status read empty for 7 s" as a timing problem; the call
log's halves ("Saving..." polls, then empty polls) date the catch. Since this was found,
`lib/collection/upload-with-retry.ts` retries 5xx, 429 and network errors only, and logs
`copy_photo_put_failed` with the status and attempts, so look for that line in the
browser console. A network failure now shows the same alert text with `status: null`; a
storage error sent without CORS headers also reads as null.

**A different red: the status stuck on "Saving…" for the whole 7 s, with an orphan
`startUpload`.** There the promise chain never settled, so no answer or network error
reached the catch. It isn't the alert case above, and it can't tell you which leg stalled:
DNS, connect, TLS, preflight, either PUT, or a Convex reply that never arrived. Each try
now has its own timeout (`attemptTimeoutMs`, at least 20 s), so the 7 s assert still goes
red before it fires. That timeout protects collectors and won't rescue the spec. Telling
the legs apart would need a Playwright listener on the storage host's requests, not a
trace.

A rerun hides the earlier attempt's artifacts from the API, so download them first.
