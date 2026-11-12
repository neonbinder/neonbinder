---
name: patterns_shared_cache_host_gate
description: A Host-header gate on Cloud Run tagged URLs is sound against outside spoofing but runs in PR code; IAM, not the gate, is the boundary for a shared cache bucket; a sha256 envelope is integrity, not authenticity (NEO-484)
metadata:
  type: project
---

NEO-484's dev-only preprocess result cache only turns on for an untagged Host, i.e. no `---` in the first label.

- **Why the gate holds against outsiders:** Cloud Run's front end routes by Host. A request that carries an untagged Host reaches the base revision, never a `pr-N---` or `sha-*` one.
- **Why the gate is not the boundary:**
  - The gate runs in PR-controlled code, and preview revisions share the runtime service account.
  - That service account, and developers, can write to the bucket.
  - So for any cache bucket shared across revisions, the trust boundary is IAM, not the Host gate.
- **The sha256 envelope:** it proves integrity, not authenticity.

**How to apply:** when a feature gates a shared store on request properties, ask who else holds write IAM on that store. Any reader that decodes cached bytes should cap their size and check the shape before decoding.
