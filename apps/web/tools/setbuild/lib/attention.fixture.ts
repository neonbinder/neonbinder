/**
 * NEO-339 — a small set for the attention tests: Base, an Inserts type with
 * one row ("Future Stars") and its parallel ("Gold"), a mutable card store the
 * fake `updateCard` / `confirmCardNoTeam` write into the way the server does,
 * and the reads the listing makes.
 *
 * Test-only: imported by `attention.test.ts` and `attention-answers.test.ts`.
 */

import { ConvexError } from "convex/values";
import type { Id } from "../../../convex/_generated/dataModel";
import type { ResolvedSet } from "../spec/resolve";
import { fakeNbClient, row, type FakeNbClient, type Handler } from "./fake-nb-client";

export const SPORT = "sport-bb";
export const SET: ResolvedSet = {
  sportId: SPORT as never,
  yearId: "year-2014" as never,
  manufacturerId: "mfr-topps" as never,
  setId: "set-chrome" as never,
  rows: {
    sport: row(SPORT, "sport", "Baseball") as never,
    year: row("year-2014", "year", "2014") as never,
    manufacturer: row("mfr-topps", "manufacturer", "Topps") as never,
    set: row("set-chrome", "setName", "Topps Chrome") as never,
  },
};

export const BASE = "vt-base";
export const INSERTS = "vt-ins";
export const FUTURE = "ins-fs";
export const GOLD = "par-gold";

export type Card = Record<string, unknown> & { _id: string; cardNumber: string; cardName: string };

/** A stored card: the identity trio plus whatever the case needs. */
export function card(id: string, cardNumber: string, cardName: string, extra: Record<string, unknown> = {}): Card {
  return {
    _id: id,
    _creationTime: 0,
    selectorOptionId: BASE,
    cardNumber,
    cardName,
    platformData: {},
    sortOrder: 0,
    lastUpdated: 0,
    ...extra,
  };
}

/** A card with a team on it and nothing to ask: never listed. */
export function quiet(id: string, cardNumber: string): Card {
  return card(id, cardNumber, `Quiet ${cardNumber}`, { teamOnCardIds: ["team-x"], listingTitle: `Title ${cardNumber}` });
}

const ID_TEXT = (id: unknown) => String(id);

export interface Store {
  /** Cards per checklist row id. A guest card can sit in two lists (same object). */
  rows: Record<string, Card[]>;
}

/** Apply `updateCard`'s semantics to the stored card (the parts the fixers use). */
function updateCard(store: Store, args: Record<string, unknown>): null {
  const target = Object.values(store.rows).flat().find((c) => c._id === args.id);
  if (!target) throw new ConvexError("updateCard: no such card");
  const { id: _id, ...patch } = args;
  if (typeof patch.listingTitle === "string") {
    const trimmed = patch.listingTitle.trim();
    if (trimmed.length > 80) throw new ConvexError(`Listing title is ${trimmed.length} characters; the limit is 80.`);
    if (trimmed !== target.listingTitle) delete target.listingTitleTruncated;
    patch.listingTitle = trimmed;
  }
  if (Array.isArray(patch.teamOnCardIds) && patch.teamOnCardIds.length > 0) {
    delete target.teamNoneConfirmedAt;
    delete target.pendingTeamNames;
  }
  for (const [k, v] of Object.entries(patch)) {
    if (Array.isArray(v) && v.length === 0) delete target[k];
    else target[k] = v;
  }
  return null;
}

function confirmNoTeam(store: Store, args: Record<string, unknown>) {
  const target = Object.values(store.rows).flat().find((c) => c._id === args.cardId);
  if (!target) return { confirmed: false, stamped: false };
  if (Array.isArray(target.teamOnCardIds) && target.teamOnCardIds.length > 0) return { confirmed: false, stamped: false };
  if (target.teamNoneConfirmedAt) return { confirmed: true, stamped: false };
  target.teamNoneConfirmedAt = 1;
  return { confirmed: true, stamped: true };
}

export interface FixtureOptions {
  store: Store;
  /** Extra or replacement handlers (suggestions, eras, previews, matches…). */
  handlers?: Record<string, Handler>;
}

/** The set's tree, the store, and the two card writes. Everything else comes from `handlers`. */
export function attentionClient({ store, handlers = {} }: FixtureOptions): FakeNbClient {
  const tree: Record<string, ReturnType<typeof row>[]> = {
    [`variantType:${SET.setId}`]: [row(BASE, "variantType", "Base"), row(INSERTS, "variantType", "Inserts")],
    [`insert:${INSERTS}`]: [row(FUTURE, "insert", "Future Stars")],
    [`parallel:${FUTURE}`]: [row(GOLD, "parallel", "Gold")],
  };
  return fakeNbClient({
    "selectorOptions:getSelectorOptions": (a) => tree[`${a.level}:${ID_TEXT(a.parentId)}`] ?? [],
    "selectorOptions:getCardChecklist": (a) => store.rows[ID_TEXT(a.selectorOptionId)] ?? [],
    "selectorOptions:updateCard": (a) => updateCard(store, a),
    "cardChecklist:confirmCardNoTeam": (a) => confirmNoTeam(store, a),
    "cardChecklist:suggestedTeamsForCard": () => [],
    "players:getManyByIds": (a) => (a.ids as string[]).map((id) => ({ _id: id, name: `Player ${id}` })),
    "teams:getManyByIds": (a) => (a.ids as string[]).map((id) => ({ _id: id, name: `Team ${id}` })),
    "teams:erasByNameAndSport": () => [],
    "selectorOptions:previewListingTitle": (a) => ({
      title: `Generated ${ID_TEXT(a.cardId)}`,
      coreFits: true,
      dropped: [],
      inputs: { cardNumber: "1", playerNames: ["Mike Trout"], year: "2014", setName: "Topps Chrome", teamNames: [] },
    }),
    ...handlers,
  });
}

/** An `erasByNameAndSport` row. */
export function era(id: string, name: string, from?: number, to?: number, location?: string) {
  const full = location ? `${location} ${name}` : name;
  const years = from !== undefined ? `${from}–${to ?? "present"}` : "";
  return {
    _id: id as Id<"teams">,
    name,
    ...(location ? { location } : {}),
    ...(from !== undefined ? { yearsActive: { from, ...(to !== undefined ? { to } : {}) } } : {}),
    label: years ? `${full} · ${years}` : full,
  };
}
