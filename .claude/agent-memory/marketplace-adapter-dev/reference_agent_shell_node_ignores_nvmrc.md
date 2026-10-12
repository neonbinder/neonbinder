---
name: agent-shell-node-ignores-nvmrc
description: In an agent's Bash tool, `node` is the nvm default binary, not apps/web/.nvmrc's version; the interactive load-nvmrc hook never runs, so pin the gate's Node by prepending the nvm bin dir to PATH
metadata:
  type: reference
---

CLAUDE.md warns that `node` is a shell function re-reading `.nvmrc`. That is
the INTERACTIVE shell. In an agent's Bash tool it is a plain binary on PATH
(`type node` → `$NVM_DIR/versions/node/<default>/bin/node`), so `cd apps/web &&
node --version` can print the nvm default while `.nvmrc` pins another version.
CI reads `node-version-file: apps/web/.nvmrc`, so a gate run on the default is
not the gate CI runs.

**How to apply:** before the apps/web gates, compare `node --version` with
`cat apps/web/.nvmrc`. If they differ and the pinned version is installed
(`ls $NVM_DIR/versions/node/`), run every gate command in one Bash call that
starts with `export PATH=$NVM_DIR/versions/node/v$(cat .nvmrc)/bin:$PATH`
(shell state does not persist between calls). Report the mismatch if the
pinned version is not installed rather than gating on the wrong one.
