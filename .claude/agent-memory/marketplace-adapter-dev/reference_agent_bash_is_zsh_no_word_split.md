---
name: agent-bash-is-zsh-no-word-split
description: The agent Bash tool runs zsh here, so an unquoted $VAR holding several paths stays one argument and bash-style globs/arrays misbehave; run multi-path commands under bash -c
metadata:
  type: reference
---

The Bash tool's shell is zsh. `RUNS="a b c"; cmd $RUNS` passes ONE argument
(no word splitting), zsh glob qualifiers like `dir/*(/)` can error as
"bad pattern" in some contexts, and there is no `timeout` binary on macOS.
Seen running `scripts/golden_masks.py hash` over ten run directories: the tool
got a single path with spaces and failed with FileNotFoundError.

**How to apply:** for any command that expands a list of paths or uses arrays,
wrap it: `bash -c '...RUNS=(a b "$S"/dir/*/); cmd "${RUNS[@]}"' _ "$S"`, passing
values as positional args. For a hard time limit use
`perl -e 'alarm N; exec @ARGV' cmd ...`. A long foreground command moves to the
background after 120 s; while it runs, anything it will restore (a mutation
backup) is still in place, so do not edit those files until it reports.
