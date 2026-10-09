---
name: convex-snapshot-import-keeps-table-numbers
description: Convex ZIP import keeps exported table numbers (encoded in every _id) and reads bare integer literals as int64; re-encode ids onto target numbers and write integral floats as N.0
metadata:
  type: reference
---

`npx convex import <zip>` preserves `_id`s, and a Convex id ENCODES its table
number. The importer (convex-backend `snapshot_import::assign_table_numbers`)
takes each table's number from the ZIP's `_tables/documents.jsonl`, or else
from the first row's `_id`, and fails with "New table `X` has IDs that conflict
with existing table `Y`" when that number belongs to a target table that is
not in the import. `--replace` does not help: only same-named tables are
exempt.

Deployments number tables differently. A long-lived deployment numbers them in
creation order (10001, 10002, …, as the schema grew). A fresh deployment that
received the whole schema at once (a PR preview) numbers them alphabetically.
So a production snapshot almost never imports raw into a preview.

The fix is mechanical. Re-encode every in-set id onto the target's number for
the same table name, keep the 16 internal-id bytes, and write `_tables` with
the target numbers. The target's numbers come from a read-only
`npx convex export --deployment <t>`. `npx convex data _tables` returns
nothing, and `npx convex run` cannot call `_system/*`.

Id format (crates/value/src/id_v6.rs): base32 (alphabet
`0123456789abcdefghjkmnpqrstvwxyz`, big-endian 5-bit groups, no padding) of
`varint(tableNumber) ++ internalId[16] ++ le16(fletcher16(previous bytes))`.
Decoding is strict, so a re-encoded string must match the original exactly.
Validate any codec by round-tripping every `_id` of a real export.

Number notation matters too. Every plain number in a snapshot is a float64
(int64 travels as `{"$integer": "<base64>"}`). The export writes integral
floats as `2005.0`, and the importer reads a bare `2005` as int64, which fails
`v.number()`. A JSON.parse → JSON.stringify round trip silently strips the
`.0` from every year, ms timestamp and integral `_creationTime`. Any tool that
rewrites rows must serialize integral numbers as `N.0`, and its checks must
scan the raw text, because parsed values cannot tell the two apart.

Ids pointing OUTSIDE the imported set, such as `sportId` → `selectorOptions`,
must already be the target's ids, because schema validation runs against the
final numbers. Rows in non-imported tables that point INTO a replaced table
dangle after the import.
