---
name: secret-manager-has-no-upsert
description: Secret Manager has no create-if-absent, so every credential write is a two-call check-then-create race; both orderings must be fall-throughs, and a raw GCP error thrown from inside a catch bypasses the sanitiser
metadata:
  type: reference
---

`SecretManagerServiceClient` has **no upsert and no create-if-absent**. Writing
a key that may not exist is unavoidably two calls — `addSecretVersion` →
NOT_FOUND → `createSecret` → `addSecretVersion` — and the gap between them is a
race that two Cloud Run instances, or two Convex deployments sharing one GCP
project, will lose regularly.

**Both orderings must be fall-throughs, not errors:**

- `addSecretVersion` → `5 NOT_FOUND` ⇒ create the secret, then add.
- `createSecret` → `6 ALREADY_EXISTS` ⇒ another writer got there first. That is
  *the state we were trying to reach*. Fall through and add the version to the
  secret that now exists.

The loser of the create race has usually already done the expensive, real work
(a marketplace sign-in). Throwing there reports a login that actually
**succeeded** as an integration fault. See [[which-paths-exercise-a-cold-bsc-password-login]].

**Idempotence, never a lock, never a retry.**
- A retry makes it worse: the SportLots adapter's retry loop re-ran the same
  losing race on every attempt and burned its whole budget.
- A lock cannot work: the writers are in different processes, and often in
  different Convex deployments (a preview has its own `userProfiles` table and
  therefore its own operation lock) writing the same GCP key. An in-process
  mutex cannot see the other writer; a distributed lock adds a worse failure
  mode than it removes.

**Bound it so it cannot ping-pong.** The second `addSecretVersion` runs at most
once, with no loop. If it *also* reports NOT_FOUND, the secret was deleted
between the create and the add — an operator clearing the credential. That must
propagate as a failure: re-creating there resurrects a credential the user just
asked to destroy.

**The sanitiser trap that made this leak.** The original code ran the
create-then-add branch *inside* the `catch` that sanitises write errors, so a
throw from `createSecret` bypassed the sanitiser entirely and the raw gRPC
message — which names the project number and the per-user secret id — reached
the login response body and Cloud Logging. Rule: a credential write has exactly
**one** exit, and the sanitising catch wraps the whole helper, not one call
inside it. Related: [[secret-version-keep-one]] for the prune that follows the
write.

**Delete is the mirror and is already idempotent**: `deleteSecret` →
NOT_FOUND is treated as success, deletion takes the versions with it, and
Secret Manager leaves no tombstone, so the id is immediately reusable.
