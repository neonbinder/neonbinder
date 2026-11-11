import { lazy, Suspense, useContext, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import NoticeLine from "@/app/collection/prototypes/p1/notice";
import { drillToCard } from "@/app/collection/final/catalog/drill";
import { CARD_PARAM, drillToParams, entityToParams, QUERY_PARAM } from "@/app/collection/final/checklistParams";
import { CollectionStoreContext, SideProvider } from "@/app/collection/final/data/store";
import type { Suggestion } from "@/app/collection/final/data/types";
import { isOpen, OpenCardDrawer, useCardDrawer } from "@/app/collection/final/drawerControl";
import { CollectionModeProvider } from "@/app/collection/final/mode";
import { PageApiContext, type ChecklistsTarget, type PageApi } from "@/app/collection/final/pageApi";
import { useFloatingClearance, useStatusLine } from "@/app/collection/final/statusLine";
import { sideHref } from "./bits";
import { heldForCard, PANEL_HELD_PARAM, PANEL_SIDE_PARAM, panelHeld, panelSide } from "./panelLink";

/**
 * NEO-464 — the card panel over the dashboard (see `./panelLink`): the
 * collection page's own card drawer (`app/collection/final/drawerControl`),
 * with its status line and Undo (`app/collection/final/statusLine`), on the
 * dashboard's URL. Loaded only once a card is opened.
 *
 * The store: the signed-in dashboard already holds the Convex collection
 * store (`../page.tsx`), so the panel reads through it, and its writes land
 * on the same live reads the dashboard draws (New Listings shows a new price
 * at once). The logged-out demo holds none: the panel mounts the demo's own
 * store, saved under the demo's key, so what is changed here shows on the
 * demo's Collection and Inventory too. That store is loaded only on the demo
 * path (`DemoPanelStore`), so the signed-in panel never fetches it.
 *
 * The panel's side comes from the link (`side=inventory`), so the add form
 * offers boxes for stock and binders for pulls. A held-back card's reason
 * (`held=`) comes the same way: the panel says it and puts the keyboard on
 * the fix; ↑ ↓ carry each held-back card's own reason, and Close drops it. Its ways out to Checklists (a
 * search pick, a card's checklist) go to Collection, a page of their own:
 * Back comes back to the dashboard with the panel open.
 */
export default function CardPanelHost() {
  const mounted = useContext(CollectionStoreContext);
  const host = (
    <CollectionModeProvider mode="app">
      <PanelOverDashboard />
    </CollectionModeProvider>
  );
  if (mounted) return host;
  return (
    <Suspense fallback={null}>
      <DemoPanelStore>{host}</DemoPanelStore>
    </Suspense>
  );
}

/** The logged-out demo's own store, under the demo's key: fetched only when the demo opens a card. */
const DemoPanelStore = lazy(async () => {
  const { DemoCollectionProvider, PUBLIC_STORAGE_KEY } = await import("@/app/collection/final/data/demoStore");
  return {
    default: function DemoPanelStore({ children }: { children: ReactNode }) {
      return <DemoCollectionProvider storageKey={PUBLIC_STORAGE_KEY}>{children}</DemoCollectionProvider>;
    },
  };
});

/** Where Checklists opens on Collection for a target the panel asked for. */
export function checklistsQuery(target: ChecklistsTarget): Record<string, string> {
  if ("card" in target) {
    return { tab: "checklists", ...drillToParams(drillToCard(target.card)), [CARD_PARAM]: target.card.id };
  }
  if ("cardId" in target) return { tab: "checklists", [CARD_PARAM]: target.cardId };
  if ("setId" in target) return { tab: "checklists", set: target.setId };
  if ("entity" in target) return { tab: "checklists", ...entityToParams(target.entity) };
  return target.q ? { tab: "checklists", [QUERY_PARAM]: target.q } : { tab: "checklists" };
}

/** A picked search suggestion, as a Checklists target: a player's or team's cards, or a set's checklist. */
export function suggestionTarget(s: Suggestion): ChecklistsTarget {
  if (s.kind === "player") return { entity: { kind: "player", id: s.id } };
  if (s.kind === "team") {
    return {
      entity: { kind: "team", id: s.id, franchiseId: s.franchise?.id ?? null, wholeFranchise: false },
    };
  }
  return { setId: s.id };
}

function PanelOverDashboard() {
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const line = useStatusLine();
  const control = useCardDrawer(params, {
    closeParams: [PANEL_SIDE_PARAM, PANEL_HELD_PARAM],
    onCardChange: heldForCard,
  });
  // With the panel shut, the status line floats over the page, as on Collection.
  useFloatingClearance(line.notice !== null && !control.drawer);

  const goToChecklists = (target: ChecklistsTarget = {}) => {
    void navigate(sideHref(pathname, "collection", checklistsQuery(target)));
  };
  const pageApi: PageApi = {
    openCard: control.openCard,
    goToChecklists,
    openSuggestion: (s) => goToChecklists(suggestionTarget(s)),
    notify: line.notify,
    inform: line.inform,
    undoLast: line.undoLast,
    run: line.run,
  };

  return (
    <PageApiContext.Provider value={pageApi}>
      <SideProvider value={panelSide(params)}>
        {isOpen(control) ? (
          <OpenCardDrawer control={control} line={line} held={panelHeld(params)} />
        ) : (
          <NoticeLine notice={line.notice} onUndo={line.undo} onDismiss={line.dismiss} floating />
        )}
      </SideProvider>
    </PageApiContext.Provider>
  );
}
