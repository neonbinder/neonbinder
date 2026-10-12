---
name: agent-bash-node-ignores-nvmrc
description: In an agent's Bash tool, `node` is the default nvm install, not .nvmrc's; prefix PATH with ~/.nvm/versions/node/v<nvmrc>/bin before gates
metadata:
  type: reference
---

The monorepo CLAUDE.md says `node` is a shell function that re-reads `.nvmrc` on every call. That holds in an interactive shell, not in an agent's Bash tool: there `node --version` in `apps/web` printed the nvm default (a newer 24.x) while `.nvmrc` pinned a different 24.x.

**How to apply:** before running the fast gates, compare `cat .nvmrc` with `node --version`. If they differ, run every gate command with `export PATH=$HOME/.nvm/versions/node/v$(cat .nvmrc)/bin:$PATH` in the same Bash call (state does not persist between calls). `ls ~/.nvm/versions/node` shows what is installed. Report the version you gated on.
