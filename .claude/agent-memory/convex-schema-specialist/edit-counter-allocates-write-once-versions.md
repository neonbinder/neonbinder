---
name: edit-counter-allocates-write-once-versions
description: Race-safe edits of a row whose rendered outputs are write-once objects — the per-row spend counter doubles as the version allocator; commit compares the version the client opened; lineage that survives a side swap lives on the row
metadata:
  type: reference
---

Pattern from the NEO-481 design (photo edits on `placeholderImages` and
`collectionCopyPhotos`), reusable for any "user edits a row, an external
service renders a new write-once object, then the row points at it" flow:

- **One counter, two jobs.** The reserve mutation checks the cap, bumps the
  row's counter (`edits`) and hands back the new value as the output
  version. OCC serialises two concurrent reserves, so they always get
  distinct versions and therefore distinct object keys. No pending-claim
  field is needed, and the service's "refuse an existing version" is only a
  backstop.
- **Commit is first-wins on the version the client OPENED** (`expectVersion`,
  0 when there is no edit yet), re-checked in the commit mutation. The loser
  is refused and its object is orphaned for the bucket lifecycle to collect.
  Bump the counter before the paid call, so a failed render still counts
  toward the cap. A test of "nothing written" must therefore exclude the counter.
- **Key the commit by the token the client opened, not by the side.** A
  swap between open and save moves the token to the other side; replacing
  "the row with token T, wherever it sits now" stays correct.
- **Lineage goes on the row, never derived by side.** A copy photo's link
  to its scan (`scan: {jobId, entryIndex}`) has to be stored on the photo
  row and carried onto replacement rows. Deriving it from the intake match's
  `frontIndex`/`backIndex` breaks after a swap, after a hand Replace, and
  when two saved matches share one line.
- When an edit can target two rows (the scan and the copy made from it),
  write both in ONE commit mutation, so neither can land without the other.

Related: [[outbox-rows-per-platform-seq-guarded-clear]],
[[workpool-cancel-does-not-stop-running-work]].
