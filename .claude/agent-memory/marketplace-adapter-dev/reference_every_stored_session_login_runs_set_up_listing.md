---
name: every-stored-session-login-runs-set-up-listing
description: every successful BSC/SL stored-session login (hourly renewal, Test Credentials) reaches listingSync.setUpListing with save:false; a user-only side effect must key on opts.save / transient
metadata:
  type: reference
---

A successful login on the stored session (token renewal via
`refreshSiteToken` → `authenticateBsc`, a silent re-authorize, Test
Credentials) runs `applyLoginOutcome` → `userProfile.updateSiteCredentialStatus`
with no `listing` arg → `listingSync.setUpListing(…, { save: false })`. So
setUpListing's early "already listing" return runs about once an hour per
owner from renewals alone, besides `runSiteLogin`'s own post-login work.

Anything meant to happen only on a collector's action (NEO-483's
`userAction` on the seller-id chain) must key on `opts.save` in setUpListing
and on `transient !== undefined` in `runSiteLogin` (a password sign-in: the
Connect/save, or the testing seed's `storeTestCredentials`, which goes
through the same `connectAndStore`). Passing `true` unconditionally from
either call site silently re-creates the perpetual re-arm.

Prove it end to end in credentials.test.ts: seed the ended state, call
`refreshSiteTokenForUser` (no identity needed) several times, assert no
scheduled job; then plant `userAction: true` and confirm the test reds.

Related: [[reference_store_loops_fall_through_to_insert]].
