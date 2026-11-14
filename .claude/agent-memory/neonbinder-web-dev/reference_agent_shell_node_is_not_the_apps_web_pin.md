---
name: agent-shell-node-is-not-the-apps-web-pin
description: Agent Bash shells run the machine's default Node, not apps/web's .nvmrc pin; prepend that pin's nvm bin dir in the same call as every gate
metadata:
  type: reference
---

Agent Bash calls are non-interactive, so the `node` shell function that runs
`load-nvmrc` never fires: `node --version` reports the machine default, which
can differ from `apps/web/.nvmrc` (seen 2026-11-13: default newer than the
pin). Before `npm run lint|typecheck|test:unit|build`, in the same command:
`export PATH="$HOME/.nvm/versions/node/v$(cat .nvmrc)/bin:$PATH"; node --version`
(list `~/.nvm/versions/node` if that exact version is missing).
services/browser has its own, different pin (see the puppeteer-security-engineer
memory `node-version-in-agent-shells`).

Related: [[gates-in-a-shared-worktree]].
