---
name: node-version-in-agent-shells
description: Agent Bash calls start on the machine's default Node (24), not the .nvmrc pin (22); prefix PATH with nvm's 22 bin before services/browser gates
metadata:
  type: feedback
---

Agent Bash shells are non-interactive, so the `node` shell function that runs
`load-nvmrc` never fires and `node --version` reports the machine default (v24),
not the `.nvmrc` pin (22). Before `npm run build && npm test` in
`services/browser`, prepend the nvm 22 bin dir in the same command:
`export PATH="$HOME/.nvm/versions/node/v22.<x>/bin:$PATH"; node --version`.

**Why:** CLAUDE.md warns a wrong Node turns a green suite red; the warning is
about the interactive shell, but agents hit the opposite drift.

**How to apply:** every gate run from an agent; list `~/.nvm/versions/node`
to pick the installed 22.x, and print `node --version` in the same call.

Related: BSC-only login options extend `LoginOptions` inside the adapter
(`BscLoginOptions`) rather than widening the shared type in observability.ts;
TS method-parameter bivariance lets the override narrow it.
