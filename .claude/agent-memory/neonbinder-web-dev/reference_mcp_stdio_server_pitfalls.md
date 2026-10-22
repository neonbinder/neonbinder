---
name: reference-mcp-stdio-server-pitfalls
description: Building a stdio MCP server in apps/web (NEO-339 nb-setbuild) — required zod args skip your handler, npm's banner and console.log corrupt stdout, `${VAR:-}` hands the server "" not unset, the client's 60 s default timeout, and how to boot it against a stub sibling module
metadata:
  type: reference
---

Things that bit or nearly bit while building `tools/setbuild/mcp*.ts` on
`@modelcontextprotocol/sdk` 1.x (McpServer.registerTool + zod v3 raw shapes):

- **A required zod field never reaches the handler.** The SDK validates input
  first and returns `isError` with a generic "Input validation error … Required".
  When a missing arg must produce a useful answer (a confirm phrase that names
  the expected value), declare it `.optional()` and check it in the handler.
- **stdout is the protocol.** `npm run <script>` prints a `> pkg@ver script`
  banner to stdout: launch with `npm --prefix apps/web run --silent <script>`.
  Reroute `console.log/info/debug` to stderr at start-up (convex/browser's
  ConvexClient logs reconnects with console.log).
- **`.mcp.json` `${VAR:-}` passes "" for an unset var**, and a var without a
  default fails config parsing. Treat "" as unset everywhere (a `?? "ws"`
  default does not fire on ""), and note `process.loadEnvFile` never
  overrides an existing key, empty or not — merge with `util.parseEnv` instead.
- `npm run` changes cwd to the package dir; resolve user-relative paths
  against `process.env.INIT_CWD`.
- **Client default request timeout is 60 s** (`DEFAULT_REQUEST_TIMEOUT_MSEC`);
  a long write tool needs `callTool(params, undefined, { timeout })`.
- Thrown handler errors become `isError` text of `err.message` only, but
  JSON.parse messages quote the input — never forward them for a file the
  user named.
- **Test pattern:** `InMemoryTransport.createLinkedPair()` + real McpServer +
  Client in the node vitest project; fast (<0.5 s for ~50 tests).
- **Boot the real stdio entry when a sibling module it imports does not exist
  yet:** a `node:module` `register()` resolve hook that maps the missing
  specifier to a scratch stub, passed via `NODE_OPTIONS=--import=<abs>` — it
  propagates into the spawned server child. Keep hook + stub in the scratchpad.

- **A new service method is wired in four places, not one:** `runner/service.ts`,
  `mcp.ts`'s `lazyService` (which must forward EVERY argument; it once dropped
  `stopAt`, and dropped `inspect`'s options until NEO-339 attention) and
  `unavailableService`, plus the fake services in `mcp-allowlist.test.ts`,
  `mcp-tools.test.ts`, `mcp-smoke.test.ts`, `mcp-oneshot.test.ts`. Pass a
  trailing option only when given: `toHaveBeenCalledWith(path)` fails on
  `(path, undefined)`.
- `eslint .` ignores `tools/setbuild`; its gates are the setbuild tsconfig
  (inside `npm run typecheck`) and vitest.

Related: [[reference-vitest-components-project-only-tsx]], [[gates-in-a-shared-worktree]].
