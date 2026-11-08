---
name: add-cards-run-start-caps
description: Two per-user caps that make Add cards run-starting specs red locally with an alert, not a bug — 2 active batches (a closed run still counts while its photos are read) and 12 starts per hour; and which test workers share one user
metadata:
  type: pattern
---

A red `expect(page).toHaveURL(/run=/)` after "Use a scanner" or a photo drop, with
an `alert` in the failure ARIA snapshot, is a cap, not a regression:

- **"You've got too many runs going. Finish one first."** — 2 active batches per
  user. "Done adding photos" closes a run but its job stays active while the
  photos are still being cropped and read (a minute or more), so two real-photo
  specs back to back (desktop then mobile on one account) leave the third start
  refused. It drains by itself; rerun after a couple of minutes.
- **"You've started a lot of runs just now."** — 12 job starts per hour per
  user (`MAX_JOB_STARTS_PER_WINDOW`). Repeated local runs exhaust it. On your OWN
  Convex deployment raise it with `npx convex env set MAX_JOB_STARTS_PER_WINDOW 100`
  (accepted up to 200); never on shared dev or a preview.
- Workers 3 and up fall back to the one `TEST_EMAIL` user when no
  `TEST_EMAIL_<n>` exists, so a second worker index is NOT a fresh account for
  these caps.
- A spec that waits on "Sent N photos." under a long ceiling sits the whole
  ceiling when a start is refused; read the alert before believing a hang.
- Order a local run of several run-starting specs so only one leaves a job
  reading at a time (scanner-code, which starts empty runs, before the photo spec).

A vite dev server that shows a blank dark page after another agent's edits to
`main.tsx` or a provider (console: "multiple <ClerkProvider>") is an HMR artifact;
restart Vite once, no spec change.

An `aria-describedby` that points at an element with its own `aria-label` yields
the label, not the element's text, as the accessible description: a
`toHaveAccessibleDescription(<the tray words>)` goes red if the tray region gets
a label.
