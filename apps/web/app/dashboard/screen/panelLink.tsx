import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import type { DrawerHistoryState } from "@/app/collection/final/drawerControl";
import { DRAWER_MODE_PARAM, DRAWER_PARAM } from "@/app/collection/final/drawerParams";
import type { HeldBack } from "@/app/collection/final/CardDetail";
import type { CardId, ListingProblemReason, Side } from "@/app/collection/final/data/types";
import { PROBLEM_COPY } from "@/app/collection/final/inventory/listing/copy";
import type { Marketplace } from "../dash-labels";

/**
 * NEO-464 — a card on the dashboard opens its card panel OVER the dashboard
 * (Jason, 2026-11-11), the same panel Collection and Inventory open: its
 * price, photos and copies are fixed right there, and Back (or Close, or
 * Escape) puts the dashboard back as it was, the keyboard on the card that
 * opened it.
 *
 * The panel rides on the dashboard's own URL, as the drawer does on
 * Collection (`app/collection/final/drawerParams`): `detail=<card>`, and
 * `side=inventory` when the card was opened as stock for sale (a held-back
 * card, a new listing, an order's card), so its add form offers boxes; a
 * card opened as a pull (Fresh Pulls) offers binders. Every card link is a
 * real link: a click pushes (Back closes it), and a new tab or a refresh
 * opens the same panel.
 *
 * Nothing loads until a card is opened: no panel code and no store reads on a
 * plain dashboard visit (`DashboardCardPanel`). The panel's code is fetched
 * ahead when the pointer or the keyboard reaches a card link.
 */

/** The panel's side on the dashboard URL: `inventory`, or absent for the collection. */
export const PANEL_SIDE_PARAM = "side";

/**
 * Why the card the panel opened on was held back from a sync, on the
 * dashboard URL: `held=<platform>.<reason>` ("ebay.noPhoto"). Set by a
 * held-back card on Sync status, so the panel says why above "Your copies"
 * and puts the keyboard on the control that fixes it. It belongs to that one
 * card: ↑ ↓ and Close take it off.
 */
export const PANEL_HELD_PARAM = "held";

/** A held-back card's reason, as the panel takes it. */
export type HeldReason = HeldBack;

/** A reason as the URL and the history entry carry it: "ebay.noPhoto". */
function heldValue(held: HeldReason): string {
  return `${held.platform}.${held.reason}`;
}

/** The reason a held-back card carries into its panel; none for a marketplace that does not list, or no code. */
export function heldOf(marketplace: Marketplace, code: ListingProblemReason | undefined): HeldReason | undefined {
  if (!code || (marketplace !== "bsc" && marketplace !== "ebay")) return undefined;
  return { platform: marketplace, reason: code };
}

/** The reason on a dashboard URL, or null when it names none (or one this build doesn't know). */
export function panelHeld(params: URLSearchParams): HeldReason | null {
  return parseHeld(params.get(PANEL_HELD_PARAM));
}

function parseHeld(value: string | null | undefined): HeldReason | null {
  const [platform, reason] = (value ?? "").split(".");
  if (platform !== "bsc" && platform !== "ebay") return null;
  if (!reason || !Object.hasOwn(PROBLEM_COPY, reason)) return null;
  return { platform, reason: reason as ListingProblemReason };
}

/** The side a dashboard URL opens its card panel on. */
export function panelSide(params: URLSearchParams): Side {
  return params.get(PANEL_SIDE_PARAM) === "inventory" ? "inventory" : "collection";
}

/**
 * The dashboard's search with `cardId`'s panel open on `side`: the view
 * under it (an open binder, its page, a disclosure) kept as it is.
 */
export function cardPanelSearch(search: string, cardId: CardId, side: Side, held?: HeldReason): string {
  const p = new URLSearchParams(search);
  p.set(DRAWER_PARAM, cardId);
  p.delete(DRAWER_MODE_PARAM);
  if (side === "inventory") p.set(PANEL_SIDE_PARAM, "inventory");
  else p.delete(PANEL_SIDE_PARAM);
  if (held) p.set(PANEL_HELD_PARAM, heldValue(held));
  else p.delete(PANEL_HELD_PARAM);
  return `?${p.toString()}`;
}

/**
 * As ↑ ↓ (or a pick inside the panel) swap the card in place: the new card's
 * own held-back reason, from the history entry the held-back card's link
 * pushed (`DrawerHistoryState.held`), else none.
 */
export function heldForCard(params: URLSearchParams, cardId: CardId, state: unknown): void {
  const map = (state as DrawerHistoryState | null)?.held;
  const held = map && typeof map === "object" ? parseHeld(map[cardId]) : null;
  if (held) params.set(PANEL_HELD_PARAM, heldValue(held));
  else params.delete(PANEL_HELD_PARAM);
}

/**
 * A link that opens `cardId`'s panel over the dashboard. Its words are the
 * caller's. `list` is the run of cards it sits in (a batch of pulls, a
 * held-back set, the chase), so the panel's ↑ ↓ step through it, as on
 * Collection; without one, or opened in a new tab, the panel holds just this
 * card.
 */
export function PanelLink({
  cardId,
  side,
  list,
  held,
  heldList,
  twin = false,
  className,
  children,
}: {
  cardId: CardId;
  side: Side;
  list?: readonly CardId[];
  /** A held-back card: why, so the panel says it and puts the keyboard on the fix. */
  held?: HeldReason;
  /** Every held-back card's reason in `list`, so ↑ ↓ in the panel carry each one's own. */
  heldList?: ReadonlyMap<CardId, HeldReason>;
  /**
   * A picture beside the card's own link (an order's thumbnail): it opens
   * the same panel for a pointer, but is hidden from a reader and out of the
   * Tab order, so the card is one stop and named once.
   */
  twin?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { pathname, search } = useLocation();
  const state: DrawerHistoryState = { drawer: true };
  if (list && list.length > 1 && list.includes(cardId)) {
    state.list = [...new Set(list)];
    if (heldList && heldList.size > 0) {
      state.held = Object.fromEntries([...heldList].map(([id, h]) => [id, heldValue(h)]));
    }
  }
  return (
    <Link
      to={{ pathname, search: cardPanelSearch(search, cardId, side, held) }}
      // The drawer pushed this entry: Close steps Back off it, as on Collection.
      state={state}
      onPointerEnter={preloadCardPanel}
      onFocus={preloadCardPanel}
      {...(twin ? { tabIndex: -1, "aria-hidden": true } : {})}
      className={className}
    >
      {children}
    </Link>
  );
}

let hostModule: Promise<typeof import("./CardPanelHost")> | null = null;
function loadHost() {
  hostModule ??= import("./CardPanelHost");
  return hostModule;
}

/** Fetches the panel's code ahead of a click (a card link reached). Loads no data. */
export function preloadCardPanel(): void {
  void loadHost();
}

const CardPanelHost = lazy(loadHost);

/**
 * The card panel over the dashboard, mounted the first time the URL names a
 * card (a click, a refresh, a shared link) and kept from then on, so the
 * status line with its Undo outlives Close as it does on Collection. Until
 * then nothing is mounted: the plain dashboard reads nothing for it.
 */
export function DashboardCardPanel() {
  const [params] = useSearchParams();
  const asked = params.has(DRAWER_PARAM);
  const [armed, setArmed] = useState(asked);
  if (asked && !armed) setArmed(true);
  if (!armed) return null;
  return (
    <Suspense fallback={null}>
      <CardPanelHost />
    </Suspense>
  );
}
