# Security Auditor Memory Index

- [Convex auth boundary](patterns_convex_auth_boundary.md) — every public Convex RPC must gate with requireAdmin (or be internal*); public action calling the browser proxy w/o it = HIGH finding
- [Testing/E2E endpoint gate](patterns_testing_endpoint_gate.md) — TESTING_RESET_SECRET prod fail-closed + Vercel 6-layer gate; unauthenticated env-gated queue mutations feed the merge-blocking e2e gate → false-green/CI-integrity risk (add a `secret` arg)
- [Set metadata admin gate](patterns_set_metadata_admin_gate.md) — setSetMetadata/Set Builder writes are requireAdmin-gated; sourceUrl/tcdbSetId stored as plain strings, rendered as text (never anchors); fetchCardChecklist action has a pre-existing no-admin-gate (informational)
