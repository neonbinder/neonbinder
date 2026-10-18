/**
 * NEO-339 — turn flags + environment into a target and a token source.
 *
 * Shared by the CLI and the MCP server so both read the same variables the
 * same way. Secrets come from the environment ONLY, never from argv (argv is
 * visible to every process on the machine via `ps`).
 *
 * | Variable                          | Used for                                   |
 * |-----------------------------------|--------------------------------------------|
 * | NB_SETBUILD_CONVEX_URL            | target (or --convex-url)                   |
 * | NB_SETBUILD_AUTH                  | machine \| testing (or --auth)             |
 * | NB_SETBUILD_API_KEY               | machine: Clerk API key (secret)            |
 * | NB_SETBUILD_APP_URL               | testing: SPA origin (or --app-url); both   |
 * |                                   | modes: origin of the Set Builder links     |
 * | TESTING_ENDPOINT_SECRET           | testing: x-testing-auth (secret)           |
 * | VITE_CLERK_PUBLISHABLE_KEY        | testing: FAPI origin (or --publishable-key)|
 * | VERCEL_AUTOMATION_BYPASS_SECRET   | testing: protected preview (secret)        |
 *
 * There is deliberately no fallback to `VITE_CONVEX_URL`: an `.env.local`
 * loaded for convenience must never pick the deployment a write lands on.
 *
 * Every credential goes only where the confirm phrase's host binds it:
 * machine auth refuses a site URL that is not the Convex URL's `.convex.site`
 * twin (`assertSiteIsTwin`), and testing auth refuses a plain-http app URL off
 * loopback and a production (`pk_live_`) Clerk key (testing-token-source.ts).
 */

import { machineTokenSource } from "../auth/machine-token-source";
import { testingTokenSource } from "../auth/testing-token-source";
import type { TokenSource } from "../auth/token-source";
import type { Transport } from "./convex-client";
import { assertSiteIsTwin, isLocalHost, parseTarget, type Target } from "./target";

export type AuthMode = "machine" | "testing";

export interface ConnectionFlags {
  auth?: string;
  convexUrl?: string;
  convexSiteUrl?: string;
  appUrl?: string;
  worker?: string | number;
  publishableKey?: string;
  transport?: string;
}

export interface Connection {
  target: Target;
  tokens: TokenSource;
  auth: AuthMode;
  transport: Transport;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Env var names whose values must never be printed. */
export const SECRET_ENV_VARS = [
  "NB_SETBUILD_API_KEY",
  "TESTING_ENDPOINT_SECRET",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
] as const;

/** The secret values present in `env`, for last-line-of-defence redaction. */
export function secretValues(env: NodeJS.ProcessEnv): string[] {
  return SECRET_ENV_VARS.map((k) => env[k]).filter((v): v is string => !!v);
}

function pick(flag: string | undefined, env: string | undefined): string | undefined {
  const v = flag ?? env;
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

/**
 * The origin Set Builder links are printed on: the app URL's origin, or
 * undefined (links stay root-relative). Held to testing auth's rule under
 * either mode: https, or plain http on loopback only. Under machine auth the
 * URL only shapes links, but a link the operator opens on a production run
 * must not send them to a plain-http host anyone on the path can answer for.
 */
function linkOrigin(appUrl: string | undefined): string | undefined {
  if (appUrl === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(appUrl);
  } catch {
    throw new ConfigError("The app URL (--app-url or NB_SETBUILD_APP_URL) is not a URL.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) {
    throw new ConfigError(
      "The app URL (--app-url or NB_SETBUILD_APP_URL) must be https:// (plain http is allowed only for localhost).",
    );
  }
  return url.origin;
}

export function resolveConnection(
  flags: ConnectionFlags,
  env: NodeJS.ProcessEnv = process.env,
  deps: { fetchFn?: typeof fetch } = {},
): Connection {
  const convexUrl = pick(flags.convexUrl, env.NB_SETBUILD_CONVEX_URL);
  if (!convexUrl) {
    throw new ConfigError("No target: pass --convex-url or set NB_SETBUILD_CONVEX_URL.");
  }
  const target = parseTarget(convexUrl, { siteUrl: flags.convexSiteUrl });

  const transportRaw = flags.transport ?? "ws";
  if (transportRaw !== "ws" && transportRaw !== "http") {
    throw new ConfigError('--transport must be "ws" or "http".');
  }
  const transport: Transport = transportRaw;

  const authRaw = pick(flags.auth, env.NB_SETBUILD_AUTH);
  if (authRaw !== "machine" && authRaw !== "testing") {
    throw new ConfigError("Pick an auth mode: --auth machine|testing, or set NB_SETBUILD_AUTH.");
  }

  const appUrl = pick(flags.appUrl, env.NB_SETBUILD_APP_URL);

  if (authRaw === "machine") {
    const apiKey = env.NB_SETBUILD_API_KEY;
    if (!apiKey) throw new ConfigError("--auth machine needs NB_SETBUILD_API_KEY in the environment.");
    assertSiteIsTwin(target);
    return {
      target: withAppOrigin(target, linkOrigin(appUrl)),
      auth: "machine",
      transport,
      tokens: machineTokenSource({ convexSite: target.convexSite, apiKey, fetchFn: deps.fetchFn }),
    };
  }

  const testingSecret = env.TESTING_ENDPOINT_SECRET;
  const publishableKey = pick(flags.publishableKey, env.VITE_CLERK_PUBLISHABLE_KEY);
  const missing = [
    !appUrl && "--app-url or NB_SETBUILD_APP_URL",
    !testingSecret && "TESTING_ENDPOINT_SECRET",
    !publishableKey && "--publishable-key or VITE_CLERK_PUBLISHABLE_KEY",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new ConfigError(`--auth testing needs ${missing.join(", ")}.`);
  }
  const workerRaw = flags.worker ?? 0;
  const worker = typeof workerRaw === "number" ? workerRaw : Number(workerRaw);
  if (!Number.isInteger(worker) || worker < 0 || worker > 31) {
    throw new ConfigError("--worker must be an integer from 0 to 31.");
  }
  // The token source checks the app URL first (the testing secret is sent to it).
  const tokens = testingTokenSource({
    appUrl: appUrl!,
    testingSecret: testingSecret!,
    bypassSecret: env.VERCEL_AUTOMATION_BYPASS_SECRET || undefined,
    worker,
    publishableKey: publishableKey!,
    fetchFn: deps.fetchFn,
  });
  return {
    target: withAppOrigin(target, linkOrigin(appUrl)),
    auth: "testing",
    transport,
    tokens,
  };
}

function withAppOrigin(target: Target, appOrigin: string | undefined): Target {
  return appOrigin === undefined ? target : { ...target, appOrigin };
}
