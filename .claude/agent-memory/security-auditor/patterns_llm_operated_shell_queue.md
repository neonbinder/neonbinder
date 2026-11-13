---
name: patterns-llm-operated-shell-queue
description: Auditing a skill where an LLM session types message-supplied strings into Bash (pr-queue state.sh/tick.sh, NEO-494) - jq --arg safety is not the boundary; gh pr list --head matches forks and old closed/merged PRs
metadata:
  type: reference
---

When a skill has one session (often a small model with `allowed-tools: Bash`)
run a script with arguments copied out of another session's message:

- **Injection happens before the script runs.** The model types the command
  line; a title/branch/reason holding `$(...)`, backticks or a `'` executes in
  the shell that parses that line. `jq --arg` and regex checks inside the
  script only protect the JSON, never the shell. Fix by construction: the
  sender (who owns the data) writes its own entry and the message carries only
  validated tokens (ticket id, PR number, sha); otherwise the skill must make
  the receiver charset-check every free-text field and single-quote it, and
  the free text should be dropped where it is cosmetic.
- **Messages carry no sender binding.** Any session can send DONE/MERGED/OUT
  for another's entry unless the receiver compares `from` to the stored address.
- **`gh pr list --head <branch>` ignores the owner** ("<owner>:<branch>" is
  unsupported): fork PRs with the same branch name and older CLOSED/MERGED PRs
  from a reused branch both match. Filter `isCrossRepository == false` and
  `createdAt >= <turn start>` (or state OPEN) before acting on state.
- **`gh run list` has no head-repository field**; to exclude fork runs use
  `gh api -X GET repos/{owner}/{repo}/actions/runs -f branch=... ` and filter
  `head_repository.full_name` (see [[patterns-ci-cross-run-queue]]).
- A PR number supplied by message (`set-pr`) should be checked against the
  entry's branch and non-fork before it can drive a MERGED/CLOSED verdict.
- Never run the write commands of a live state script to test it; the state
  file is shared by every worktree (git common dir). Copy to the scratchpad.
