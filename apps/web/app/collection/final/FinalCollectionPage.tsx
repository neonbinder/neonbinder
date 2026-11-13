import {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigationType } from "react-router";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import NoticeLine from "../prototypes/p1/notice";
import { isOpen, OpenCardDrawer, useCardDrawer } from "./drawerControl";
import type { RowActions } from "./CardRows";
import { drillToCard, EMPTY_DRILL, type Drill } from "./catalog/drill";
import { useDrillState } from "./catalog/useDrillState";
import {
  CARD_PARAM,
  drillFromParams,
  drillToParams,
  entityFromParams,
  entityToParams,
  FRANCHISE_PARAM,
  PLAYER_PARAM,
  QUERY_PARAM,
  sameDrill,
  TEAM_PARAM,
  WHOLE_PARAM,
  type EntityParam,
} from "./checklistParams";
import ChecklistsTab from "./ChecklistsTab";
import { DemoBar, DemoRail } from "./DemoChrome";
import { SkeletonBars } from "./catalog/Skeleton";
// Add cards loads only when opened: the demo's scripted pile (NEO-369), or
// the signed-in screen on the real pipeline (NEO-382).
const AddCardsTab = lazy(() => import("./intake/AddCardsTab"));
const RealAddCardsTab = lazy(() => import("./intake/RealAddCardsTab"));
import { DemoCollectionProvider, PUBLIC_STORAGE_KEY } from "./data/demoStore";
import { setLabel, shortCardName } from "./data/labels";
import {
  CollectionStoreContext,
  SideProvider,
  useCard,
  useCollectionActions,
  useCollectionStore,
  useContainers,
  useReadOnlyAll,
  useScope,
  useSetPath,
  useWants,
  wantToggle,
} from "./data/store";
import type {
  Capabilities,
  Card,
  CardId,
  CollectionTab,
  Container,
  Scope,
  Side,
  Suggestion,
  Want,
} from "./data/types";
import { useHomeName, useScopedName } from "./catalog/home";
import { viewOf } from "./drawerParams";
import InventoryListTab from "./inventory/InventoryListTab";
// The Sales and Sync status tabs (NEO-370) load only when opened.
const SalesTab = lazy(() => import("./inventory/listing/SalesTab"));
const SyncStatusTab = lazy(() => import("./inventory/listing/SyncStatusTab"));
// NEO-500 — the Pick List: the demo's fixture, or the signed-in seller's
// orders through the Convex store mounted around it.
const PickListTab = lazy(() => import("./pick/PickListTab"));
const ConvexPickListTab = lazy(() =>
  import("./pick/convexPickStore").then(({ ConvexPickListProvider }) => ({
    default: (props: { onTitleDetail: (detail: string | null) => void }) => (
      <ConvexPickListProvider>
        <PickListTab {...props} />
      </ConvexPickListProvider>
    ),
  })),
);
// The inventory Checklists' target box (`box=`, NEO-364 D8): replaced in
// place by the picker, carried here on each drill step within Checklists
// like the scope, and dropped on a tab change (the Inventory list's rail
// uses `box=` too, and neither may become the other's).
import { TARGET_BOX_PARAM } from "./inventory/targetBox";
import { lineSummary } from "./lineItems";
import MyBindersTab from "./MyBindersTab";
import MyCardsTab from "./MyCardsTab";
import {
  CollectionModeProvider,
  ParamLink,
  SCOPE_PARAM,
  scopeFromParams,
  SIDE_PARAM,
  takeSideArrival,
  useCollectionMode,
  useCollectionParams,
  useCollectionSide,
  useGoToSide,
  useReplaceParams,
  useSetScope,
  ViewScopeProvider,
  type CollectionMode,
} from "./mode";
import {
  PageApiContext,
  type ChecklistsTarget,
  type PageApi,
} from "./pageApi";
import { useFloatingClearance, useStatusLine } from "./statusLine";
import type { GoToTabParams } from "./store";

