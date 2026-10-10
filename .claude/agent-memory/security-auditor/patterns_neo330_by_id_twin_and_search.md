---
name: neo330-by-id-twin-and-search
description: v.string()+normalizeId "getByIdParam" twins and server-side management searches — what to check (validator parity, audit-field strip, unbounded query text, scan caps)
metadata:
  type: project
---

NEO-330 added `teams.getByIdParam` (signed-in) and `teams.searchForManagement`
(admin) as twins of the players pair. Clean on auth; registry entries present.

**By-id twin checklist.** `v.string()` + `ctx.db.normalizeId(table, s)` is the
house shape for URL ids (bad/foreign-table id -> null, no throw). The exposure
question is never the id parse, it is the returns validator: compare it to the
gated `get` it wraps. `players.getByIdParam` strips via `toPublicPlayer`
(players carry `createdByUserId`); teams carry no per-user field, so returning
`teamDocValidator` raw is parity, not a leak. If a per-user/audit field is
ever added to `teams`, every raw-doc team reader (get, list, search,
listForPicker, getByIdParam) leaks it at once.

**Search query text is unbounded house-wide.** `teams.search`,
`players.search` and `teams.searchForManagement` take `query: v.string()` with
no length/word cap; the every-word pass (`teamMatchesFilter`) is
O(words x name-words) per scanned row. Admin-only for the management search,
signed-in for `teams.search` (now also driven by the collector spine-label
picker). Recommend one shared server-side clamp rather than per-function.

**Scan caps make "truncated" a lower bound.** A bounded index scan filtered in
memory can miss matches past the scan and still report `truncated: false`;
correctness, not security, but don't accept "complete" claims on such lists.

Related: [[patterns_public_function_auth_registry]], [[patterns_neo327_pair_decision_log_and_ocr_parse]]
