/**
 * NEO-339 — a scripted `NbClient` for the runner's unit tests. No network:
 * every call is answered by a handler registered under the Convex function's
 * name ("selectorOptions:getSelectorOptions"), and every call is recorded so
 * a test can assert exactly what was (and was not) sent.
 *
 * `waitFor` re-asks the handler until the predicate holds, so a handler can
 * model a value that changes over time; it gives up with `WaitTimeout` after
 * `maxPolls` answers.
 */

import { getFunctionName, type FunctionReference } from "convex/server";
import { WaitTimeout, type NbClient } from "../client/convex-client";
import { parseTarget } from "../client/target";

export type CallKind = "query" | "mutation" | "action" | "waitFor";
export interface RecordedCall {
  kind: CallKind;
  fn: string;
  args: Record<string, unknown>;
}
type Handler = (args: Record<string, unknown>, call: number) => unknown;

export interface FakeClient extends NbClient {
  calls: RecordedCall[];
  /** Answer `fn` with a handler (called per call) … */
  on(fn: string, handler: Handler): FakeClient;
  /** … or with a fixed value (a fresh copy per call). */
  on(fn: string, value: unknown): FakeClient;
  /** The mutations and actions sent (the calls that could write). */
  writes(): RecordedCall[];
  callsTo(fn: string): RecordedCall[];
}

export const FAKE_TARGET = parseTarget("https://happy-otter-123.convex.cloud");

export function fakeClient(opts: { maxPolls?: number } = {}): FakeClient {
  const handlers = new Map<string, Handler>();
  const counts = new Map<string, number>();
  const calls: RecordedCall[] = [];
  const answer = (kind: CallKind, fn: unknown, args: unknown) => {
    const name = getFunctionName(fn as FunctionReference<"query">);
    calls.push({ kind, fn: name, args: (args ?? {}) as Record<string, unknown> });
    const h = handlers.get(name);
    if (!h) throw new Error(`fake client: no handler for ${kind} ${name}`);
    const n = counts.get(name) ?? 0;
    counts.set(name, n + 1);
    return h((args ?? {}) as Record<string, unknown>, n);
  };
  const client: FakeClient = {
    target: FAKE_TARGET,
    transport: "ws",
    calls,
    on(fn: string, handler: unknown) {
      handlers.set(fn, typeof handler === "function" ? (handler as Handler) : () => structuredClone(handler));
      return client;
    },
    writes: () => calls.filter((c) => c.kind === "mutation" || c.kind === "action"),
    callsTo: (fn) => calls.filter((c) => c.fn === fn),
    query: async (fn, args) => answer("query", fn, args) as never,
    mutation: async (fn, args) => answer("mutation", fn, args) as never,
    action: async (fn, args) => answer("action", fn, args) as never,
    async waitFor(fn, args, predicate, w) {
      let last: unknown;
      for (let i = 0; i < (opts.maxPolls ?? 20); i++) {
        last = answer("waitFor", fn, args);
        if (predicate(last as never)) return last as never;
      }
      throw new WaitTimeout(w.label, w.timeoutMs, last);
    },
    close: async () => {},
  };
  return client;
}
