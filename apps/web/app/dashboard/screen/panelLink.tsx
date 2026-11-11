import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import type { DrawerHistoryState } from "@/app/collection/final/drawerControl";
import { DRAWER_MODE_PARAM, DRAWER_PARAM } from "@/app/collection/final/drawerParams";
import type { CardId, Side } from "@/app/collection/final/data/types";

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

/** The side a dashboard URL opens its card panel on. */
export function panelSide(params: URLSearchParams): Side {
  return params.get(PANEL_SIDE_PARAM) === "inventory" ? "inventory" : "collection";
}

/**
 * The dashboard's search with `cardId`'s panel open on `side`: the view
 * under it (an open binder, its page, a disclosure) kept as it is.
 */
export function cardPanelSearch(search: string, cardId: CardId, side: Side): string {
  const p = new URLSearchParams(search);
  p.set(DRAWER_PARAM, cardId);
  p.delete(DRAWER_MODE_PARAM);
  if (side === "inventory") p.set(PANEL_SIDE_PARAM, "inventory");
  else p.delete(PANEL_SIDE_PARAM);
  return `?${p.toString()}`;
}

/** A link that opens `cardId`'s panel over the dashboard. Its words are the caller's. */
export function PanelLink({
  cardId,
  side,
  className,
  children,
}: {
  cardId: CardId;
  side: Side;
  className?: string;
  children: ReactNode;
}) {
  const { pathname, search } = useLocation();
  return (
    <Link
      to={{ pathname, search: cardPanelSearch(search, cardId, side) }}
      // The drawer pushed this entry: Close steps Back off it, as on Collection.
      state={{ drawer: true } satisfies DrawerHistoryState}
      onPointerEnter={preloadCardPanel}
      onFocus={preloadCardPanel}
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
