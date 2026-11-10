---
name: testing-wired-bsc-call-telemetry
description: How to prove the NEO-475 BSC call recorder is wired without changing behaviour — flush-once by counting scheduled rows, body-drain proof past the clone sample, instant selector backoff
metadata:
  type: reference
---

The BSC adapters record each call on a `lib/bscCallTelemetry.ts` recorder and
flush once per invocation (`flushBscRecorder` / `closeBscSellerSession` in
`adapters/bscSeller.ts`). Tests that held up:

- **Flush exactly once:** count `_scheduled_functions` rows whose `name`
  includes `bscCallStats`, in ANY state, plus the `bsc_call_summary` console
  lines. Works through real action ctx (`t.action(internal.listingDrain.drainOwner)`,
  `pollOwner`, `clearSellerAccounts`); the `*Impl` stub ctxs have no
  `scheduler`, so they only ever get the log line.
- **Caller still reads a non-2xx body:** stub a pull-based `ReadableStream`
  larger than the recorder's 4 KB clone sample and set a `drained` flag when
  `pull` reaches close; only the caller's own read can drain it. For the
  selector loop, assert the caller's `errText` console.error line instead.
- **Selector backoff (500/1000 ms):** spy `globalThis.setTimeout` and map only
  those delays to 0; the recorder's own 2 s body-read deadline keeps its delay.
- **Body failures after a 2xx** (`parse`, `body_timeout`): a pull stream that
  `controller.error`s a `TimeoutError` gives body_timeout; `"{not json"` gives parse.
- Plant a removal (drop `rec.respond`, skip `runAfter`, skip the session
  close) and watch the new tests go red before trusting them.

Related: [[hold-runafter0-in-convex-test]], [[scheduled-telemetry-unmasks-cross-test-leaks]],
[[adapter-retry-pause-is-injected]].
