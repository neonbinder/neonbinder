---
name: every-stored-session-login-runs-set-up-listing
description: stored-session logins reach setUpListing(save:false) hourly, so user-only effects key on opts.save / transient; a user-action bypass still needs a per-row floor
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

A user-action bypass needs its own floor too: a Sync press is a public
mutation a script can loop, so "user action skips the cooldown" is
unbounded unless the bypass waits a per-row minimum since the chain ended.
And clearing a chain's field on a stop is itself a re-arm hole (no record,
no floor); keep an ended record and clear only when the account is known.
