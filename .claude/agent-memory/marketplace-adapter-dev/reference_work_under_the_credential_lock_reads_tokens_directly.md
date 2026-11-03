---
name: work-under-the-credential-lock-reads-tokens-directly
description: An action already holding the per-(user, site) credential lock cannot get a token through getSiteTokenForUser/refreshSiteToken (they contend for the same lock and read busy as "no token"); read the cached token and call the site's refresh body directly
metadata:
  type: reference
---

`refreshSiteToken` and the adapters' 401 re-auth (`refreshSiteTokenForUser`)
take the credential lock. Code that already holds it (a Disconnect that must
withdraw listings before deleting the session, so no publish slips between)
gets `busy`, which every caller reads as "no token", and silently does nothing.

Inside the lock body: read the cache (`readCachedToken`), renew with the
site's refresh body directly when missing or near expiry (eBay:
`refreshEbayToken`, documented as "already under the lock"), and build the
adapter session with `reauthAttempted: true` so a 401 kills the session
instead of contending for the lock again. Keep the work well inside the
lock lease (`CRED_LOCK_LEASE_MS`, 5 min) and count what was left undone.

Tests that `vi.mock` `credentials.getSiteTokenForUser` do not cover this path;
stub the browser `/credentials/<key>/token` route instead.
Related: [[reference-adapter-reauth-goes-through-refresh-site-token]], [[reference-no-token-can-be-our-own-limiter]].
