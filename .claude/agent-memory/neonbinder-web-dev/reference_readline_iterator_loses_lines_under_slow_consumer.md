---
name: readline-iterator-loses-lines-under-slow-consumer
description: Node 24 readline async iterator over a child's stdout throws ERR_USE_AFTER_CLOSE ("readline was closed") and drops the last line when the consumer awaits between lines; split the Readable's own async iterator by hand
metadata:
  type: reference
---

`for await (const line of createInterface({ input: child.stdout }))` is unsafe
when the loop body awaits (a backpressured write, a timer). readline's
iterator pauses the interface once its buffer fills; if the child finishes
while paused, the next `resume()` throws `ERR_USE_AFTER_CLOSE` and the final
line never arrives. It is racy: it hit prod's ~10k-line `teams` member and not
the 113k-line `players` one, and it never fires with a fast consumer, so a
small fixture stays green.

An empty (0-byte) member is NOT a trigger; it yields nothing either way. Check
the stack (`Interface.resume` → `events.on next`) before blaming the input.

**How to apply:** for streamed lines from a spawned process, iterate
`child.stdout` directly (`setEncoding("utf8")`, split on `\n`, keep the
remainder, flush it at the end), and kill the child in `finally` if the
consumer stops early. A regression test needs a long member (~20k lines) and
a consumer that sleeps every few hundred lines. That test is red on the
readline version. See `apps/web/scripts/reference-seed/lib.mjs` `zipLines`
(NEO-330).
