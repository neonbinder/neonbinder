import { startTransition, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import NoticeLine, { type Notice } from "../prototypes/p1/notice";
import CardDrawer from "./CardDrawer";
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
import { DemoCollectionProvider, PUBLIC_STORAGE_KEY } from "./data/demoStore";
import { setLabel, shortCardName } from "./data/labels";
import {
  CollectionStoreContext,
  useCard,
  useCollectionActions,
  useCollectionStore,
  useContainers,
  useScope,
  useSetPath,
  useWants,
  wantToggle,
  writeErrorMessage,
} from "./data/store";
import type { Capabilities, Card, CardId, Container, CopyId, Scope, Suggestion, Undo, Want } from "./data/types";
import { useHomeName, useScopedName } from "./catalog/home";
import { DRAWER_MODE_PARAM, DRAWER_PARAM, viewOf } from "./drawerParams";
import { lineSummary } from "./lineItems";
import MyBindersTab from "./MyBindersTab";
import MyCardsTab from "./MyCardsTab";
import {
  CollectionModeProvider,
  ParamLink,
  scopeFromParams,
  useCollectionMode,
  useCollectionParams,
  usePushParams,
  useReplaceParams,
  ViewScopeProvider,
  type CollectionMode,
} from "./mode";
import { PageApiContext, type ChecklistsTarget, type OpenCardOptions, type PageApi } from "./pageApi";
import type { CollectionTab, GoToTabParams } from "./store";

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
 * Tabs on `?tab=` (My Cards, My Binders when the store has binders,
 * Checklists), drawn like the admin section strip, sharing one status line
 * with Undo and one right-side card drawer opened through `openCard`.
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
 */

const TABS: { key: CollectionTab; label: string; needs?: keyof Capabilities }[] = [
  { key: "cards", label: "My Cards" },
  { key: "binders", label: "My Binders", needs: "binders" },
  { key: "checklists", label: "Checklists" },
];

/** The tabs this store can show: My Binders only where binders are built. */
function tabsFor(capabilities: Capabilities) {
  return TABS.filter((t) => !t.needs || capabilities[t.needs]);
}

/**
 * Runs a notice's undo. A store's undo is a write of its own: run it now (the
 * demo's lands in this same click) and report an async one's refusal when it
 * comes back.
 */
function runUndo(undo: () => unknown, onError: (error: unknown) => void) {
  try {
    const pending = undo();
    if (pending instanceof Promise) pending.catch(onError);
  } catch (error) {
    onError(error);
  }
}

/** What an undo that the server refused says on the status line. */
function undoFailed(error: unknown): string {
  return `That undo didn't go through. ${writeErrorMessage(error)}`;
}

const NOTICE_MS = 10_000;
/** How long the search box waits for a pause in typing before it writes `q`. */
const QUERY_SETTLE_MS = 300;

/** The params that say a picked search suggestion. */
const ENTITY_PARAMS = [PLAYER_PARAM, TEAM_PARAM, FRANCHISE_PARAM, WHOLE_PARAM];

/**
 * What the opener knew that the URL does not carry: the list the drawer's
 * ↑ ↓ step through, the card as drawn, the copy to ring. Kept for the card
 * it was set for; a drawer reopened from the URL alone steps through just
 * its own card.
 */
interface DrawerExtras {
  cardId: CardId;
  listIds: CardId[];
  seed?: Card;
  copyId?: CopyId;
  /** The home the add form picks instead of the page's scope. */
  binderId?: string;
  key: number;
}

/** The history state on an entry the drawer pushed: Close steps Back off it. */
interface DrawerHistoryState {
  drawer?: boolean;
}

export interface FinalCollectionPageProps {
  /** `"app"` (default): `/collection`. `"public"`: the no-login demo. */
  mode?: CollectionMode;
  /** Public mode: params every view URL keeps (the marketing page's `demo=on`). */
  keepParams?: Record<string, string>;
  /** Public mode: leave the demo ("Back to the tour"). */
  onExit?: () => void;
}

export default function FinalCollectionPage({ mode = "app", keepParams, onExit }: FinalCollectionPageProps) {
  const mounted = useContext(CollectionStoreContext);
  const page = (
    <CollectionModeProvider mode={mode} keepParams={keepParams}>
      <CollectionPage onExit={onExit} />
    </CollectionModeProvider>
  );
  if (mounted) return page;
  return (
    <DemoCollectionProvider storageKey={mode === "public" ? PUBLIC_STORAGE_KEY : undefined}>{page}</DemoCollectionProvider>
  );
}

function CollectionPage({ onExit }: { onExit?: () => void }) {
  const isPublic = useCollectionMode().mode === "public";
  const { capabilities, demo } = useCollectionStore();
  const containers = useContainers();
  const tabs = tabsFor(capabilities);
  const [params, setParams] = useCollectionParams();
  const replaceParams = useReplaceParams();
  const tabParam = params.get("tab");
  // A tab this store does not have (`?tab=binders` on the real collection) opens My Cards.
  const tab: CollectionTab = tabs.some((t) => t.key === tabParam) ? (tabParam as CollectionTab) : "cards";
  const onChecklists = tab === "checklists";

  // The Checklists drill and its ringed row live on the URL (see
  // `./checklistParams`): each drill step is a Back step, and a refresh or a
  // shared link reopens the same checklist.
  const search = params.toString();
  const urlDrill = useMemo<Drill>(
    () => (onChecklists ? drillFromParams(new URLSearchParams(search)) : EMPTY_DRILL),
    [onChecklists, search],
  );
  const urlCard = onChecklists ? params.get(CARD_PARAM) : null;
  const entity = onChecklists ? entityFromParams(params) : null;
  // The router commits a navigation in a transition, a beat after the click.
  // A pick shows at once from here (the cascade moves focus into the next
  // column on that same beat), until the URL catches up or Back moves on.
  const [pending, setPending] = useState<{ drill: Drill; card: CardId | null } | null>(null);
  const drill = onChecklists && pending ? pending.drill : urlDrill;
  const highlightCardId = onChecklists && pending ? pending.card : drill.set ? urlCard : null;
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
  const [seenEntry, setSeenEntry] = useState({ key: location.key, view: viewOf(location.search) });
  const view = viewOf(location.search);
  if (seenEntry.key !== location.key && seenEntry.view === view) {
    // Only the card drawer opened, stepped or closed: the view under it stays as it is.
    setSeenEntry({ key: location.key, view });
  } else if (seenEntry.key !== location.key) {
    setSeenEntry({ key: location.key, view });
    if (navigationType !== "REPLACE") setQuery(urlQuery);
    if (pending && (navigationType === "POP" || !onChecklists || sameDrill(pending.drill, urlDrill))) {
      setPending(null);
    }
    // Back/Forward moved the drill from outside the cascade: rebuild it so
    // the picks read as a trail of summary cards, as on a deep link.
    if (navigationType === "POP") setCascadeKey((k) => k + 1);
  }

  // A jump to a card names only the card (`?tab=checklists&card=<id>`); once
  // the card is read, its checklist goes on the same entry.
  const jumpCard = useCard(onChecklists && urlCard && !drill.set ? urlCard : null);
  useEffect(() => {
    if (!jumpCard) return;
    replaceParams((p) => {
      if (p.get(CARD_PARAM) !== jumpCard.id || p.get("set")) return;
      for (const [key, value] of Object.entries(drillToParams(drillToCard(jumpCard)))) p.set(key, value);
    });
  }, [jumpCard, replaceParams]);

  // Where Checklists was, so leaving the tab and coming back keeps your place.
  const here = new URLSearchParams(drillToParams(drill));
  if (entity) for (const [k, v] of Object.entries(entityToParams(entity))) here.set(k, v);
  if (query) here.set(QUERY_PARAM, query);
  if (highlightCardId) here.set(CARD_PARAM, highlightCardId);
  const hereKey = here.toString();
  const [checklistsPlace, setChecklistsPlace] = useState(onChecklists ? hereKey : "");
  if (onChecklists && checklistsPlace !== hereKey) setChecklistsPlace(hereKey);

  // --- Page title ------------------------------------------------------------
  const titleSetId = !onChecklists ? params.get("set") : null;
  const titlePath = useSetPath(titleSetId);
  const titleSet = titlePath ? setLabel({ season: titlePath.year.name, name: titlePath.set.name }) : null;
  let detail: string | null = null;
  if (tab === "cards") {
    detail = titleSet ?? (params.get("view") === "needs" ? "Take it to the show" : null);
  } else if (tab === "binders") {
    const b = params.get("b");
    detail = containers?.find((x) => x.id === b)?.name ?? titleSet ?? (params.get("all") ? "All my cards" : null);
  } else {
    detail = drillState.title;
  }
  const label = TABS.find((t) => t.key === tab)?.label ?? "Collection";
  useDocumentTitle(`${detail ? `${label} · ${detail}` : label} · ${isPublic ? "Collection demo" : "Collection"}`);

  // The Binder picker's scope comes from the URL, checked against the shelf
  // (an unknown id, or one that is not a home, reads as All). A store with no
  // binder scope always counts everything.
  const scope: Scope = capabilities.scope ? scopeFromParams(params, containers) : "all";

  // --- Status line -----------------------------------------------------------
  const [notice, setNotice] = useState<Notice | null>(null);
  // The line waits while the pointer rests on it or the keyboard is in it, so
  // Undo can always be reached in time (WCAG 2.2.1); it counts again after.
  const held = useNoticeHold();
  // No manual memo here: the React Compiler memoizes these handlers itself.
  const notify = (message: string, undo?: () => void) => {
    setNotice((prev) => ({ id: (prev?.id ?? 0) + 1, message, undo }));
  };
  useEffect(() => {
    if (!notice || held) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice, held]);
  const undo = () => {
    const run = notice?.undo;
    setNotice((prev) => (prev ? { id: prev.id + 1, message: "Undone." } : null));
    if (run) runUndo(run, (error) => notify(undoFailed(error)));
  };
  const run = async <T extends { undo: Undo }>(
    write: () => Promise<T>,
    message: (result: T) => string,
  ): Promise<T | null> => {
    try {
      const result = await write();
      notify(message(result), result.undo);
      return result;
    } catch (error) {
      notify(writeErrorMessage(error));
      return null;
    }
  };

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
  // Opening a card pushes `detail=<id>` (Back closes it); ↑ ↓ replace it (Back
  // never walks the cards one by one); Close steps Back off an entry the
  // drawer pushed, and otherwise (a shared link, a refresh in a new tab)
  // takes the params off in place.
  const navigate = useNavigate();
  const pushParams = usePushParams();
  const [extras, setExtras] = useState<DrawerExtras | null>(null);
  const drawerId = params.get(DRAWER_PARAM);
  const ours = extras && extras.cardId === drawerId ? extras : null;
  const drawer = drawerId
    ? {
        cardId: drawerId,
        listIds: extras && extras.listIds.includes(drawerId) ? extras.listIds : [drawerId],
        seed: ours?.seed,
        mode: params.get(DRAWER_MODE_PARAM) === "add" ? ("add" as const) : ("view" as const),
        copyId: ours?.copyId,
        binderId: ours?.binderId,
        key: extras?.key ?? 0,
      }
    : null;
  const pushedDrawer = (location.state as DrawerHistoryState | null)?.drawer === true;
  const openCard = (cardId: CardId, opts: OpenCardOptions = {}) => {
    settleQuery();
    // The URL commits in a transition: let the opener's extras land with it.
    startTransition(() =>
      setExtras((prev) => ({
        cardId,
        listIds: opts.list && opts.list.includes(cardId) ? opts.list : [cardId],
        seed: opts.seed,
        copyId: opts.copyId,
        binderId: opts.binderId,
        key: (prev?.key ?? 0) + 1,
      })),
    );
    const write = (p: URLSearchParams) => {
      p.set(DRAWER_PARAM, cardId);
      if (opts.mode === "add") p.set(DRAWER_MODE_PARAM, "add");
      else p.delete(DRAWER_MODE_PARAM);
    };
    // Already open (a card picked from inside it): swap the card in place.
    if (drawerId) replaceParams(write);
    else pushParams(write, { drawer: true } satisfies DrawerHistoryState);
  };
  const closeDrawer = () => {
    if (pushedDrawer) void navigate(-1);
    else
      replaceParams((p) => {
        p.delete(DRAWER_PARAM);
        p.delete(DRAWER_MODE_PARAM);
      });
  };
  const drawerIndex = drawer ? drawer.listIds.indexOf(drawer.cardId) : -1;
  const step = (delta: 1 | -1) =>
    drawer && drawerIndex + delta >= 0 && drawerIndex + delta < drawer.listIds.length
      ? () => {
          const next = drawer.listIds[drawerIndex + delta];
          startTransition(() =>
            setExtras((prev) => ({ cardId: next, listIds: drawer.listIds, key: (prev?.key ?? 0) + 1 })),
          );
          replaceParams((p) => {
            p.set(DRAWER_PARAM, next);
            p.delete(DRAWER_MODE_PARAM);
          });
        }
      : null;

  const checklistsSearch = (q?: string) => {
    const p = new URLSearchParams({ tab: "checklists" });
    new URLSearchParams(checklistsPlace).forEach((value, key) => p.set(key, value));
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
    const p = new URLSearchParams({ tab: "checklists", ...drillToParams(next) });
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
    setParams({ tab: "checklists", ...drillToParams(next), [CARD_PARAM]: card.id });
  };

  const goToChecklists = (target: ChecklistsTarget = {}) => {
    if ("card" in target) return jumpTo(target.card);
    settleQuery();
    if ("cardId" in target) {
      setParams({ tab: "checklists", [CARD_PARAM]: target.cardId });
    } else if ("setId" in target) {
      setCascadeKey((k) => k + 1);
      setParams({ tab: "checklists", set: target.setId });
    } else if ("entity" in target) {
      setParams({ tab: "checklists", ...entityToParams(target.entity) });
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
    else if (s.kind === "team") openEntity({ kind: "team", id: s.id, franchiseId: s.franchise?.id ?? null, wholeFranchise: false });
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

  /** My Binders still asks for a tab (the demo's own props). */
  const goToTab = (next: CollectionTab, p: GoToTabParams = {}) => {
    if (next === "checklists") goToChecklists(p.cardId ? { cardId: p.cardId } : { q: p.q });
    else setParams({ tab: next });
  };

  const pageApi: PageApi = { openCard, goToChecklists, openSuggestion: pickSuggestion, notify, run };

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
                {capabilities.demoChrome && demo && <DemoBar onReset={resetDemo} onExit={onExit} />}
                <h1 className="text-2xl font-bold">Collection</h1>

                <nav aria-label="Collection sections" className="border-b border-rule">
                  <ul className="flex flex-wrap gap-x-6 gap-y-2">
                    {tabs.map((t) => {
                      const active = t.key === tab;
                      return (
                        <li key={t.key}>
                          <ParamLink
                            // Checklists opens where you left it.
                            search={t.key === "checklists" ? checklistsSearch() : { tab: t.key }}
                            onClick={settleQuery}
                            aria-current={active ? "page" : undefined}
                            className={
                              "-mb-px block rounded-sm border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-outline " +
                              (active
                                ? "border-selection text-neon-blue-text"
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

                {tab === "cards" && <MyCardsTab />}
                {tab === "binders" && capabilities.binders && (
                  // My Binders' pack tray is pinned to the bottom, where the floating
                  // toast would sit on its search box, so the tray shows the notice.
                  <MyBindersTab
                    openCard={openCard}
                    goToTab={goToTab}
                    notify={notify}
                    notice={notice}
                    onUndo={undo}
                    onDismissNotice={() => setNotice(null)}
                  />
                )}
                {tab === "checklists" && (
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

              {isPublic && capabilities.demoChrome && <DemoRail onExit={onExit} />}

              {!drawer && tab !== "binders" && (
                <NoticeLine notice={notice} onUndo={undo} onDismiss={() => setNotice(null)} floating />
              )}
              {drawer && (
                <CardDrawer
                  cardId={drawer.cardId}
                  seed={drawer.seed}
                  mode={drawer.mode}
                  focusCopyId={drawer.copyId}
                  addBinderId={drawer.binderId}
                  openKey={drawer.key}
                  notice={notice}
                  onUndo={undo}
                  onDismissNotice={() => setNotice(null)}
                  onClose={closeDrawer}
                  onPrev={step(-1)}
                  onNext={step(1)}
                  position={drawer.listIds.length > 1 ? { index: drawerIndex, total: drawer.listIds.length } : null}
                />
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
  const wants = useWants();
  const actions: RowActions = {
    have: (card) => {
      void run(
        () => writes.addHave(card),
        () => `Added ${shortCardName(card)} to ${into}`,
      );
    },
    removeLine: (card, copy) => {
      void run(
        () => writes.removeCopy(copy),
        (r) => `Removed ${shortCardName(card)}, ${lineSummary(r.removed, containers)}`,
      );
    },
    addAnother: (card) => openCard(card.id, { mode: "add", seed: card }),
    toggleWant: (card) => {
      const t = wantToggle(wants ?? NO_WANTS, card.id, scope);
      const name = shortCardName(card);
      const forScope = t.binderId && scopedName ? ` for ${scopedName}` : "";
      void run(
        () => writes.setWant(t.cardId, t.binderId, t.on),
        () => (t.on ? `${name} is on your Want List${forScope}` : `${name} is off your Want List`),
      );
    },
    toggleTrade: (card, copy) => {
      const on = !copy.upForTrade;
      const name = shortCardName(card);
      void run(
        () => writes.setTrade(copy, on),
        () => (on ? `${name} is up for trade` : `${name} is off the trade pile`),
      );
    },
    open: (card, copyId, list) => openCard(card.id, { copyId, list: list?.map((c) => c.id), seed: card }),
  };
  return <>{children(actions)}</>;
}

const NO_WANTS: readonly Want[] = [];

/** Marks a status line whose timer waits while it is pointed at or focused (`../prototypes/p1/notice`, the pack tray). */
const NOTICE_HOLD_ATTR = "data-notice-hold";

/**
 * True while the pointer rests on, or the keyboard focus is inside, an
 * element marked `data-notice-hold` (the status line with its Undo, wherever
 * it is drawn: the page toast, the card drawer, the pack tray).
 */
function useNoticeHold(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    let hover = false;
    let focus = false;
    const inLine = (t: EventTarget | null) => t instanceof Element && t.closest(`[${NOTICE_HOLD_ATTR}]`) !== null;
    const sync = () => setHeld(hover || focus);
    const onOver = (e: MouseEvent) => {
      hover = inLine(e.target);
      sync();
    };
    const onOut = (e: MouseEvent) => {
      if (e.relatedTarget === null) {
        hover = false;
        sync();
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      focus = inLine(e.target);
      sync();
    };
    const onFocusOut = (e: FocusEvent) => {
      focus = inLine(e.relatedTarget);
      sync();
    };
    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);
  return held;
}