/**
 * NEO-350 / NEO-358 — the collection page: the signed-in collector's real
 * collection at `/collection`, and the hard-coded marketing demo on
 * `/binder-tracking`. One page, two stores (see `./data/store`):
 *
 * - `/collection` (`../page.tsx`) mounts it inside `ConvexCollectionProvider`:
 *   the real catalog and the collector's own copies, binders and boxes,
 *   wants and trade (NEO-359), with what has not shipped yet switched off
 *   (smart binders, share links, card requests, the demo bar).
 * - The public demo (`./PublicCollectionDemo`) mounts it inside
 *   `DemoCollectionProvider`: fixture data, every capability on. It never
 *   reaches Convex or Clerk. Mounted with no provider at all (a unit test),
 *   the page runs on the demo store.
 *
 * Two sides, one page (NEO-364; hard line: Collection = Binders, Inventory
 * = Boxes). `surface` (the app's route; the demo's `side=` param, see
 * `./mode`) picks the side, which goes in `SideProvider` for every view and
 * the store's side-aware reads:
 *
 * - The collection (`/collection`, h1 "Collection"): My Cards, My Binders
 *   (where the store has binders) and Checklists. No inventory tab.
 * - The inventory (`/inventory`, h1 "Inventory"): Inventory (the list,
 *   `tab=cards`, the default), My Boxes (`tab=boxes`) and Checklists (quick
 *   quantity entry into a target box, `box=`).
 *
 * Tabs on `?tab=`, drawn like the admin section strip, sharing one status
 * line with Undo and one right-side card drawer opened through `openCard`.
 * Every tab reads the store's hooks, so the demo and the real collection
 * run the same views.
 *
 * The scope (the "Binder: [All ▾]" pick, `scope=` on the URL) is read here
 * against the shelf and put in `ViewScopeProvider`, where both stores and
 * every view read it.
 *
 * `mode` (see `./mode`) is WHERE the page runs, not which store: `"app"`
 * (default) is the signed-in binder shell, `"public"` the marketing page with
 * its own persist key, public destinations and the demo's exits.
 *
 * My Boxes is the same desk as My Binders (`MyBindersTab` with
 * `surface="inventory"`), and the inventory never narrows by the Binder
 * picker. Jason: "Inventory is things for sale and My Collection is things
 * that are for your collection. They should not mix on the screens." The
 * old `tab=inventory` (and `sale=1`) links redirect to the inventory, in
 * place of the entry.
 */

interface TabDef {
  key: CollectionTab;
  label: string;
  needs?: keyof Capabilities;
}

const TABS: Record<Side, TabDef[]> = {
  collection: [
    { key: "cards", label: "My Cards" },
    { key: "binders", label: "My Binders", needs: "binders" },
    { key: "checklists", label: "Checklists" },
    { key: "add", label: "Add cards", needs: "intake" },
  ],
  inventory: [
    { key: "cards", label: "Inventory" },
    { key: "boxes", label: "My Boxes" },
    { key: "checklists", label: "Checklists" },
    { key: "add", label: "Add cards", needs: "intake" },
    { key: "pick", label: "Pick List", needs: "pickList" },
    // NEO-370 — orders from the marketplaces the collector lists on.
    { key: "sales", label: "Sales", needs: "marketplaceListing" },
    // NEO-370 Rev 4 — what is syncing, what waits, and each set's last result.
    { key: "sync", label: "Sync status", needs: "marketplaceListing" },
  ],
};

/** What each side's page is called: its h1, and the last words of its title. */
const SIDE_TITLE: Record<Side, string> = { collection: "Collection", inventory: "Inventory" };

/** The tabs this side shows in this store: My Binders only where binders are built. */
function tabsFor(side: Side, capabilities: Capabilities) {
  return TABS[side].filter((t) => !t.needs || capabilities[t.needs]);
}

/**
 * A link to the other side's tab, or an old one, and where it goes instead
 * (NEO-364 Routing): `tab=inventory` and a collection `tab=boxes` to My
 * Boxes, an inventory `tab=binders` to My Binders, `sale=1` (the retired
 * everything-for-sale view) to the Inventory list. `null`: it is this side's.
 */
