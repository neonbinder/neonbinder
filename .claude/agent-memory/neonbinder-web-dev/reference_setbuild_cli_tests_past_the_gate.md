---
name: setbuild-cli-tests-past-the-gate
description: A setbuild CLI test that gets past the confirm gate trips the NEO-188 network guard (makeClient mints a token eagerly); stub global fetch with a 401 fake, never a 5xx/throw (those retry with seconds of backoff)
metadata:
  type: reference
---

`tools/setbuild/client/convex-client.ts` `makeClient` kicks off `tokens.getToken()`
the moment the client exists, so any `main(["apply", …])` test whose phrase is
RIGHT reaches the real token source → global `fetch` → the vitest network guard
("NEO-188: N real outbound request(s)"), even with `convex/browser` mocked.

- `CommandContext.connect()` takes no injectable fetch, so stub it:
  `vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })))`
  in `beforeEach`, `vi.unstubAllGlobals()` in `afterEach`. This is a fake server,
  not a way around the guard: nothing reaches a real host.
- Answer **401**. A thrown fetch or 429/5xx is "transient" to both token sources
  and re-runs the chain with 500 ms + 1.5 s backoff, so each test costs ~2 s and
  the suite crawls.
- "Past the gate" is then `fetchStub.mock.calls.length > 0`; "refused before any
  network call" is `=== 0` (plus the mocked ConvexClient's own counter).
- A 401 body's `error` string is echoed (secret-redacted only) into the
  RunFailed message, which makes it a cheap way to put a JWT-shaped string on the
  report/stderr path and prove the shared `scrub` catches it.

CLI prompts: `CliIO.prompt` exists only on a real TTY; a test passes one to play
the operator, and omits it to be a pipe (see `ttyIo` in runner/cli-commands.test.ts).
