import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import path from "path";
import { issueClerkTestingTokens } from "./lib/testing/issue-clerk-tokens";

// `vite-plugin-mkcert@2` pulls in `undici@8.x` whose CacheStorage init
// calls `webidl.util.markAsUncloneable`. That API landed in Node 22.13+;
// older Node 22 (e.g. 22.5.x — what a fresh worktree hits before
// `nvm use`) blows up on the *top-level* `import mkcert` side-effect
// with `TypeError: webidl.util.markAsUncloneable is not a function`,
// even when VITE_DEV_DISABLE_HTTPS=1 means mkcert won't actually run.
//
// Deferring to a dynamic `import()` keeps the side-effect off the cold
// path. Async defineConfig is fully supported by Vite ≥3 and matches
// what runs on Vercel (Node ≥22.13 there, so the import would work,
// but we never enter this branch in production builds either way).
async function loadMkcertIfHttpsEnabled(): Promise<Plugin | null> {
  if (process.env.VITE_DEV_DISABLE_HTTPS) return null;
  const { default: mkcert } = await import("vite-plugin-mkcert");
  return mkcert();
}

// Dev-only middleware that mirrors api/auth/testing.ts so that Maestro E2E
// flows can hit /testing/sign-in against `vite dev` without needing a full
// `vercel dev` setup. Same security layers and account selector as the
// Vercel handler.
type DevTestAccount =
  | "main"
  | "new-profile"
  | "admin-no-credentials"
  | "admin-bsc-only"
  | "admin-sl-only";
const DEV_TEST_ACCOUNTS = [
  "main",
  "new-profile",
  "admin-no-credentials",
  "admin-bsc-only",
  "admin-sl-only",
] as const satisfies readonly DevTestAccount[];
const DEV_ACCOUNT_EMAIL_KEY: Record<DevTestAccount, string> = {
  "main": "TEST_EMAIL",
  "new-profile": "NEW_PROFILE_TEST_EMAIL",
  "admin-no-credentials": "ADMIN_NO_CREDENTIALS_TEST_EMAIL",
  "admin-bsc-only": "ADMIN_BSC_ONLY_TEST_EMAIL",
  "admin-sl-only": "ADMIN_SL_ONLY_TEST_EMAIL",
};
const DEV_MAX_WORKER_INDEX = 31;

function isDevTestAccount(value: unknown): value is DevTestAccount {
  return typeof value === "string" && (DEV_TEST_ACCOUNTS as readonly string[]).includes(value);
}

function parseDevWorkerIndex(
  value: unknown,
): { ok: true; index: number | null } | { ok: false } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, index: null };
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > DEV_MAX_WORKER_INDEX) {
    return { ok: false };
  }
  return { ok: true, index: n };
}

function resolveDevTestEmail(
  account: DevTestAccount,
  worker: number | null,
): string | undefined {
  const baseKey = DEV_ACCOUNT_EMAIL_KEY[account];
  if (worker !== null) {
    const indexed = process.env[`${baseKey}_${worker}`];
    if (indexed) return indexed;
  }
  return process.env[baseKey];
}

function clerkTestingApiPlugin(): Plugin {
  return {
    name: "clerk-testing-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/auth/testing", async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }
        if (process.env.CLERK_TESTING_ENABLED !== "true") {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Not found" }));
          return;
        }
        const expectedSecret = process.env.TESTING_ENDPOINT_SECRET;
        const providedSecret = req.headers["x-testing-auth"];
        if (!expectedSecret || providedSecret !== expectedSecret) {
          res.statusCode = 401;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        // Read JSON body — http.IncomingMessage doesn't auto-parse like Vercel.
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsedBody: { account?: unknown; worker?: unknown } = {};
        if (raw) {
          try {
            parsedBody = JSON.parse(raw) as { account?: unknown; worker?: unknown };
          } catch {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
            return;
          }
        }
        const requestedAccount = parsedBody.account;
        if (requestedAccount !== undefined && !isDevTestAccount(requestedAccount)) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Unknown account" }));
          return;
        }
        const account: DevTestAccount =
          requestedAccount === undefined ? "main" : requestedAccount;
        const parsedWorker = parseDevWorkerIndex(parsedBody.worker);
        if (!parsedWorker.ok) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Invalid worker index" }));
          return;
        }
        const worker = parsedWorker.index;
        const testEmail = resolveDevTestEmail(account, worker);
        if (!testEmail) {
          const baseKey = DEV_ACCOUNT_EMAIL_KEY[account];
          const detail = worker !== null ? ` (tried ${baseKey}_${worker} and ${baseKey})` : "";
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: `${baseKey} not configured for account "${account}"${detail}`,
            }),
          );
          return;
        }

        const result = await issueClerkTestingTokens({
          clerkSecretKey: process.env.CLERK_SECRET_KEY,
          testEmail,
        });
        res.setHeader("Content-Type", "application/json");
        if (!result.ok) {
          res.statusCode = result.status;
          res.end(JSON.stringify({ error: result.error, detail: result.detail }));
          return;
        }
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            signInToken: result.signInToken,
            testingToken: result.testingToken,
            clerkUserId: result.clerkUserId,
          }),
        );
      });
    },
  };
}

export default defineConfig(async ({ mode }) => {
  // Load .env* into process.env for server-side code (Vite only populates
  // import.meta.env.VITE_* by default; the dev-only Clerk testing middleware
  // reads CLERK_SECRET_KEY, TEST_EMAIL, etc. from process.env).
  Object.assign(process.env, loadEnv(mode, process.cwd(), ""));
  const mkcertPlugin = await loadMkcertIfHttpsEnabled();
  return {
  plugins: [
    react(),
    tailwindcss(),
    ...(mkcertPlugin ? [mkcertPlugin] : []),
    clerkTestingApiPlugin(),
    sentryVitePlugin({
      org: "neon-binder",
      project: "javascript-nextjs",
      sourcemaps: {
        filesToDeleteAfterUpload: ["./dist/**/*.map"],
      },
      silent: !process.env.CI,
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  build: {
    sourcemap: true,
  },
  server: {
    port: 3000,
    // Maestro writes thousands of session/log files into maestro-report/ and
    // tmp/ during local e2e runs (run-e2e-smoke.sh concatenates $PWD with
    // $REPORT_DIR, so absolute REPORT_DIR values still land inside the
    // project root). Without this ignore list, Vite's HMR fires a page
    // reload on every Maestro write and can OOM the laptop mid-suite.
    watch: {
      ignored: [
        "**/maestro-report/**",
        "**/maestro-report-*/**",
        "**/tmp/**",
        "**/.maestro/tests/**",
      ],
    },
    proxy: {
      "/ingest/static": {
        target: "https://us-assets.i.posthog.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ingest\/static/, "/static"),
      },
      "/ingest": {
        target: "https://us.i.posthog.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ingest/, ""),
      },
      "/monitoring": {
        target: "https://o4510257330520064.ingest.us.sentry.io",
        changeOrigin: true,
      },
    },
  },
  };
});