function redirectFor(side: Side, params: URLSearchParams): { side: Side; tab: CollectionTab } | null {
  if (params.get("sale")) return { side: "inventory", tab: "cards" };
  const tab = params.get("tab");
  if (side === "collection" && (tab === "inventory" || tab === "boxes")) return { side: "inventory", tab: "boxes" };
  if (side === "inventory" && tab === "inventory") return { side: "inventory", tab: "boxes" };
  if (side === "inventory" && tab === "binders") return { side: "collection", tab: "binders" };
  // NEO-370: sales are the inventory's (what sold came out of a box).
  if (side === "collection" && (tab === "sales" || tab === "sync" || tab === "pick")) return { side: "inventory", tab };
  return null;
}

/** How long the search box waits for a pause in typing before it writes `q`. */
const QUERY_SETTLE_MS = 300;

/** The params that say a picked search suggestion. */
const ENTITY_PARAMS = [PLAYER_PARAM, TEAM_PARAM, FRANCHISE_PARAM, WHOLE_PARAM];

export interface FinalCollectionPageProps {
  /** `"app"` (default): `/collection` or `/inventory`. `"public"`: the no-login demo. */
  mode?: CollectionMode;
  /**
   * The app's side: `"collection"` (default, `/collection`) or `"inventory"`
   * (`/inventory`). The public demo reads its `side=` param instead.
   */
  surface?: Side;
  /** Public mode: params every view URL keeps (the marketing page's `demo=on`). */
  keepParams?: Record<string, string>;
  /** Public mode: leave the demo ("Back to the tour"). */
  onExit?: () => void;
  /**
   * Public mode inside the dashboard demo's shell (NEO-464): the shell already
   * has the tabs (both sides, Sign up, Back to the tour), so the demo drops
   * its own right-edge rail, mobile exits and side switch.
   */
  shell?: boolean;
}

export default function FinalCollectionPage({
  mode = "app",
  surface = "collection",
  keepParams,
  onExit,
  shell = false,
}: FinalCollectionPageProps) {
  const mounted = useContext(CollectionStoreContext);
  const page = (
    <CollectionModeProvider mode={mode} keepParams={keepParams} surface={surface}>
      <SidePage onExit={onExit} shell={shell} />
    </CollectionModeProvider>
  );
  if (mounted) return page;
  return (
    <DemoCollectionProvider
      storageKey={mode === "public" ? PUBLIC_STORAGE_KEY : undefined}
    >
      {page}
    </DemoCollectionProvider>
  );
}

/** The page on its side: every view below reads the side from `SideProvider`. */
function SidePage({ onExit, shell }: { onExit?: () => void; shell: boolean }) {
  const side = useCollectionSide();
  return (
    <SideProvider value={side}>
      <CollectionPage side={side} onExit={onExit} shell={shell} />
    </SideProvider>
  );
}

