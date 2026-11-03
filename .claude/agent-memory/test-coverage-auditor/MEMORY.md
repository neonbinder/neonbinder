# Test Coverage Auditor — Agent Memory Index

- [App-wide restyle axe gap](app-wide-restyle-axe-gap.md) — theme PRs prove the switch but axe only runs on a few screens; ask for a light-mode sweep
- [One big spec, many screens](one-big-spec-many-screens-axe-gap.md) — map every view of a multi-view feature to an open assert plus axe; open forms count
- [CLI to Convex boundary args pin](cli-to-convex-boundary-args-pin.md) — a script calling `convex run` needs a test pinning the JSON it sends and the refusal on a short answer; convex-test ids cannot prove id-byte logic, ask for a read-only cross-check on a deployment
- [Retry chain plus sweep overlap](retry-chain-plus-sweep-overlap.md) — delay ladder longer than the sweep threshold runs two chains; ask for an overlap test; failure-only UI gets a component test, not a backdoor
- [Scheduled deadline keyed on row id](scheduled-deadline-keyed-on-row-id.md) — a deadline that carries only the row id fires on a retried/restarted row; require a test running the old deadline after the reset
- [Seeded terminal-state spec](seeded-terminal-state-spec.md) — a spec that seeds a failed row then drives the real path: trace it to a terminal 4xx, check close keeps the screen, prove the cap variant; gate sign-in on LAUNCH_GATE
- [Consent-flow return leg unproven](third-party-consent-flow-return-leg-unproven.md) — seed-hop connect leaves begin/return/error legs without live proof; instant isVisible branches on server-read controls
- [Progress ledger live-spec gaps](progress-ledger-live-spec-gaps.md) — lease guard, call-order claim, rerun-dependent step list, axe only on finished state
