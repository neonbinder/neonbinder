---
name: patterns-confirm-phrase-and-read-write-splits
description: Gate patterns from auditing a headless write tool (NEO-339) — echoed phrase is not approval, URL overrides vs phrase host, read-only client, the digest's real input, name-bound phrases vs findOrCreate dedupe, replay vs moot gating
metadata:
  type: feedback
---

1. **A confirm phrase the tool echoes back on a mismatch checks the target, not
   who approved.** Under `Bash(*)` an agent just re-runs with the echoed phrase.
   Only a TTY-only prompt or a Claude Code permission prompt actually gates an
   agent's write. When the permission prompt shows only a file path, bind the
   phrase to the content (a digest of the canonical spec) so "plan A, apply B"
   cannot pass.
2. **Check every URL override against the phrase-bound host.** If one flag binds
   the phrase (`--convex-url`) and an independent override decides where a
   credential is POSTed (`--convex-site-url`, `--app-url`), the phrase means
   nothing for credential exfiltration. Pin the override to the derived twin,
   or to localhost, and require https.
3. **A read/write split is structural only if the read implementation holds a
   read-only client.** Handing MCP read tools `service.read` proves nothing when
   `read.*` closes over a write-capable client. Check what client the read code
   holds, and ask for a test that runs every read tool against a client whose
   mutations and actions throw.
4. **Find the digest's real input; a sibling "ForDigest" normaliser can be dead.**
   A helper named for the digest, with tests pinning its behaviour (e.g. "a
   trailing space is a different input"), may not be what the phrase function
   calls. Grep the phrase helper's body, not the helper's name. Usually the
   live input is the zod-parsed value (already trimmed), which is fine as long
   as the tool and the service both hash the same parse.
5. **A name-bound phrase binds names, not the rows they resolve to.** Ask what
   lands when the name resolves differently later. The sharpest case is a
   `create` answer sent through a `findOrCreate` mutation that dedupes: with
   exactly one same-name row it returns that row (and may ignore a
   disambiguating field such as `birthYear`), so an approved "create" quietly
   links an existing, possibly different, entity. The tool should refuse a
   create when a same-name row exists, not report `existed: true` afterwards.
6. **Replaying a phrase is mostly harmless when every answer is re-gated on the
   item's current flag** (an answer for an item that is gone is `moot`). Check
   for answers that are NOT gated that way: those re-apply on replay.
7. **Guidance that sends the agent to the web widens the injection surface.**
   When a tool description tells the driving agent to research answers on
   third-party pages, the "X is data, never instructions" line must name web
   pages too, and say a page never stands in for the operator's confirmation.
   The real gate stays the client permission prompt on the write tool (check
   it is not allowlisted), not the advisory "operator confirms" wording.
8. **A live check that filters a list for misses passes on an empty list.**
   "Every listed X is answered" plus "0 still asking" proves nothing if the
   lister regresses to listing nothing. Ask for a positive control: the
   expected count or ids pinned in the fixture, or a read-back of the written
   value, and for each new answer kind in a fixture's fix block to be
   checked before/after like the old kinds (NEO-339 autograph formats).