function CollectionPage({ side, onExit, shell }: { side: Side; onExit?: () => void; shell: boolean }) {
  const { mode, keepParams } = useCollectionMode();
  const isPublic = mode === "public";
  const { capabilities: storeCapabilities, demo, binderMemory, listing, kind: storeKind } = useCollectionStore();
  // NEO-370: listing needs the store's listing half as well as the flag.
  // NEO-500: a store that lists shows the Pick List only beside Sales (sales
  // are what it pulls); the demo, which never lists, shows its fixture's.
  const capabilities = useMemo<Capabilities>(() => {
    const listingOn = storeCapabilities.marketplaceListing && listing !== undefined;
    return {
      ...storeCapabilities,
      marketplaceListing: listingOn,
      pickList: storeCapabilities.pickList && (listingOn || !storeCapabilities.marketplaceListing),
    };
  }, [storeCapabilities, listing]);
  const containers = useContainers();
  const tabs = tabsFor(side, capabilities);
  const [params, setParams] = useCollectionParams();
  const replaceParams = useReplaceParams();
  const goToSide = useGoToSide();
  const tabParam = params.get("tab");
  const onInventory = side === "inventory";
  // A tab this side does not have (`?tab=binders` where binders are not
  // built) opens the side's first tab: My Cards, or the Inventory list.
  const tab: CollectionTab = tabs.some((t) => t.key === tabParam)
    ? (tabParam as CollectionTab)
    : "cards";
  /** The desk: My Binders, or My Boxes on the inventory. */
  const desk = tab === "binders" || tab === "boxes";
  const onChecklists = tab === "checklists";

  // The other side's tab (or an old link) goes there, in place of this entry
  // so Back skips it, with the rest of its params (an open container's `b`).
  const redirect = redirectFor(side, params);
  let redirectSearch: string | null = null;
  if (redirect) {
    const next = new URLSearchParams(params);
    for (const key of [SIDE_PARAM, "sale", "scope", ...Object.keys(keepParams)]) next.delete(key);
    next.set("tab", redirect.tab);
    redirectSearch = next.toString();
  }
  const redirectSide = redirect?.side ?? null;
  useEffect(() => {
    if (redirectSide && redirectSearch !== null)
      goToSide(redirectSide, new URLSearchParams(redirectSearch), { replace: true });
  }, [redirectSide, redirectSearch, goToSide]);

  // The Checklists drill and its ringed row live on the URL (see
  // `./checklistParams`): each drill step is a Back step, and a refresh or a
  // shared link reopens the same checklist.
  const search = params.toString();
  const urlDrill = useMemo<Drill>(
    () =>
      onChecklists ? drillFromParams(new URLSearchParams(search)) : EMPTY_DRILL,
    [onChecklists, search],
  );
  const urlCard = onChecklists ? params.get(CARD_PARAM) : null;
  const urlBox = onChecklists && onInventory ? params.get(TARGET_BOX_PARAM) : null;
  const entity = onChecklists ? entityFromParams(params) : null;
  // The router commits a navigation in a transition, a beat after the click.
  // A pick shows at once from here (the cascade moves focus into the next
  // column on that same beat), until the URL catches up or Back moves on.
  const [pending, setPending] = useState<{
    drill: Drill;
    card: CardId | null;
  } | null>(null);
  const drill = onChecklists && pending ? pending.drill : urlDrill;
  const highlightCardId =
    onChecklists && pending ? pending.card : drill.set ? urlCard : null;
  const drillState = useDrillState(drill, onChecklists);

  // The search box answers every keystroke from local state; `q` follows on
  // the URL once typing pauses, replacing the entry (never a Back step per
  // letter). A view change of ours or a Back/Forward brings the URL's `q`
  // into the box; our own replaces never do, so a late one cannot undo
  // fresh typing.
  const urlQuery = onChecklists ? (params.get(QUERY_PARAM) ?? "") : "";
  const [query, setQuery] = useState(urlQuery);
  const [cascadeKey, setCascadeKey] = useState(0);

  const location = useLocation();
  const navigationType = useNavigationType();
  const [seenEntry, setSeenEntry] = useState({
    key: location.key,
    view: viewOf(location.search),
  });
  const view = viewOf(location.search);
  if (seenEntry.key !== location.key && seenEntry.view === view) {
    // Only the card drawer opened, stepped or closed: the view under it stays as it is.
    setSeenEntry({ key: location.key, view });
  } else if (seenEntry.key !== location.key) {
    setSeenEntry({ key: location.key, view });
    if (navigationType !== "REPLACE") setQuery(urlQuery);
    if (
      pending &&
      (navigationType === "POP" ||
        !onChecklists ||
        sameDrill(pending.drill, urlDrill))
    ) {
      setPending(null);
    }
    // Back/Forward moved the drill from outside the cascade: rebuild it so
    // the picks read as a trail of summary cards, as on a deep link.
    if (navigationType === "POP") setCascadeKey((k) => k + 1);
  }

  // A jump to a card names only the card (`?tab=checklists&card=<id>`); once
  // the card is read, its checklist goes on the same entry.
  const jumpCard = useCard(
    onChecklists && urlCard && !drill.set ? urlCard : null,
  );
  useEffect(() => {
    if (!jumpCard) return;
    replaceParams((p) => {
      if (p.get(CARD_PARAM) !== jumpCard.id || p.get("set")) return;
      for (const [key, value] of Object.entries(
        drillToParams(drillToCard(jumpCard)),
      ))
        p.set(key, value);
    });
  }, [jumpCard, replaceParams]);

  // Where Checklists was, so leaving the tab and coming back keeps your place.
  const here = new URLSearchParams(drillToParams(drill));
  if (entity)
    for (const [k, v] of Object.entries(entityToParams(entity))) here.set(k, v);
  if (query) here.set(QUERY_PARAM, query);
  if (highlightCardId) here.set(CARD_PARAM, highlightCardId);
  const hereKey = here.toString();
  const [checklistsPlace, setChecklistsPlace] = useState(
    onChecklists ? hereKey : "",
  );
  if (onChecklists && checklistsPlace !== hereKey) setChecklistsPlace(hereKey);
  /**
   * A Checklists drill step's params, with the target box carried on while
   * the step stays inside the inventory's Checklists. Coming from another
   * tab there is none to carry: `box=` never crosses a tab change (the
   * picker falls back to the collector's last pick, then Unsorted).
   */
  const withBox = (p: Record<string, string>): Record<string, string> =>
    urlBox ? { ...p, [TARGET_BOX_PARAM]: urlBox } : p;

  // --- Page title ------------------------------------------------------------
  // The Pick List's By the Box names the box it is on (NEO-500).
  const [pickDetail, setPickDetail] = useState<string | null>(null);
  const titleSetId = !onChecklists ? params.get("set") : null;
  const titlePath = useSetPath(titleSetId);
  const titleSet = titlePath
    ? setLabel({ season: titlePath.year.name, name: titlePath.set.name })
    : null;
  let detail: string | null = null;
  if (tab === "cards") {
    detail =
      titleSet ??
      (params.get("view") === "needs" ? "Take it to the show" : null);
  } else if (tab === "binders") {
    const b = params.get("b");
    detail =
      containers?.find((x) => x.id === b && x.kind !== "box")?.name ??
      titleSet ??
      (params.get("all") ? "All my cards" : null);
  } else if (tab === "boxes") {
    const b = params.get("b");
    detail =
      containers?.find(
        (x) => x.id === b && (x.kind === "box" || x.system === "trade"),
      )?.name ?? null;
  } else if (tab === "checklists") {
    detail = drillState.title;
  } else if (tab === "pick") {
    detail = pickDetail;
  }
  const label = TABS[side].find((t) => t.key === tab)?.label ?? SIDE_TITLE[side];
  const page = `${SIDE_TITLE[side]}${isPublic ? " demo" : ""}`;
  // The Inventory list's tab is the page's own name: "Inventory", not "Inventory · Inventory".
  const head = label === SIDE_TITLE[side] ? null : label;
  useDocumentTitle(
    [head, detail, page].filter(Boolean).join(" · "),
  );

  // The Binder picker's scope comes from the URL, checked against the shelf
  // (an unknown id, or one that is not a home, reads as All). A store with no
  // binder scope always counts everything.
  // The inventory never narrows: its boxes are not the collection's scope.
  const scope: Scope =
    capabilities.scope && !onInventory
      ? scopeFromParams(params, containers)
      : "all";

  // NEO-374 — Profile → Settings' "remember the last binder": a visit whose
  // URL names no scope opens on the binder picked last, once the shelf and
  // the setting have loaded (a binder deleted since reads as All). Once per
  // mount, so picking All afterwards stays All.
  const setScope = useSetScope();
  const opening = binderMemory?.opening;
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !capabilities.scope || onInventory || !containers || !opening) return;
    opened.current = true;
    const last = opening.open === "last" ? opening.lastBinder : null;
    if (!last || scope !== "all" || params.has(SCOPE_PARAM)) return;
    if (scopeFromParams(new URLSearchParams({ [SCOPE_PARAM]: last }), containers) === "all") return;
    setScope(last);
  }, [capabilities.scope, onInventory, containers, opening, scope, params, setScope]);

  // --- Status line -----------------------------------------------------------
  // One line with its Undo for every tab and the card drawer (`./statusLine`).
  const line = useStatusLine();
  const { notice, notify, inform, undoLast, run, undo, dismiss } = line;

  // --- Checklists: writing the URL ------------------------------------------
  const writeQuery = useCallback(
    (q: string) =>
      replaceParams((p) => {
        if (p.get("tab") !== "checklists") return;
        if (q) p.set(QUERY_PARAM, q);
        else p.delete(QUERY_PARAM);
      }),
    [replaceParams],
  );
  useEffect(() => {
    if (!onChecklists || query === urlQuery) return;
    const t = setTimeout(() => writeQuery(query), QUERY_SETTLE_MS);
    return () => clearTimeout(t);
  }, [onChecklists, query, urlQuery, writeQuery]);
  /** Before leaving this entry, give it the search as typed, so Back finds it. */
  const settleQuery = () => {
    if (onChecklists && query !== urlQuery) writeQuery(query);
  };

  // --- Card drawer -----------------------------------------------------------
  // On the URL (`./drawerControl`): opening pushes `detail=<id>`, Back closes it.
  const drawerControl = useCardDrawer(params, { beforeOpen: settleQuery });
  const { drawer, openCard } = drawerControl;

  const checklistsSearch = (q?: string) => {
    const p = new URLSearchParams({ tab: "checklists" });
    new URLSearchParams(checklistsPlace).forEach((value, key) =>
      p.set(key, value),
    );
    // Only from inside Checklists (clearing a search pick, say): `urlBox` is
    // null on every other tab, so the box never rides a tab change.
    if (urlBox) p.set(TARGET_BOX_PARAM, urlBox);
    if (q !== undefined) {
      if (q) p.set(QUERY_PARAM, q);
      else p.delete(QUERY_PARAM);
    }
    return p;
  };

  /** A cascade pick: one Back step per level. */
  const drillInto = (next: Drill) => {
    if (sameDrill(next, drill)) return;
    settleQuery();
    setPending({ drill: next, card: null });
    const p = new URLSearchParams(withBox({
      tab: "checklists",
      ...drillToParams(next),
    }));
    if (query) p.set(QUERY_PARAM, query);
    setParams(p);
  };

  /**
   * Open a card's checklist and ring its row. Another checklist is a Back
   * step; ringing another row of the checklist on screen replaces.
   */
  const jumpTo = (card: Card) => {
    const next = drillToCard(card);
    setPending({ drill: next, card: card.id });
    setCascadeKey((k) => k + 1);
    setQuery("");
    if (onChecklists && !entity && sameDrill(next, drill)) {
      replaceParams((p) => {
        p.set(CARD_PARAM, card.id);
        p.delete(QUERY_PARAM);
      });
      return;
    }
    settleQuery();
    setParams(withBox({
      tab: "checklists",
      ...drillToParams(next),
      [CARD_PARAM]: card.id,
    }));
  };

  const goToChecklists = (target: ChecklistsTarget = {}) => {
    if ("card" in target) return jumpTo(target.card);
    settleQuery();
    if ("cardId" in target) {
      setParams(withBox({ tab: "checklists", [CARD_PARAM]: target.cardId }));
    } else if ("setId" in target) {
      setCascadeKey((k) => k + 1);
      setParams(withBox({ tab: "checklists", set: target.setId }));
    } else if ("entity" in target) {
      setParams(withBox({ tab: "checklists", ...entityToParams(target.entity) }));
    } else {
      // Checklists opens where it was, with the search the caller asked for.
      setParams(checklistsSearch(target.q));
    }
  };

  const openEntity = (e: EntityParam) => goToChecklists({ entity: e });
  /** Where Checklists puts the keyboard once the URL catches up (see `ChecklistsTab`). */
  const arrival = useRef<"entity" | "search" | null>(null);
  const pickSuggestion = (s: Suggestion) => {
    // The suggestion goes away with the search: the cards' heading takes the keyboard.
    arrival.current = s.kind === "set" ? null : "entity";
    if (s.kind === "player") openEntity({ kind: "player", id: s.id });
    else if (s.kind === "team")
      openEntity({
        kind: "team",
        id: s.id,
        franchiseId: s.franchise?.id ?? null,
        wholeFranchise: false,
      });
    else goToChecklists({ setId: s.id });
  };
  const setFranchise = (whole: boolean) =>
    replaceParams((p) => {
      if (whole) p.set(WHOLE_PARAM, "1");
      else p.delete(WHOLE_PARAM);
    });
  const clearEntity = () => {
    arrival.current = "search";
    const p = checklistsSearch();
    for (const key of ENTITY_PARAMS) p.delete(key);
    setParams(p);
  };

  /** My Binders and My Boxes still ask for a tab (the demo's own props). */
  const goToTab = (next: CollectionTab, p: GoToTabParams = {}) => {
    if (next === "checklists")
      goToChecklists(p.cardId ? { cardId: p.cardId } : { q: p.q });
    else setParams({ tab: next });
  };

  // The floating status line sits over the bottom of the page: while it is
  // up, keep a field the keyboard lands on clear of it (WCAG 2.4.11).
  useFloatingClearance(notice !== null && !drawer && !desk);

  // Arriving from the other side (a side link, the demo's switch): the
  // keyboard starts on this side's heading, not wherever the link was.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (takeSideArrival(side)) heading.current?.focus({ preventScroll: true });
  }, [side]);

  const pageApi: PageApi = {
    openCard,
    goToChecklists,
    openSuggestion: pickSuggestion,
    notify,
    inform,
    undoLast,
    run,
  };

  const resetDemo = () => {
    demo?.reset();
    notify("Back to the starting stack.");
  };

  return (
    <PageApiContext.Provider value={pageApi}>
      <ViewScopeProvider value={scope}>
        <ScopedRows containers={containers} openCard={openCard} run={run}>
          {(actions) => (
            <div className="text-ink">
              <div className="space-y-4">
                {capabilities.demoChrome && demo && (
                  <DemoBar onReset={resetDemo} onExit={onExit} shell={shell} />
                )}
                <h1 ref={heading} tabIndex={-1} className="text-2xl font-bold focus:outline-none">
                  {SIDE_TITLE[side]}
                </h1>

                <nav
                  aria-label={`${SIDE_TITLE[side]} sections`}
                  className="border-b border-rule"
                >
                  <ul className="flex flex-wrap gap-x-6 gap-y-2">
                    {tabs.map((t) => {
                      const active = t.key === tab;
                      return (
                        <li key={t.key}>
                          <ParamLink
                            // Checklists opens where you left it.
                            search={
                              t.key === "checklists"
                                ? checklistsSearch()
                                : { tab: t.key }
                            }
                            onClick={settleQuery}
                            aria-current={active ? "page" : undefined}
                            className={
                              "-mb-px block rounded-sm border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-outline " +
                              (active
                                ? // One hue per section: the collection's cyan, the inventory's yellow.
                                  onInventory
                                  ? "border-neon-yellow-text text-neon-yellow-text"
                                  : "border-selection text-neon-blue-text"
                                : "border-transparent text-ink-3 hover:border-control hover:text-ink")
                            }
                          >
                            {t.label}
                          </ParamLink>
                        </li>
                      );
                    })}
                  </ul>
                </nav>

                {!redirect && tab === "cards" && (onInventory ? <InventoryListTab /> : <MyCardsTab />)}
                {!redirect && desk && capabilities.binders && (
                  // My Binders' pack tray is pinned to the bottom, where the floating
                  // toast would sit on its search box, so the tray shows the notice
                  // (My Boxes floats its own where no box is open). One desk per
                  // side: what each has aimed or found stays its own.
                  <MyBindersTab
                    key={side}
                    surface={side}
                    openCard={openCard}
                    goToTab={goToTab}
                    notify={notify}
                    // While the card drawer is open it carries the status
                    // line; the desk's copy would say it a second time.
                    notice={drawer ? null : notice}
                    onUndo={undo}
                    onDismissNotice={dismiss}
                  />
                )}
                {!redirect && tab === "add" && capabilities.intake && (
                  <Suspense fallback={<SkeletonBars rows={4} />}>
                    {storeKind === "convex" ? <RealAddCardsTab /> : <AddCardsTab />}
                  </Suspense>
                )}
                {!redirect && tab === "sales" && capabilities.marketplaceListing && (
                  <Suspense fallback={<SkeletonBars rows={4} />}>
                    <SalesTab />
                  </Suspense>
                )}
                {!redirect && tab === "pick" && capabilities.pickList && (
                  <Suspense fallback={<SkeletonBars rows={4} />}>
                    {storeKind === "convex" ? (
                      <ConvexPickListTab onTitleDetail={setPickDetail} />
                    ) : (
                      <PickListTab onTitleDetail={setPickDetail} />
                    )}
                  </Suspense>
                )}
                {!redirect && tab === "sync" && capabilities.marketplaceListing && (
                  <Suspense fallback={<SkeletonBars rows={4} />}>
                    <SyncStatusTab />
                  </Suspense>
                )}
                {!redirect && tab === "checklists" && (
                  <ChecklistsTab
                    actions={actions}
                    query={query}
                    onQuery={setQuery}
                    drill={drillState}
                    cascadeKey={cascadeKey}
                    onDrill={drillInto}
                    onJump={jumpTo}
                    highlightCardId={highlightCardId}
                    selectedCardId={drawer?.cardId ?? null}
                    entity={entity}
                    onPickSuggestion={pickSuggestion}
                    onFranchise={setFranchise}
                    onClearEntity={clearEntity}
                    missingCard={jumpCard === null}
                    arrivalRef={arrival}
                  />
                )}
              </div>

              {isPublic && capabilities.demoChrome && !shell && (
                <DemoRail onExit={onExit} />
              )}

              {!drawer && !desk && (
                <NoticeLine
                  notice={notice}
                  onUndo={undo}
                  onDismiss={dismiss}
                  floating
                />
              )}
              {isOpen(drawerControl) && (
                <OpenCardDrawer control={drawerControl} line={line} />
              )}
            </div>
          )}
        </ScopedRows>
      </ViewScopeProvider>
    </PageApiContext.Provider>
  );
}

