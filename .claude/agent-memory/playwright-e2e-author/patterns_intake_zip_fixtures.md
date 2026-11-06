---
name: patterns-intake-zip-fixtures
description: How to build zip and oversize-photo fixtures for Add cards specs, and why a card-sized scan stays on the preprocess fast path
metadata:
  type: reference
---

- A flat oversize JPEG for a "too many pixels" fixture: write a PPM with a short
  python3 -I script and compress with `cjpeg -quality 50 -optimize -sample 2x2`
  (8200x8200 is about 395 KB). macOS `sips` cannot get a flat 67 MP JPEG under
  1 MiB (about one byte per 8x8 block). Build zips with `zip -0 -X`; a stored entry
  expands 1:1, so the 100:1 guard (only applies above 1 MiB) never fires.
- A big photo that must stay on the fast path (no heavy-model cold start): stamp it
  so `scan_meta.is_card_sized_scan` accepts the frame: JFIF density square and
  >= 200 dpi, pixels / dpi within 3% of 2.5 x 3.5 in (6000x8400 at 2400 dpi).
  `sips -z H W -s dpiWidth N -s dpiHeight N` writes that density, BUT it leaves the
  JFIF density UNIT byte (file offset 13) at 0, which `_trustworthy_dpi` rejects
  ("no trustworthy resolution"), so the photo escalates to the heavy service anyway.
  Patch byte 13 to 1 (python3 -I, no re-encode) and verify with `xxd -s 13 -l 5`
  (`01 09 60 09 60` for 2400 dpi), never with `sips -g dpiWidth`, which reports 2400
  either way.
- Pixel limit rejection happens at /extract (header only), so a zip of oversize
  photos fails the whole run without any model call; the failure line comes from
  `runNotice` in realLanes.ts, so compute the expected string from there.
- The Add cards drop zone is `getByLabel("Drag your card photos here, or browse
  your files")`; "Start a new run" is a substring of nothing else but the setup
  bar's "New run" matches it, so use `exact: true` for both.
