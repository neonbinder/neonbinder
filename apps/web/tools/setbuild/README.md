# setbuild

NEO-339. Builds sets through the **same public admin Convex functions the Set
Builder UI calls**, as a real admin, from a declarative JSON spec. It adds no
Convex function, HTTP action or secret.

Operators: read `docs/operations/neo339-setbuild.md` (running plan/apply/MCP
locally and in CI, production use, fixing a red seed, marketplace drift,
enrichment capture). This file is for people changing the tool.

## Commands

```bash
cd apps/web
npm run setbuild -- help
npm run setbuild -- whoami|inspect|plan|apply|decisions-template|schema|mcp-smoke ...
npm run --silent setbuild -- confirm-phrase --spec <file.json> --convex-url <url>   # offline
npm run setbuild:mcp          # MCP server over stdio (repo-root .mcp.json: nb-setbuild)
```

Exit codes: 0 ok, 1 the command failed, 2 usage error (including `apply
--auth machine` without a terminal), 3 `apply` stopped at an open decision.

`plan`, `apply` and `decisions-template` take `--paused-platforms <keys>`
(default: env `PAUSED_PLATFORMS`; an explicit `""` means nothing is paused).
`mcp-smoke` passes it to the server it spawns, and the MCP server reads
`PAUSED_PLATFORMS` from its own environment.

## Connection (shared by the CLI and the MCP server)

| Flag | Env | Purpose |
|---|---|---|
| `--convex-url` | `NB_SETBUILD_CONVEX_URL` | The target. There is no fallback to `VITE_CONVEX_URL`. |
| `--auth machine\|testing` | `NB_SETBUILD_AUTH` | Token source. |
| `--app-url` | `NB_SETBUILD_APP_URL` | `testing`: origin serving `/api/auth/testing`. |
| `--worker` | `NB_SETBUILD_WORKER` | `testing`: per-worker test account (default 0). |
| `--publishable-key` | `VITE_CLERK_PUBLISHABLE_KEY` | `testing`: derives the Clerk FAPI origin. |
| `--transport ws\|http` | `NB_SETBUILD_TRANSPORT` | Default `ws` (`ConvexClient`); `http` is the fallback. |
| `--convex-site-url` | `NB_SETBUILD_CONVEX_SITE_URL` (MCP server) | Only for a custom Convex domain. With `--auth machine` it must be the `.convex.site` twin of `--convex-url` (loopback excepted), since the API key is posted there. |
| `--env-file` | `NB_SETBUILD_ENV_FILE` | dotenv file loaded first (does not override the environment). |
| `--json` | | Machine-readable output. |

Secrets come from the environment only: `NB_SETBUILD_API_KEY` (machine),
`TESTING_ENDPOINT_SECRET` and `VERCEL_AUTOMATION_BYPASS_SECRET` (testing). Every
output path (MCP results, report files, CLI errors) goes through one `scrub`
(`auth/token-source.ts`): the secret values plus anything JWT-shaped. Never add
a flag that accepts a secret, and never print or write output that skips
`scrub`.

`--auth testing` refuses a `pk_live_` publishable key, an `http://` app URL off
loopback, and any minted token whose `iss` is not the FAPI host the key names;
the bypass header goes only to an https origin.

## Layout

```
auth/      token sources (machine API key, testing ticket -> Clerk template JWT)
client/    target parsing, connection resolution, ConvexClient wrapper
spec/      the zod spec schema and loader
lib/       one module per operation (credentials, sync, map base, reconcile, review, commit, parallel)
runner/    plan and apply: ordering, idempotency, open-decision templates
service.ts the seam the CLI and the MCP tools both call (read vs write halves)
mcp*.ts    the MCP server, its seven tools, and mcp-smoke
```

## Rules to keep

- **Read and write are separate objects** in `service.ts`. Read tools hold no
  reference to the write half, and `inspect` / `reviewItems` run on
  `queryOnlyClient` (a mutation or action throws before it is sent); `plan`
  runs on `readOnlyClient`, which also allows the marketplace candidate read.
- **The confirm phrase is `BUILD <host> <scope> <digest>`**, the digest being
  8 hex of SHA-256 over canonical JSON (`client/target.ts`) of the parsed spec
  or the write's arguments. One helper per write in `service.ts`
  (`specConfirmPhrase`, `decideConfirmPhrase`, …) is used by both the MCP tool
  and the service, so the two cannot drift. Never compose a phrase elsewhere.
- **Writes check the phrase twice**: in the MCP tool and in the service. On
  the CLI, `--auth testing` takes `--confirm` (or a TTY prompt); `--auth
  machine` ignores `--confirm` and requires the TTY prompt.
- **A `specPath` must resolve inside the repo or `INIT_CWD`**
  (`containedSpecPath`).
- **No wildcards, no inference.** A decision is either in the spec or an open
  decision. Ties are never given to the first candidate.
- **Idempotent and resumable.** Every step checks state before it writes.
- **No marketplace name is ever a key.** Rows are addressed by NB path or by a
  marketplace id from a slot.

## Tests and gates

```bash
npm run typecheck                           # includes tools/setbuild/tsconfig.json
npx vitest run tools/setbuild               # unit + the MCP in-memory suites
```

`mcp-tools.test.ts` drives a real `McpServer` and `Client` over
`InMemoryTransport` with a fake service; `mcp-allowlist.test.ts` asserts no MCP
write tool appears in `.claude/settings.json` and that every `.mcp.json` env
value is a `${VAR}` reference.

## CI

`e2e.yml` `seed` job: compute both phrases with `confirm-phrase`, reset,
`apply --spec .maestro/seed/baseline.spec.json`, `mcp-smoke --spec
.maestro/seed/parallel.spec.json --expect .maestro/seed/mcp-smoke.expect.json`
(its `--confirm` must equal `nb_plan`'s phrase). `e2e-seed.sh` computes its
phrase the same way. The reports upload as the `setbuild-seed` artifact.
