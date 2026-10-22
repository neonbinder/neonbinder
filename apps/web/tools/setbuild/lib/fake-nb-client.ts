/**
 * NEO-339 — a fake `NbClient` for the step tests. No network: every call is
 * dispatched by Convex function name (`module:function`) to a handler the
 * test supplies, and recorded. An unhandled call throws, so a test that
 * forgets to stub a function fails on the name rather than on a symptom.
 *
 * Test-only: imported by `*.test.ts` beside it, never by the tool.
 */

import { getFunctionName, type FunctionReference } from "convex/server";
import { WaitTimeout, type NbClient } from "../client/convex-client";
import type { Target } from "../client/target";

export type Handler = (args: Record<string, unknown>) => unknown;

export interface FakeCall {
  kind: "query" | "mutation" | "action";
  name: string;
  args: Record<string, unknown>;
}

export interface FakeNbClient extends NbClient {
  calls: FakeCall[];
  /** Calls to one function, in order. */
  callsTo(name: string): FakeCall[];
  /** Replace or add a handler mid-test. */
  on(name: string, handler: Handler): void;
}

export const FAKE_TARGET: Target = {
  convexUrl: "https://fake-deployment-123.convex.cloud",
  convexSite: "https://fake-deployment-123.convex.site",
  host: "fake-deployment-123.convex.cloud",
};

export function fakeNbClient(handlers: Record<string, Handler>): FakeNbClient {
  const table = new Map(Object.entries(handlers));
  const calls: FakeCall[] = [];

  async function run(kind: FakeCall["kind"], fn: FunctionReference<typeof kind>, args: unknown) {
    const name = getFunctionName(fn);
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ kind, name, args: a });
    const h = table.get(name);
    if (!h) throw new Error(`fakeNbClient: no handler for ${kind} ${name}`);
    // Clone so a handler's stored state cannot be mutated by the caller.
    return structuredClone(await h(a));
  }

  const client: FakeNbClient = {
    target: FAKE_TARGET,
    transport: "ws",
    calls,
    callsTo: (name) => calls.filter((c) => c.name === name),
    on: (name, handler) => {
      table.set(name, handler);
    },
    query: (fn, args) => run("query", fn, args) as never,
    mutation: (fn, args) => run("mutation", fn, args) as never,
    action: (fn, args) => run("action", fn, args) as never,
    async waitFor(fn, args, predicate, opts) {
      const value = (await run("query", fn, args)) as never;
      if (predicate(value)) return value;
      throw new WaitTimeout(opts.label, opts.timeoutMs, value);
    },
    close: async () => {},
  };
  return client;
}

/** A selectorOptions row as the admin queries return it. Only what the steps read. */
export function row(
  id: string,
  level: string,
  value: string,
  extra: Record<string, unknown> = {},
): { _id: string; _creationTime: number; level: string; value: string; platformData: Record<string, Record<string, string>> } & Record<string, unknown> {
  return { _id: id, _creationTime: 0, level, value, platformData: {}, ...extra };
}

/** The Convex error shape a `ConvexError({ code })` reaches the client as. */
export function convexCodeError(code: string): Error & { data: { code: string } } {
  const err = new Error(`ConvexError: ${code}`) as Error & { data: { code: string } };
  err.data = { code };
  return err;
}
