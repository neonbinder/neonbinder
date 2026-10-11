/**
 * NEO-339 — the Convex client the set-build tool drives the public admin
 * functions through.
 *
 * Default transport is `ConvexClient` over WebSocket (Node 24; convex/browser's
 * node build carries its own `ws`), so long waits are subscriptions rather
 * than polls and token refresh is the client's own `setAuth` loop. `http`
 * (`ConvexHttpClient`) is the opt-in fallback: every call sets a fresh token,
 * and `waitFor` polls.
 *
 * Auth failures surface as the token source's own error, not as the
 * "Not authenticated" a query would otherwise throw after silently running
 * without a token.
 */

import { ConvexClient, ConvexHttpClient } from "convex/browser";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import type { TokenSource } from "../auth/token-source";
import type { Target } from "./target";

export type Transport = "ws" | "http";

export interface WaitForOptions {
  timeoutMs: number;
  /** What is being waited for, in operator words; it names the timeout. */
  label: string;
  /** http transport only: poll interval (default 1000 ms). */
  pollMs?: number;
}

export class WaitTimeout extends Error {
  readonly label: string;
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number, lastValue: unknown) {
    const seen =
      lastValue === undefined
        ? "no result yet"
        : `last result ${truncate(safeJson(lastValue), 200)}`;
    const secs = timeoutMs < 10_000 ? (timeoutMs / 1000).toFixed(1) : String(Math.round(timeoutMs / 1000));
    super(`Timed out after ${secs}s waiting for ${label} (${seen}).`);
    this.name = "WaitTimeout";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

export interface NbClient {
  readonly target: Target;
  readonly transport: Transport;
  query<Q extends FunctionReference<"query">>(fn: Q, args: FunctionArgs<Q>): Promise<FunctionReturnType<Q>>;
  mutation<M extends FunctionReference<"mutation">>(fn: M, args: FunctionArgs<M>): Promise<FunctionReturnType<M>>;
  action<A extends FunctionReference<"action">>(fn: A, args: FunctionArgs<A>): Promise<FunctionReturnType<A>>;
  /**
   * Resolve with the first result of `fn(args)` that satisfies `predicate`;
   * reject with `WaitTimeout` after `timeoutMs`, or with the query's error.
   */
  waitFor<Q extends FunctionReference<"query">>(
    fn: Q,
    args: FunctionArgs<Q>,
    predicate: (value: FunctionReturnType<Q>) => boolean,
    opts: WaitForOptions,
  ): Promise<FunctionReturnType<Q>>;
  close(): Promise<void>;
}

export interface MakeClientOptions {
  transport?: Transport;
  /** ws only: told when the server accepts (true) or rejects (false) the token. */
  onAuthChange?: (isAuthenticated: boolean) => void;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Errors Convex returns for a token it will not accept. */
const AUTH_REJECTED_RE = /Unauthenticated|InvalidAuthHeader|Could not verify OIDC token|AuthTokenExpired|token.*expired/i;

export function makeClient(
  target: Target,
  tokens: TokenSource,
  opts: MakeClientOptions = {},
): NbClient {
  const transport = opts.transport ?? "ws";
  const skipConvexDeploymentUrlCheck = !new URL(target.convexUrl).hostname.endsWith(".convex.cloud");

  // Kick the first mint off now and make every call wait on it: a bad secret
  // or a refused ticket then fails the call with the real reason.
  const firstToken = tokens.getToken();
  firstToken.catch(() => {
    /* reported by the first call that awaits it */
  });

  if (transport === "http") {
    const http = new ConvexHttpClient(target.convexUrl, { skipConvexDeploymentUrlCheck });

    async function withAuth<T>(run: () => Promise<T>): Promise<T> {
      await firstToken;
      http.setAuth(await tokens.getToken());
      try {
        return await run();
      } catch (err) {
        if (err instanceof Error && AUTH_REJECTED_RE.test(err.message)) {
          // A rejected token means the call did not run; one retry is safe
          // even for a mutation.
          http.setAuth(await tokens.getToken({ forceRefresh: true }));
          return run();
        }
        throw err;
      }
    }

    const client: NbClient = {
      target,
      transport,
      query: (fn, args) => withAuth(() => http.query(fn, ...([args] as [never]))),
      mutation: (fn, args) => withAuth(() => http.mutation(fn, ...([args] as [never]))),
      action: (fn, args) => withAuth(() => http.action(fn, ...([args] as [never]))),
      async waitFor(fn, args, predicate, w) {
        const deadline = Date.now() + w.timeoutMs;
        let last: unknown;
        for (;;) {
          const value = await client.query(fn, args);
          last = value;
          if (predicate(value)) return value;
          if (Date.now() + (w.pollMs ?? 1000) > deadline) throw new WaitTimeout(w.label, w.timeoutMs, last);
          await new Promise((r) => setTimeout(r, w.pollMs ?? 1000));
        }
      },
      close: async () => {},
    };
    return client;
  }

  const ws = new ConvexClient(target.convexUrl, {
    unsavedChangesWarning: false,
    skipConvexDeploymentUrlCheck,
  });
  ws.setAuth(
    async ({ forceRefreshToken }) => {
      try {
        return await tokens.getToken({ forceRefresh: forceRefreshToken });
      } catch {
        // The client treats null as "signed out"; the call that next awaits
        // `firstToken` (or a fresh getToken) carries the real reason.
        return null;
      }
    },
    (ok) => opts.onAuthChange?.(ok),
  );

  return {
    target,
    transport,
    async query(fn, args) {
      await firstToken;
      return ws.query(fn, args);
    },
    async mutation(fn, args) {
      await firstToken;
      return ws.mutation(fn, args);
    },
    async action(fn, args) {
      await firstToken;
      return ws.action(fn, args);
    },
    async waitFor(fn, args, predicate, w) {
      await firstToken;
      return new Promise<FunctionReturnType<typeof fn>>((resolve, reject) => {
        let settled = false;
        let last: unknown;
        let unsubscribe: (() => void) | undefined;
        const finish = (err: unknown, value?: FunctionReturnType<typeof fn>) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe?.();
          if (err) reject(err);
          else resolve(value as FunctionReturnType<typeof fn>);
        };
        const timer = setTimeout(() => finish(new WaitTimeout(w.label, w.timeoutMs, last)), w.timeoutMs);
        const sub = ws.onUpdate(
          fn,
          args,
          (value) => {
            last = value;
            let ok = false;
            try {
              ok = predicate(value);
            } catch (err) {
              finish(err);
              return;
            }
            if (ok) finish(undefined, value);
          },
          (err) => finish(err),
        );
        unsubscribe = () => sub();
        if (settled) sub();
      });
    },
    close: () => ws.close(),
  };
}
