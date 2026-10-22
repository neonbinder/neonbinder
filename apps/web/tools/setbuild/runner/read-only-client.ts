/**
 * NEO-339 — the read-only clients.
 *
 * `queryOnlyClient` is what `inspect` and `reviewItems` run on: queries (and
 * query subscriptions) pass through, every mutation and every action throws
 * before it is sent. Those reads need nothing else, so nothing else is let
 * through, and "read tools never write" holds by construction.
 *
 * `readOnlyClient` is the client `plan` runs on: queries pass through, every
 * mutation is refused, and an action passes only when it is a known
 * MARKETPLACE READ.
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

/**
 * What `nb_draft_set` may run: `READ_ONLY_ACTIONS` plus exactly the two
 * read-only preview actions (NEO-339 part B). Never `fetchCardChecklist`
 * (it stages candidate rows) or `resolveChecklistEntities` (it opens a review
 * batch). The third preview, `previewChecklistEntities`, is a query and needs
 * no entry. Read-only on NB data; a marketplace adapter may still refresh its
 * session, as any fetch does.
 */
export const DRAFT_READ_ACTIONS: ReadonlySet<string> = new Set([
  ...READ_ONLY_ACTIONS,
  "setReconciliation:previewSetStructure",
  "selectorOptions:previewCardChecklist",
]);

/** The write a plan step stopped at. Not an error: it means "apply would do this". */
export class PlanWouldWrite extends Error {
  readonly fn: string;
  constructor(fn: string) {
    super(`plan stops before ${fn}, which writes.`);
    this.name = "PlanWouldWrite";
    this.fn = fn;
  }
}

/**
 * Queries pass; every mutation is refused; an action passes only when it is in
 * `allowed` (default `READ_ONLY_ACTIONS`). An empty set refuses every action.
 */
export function readOnlyClient(inner: NbClient, allowed: ReadonlySet<string> = READ_ONLY_ACTIONS): NbClient {
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
      if (!allowed.has(name)) throw new PlanWouldWrite(name);
      return inner.action(fn, args);
    },
    // The plan does not own the connection.
    close: async () => {},
  };
}

/** The client `nb_draft_set` drafts on: `readOnlyClient` over `DRAFT_READ_ACTIONS`. */
export function draftClient(inner: NbClient): NbClient {
  return readOnlyClient(inner, DRAFT_READ_ACTIONS);
}

/** A mutation or action attempted through `queryOnlyClient`. */
export class ReadOnlyViolation extends Error {
  readonly fn: string;
  constructor(kind: "mutation" | "action", fn: string) {
    super(`A read-only call tried to run the ${kind} ${fn}; reads send queries only.`);
    this.name = "ReadOnlyViolation";
    this.fn = fn;
  }
}

export function queryOnlyClient(inner: NbClient): NbClient {
  return {
    target: inner.target,
    transport: inner.transport,
    query: (fn, args) => inner.query(fn, args),
    waitFor: (fn, args, predicate, opts) => inner.waitFor(fn, args, predicate, opts),
    mutation: async (fn) => {
      throw new ReadOnlyViolation("mutation", getFunctionName(fn as FunctionReference<"mutation">));
    },
    action: async (fn) => {
      throw new ReadOnlyViolation("action", getFunctionName(fn as FunctionReference<"action">));
    },
    // The reader does not own the connection.
    close: async () => {},
  };
}
