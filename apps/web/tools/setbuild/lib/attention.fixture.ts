/**
 * NEO-339 — a small set for the attention tests: Base, an Inserts type with
 * one row ("Future Stars") and its parallel ("Gold"), a mutable card store the
 * fake `updateCard` / `confirmCardNoTeam` / `confirmCardNoPlayer` (NEO-339)
 * write into the way the server does,
 * the rows' own `features` (NEO-345 `autographFormat`) with the header
 * prompt's `setAutographFormat`, its reach onto Future Stars' parallel and its
 * scheduled carry-over to the cards, and
 * the reads the listing makes.
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

/** A card with a player and a team on it and nothing to ask: never listed. */
export function quiet(id: string, cardNumber: string): Card {
  return card(id, cardNumber, `Quiet ${cardNumber}`, {
    playerIds: [`player-${id}`],
    teamOnCardIds: ["team-x"],
    listingTitle: `Title ${cardNumber}`,
  });
}

const ID_TEXT = (id: unknown) => String(id);

export interface Store {
  /** Cards per checklist row id. A guest card can sit in two lists (same object). */
  rows: Record<string, Card[]>;
  /** NEO-345: each tree row's own `features` (Base, Future Stars, Gold), keyed by row id. */
  leafFeatures?: Record<string, Record<string, string>>;
}

/**
 * NEO-345 — the server's carry-over of a row's new format onto its OWN AU
 * cards still "None" (a guest's home is elsewhere), as `cascadeAutographFormat`
 * does in its scheduled walk.
 */
export function cascade(store: Store, rowId: string): void {
  const format = store.leafFeatures?.[rowId]?.autographFormat;
  if (!format) return;
  for (const c of store.rows[rowId] ?? []) {
    const attrs = (c.attributes as string[] | undefined) ?? [];
    const features = (c.features as Record<string, string> | undefined) ?? {};
    if (c.isCrossListed || !attrs.some((a) => a.trim().toUpperCase() === "AU")) continue;
    if ((features.autographed ?? "None") !== "None") continue;
    c.features = { ...features, autographed: format };
  }
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
  // NEO-339: a non-empty player write retires "No player on this card".
  if (Array.isArray(patch.playerIds) && patch.playerIds.length > 0) {
    delete target.playerNoneConfirmedAt;
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

/** NEO-339 — `confirmCardNoPlayer`: refused once the card names a player. */
function confirmNoPlayer(store: Store, args: Record<string, unknown>) {
  const target = Object.values(store.rows).flat().find((c) => c._id === args.cardId);
  if (!target) return { confirmed: false, stamped: false };
  const named = (k: string) => Array.isArray(target[k]) && (target[k] as unknown[]).length > 0;
  if (named("playerIds") || named("pendingPlayerNames")) return { confirmed: false, stamped: false };
  if (target.playerNoneConfirmedAt) return { confirmed: true, stamped: false };
  target.playerNoneConfirmedAt = 1;
  return { confirmed: true, stamped: true };
}

export interface FixtureOptions {
  store: Store;
  /**
   * NEO-345: when `setAutographFormat`'s scheduled walk lands: "now" (before
   * the next read, the default), after this many `getCardChecklist` reads of
   * the row, or "never" (the wait runs out).
   */
  cascadeAfter?: "now" | number | "never";
  /** Extra or replacement handlers (suggestions, eras, previews, matches…). */
  handlers?: Record<string, Handler>;
}

/** The set's tree, the store, and the two card writes. Everything else comes from `handlers`. */
export function attentionClient({ store, handlers = {}, cascadeAfter = "now" }: FixtureOptions): FakeNbClient {
  const withFeatures = (id: string, level: string, value: string) => {
    const features = store.leafFeatures?.[id];
    return row(id, level, value, features ? { features } : {});
  };
  const tree = (): Record<string, ReturnType<typeof row>[]> => ({
    [`variantType:${SET.setId}`]: [withFeatures(BASE, "variantType", "Base"), withFeatures(INSERTS, "variantType", "Inserts")],
    [`insert:${INSERTS}`]: [withFeatures(FUTURE, "insert", "Future Stars")],
    [`parallel:${FUTURE}`]: [withFeatures(GOLD, "parallel", "Gold")],
  });
  const LEVELS: Record<string, [string, string]> = {
    [BASE]: ["variantType", "Base"],
    [INSERTS]: ["variantType", "Inserts"],
    [FUTURE]: ["insert", "Future Stars"],
    [GOLD]: ["parallel", "Gold"],
  };
  /** Rows whose walk is scheduled, with the reads left before it lands. */
  const scheduled = new Map<string, number>();
  return fakeNbClient({
    "selectorOptions:getSelectorOptions": (a) => tree()[`${a.level}:${ID_TEXT(a.parentId)}`] ?? [],
    // The type's inserts with their grouped parallels (the shared row resolution reads it on a miss).
    "selectorOptions:getInsertTreeByVariantType": (a) =>
      (tree()[`insert:${ID_TEXT(a.variantTypeId)}`] ?? []).map((insert) => ({ insert, parallels: tree()[`parallel:${insert._id}`] ?? [] })),
    "selectorOptions:getSelectorOptionById": (a) => {
      const at = LEVELS[ID_TEXT(a.id)];
      return at ? withFeatures(ID_TEXT(a.id), at[0], at[1]) : null;
    },
    "autographFormat:setAutographFormat": (a) => {
      const id = ID_TEXT(a.selectorOptionId);
      if (!LEVELS[id] || id === INSERTS) throw new ConvexError("An autograph format goes on a base, insert or parallel.");
      const value = String(a.value);
      const setFormat = (rowId: string) => {
        store.leafFeatures = { ...(store.leafFeatures ?? {}), [rowId]: { ...(store.leafFeatures?.[rowId] ?? {}), autographFormat: value } };
      };
      setFormat(id);
      // The server's reach onto the row's parallels (Jason, 2026-10-18): Gold
      // takes Future Stars' answer while its own format is unset, or is walked
      // again when it already holds the same one; a different one is kept.
      const parallelIds: string[] = [];
      if (id === FUTURE) {
        const own = store.leafFeatures?.[GOLD]?.autographFormat;
        if (own === undefined) setFormat(GOLD);
        if (own === undefined || own === value) parallelIds.push(GOLD);
      }
      for (const rowId of [id, ...parallelIds]) {
        if (cascadeAfter === "now") cascade(store, rowId);
        else if (cascadeAfter !== "never") scheduled.set(rowId, cascadeAfter);
      }
      return { parallelIds };
    },
    "selectorOptions:getCardChecklist": (a) => {
      const id = ID_TEXT(a.selectorOptionId);
      const left = scheduled.get(id);
      if (left !== undefined) {
        if (left <= 0) {
          cascade(store, id);
          scheduled.delete(id);
        } else scheduled.set(id, left - 1);
      }
      return store.rows[id] ?? [];
    },
    "selectorOptions:updateCard": (a) => updateCard(store, a),
    "cardChecklist:confirmCardNoTeam": (a) => confirmNoTeam(store, a),
    "cardChecklist:confirmCardNoPlayer": (a) => confirmNoPlayer(store, a),
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
