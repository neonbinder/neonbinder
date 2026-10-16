---
name: patterns-confirm-phrase-and-read-write-splits
description: Three gate patterns from auditing a headless write tool (NEO-339) — an echoed confirm phrase is not human approval, credential-destination overrides must match the phrase-bound host, and a read/write service split is only structural if the read side holds a read-only client
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
