---
name: leftover-copy-red-is-an-unconfirmed-final-remove
description: A collection spec red because #1's Have is already pressed means an earlier spec on that worker ended on an optimistic Remove; attribute by removeCopy completions in that spec's window
metadata:
  type: project
---

A collection spec that fails at its first `Have <short>` (pressed:false) with the row already "Raw, Excellent" means an earlier spec on the SAME worker left a copy on the shared first Base row. Seen 2026-11-13 (run for PR #473): add-copy-with-photos-never-stacks pressed three Removes but only two `collection:removeCopy` completions landed before it ended; it closed on optimistic "None yet." / pressed:false.

**Why:** Remove is a Convex optimistic update; a spec that ends (or presses the next Remove) on the optimistic state can leave the write unsent. Every drawer "Removed …" notice for identical lines reads the same, so a `^Removed` wait only distinguishes the first one.

**How to apply:** shard test order is in the job log (one worker per shard). The Convex log artifact is deployment-wide (all shards), so attribute by counting removeCopy/addLineItem completions inside the suspect spec's start/end window and cross-check other shards' concurrent specs. Fix is spec-only: confirm each Remove on the server (`^Removed` notice, then "Dismiss message" before the next press) and before leaving the drawer. Same gap sat in saves-both-at-once, copy-photos-add-replace-remove and card-photo-viewer-rotate-crop-saved-copy. Related: [[seller-specs-race-background-drains]].
