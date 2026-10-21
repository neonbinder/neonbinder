/**
 * NEO-350 — My Binders (prototype 2, Nine-Pocket, on the consolidated page):
 * the pure half on top of p2's model. Adds what the consolidated page needs
 * and p2 never had: the special shelf's liveries, the Want List's pages,
 * share links, the smart binder's team rule, and the one-match guard for a
 * typed card.
 *
 * Nothing here keys on a display name to decide behaviour: system binders are
 * recognised by `binder.system`, rules name ids, and a name only ever becomes
 * a slug for a link the collector can read.
 */

import {
  copiesOf,
  getCard,
  type BinderId,
  type BinderRule,
  type Card,
  type Copy,
  type SearchHit,
  type TeamId,
} from "../../prototypes/_shared/data";
import {
  binderLivery as p2Livery,
  type Livery,
  type PageModel,
  type PocketModel,
} from "../../prototypes/p2/model";
import type { CollectionBinder } from "../store";

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const EMPTY: PocketModel = { content: { kind: "empty" } };

/** Chop pockets into pages of nine, padding the last with empty sleeves. */
export function paginate(pockets: PocketModel[], section: string | null): PageModel[] {
  const pages: PageModel[] = [];
  for (let i = 0; i < pockets.length; i += 9) {
    const chunk = pockets.slice(i, i + 9);
    while (chunk.length < 9) chunk.push(EMPTY);
    pages.push({ pockets: chunk, section });
  }
  return pages;
}

export interface WantGroup {
  binderId: BinderId | null;
  cards: Card[];
}

/** The section heading over a group of wants. */
export function wantSection(binderId: BinderId | null, nameOf: (id: BinderId) => string | undefined) {
  if (binderId === null) return "Just want it";
  return `For ${nameOf(binderId) ?? "a binder"}`;
}

/**
 * The Want List, opened: one run of pages per group (unscoped wants first,
 * as `wantsByBinder()` orders them), each group starting a fresh page like a
 * new section of a real binder. A want you have since landed shows the card
 * in its sleeve; the rest are "Need" sleeves.
 */
export function wantPages(
  groups: WantGroup[],
  copies: Copy[],
  nameOf: (id: BinderId) => string | undefined,
): PageModel[] {
  const pages: PageModel[] = [];
  for (const group of groups) {
    const pockets = group.cards.map((card): PocketModel => {
      const mine = copiesOf(card.id, copies);
      return {
        content: mine.length ? { kind: "have", card, copies: mine } : { kind: "need", card },
      };
    });
    pages.push(...paginate(pockets, wantSection(group.binderId, nameOf)));
  }
  return pages;
}

/** Every card on the pages, in order, once: what the drawer's ↑ ↓ step through. */
export function cardsOnPages(pages: PageModel[]): string[] {
  const seen = new Set<string>();
  for (const page of pages) {
    for (const { content } of page.pockets) {
      if (content.kind !== "empty") seen.add(content.card.id);
    }
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/** The special shelf's vinyl: picked by role, never by name. */
const SYSTEM_LIVERY: Record<NonNullable<CollectionBinder["system"]>, Livery> = {
  main: { primary: "#14532d", secondary: "#00D558" },
  want: { primary: "#4a0b33", secondary: "#FF2E9A" },
  trade: { primary: "#5c4a00", secondary: "#FFE600" },
};

/** The rule's team, when a smart binder is "a team" (with or without alumni). */
export function ruleTeamId(rule: BinderRule): TeamId | null {
  if (rule.kind === "teamOnCard" || rule.kind === "playedFor") return rule.teamId;
  if (rule.kind === "or") {
    for (const r of rule.rules) {
      const id = ruleTeamId(r);
      if (id) return id;
    }
  }
  return null;
}

export function liveryOf(binder: CollectionBinder | "all"): Livery {
  if (binder === "all") return p2Livery("all");
  if (binder.system) return SYSTEM_LIVERY[binder.system];
  if (binder.kind === "smart") {
    const teamId = ruleTeamId(binder.rule);
    if (teamId && binder.rule.kind === "or") {
      // p2 only knows a bare team rule; hand it the same team.
      return p2Livery({ ...binder, rule: { kind: "teamOnCard", teamId } });
    }
  }
  return p2Livery(binder);
}

// ---------------------------------------------------------------------------
// The smart binder's team rule
// ---------------------------------------------------------------------------

/**
 * "A team" means cards showing the team, in that jersey. Ticking "Also count
 * anyone who played for them" widens it to the team's alumni as well.
 */
export function teamRule(teamId: TeamId, alsoPlayedFor: boolean): BinderRule {
  const onCard: BinderRule = { kind: "teamOnCard", teamId };
  return alsoPlayedFor ? { kind: "or", rules: [onCard, { kind: "playedFor", teamId }] } : onCard;
}

// ---------------------------------------------------------------------------
// Share links (mock: no such route yet)
// ---------------------------------------------------------------------------

/** The collector's public handle. Mock: the real one comes from their profile. */
export const MOCK_HANDLE = "jason";

/** "'96 Contenders" -> "96-contenders", "Ohtani rainbow" -> "ohtani-rainbow". */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "binder";
}

/** A human-readable public link to a binder, or to the Want List. */
export function shareLink(binder: CollectionBinder, handle = MOCK_HANDLE): string {
  if (binder.system === "want") return `neonbinder.io/@${handle}/want-list`;
  return `neonbinder.io/@${handle}/binders/${slugify(binder.name)}`;
}

// ---------------------------------------------------------------------------
// A typed card: act only on exactly one match
// ---------------------------------------------------------------------------

export type TypedCard =
  | { kind: "none" }
  | { kind: "one"; card: Card }
  /** More than one card fits: the collector picks. Never the first. */
  | { kind: "many"; count: number };

/**
 * What Enter in the pack may act on. A card number is not unique (a set has
 * #1 in Base and #1 in every parallel), so a search only resolves to a card
 * when it fits every word AND exactly one card fits.
 */
export function resolveTyped(hits: SearchHit[]): TypedCard {
  const full = hits.filter((h) => h.matchedAll);
  if (full.length === 0) return { kind: "none" };
  if (full.length === 1) return { kind: "one", card: full[0].card };
  return { kind: "many", count: full.length };
}

/** The copy a per-copy pocket holds, so the drawer can ring its line item. */
export function soleCopyId(copies: Copy[]): string | undefined {
  return copies.length === 1 ? copies[0].id : undefined;
}

export { getCard };
