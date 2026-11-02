---
name: patterns-neo415-ebay-oauth-and-deletion-webhook
description: eBay OAuth connect (NEO-415) - the state/secret shape that held, and the unauthenticated Marketplace Account Deletion POST that must verify X-EBAY-SIGNATURE before it may delete anything
metadata:
  type: project
---

eBay listing connects by OAuth, not password. The shape that held on audit:
the OAuth `state` is a per-owner server nonce on the owner's settings row,
spent in an internalMutation before the code exchange (requireSignedIn picks
the row, so a consent-injection link carrying another user's state is
refused); the browser service holds the client secret and the refresh token,
returns only `{username, ebayUserId, expiresAt}` on connect and the access
token on refresh, and its routes refuse any key outside an anchored
`ebay-credentials-*` regex (connect REPLACES a secret, so a BSC key would wipe
that seller's rotating token).

Traps found (check on any change to this surface):

- **The deletion webhook is an unauthenticated destructive door.** Matching
  "eBay userId + stored username" is not authentication: usernames are public,
  the immutable userId is opaque but not secret, and a disconnected owner has
  no settings row so a `stored === undefined` branch matches on the userId
  alone. Require X-EBAY-SIGNATURE verification (public key via Notification
  API getPublicKey, which needs an app token, so the browser service fetches
  it) before scheduling anything; after that key on userId only (a username
  match fails a LEGITIMATE notice after a rename).
- **Self-rescheduling retry per failing owner** multiplies (k owners -> k^n).
  Seller conflicts are disabled on sandbox testing deployments, so many owners
  CAN share one eBay user id there. Reschedule once, with the failing set and
  an attempt cap.
- **Reconnect with a different eBay account**: the browser service overwrites
  the secret before Convex learns the new id, so the old account's live
  listings become unmanageable. The guard must sit before the overwrite
  (pass the expected id to the service, or refuse beginConnect while connected).
- **Testing-only grant forms** (refresh-token seed) should be refused by the
  service itself in production, not only by a Convex env check.

**How to apply:** for any marketplace webhook or OAuth flow, ask: what does a
forged request delete, which branch matches on less than the claimed pair,
and where does a stored secret get overwritten before identity is known.
Related: [[patterns-neo141-credential-rework]], [[patterns-neo172-machine-auth]].