/**
 * What a row's controls do, built inside the page's scope so a Have files
 * into the scoped binder or box (`useCollectionActions` reads the scope) and
 * a Want is for it.
 */
function ScopedRows({
  containers,
  openCard,
  run,
  children,
}: {
  containers: Container[] | undefined;
  openCard: PageApi["openCard"];
  run: PageApi["run"];
  children: (actions: RowActions) => ReactNode;
}) {
  const writes = useCollectionActions();
  const into = useHomeName();
  const scopedName = useScopedName();
  const scope = useScope();
  const readOnly = useReadOnlyAll();
  const wants = useWants();
  const actions: RowActions = {
    have: (card, homeId) => {
      // NEO-374 — All is a view: the row's Have is locked, this is the
      // backstop. A caller that names its home (a card request's "I have
      // it") still adds.
      if (readOnly && !homeId) return;
      const home = homeId ? (containers?.find((c) => c.id === homeId)?.name ?? into) : into;
      void run(
        () => (homeId ? writes.addHave(card, homeId) : writes.addHave(card)),
        () => `Added ${shortCardName(card)} to ${home}`,
      );
    },
    removeLine: (card, copy) => {
      void run(
        () => writes.removeCopy(copy),
        (r) =>
          `Removed ${shortCardName(card)}, ${lineSummary(r.removed, containers)}`,
      );
    },
    addAnother: (card) => openCard(card.id, { mode: "add", seed: card }),
    toggleWant: (card) => {
      const t = wantToggle(wants ?? NO_WANTS, card.id, scope);
      const name = shortCardName(card);
      const forScope = t.binderId && scopedName ? ` for ${scopedName}` : "";
      void run(
        () => writes.setWant(t.cardId, t.binderId, t.on),
        () =>
          t.on
            ? `${name} is on your Want List${forScope}`
            : `${name} is off your Want List`,
      );
    },
    toggleTrade: (card, copy) => {
      const on = !copy.upForTrade;
      const name = shortCardName(card);
      void run(
        () => writes.setTrade(copy, on),
        () =>
          on ? `${name} is up for trade` : `${name} is off the trade pile`,
      );
    },
    open: (card, copyId, list, edit) =>
      openCard(card.id, { copyId, list: list?.map((c) => c.id), seed: card, edit }),
  };
  return <>{children(actions)}</>;
}

const NO_WANTS: readonly Want[] = [];
