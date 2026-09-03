# Security Auditor Memory Index

- [Convex auth boundary](patterns_convex_auth_boundary.md) — every public Convex RPC must gate with requireAdmin (or be internal*); public action calling the browser proxy w/o it = HIGH finding
- [Testing/E2E endpoint gate](patterns_testing_endpoint_gate.md) — TESTING_RESET_SECRET prod fail-closed + Vercel 6-layer gate; unauthenticated env-gated queue mutations feed the merge-blocking e2e gate → false-green/CI-integrity risk (add a `secret` arg)
- [Set metadata admin gate](patterns_set_metadata_admin_gate.md) — setSetMetadata/Set Builder writes are requireAdmin-gated; sourceUrl/tcdbSetId stored as plain strings, rendered as text (never anchors); fetchCardChecklist action has a pre-existing no-admin-gate (informational)
- [Checklist commit trust boundary](patterns_checklist_commit_trust_boundary.md) — commitCardChecklist's marketplace strings: setId must resolve through the parent slot map, ids scoped by snapshot, literal patch list, bounded ref logging
- [Attention-flag suppression](patterns_attention_flag_suppression.md) — a stored review flag cleared by "any write of field X" is clearable by an unrelated drawer save; check client args + the playerIds/teamOnCardIds validation asymmetry
- [Postage/label trust boundary](patterns_postage_label_trust_boundary.md) — refreshLabelUrl derives the shipment id from an owned row, but public recordLabelPurchase lets the caller author it; printHtmlDocument never escapes bodyHtml
- [Entity skip suppression](patterns_entity_skip_suppression.md) — entityReviewSkips is write-only: bulk skip + no delete/list surface + unreadable skippedByUserId = irreversible suppression
- [Public function auth registry](patterns_public_function_auth_registry.md) — publicFunctionAuth*.test.ts are the hand-maintained registry; unchanged + green does NOT mean new public functions are pinned
