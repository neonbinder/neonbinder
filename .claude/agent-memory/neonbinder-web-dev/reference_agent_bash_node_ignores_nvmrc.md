---
name: agent-bash-node-ignores-nvmrc
description: In an agent's Bash tool, `node` does not run the load-nvmrc shell function, so `cd apps/web && node --version` reports the default nvm Node, not apps/web/.nvmrc — prefix PATH with the nvmrc version before running gates
metadata:
  type: reference
---

The monorepo CLAUDE.md says `node` is a shell function that re-reads `.nvmrc`
on every call. That holds in Jason's interactive zsh, NOT in an agent's Bash
tool: there `cd apps/web && node --version` printed nvm's default (a newer
24.x) while `apps/web/.nvmrc` pinned an older 24.x. There is no `.nvmrc` at
the repo root, only `apps/web/.nvmrc`.

**How to apply:** before any apps/web gate, run
`export PATH=$HOME/.nvm/versions/node/v$(cat apps/web/.nvmrc)/bin:$PATH` in the
same Bash call and confirm `node --version` matches. Each Bash call is a fresh
shell, so repeat the export per call. Report the version you ran on.

Related: [[apps-web-root-tsc-is-red-at-baseline]], [[gates-in-a-shared-worktree]].
