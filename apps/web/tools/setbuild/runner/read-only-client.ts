/**
 * NEO-339 — the client `plan` runs on: queries pass through, every mutation
 * is refused, and an action passes only when it is a known MARKETPLACE READ.
 *
 * `plan` runs the very step functions `apply` runs, on this client. Where a
 * step would write, the refusal (`PlanWouldWrite`) is the answer: everything
 * before the write resolved, so the step is "todo". That makes "plan is
 * read-only on NB data" a property of the wrapper rather than of every step
 * remembering to check a flag.
 */

import { getFunctionName, type FunctionReference } from "convex/server";
import type { NbClient } from "../client/convex-client";

/**
 * Actions that read a marketplace and write nothing to NB: the Base and
 * variant candidate fetch (`fetchRawOptions`). Nothing else is let through.
 */
export const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set(["setReconciliation:fetchRawOptions"]);

/** The write a plan step stopped at. Not an error: it means "apply would do this". */
export class PlanWouldWrite extends Error {
  readonly fn: string;
  constructor(fn: string) {
    super(`plan stops before ${fn}, which writes.`);
    this.name = "PlanWouldWrite";
    this.fn = fn;
  }
}

export function readOnlyClient(inner: NbClient): NbClient {
  return {
    target: inner.target,
    transport: inner.transport,
    query: (fn, args) => inner.query(fn, args),
    waitFor: (fn, args, predicate, opts) => inner.waitFor(fn, args, predicate, opts),
    mutation: async (fn) => {
      throw new PlanWouldWrite(getFunctionName(fn as FunctionReference<"mutation">));
    },
    action: async (fn, args) => {
      const name = getFunctionName(fn as FunctionReference<"action">);
      if (!READ_ONLY_ACTIONS.has(name)) throw new PlanWouldWrite(name);
      return inner.action(fn, args);
    },
    // The plan does not own the connection.
    close: async () => {},
  };
}
