---
name: patterns-inline-reauth-bypasses-backoff
description: An inline 401 → authenticate* call inside an adapter skips refreshSiteToken's NEO-278 backoff and credential lock; batches/queues built on it multiply logins (NEO-325 base-match probe)
metadata:
  type: project
---

An inline 401 → `authenticate*` call inside an adapter skips `refreshSiteToken`'s
NEO-278 re-auth backoff and the per-(user, site) credential lock. Any batch or
client queue built on that path multiplies stored-session logins per item, and
two in flight race the Secret Manager write.

Require: at most one re-auth per session object (route it through
`refreshSiteToken`), the client stops dispatching a side once a batch comes back
signed_out for every id, and a test that a failed re-auth makes zero further login
calls for the rest of the batch.
