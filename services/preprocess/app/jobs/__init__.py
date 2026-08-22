"""Stateless GCS helpers for the placeholder batch pipeline (NEO-170).

Convex owns ALL job state and orchestration — its workpool decides what runs,
records progress and holds every result. Nothing in this package tracks a job:
`layout` derives object keys from `{user_id, job_id, index}`, `gcs` reads and
write-once-creates objects at those keys, and `zipsafe` guards the one
attacker-controlled input (the uploaded archive). No status log, no manifest,
no runner — a route call is the entire lifetime of any work done here.
"""
