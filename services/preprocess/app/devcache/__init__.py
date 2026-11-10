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
"""
