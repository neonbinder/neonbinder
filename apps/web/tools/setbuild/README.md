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
npm run setbuild -- whoami|inspect|plan|apply|mcp-smoke ...
npm run setbuild:mcp          # MCP server over stdio (repo-root .mcp.json: nb-setbuild)
```

Exit codes: 0 ok, 1 the command failed, 2 usage error.

## Connection (shared by the CLI and the MCP server)

| Flag | Env | Purpose |
|---|---|---|
| `--convex-url` | `NB_SETBUILD_CONVEX_URL` | The target. There is no fallback to `VITE_CONVEX_URL`. |
| `--auth machine\|testing` | `NB_SETBUILD_AUTH` | Token source. |
| `--app-url` | `NB_SETBUILD_APP_URL` | `testing`: origin serving `/api/auth/testing`. |
| `--worker` | `NB_SETBUILD_WORKER` | `testing`: per-worker test account (default 0). |
| `--publishable-key` | `VITE_CLERK_PUBLISHABLE_KEY` | `testing`: derives the Clerk FAPI origin. |
| `--transport ws\|http` | `NB_SETBUILD_TRANSPORT` | Default `ws` (`ConvexClient`); `http` is the fallback. |
| `--convex-site-url` | `NB_SETBUILD_CONVEX_SITE_URL` | Only for a custom Convex domain. |
| `--env-file` | `NB_SETBUILD_ENV_FILE` | dotenv file loaded first (does not override the environment). |
| `--json` | | Machine-readable output. |

Secrets come from the environment only: `NB_SETBUILD_API_KEY` (machine),
`TESTING_ENDPOINT_SECRET` and `VERCEL_AUTOMATION_BYPASS_SECRET` (testing). Every
error path redacts them; never add a flag that accepts one.

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
  reference to the write half.
- **Writes check the confirm phrase twice**: in the MCP tool and in the service.
  The CLI's `--confirm` / TTY prompt is the only lock on the CLI path.
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

`e2e.yml` `seed` job: reset, `apply --spec .maestro/seed/baseline.spec.json`,
`mcp-smoke --spec .maestro/seed/parallel.spec.json --expect
.maestro/seed/mcp-smoke.expect.json`. The reports upload as the `setbuild-seed`
artifact.
