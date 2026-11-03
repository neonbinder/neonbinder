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

Re-audit after the fix round (what held, what to re-check):

- Shape that closed the blocker: parse the notice, look up owners by the
  immutable id, ack 200 with NO action when nobody matches, and only for a
  matched owner call the service verifier (raw bytes first, then the SDK's
  re-serialised form; both derive the userId from the same JSON.parse, so
  the fallback cannot split "what was signed" from "who is deleted").
- Residual trap: the owner pre-check makes the verify path reachable by
  anyone who owns ONE connected eBay id (their own). Random well-formed kids
  are never cached, so each forged notice is an eBay getPublicKey call and a
  hit on the shared verify rate bucket. Ask for a negative cache / budget on
  uncached kids, or a per-ebayUserId invalid-verdict throttle in Convex.
- Pre-verify branching (200 no-owner vs 412 owner) is a membership oracle
  on eBay user ids; low value while those ids are opaque.
- Owner match via the listing-state stamp (`platformAccountId`) can name an
  owner who has since connected a DIFFERENT account (sellerConflict leaves
  the old stamp), so a genuine deletion of the old account disconnects the
  new one. Any "owner of account X" lookup that unions a historical stamp
  must check the owner's current account before destructive steps.

**How to apply:** for any marketplace webhook or OAuth flow, ask: what does a
forged request delete, which branch matches on less than the claimed pair,
and where does a stored secret get overwritten before identity is known.
Related: [[patterns-neo141-credential-rework]], [[patterns-neo172-machine-auth]].

Third round (policy-setup rework, per-offer publish):

- **Single-flight token refresh shape that held** (`reauthOnce` in the eBay
  seller adapter): capture the token synchronously before the attempt's first
  await; on 401, retry if the session token already moved, else await the ONE
  shared refresh promise and require the token to differ from the one sent.
  A 401 on the NEW token then kills instead of looping. Re-check these three
  properties whenever a concurrent pool (Promise.all / inPool) is added to a
  session-bearing adapter.
- **Raw upstream-body debug logs**: masking must happen on the whole
  serialised text BEFORE chunking (a token split across chunks evades a
  per-chunk mask); mask both the raw and JSON-escaped forms. Residuals to
  flag: only the CURRENT token is masked (a refresh mid-Promise.all swaps
  it), a 2 MB cap at 8k/line is ~260 lines per read, and "temporary,
  approved for one user" has no env gate, so a second production seller's
  free-text policy fields land in logs too.
- **New public mutation registered only in its domain test** (not in
  publicFunctionAuth.test.ts) recurred here (`setCardWeight`); always diff
  the registry file when the diff adds `= mutation({`.
- Sandbox-only substitute data (fixed test picture) is safe when the switch
  and the API host derive from ONE env read in one function; confirm a
  production test pins the exact production value, not just "uploaded".
