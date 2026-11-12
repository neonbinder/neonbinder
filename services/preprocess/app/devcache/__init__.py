"""Dev-only response cache for Vision (A) and BiRefNet (B) (NEO-484).

On the dev base service only, `/process-entry` reuses a stored Vision answer or
BiRefNet alpha plane for an input it has already seen, so the E2E suite stops
paying for the same model calls on every run. Everywhere else the cache is off
and every call is live.

- `policy` decides per request whether the cache is on (gates G1 to G3) and
  binds that decision for the request.
- `store` is the GCS-backed key/value store. It never raises.
- `vision` and `birefnet` own each kind's key, value encoding and counters.

Nothing here may change what a request returns: a hit must equal the live
answer byte for byte, and any failure falls back to the live call.

**Trust boundary.** IAM on the cache bucket is the security boundary: whoever
can write an object there can choose what a dev `/process-entry` returns for
that input. The rest is correctness, not security:

- G3 (the request Host is the untagged service URL) runs in the PR's own code,
  and `pr-N` preview revisions run as the same runtime service account as the
  dev base service. It keeps previews from reading or writing the cache by
  accident; it cannot stop PR code that chooses to.
- The `NBC1` envelope's sha256 gives integrity (a truncated or damaged object
  is a miss), not authenticity: anyone who can write the object can write a
  matching digest.
- Reads are size-capped (`store.MAX_OBJECT_BYTES`) and a BiRefNet plane's PNG
  header is checked before any pixel is decoded, so a hostile object costs at
  most a bounded read and a live call.

If a dev E2E red looks like a wrong mask or OCR answer, wipe the cache prefix
(README, "Dev cache").
"""
