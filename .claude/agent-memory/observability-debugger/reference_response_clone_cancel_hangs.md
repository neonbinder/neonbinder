---
name: reference-response-clone-cancel-hangs
description: Sampling a response body via response.clone() — awaiting reader.cancel() on the clone hangs until the caller's branch is also cancelled; fire and forget it
metadata:
  type: reference
---

- `Response.clone()` tees the body. A tee branch's `cancel()` promise settles only when BOTH branches are cancelled, and the other branch is the caller's. So `await reader.cancel()` on the clone hangs forever (tests time out at 5s).
- Read at most N bytes from the clone, then `reader.cancel().catch(() => {})` without awaiting. Race the read against a timer so a body that never arrives cannot hold the recorder.
- A body already used cannot be cloned (`clone()` throws): catch it and still record the failure.
- zsh: unquoted `--include=*.ts` in grep errors "no matches found" when cwd has no match; quote it. macOS `zcat` wants `.Z`; use `gzip -dc`.
