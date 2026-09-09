---
name: patterns-neo149-zip-ingest
description: NEO-149 preprocess zip ingest — the two guard bypasses found (Zip64 EOCD locator overriding the pre-parse cap, no pixel-count cap), plus the invariants that DO hold and must not regress
metadata:
  type: project
---

`services/preprocess/app/jobs/` (NEO-149) is the platform's first attacker-controlled
archive handler. Audited 2026-08-13 against `origin/main`; verdict NOT APPROVED.

## The two bypasses (verify these are fixed before trusting the module again)

**1. Zip64 EOCD locator defeats `MAX_CENTRAL_DIRECTORY_BYTES`.**
`zipsafe.read_central_directory_info` reads `size_cd`/`total entries` from the
32-bit EOCD and rejects the `0xFFFF`/`0xFFFFFFFF` sentinels. But CPython's
`_EndRecData` calls `_EndRecData64` **unconditionally** — it overwrites
`_ECD_SIZE` and `_ECD_ENTRIES_TOTAL` from a Zip64 EOCD record whenever a valid
`PK\x06\x07` locator sits at `eocd_offset - 20`, with no sentinel required. So
the guard validates a field CPython does not use.
Verified: guard saw `entries=1 dir_bytes=46` while `ZipFile` parsed 1,000,000
entries; peak RSS is **8.0x the archive size**, so a 500 MB archive of packed
46-byte CD records is ~4.0 GiB on a 4 GiB instance. The post-parse
`len(infolist()) > MAX_ZIP_ENTRIES` recheck is behind the OOM.
**Rule to carry forward: a pre-parse header guard is only worth anything if it
reads the exact field the parser will read. Check the parser's source, not the
spec.**

**2. No pixel-dimension cap anywhere.** Every zip guard is on *file* bytes. A
flat 13000x13000 PNG is 517,956 bytes and decodes to 507,000,000 bytes — under
`RATIO_CHECK_MIN_BYTES` (1 MiB) so the ratio check is skipped entirely, far
under the 32 MB entry cap. Pillow's default `MAX_IMAGE_PIXELS` only *warns*
below 178,956,970 px. The raster is then re-decoded by `exif.apply_exif_orientation`,
`cropper/_utils.rotate_image_bytes`, `cropper/pil_trim.py` and `cropper/sam.py`
(`np.array` = a second 507 MB copy).
**Rule: byte-size caps on compressed image formats are not memory caps. Any new
image ingest needs an explicit `Image.MAX_IMAGE_PIXELS` + `DecompressionBombError`
handler.**

## Invariants that DO hold — do not let these regress

- **Zip slip is structurally closed.** `layout.output_image_object` derives keys
  from the zip *ordinal* (`member.index`), never the entry name. Both id patterns
  admit no `.` or `/`. Every key builder routes through `job_prefix` ->
  `validate_identifiers`. Nothing in `app/` writes to the local filesystem or a
  temp dir, so on-disk traversal is out of scope entirely.
- **The "no object path as an argument" rule holds.** The one place worth
  re-checking on any change is `runner._CountingResolver.__call__(key)`, which
  downloads whatever key it is handed. Today `key` traces
  `pair_batch` -> `BatchImage.key` -> `record.output_key` -> `output_image_object`.
  If it ever becomes `PoolCard.original_filename` (the attacker-controlled zip
  entry name) that is an instant cross-user read oracle, because both SAs hold
  bucket-wide `objectViewer`. `pool.py`'s `hash_image` callback takes a key the
  same way and is deliberately not wired by the runner.
- **`manifest_uri` is an object path this service *emits* across the boundary**
  and Convex dereferences directly from GCS. It is safe only because the signed
  POST policy pins the **exact** key (`file.generateSignedPostPolicyV4` on one
  `File`, not a `starts-with` prefix), so a user cannot forge a status snapshot
  under their own `status/` prefix. If that policy is ever loosened to a prefix
  condition, forging `manifest_uri` becomes the read oracle. Convex should
  re-derive `output/manifest.json` from (user_id, job_id) rather than trust it.
- Duplicate submit is genuinely race-safe: `if_generation_match=0` on sequence 0.
  Tests drive the real `ObjectStore` against a fake that models the 412.
- The `# pragma: no cover` post-read size check in `iter_zip_members` is
  **correctly** argued unreachable — CPython's `ZipExtFile._read1` ends with
  `data = data[:self._left]`, `_left` initialised to `zinfo.file_size`.

## Availability traps in this design

- **Slot leak.** `submit_job` takes the `_active_jobs` slot; `execute_job`
  releases it. Starlette runs `await self.background()` *after* both `send()`
  calls, so a client/LB timeout during submit's two GCS round-trips means the
  background task never runs and the slot is held until the instance recycles.
  With `MAX_ACTIVE_JOBS_PER_INSTANCE=1` and max-instances 3, three timed-out
  submits wedge the feature. A Convex retry policy triggers this on its own.
- **`stalled` is over-triggered.** `_checkpoint` only fires inside the per-member
  loop at `done % 5 == 0`. The whole `pair_batch` phase writes nothing, so a long
  job reads `stalled` (>5 min quiet) while running fine — and the documented
  client response is "resubmit under a fresh job id", which doubles the spend.
- **Cost amplification.** `_plan_adjacency` only pairs *confidently-opposite*
  neighbours. 1000 blank images all resolve to "front", so zero adjacency pairs
  and every image becomes a leftover -> one Haiku vision call each. The
  "resolver is a fraction of the batch" saving assumes honest scans; tests only
  assert `resolver_calls == 2` on honest 4-image batches.

See [[patterns-convex-auth-boundary]] for the Convex-side rule this mirrors.
