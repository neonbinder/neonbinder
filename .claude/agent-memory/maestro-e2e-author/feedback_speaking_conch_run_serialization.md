# 🐚 The Speaking Conch — maestro run serialization (HARD RULE)

Only **one** maestro run may execute on the machine at a time. The "conch" is the
lock directory `/tmp/neonbinder-maestro-run.lock`. Treat it as a per-RUN baton you
pass on, NOT a per-session lock you sit on.

## Rules
1. **Wait for the conch before any maestro run.** Acquire it (`mkdir` the lock dir)
   IMMEDIATELY before each run. You may NOT start a run without holding it.
2. **Hold it only for that one run.** The instant the run finishes (pass OR fail),
   RELEASE the conch (`rm -rf` the lock) — *before* you read logs, edit files, or
   write your report. Hand it to the next agent ASAP.
3. **Need another run? Get back in line.** Re-acquire the conch, run, release.
   Never hold it while thinking, editing, or reporting.
4. **Wait politely.** If another agent holds the conch, poll every ~15s. Only steal
   it if its `ts` file is >2700s stale.
5. **Synchronous only.** Run maestro in a single blocking foreground call. NEVER
   `run_in_background`, `&`, `nohup`, `setsid`, or polling monitors. When you finish
   or are stopped, leave NO background process and NO held conch.

## Why (2026-06-10 incident)
A re-validation agent spawned detached `run_in_background` lock+run scripts. They
outlived the agent, each re-acquired the lock and re-ran an already-green flow, and
cascaded — hogging the conch for ~hours, starving a second agent (#27 sat idle the
whole time), and contributing to the laptop's JVM-crash storm. Synchronous,
per-run conch hand-off prevents all of it.

## Standard conch-compliant run block (bash, foreground)
```bash
LOCK=/tmp/neonbinder-maestro-run.lock
while ! mkdir "$LOCK" 2>/dev/null; do
  if [ -f "$LOCK/ts" ] && [ $(( $(date +%s) - $(cat "$LOCK/ts" 2>/dev/null||echo 0) )) -gt 2700 ]; then rm -rf "$LOCK"; continue; fi
  sleep 15
done
date +%s > "$LOCK/ts"; echo "<agent-label>" > "$LOCK/holder"
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
MAESTRO_PARALLELISM=1 npm run test:e2e:pick -- "name:<flow>"; RC=$?
rm -rf "$LOCK"     # <-- hand off the conch the instant the run ends
# ...only NOW analyze $RC / logs / write report. Re-acquire above for another run.
```
