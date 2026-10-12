---
name: agent-bash-skips-load-nvmrc
description: The agent's Bash tool does not run the `node` → load-nvmrc shell function CLAUDE.md describes, so `node` is the nvm default, not apps/web/.nvmrc; prepend the pinned version's bin to PATH for every gate
metadata:
  type: reference
---

CLAUDE.md says `node` re-reads `.nvmrc` on every call. That is a function in an
interactive zsh; the agent's Bash tool does not load it, so `cd apps/web && node
--version` prints the nvm default (seen: v24.21.0 against an `.nvmrc` of 24.3.0).

**How to apply:** read `apps/web/.nvmrc`, then run every gate in one command with
`export PATH=$HOME/.nvm/versions/node/v<that version>/bin:$PATH && node --version && npm …`
(PATH does not persist between Bash calls). A fresh worktree may also have no
`node_modules`: `npm ci` there takes seconds, but check `ps` for a sibling's
install first ([[gates-in-a-shared-worktree]]).
