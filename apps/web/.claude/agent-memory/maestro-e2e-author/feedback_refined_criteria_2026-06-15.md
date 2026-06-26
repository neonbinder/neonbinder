# ⭐ REFINED FLOW-QUALITY CRITERIA (2026-06-15) — READ FIRST, SUPERSEDES specific long-wait entries

The user tightened R4/R5 and added R9. These OVERRIDE the older memory entries that document
45s sign-in / 30s propagation / 30s bulk-commit / inline-drill patterns for FEATURE flows.

## R4 — no IN-BODY re-login / credential-setup (KEEP the `/testing/sign-in` entry)
- **Every authenticated flow MUST enter via `url: …/testing/sign-in?redirect=<route>&worker=${WORKER_INDEX || "0"}`.**
  This is the REQUIRED per-flow Clerk auth handshake — NOT a removable redirect. `launchApp` starts an
  UNAUTHENTICATED browser; `/set-selector` (and other app routes) are auth-gated, so pointing a flow straight at
  `/set-selector` **bounces to the Clerk `/signin` page** (PROVEN — #35's direct-nav failed, screenshot = sign-in).
  Do NOT remove the hop. Keep the `extendedWaitUntil "Set Selector" timeout: 45000` (the Clerk ticket sign-in can
  hit rate-limit retries under parallelism; 45s matches every green flow). Everything AFTER auth is 7s (R5).
- What's BANNED (this is the actual R4): redundant **in-body** credential-setup / re-sign-in STEPS —
  `runFlow setup-bsc-credentials` / `setup-sportlots-credentials`, explicit re-auth, etc. Flows rely on the
  bootstrap-seeded creds. (The audit stripped those blocks; it never removed the `/testing/sign-in` entry.)
- ⚠️ Earlier notes claiming "session persists / drop the hop / fresh-browser-per-flow" were ALL WRONG — corrected.
- EXCEPTION: the `setup` track + `credentials-lifecycle.yaml` legitimately exercise auth — keep their waits.

## R5 — everything reacts in 7s
- Every wait is the **7s default**. The ONLY long-wait exception is a step that **directly drives a LIVE
  marketplace round-trip** (real BSC/SportLots fetch or auth) **and only when the data is not pre-synced**.
- EVERYTHING else → 7s: page loads, column renders against pre-synced data, and **ALL Convex backend calls**
  (entity-create, card/metadata save, **feature propagation to N cards**, sync-status reads).
- A `>7s` non-marketplace response is a **FINDING to fix in the product** (optimize / async / optimistic),
  **never a wait to inflate.**
- **RETIRED:** the "30s propagation toast" and "30s cold bulk-commit" carve-outs. They are 7s now; if a
  bulk propagation/commit exceeds 7s, that IS the finding (e.g. measured warm propagation to Topps Chrome
  cards = ~0.4–1s, so 7s is plenty; a cold-preview >7s should be fixed, not padded).
- Only the **setup track** keeps cold-sync long waits — it is the one place that deliberately warms marketplaces.

## R9 — all set-builder drilling via the drill utils
- ALL Sport→Year→Manufacturer→Set→Variant drilling goes through `util-drill-to-2024-topps-chrome.yaml`
  (real Topps Chrome anchor) or `util-drill-to-custom.yaml` (custom subtrees). The util owns the drill logic
  AND its (marketplace-exception) waits.
- No flow hand-rolls its own inline drill. A hand-rolled drill is a violation → replace with `runFlow` the util.
  (As of 2026-06-15 only `topps-chrome-add-feature` + `topps-chrome-marketplace-read` still hand-rolled it.)

## Net effect on the standard flow skeleton
`launchApp` → `extendedWaitUntil "Set Selector" timeout: 7000` → `runFlow util-drill-to-…` → assert/act with
all-7s waits. Long waits live ONLY in the util's cold-marketplace-fetch branches and the setup track.
