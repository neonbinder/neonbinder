---
name: no-timeout-binary-empties-a-grep-gate
description: macOS agent shells have no `timeout`/`gtimeout`; `timeout 600 npx tsc ... | grep myfile` prints nothing and reads as a clean root-tsc gate
metadata:
  type: reference
---

The root-`tsc` gate for app/components/src files is "grep the root run for your
own files; an empty grep is clean" ([[reference_apps_web_root_tsc_is_red_at_baseline]]).
Wrapping it in `timeout 600 …` on this Mac fails with `command not found`
(exit 127) before tsc runs, and `| grep` then prints nothing — a false green.
Seen in NEO-359: the empty grep hid a real TS2322 in a new component.

**How to apply:** never prefix gate commands with `timeout` (use the Bash
tool's own `timeout` parameter). Write tsc output to a scratch file, check it
has ~1000 baseline lines, THEN grep it for your files.
