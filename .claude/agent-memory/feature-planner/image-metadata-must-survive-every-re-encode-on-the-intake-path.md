---
name: image-metadata-must-survive-every-re-encode-on-the-intake-path
description: Any re-encode between the scanner and crop() (CLI enhance from a raw buffer, sharp .jpeg(), cv2.imencode) silently drops JFIF density and blinds scan_meta; plan every intake change to carry density explicitly
metadata:
  type: project
---
The NEO-191 scanner-metadata identity reads JFIF density off the uploaded bytes and declines below 200 dpi. A re-encode from a raw pixel buffer (sharp `raw()` round trip in the CLI scanner's `enhance()`), a `.jpeg()` without `withMetadata({density})`, or a `cv2.imencode` writes 72 dpi or nothing, so every such card pays the classical pass and escalates on any non-"frame" verdict.

**Why:** found while planning the 2026-10-02 preprocess perf ticket: the CLI scanner path strips density, so the "95% of scanner intake settles with no pixel work" claim does not hold for CLI-streamed batches. The service already carries density across its own EXIF transpose for exactly this reason.

**How to apply:** any plan that touches image bytes between scanner and `crop()` (client resize, enhance, EXIF upright, format conversion) must say how density is preserved, and the measurement for it is the `scan_meta:` log line ratio ("no trustworthy resolution" vs "is one card") on a real batch. Verify with current code before relying on it.
