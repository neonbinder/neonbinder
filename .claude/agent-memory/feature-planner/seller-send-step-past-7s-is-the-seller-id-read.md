---
name: seller-send-step-past-7s-is-the-seller-id-read
description: BSC sellerProfile stall signatures - Send step spinning past 7 s (drain reads the id live), or since NEO-482 the seed hop printing "profile read stalled on every sign-in (5 tries)"; environment, rerun
metadata:
  type: project
---

A `@marketplace-seller` BSC spec red at `followRunToRest`/`followRunToEnd`
with the screenshot showing "Send changes to BuySportsCards" still spinning
(Read and Upload photos ticked) is the drain fetching the seller id inside
the send step: `fetchBscSellerId` runs only when no seller id is stored, and
on a CI-bootstrapped user none is. Convex signature on `listingDrain:drainOwner`:
`bsc_seller_call operation sellerProfile outcome timeout` twice (~5 s each),
then `listing_drain stoppedFor done` with no `bsc_photo_confirm`. The step
needs ~10 s against a 7 s bar, so it is red even though the run then fails
cleanly. A spec the PR never touched failing the same way is the proof.

**Why:** 2026-11-10 a photo-refresh PR's drain diff looked guilty; the run never
reached the PUT, let alone the refresh. The cure is the seed storing the seller
id (NEO-482), never a longer Send budget ([[bsc-seller-id-is-api-only-never-static]]
is coordinator policy: read live, store once).

**How to apply:** read the drainOwner log lines for the press before blaming
the diff; if sellerProfile timed out, it is environment, rerun after the
seller-id seed fix is on main. See [[seller-spec-red-with-no-step-ledger-is-the-sales-poll]].

**After NEO-482 the same stall surfaces earlier, at the seed hop:** the
listing-on BSC seed signs in up to 5 times (one `seed_bsc_relogin` line each)
and, all `idSaved:false`, prints "Seed failed (... the profile read stalled on
every sign-in (5 tries))" at ~65 s. Signature: every BSC `credential_login_call`
in the window takes 11-21 s (healthy is 2.5-6.6 s) while catalog reads stay
sub-second. That is BSC, a rerun, not the loop. A `saveBscSignIn` that waits
only for the "Profile Settings" heading hides the printed reason behind its
90 s timeout; race it against the "Seed failed" text the way
`saveEbayConnection` does.
