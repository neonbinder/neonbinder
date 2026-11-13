import { createContext, useContext } from "react";
import type { Marketplace } from "../dash-labels";

/**
 * NEO-536 — what is open between a collector and the crew (NB's admin team),
 * as the dashboard draws it: the collector's own open asks ("With our crew")
 * and, for an admin, every collector's ("From collectors"), plus the two
 * actions on a held-back set (report it, withdraw a report).
 *
 * Only the signed-in page supplies it (`../real/useCrewDesk`, through
 * `CrewProvider`). The logged-out demo has no crew: with none, Sync status
 * draws no Report button and the crew section draws nothing, so the demo
 * screen is exactly what it was. Pure of Convex: ids are strings here, and a
 * failed call comes back as the sentence to show.
 */

export type CrewAskKind = "card" | "set" | "report";

/** One open ask on one line. */
export interface CrewAsk {
  id: string;
  kind: CrewAskKind;
  /** NB's own name for what was asked about: the card, the set, or the held-back set. */
  label: string;
  /** For a sync report: the marketplace its set is held back from. */
  platform?: Marketplace;
  /** When it was asked, for the order (ms). */
  at: number;
  /** For a sync report the admin sees: other collectors with the same set open, to `SYNC_REPORT_GROUP_COUNT_CAP`. */
  alsoReportedBy?: number;
}

export interface CrewDeskData {
  /** The collector's open asks, newest first. */
  mine: CrewAsk[];
  /** Open asks past `mine` (the totals say how many). */
  mineMore: number;
  /** For an admin: every collector's open asks, oldest first; null for anyone else (or while it loads). */
  waiting: CrewAsk[] | null;
  /** More are waiting than `waiting` names. */
  waitingMore: boolean;
}

export interface Crew {
  /** Undefined while the reads settle. */
  desk: CrewDeskData | undefined;
  /** Has the collector an open report on this set and marketplace? */
  isReported(variantId: string, platform: Marketplace): boolean;
  /** Report a held-back set. Resolves to null when it went through, or the sentence saying why not. */
  report(input: { variantId: string; platform: Marketplace; note: string }): Promise<string | null>;
  /** Withdraw one of the collector's open reports. Null when done, or why not. */
  withdraw(reportId: string): Promise<string | null>;
}

const CrewContext = createContext<Crew | null>(null);

export const CrewProvider = CrewContext.Provider;

/** The crew, or null on a page that has none (the demo). */
export function useCrew(): Crew | null {
  return useContext(CrewContext);
}

/** Where the collector's whole list of asks lives (Collection → Checklists → My requests). */
export const MY_REQUESTS_HREF = "/collection?tab=checklists&ask=mine";

/** Where an admin reviews the asks. */
export const ADMIN_REQUESTS_HREF = "/admin/card-requests";

/** The admin review of one ask: a card or set request by its id, a sync report on the sync list. */
export function adminAskHref(ask: Pick<CrewAsk, "id" | "kind">): string {
  const query = new URLSearchParams(ask.kind === "report" ? { kind: "sync", open: ask.id } : { open: ask.id });
  return `${ADMIN_REQUESTS_HREF}?${query}`;
}

/** What each kind of ask reads as on its line. */
export const ASK_KIND_LABEL: Record<CrewAskKind, string> = {
  card: "Card request",
  set: "Set request",
  report: "Sync report",
};

/** Asks from collectors the admin list draws (oldest first); the rest are counted. */
export const WAITING_SHOWN = 8;
