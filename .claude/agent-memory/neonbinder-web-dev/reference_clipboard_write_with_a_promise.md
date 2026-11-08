---
name: clipboard-write-with-a-promise
description: Copying text that lands after awaits - start clipboard.write in the click with a promise; measured in Chromium; headless shell denies every write, so a Playwright spec must stub it
metadata:
  type: reference
---

To copy something a mutation has not returned yet, call
`navigator.clipboard.write([new ClipboardItem({ "text/plain": blobPromise })])`
synchronously in the click, and fall back to `writeText` once the text is in hand.

Measured on Chromium 153 (full build, `channel: "chromium"`, no permission grants):

- The promise form resolved after 300 ms, 3 s, 8 s and 20 s delays.
- A rejected promise rejects `write` and leaves the old clipboard contents alone.
- A late `writeText` worked at 300 ms and was denied at 8 s, so the promise form
  helps Chrome on a slow mutation too, not only Safari.

**Playwright's default headless shell denies every clipboard write**, gesture or
not, and `grantPermissions(["clipboard-read"])` alone also denies writes. So a spec
cannot rely on the real clipboard: stub `navigator.clipboard` before the click.

**Why:** found on NEO-459's scanner code auto-copy, where the old code gave up on
the copy because the code lands past the click.

**How to apply:** Attach a no-op `catch` to the blob promise, or a browser missing
`write` leaves it as an unhandled rejection. Chrome 98-132 takes only a Blob promise,
not a string one. Safari and Firefox are docs-only here: no build of either was run.
Related: [[ref-cleanup-sees-focus-before-removal]].
