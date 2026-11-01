import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigationType } from "react-router";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import {
  getCard,
  sets,
  setLabel,
  type BinderId,
  type Card,
  type CardId,
  type CopyId,
} from "../prototypes/_shared/data";
import { EMPTY_DRILL, type Drill } from "../prototypes/p1/drill";
import NoticeLine, { type Notice } from "../prototypes/p1/notice";
import { shortCardName } from "../prototypes/p1/ui";
import CardDrawer from "./CardDrawer";
import { DemoBar, DemoRail } from "./DemoChrome";
import type { RowActions } from "./CardRows";
import {
  CARD_PARAM,
  cardFromParams,
  drillFromParams,
  drillTitle,
  drillToParams,
  QUERY_PARAM,
  sameDrill,
} from "./checklistParams";
import ChecklistsTab, { drillToCard } from "./ChecklistsTab";
import { lineSummary } from "./lineItems";
import MyBindersTab from "./MyBindersTab";
import MyCardsTab from "./MyCardsTab";
import {
  CollectionModeProvider,
  ParamLink,
  scopeFromParams,
  useCollectionMode,
  useCollectionParams,
  useReplaceParams,
  ViewScopeProvider,
  type CollectionMode,
} from "./mode";
import {
  PUBLIC_STORAGE_KEY,
  useCollectionStore,
  type CollectionTab,
  type CollectionBinder,
  type CollectionTabProps,
  type GoToTabParams,
  type OpenCardOptions,
} from "./store";

/**
 * NEO-350 — the collection demo: a permanent, hard-coded marketing demo, not
 * the future real collection. It never reaches Convex or Clerk.
 *
 * Three tabs on `?tab=` (My Cards, My Binders, Checklists), drawn like the
 * admin section strip, sharing one store, one status line with Undo, and one
 * right-side card drawer opened through `openCard`. Fake data only.
 *
 * It runs in two places (see `./mode`):
 * - `mode="app"` (default): `/collection`, for signed-in collectors, in the
 *   binder shell; where you are rides on the URL. Still the demo: the demo
 *   bar marks it as sample data and holds Reset.
 * - `mode="public"`: the no-login demo on `/binder-tracking`, through
 *   `PublicCollectionDemo`. Its own persist key, public destinations for
 *   signed-in links, and the demo bar's exits (Sign up, Back to the tour).
 */

const TABS: { key: CollectionTab; label: string }[] = [
  { key: "cards", label: "My Cards" },
  { key: "binders", label: "My Binders" },
  { key: "checklists", label: "Checklists" },
];

const NOTICE_MS = 10_000;
/** How long the search box waits for a pause in typing before it writes `q`. */
const QUERY_SETTLE_MS = 300;

/**
 * The tab's title: "My Binders · Main", "Checklists · 2024 Topps Chrome
 * Base", "My Cards". Each tab's views read their params the way the tab does.
 */
function viewTitle(tab: CollectionTab, params: URLSearchParams, binders: CollectionBinder[], drill: Drill): string {
  const label = TABS.find((t) => t.key === tab)?.label ?? "Collection";
  const setNamed = (id: string | null) => {
    const set = id ? sets.find((s) => s.id === id) : undefined;
    return set ? setLabel(set) : null;
  };
  let detail: string | null = null;
  if (tab === "cards") {
    detail = setNamed(params.get("set")) ?? (params.get("view") === "needs" ? "Take it to the show" : null);
  } else if (tab === "binders") {
    const b = params.get("b");
    detail =
      binders.find((x) => x.id === b)?.name ??
      setNamed(params.get("set")) ??
      (params.get("all") ? "All my cards" : null);
  } else {
    detail = drillTitle(drill);
  }
  return detail ? `${label} · ${detail}` : label;
}

interface DrawerState {
  cardId: CardId;
  listIds: CardId[];
  mode: "view" | "add";
  copyId?: CopyId;
  /** The binder the add form ticks instead of the page's target. */
  binderId?: BinderId;
  key: number;
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
  return (
    <CollectionModeProvider mode={mode} keepParams={keepParams}>
      <CollectionPage onExit={onExit} />
    </CollectionModeProvider>
  );
}

function CollectionPage({ onExit }: { onExit?: () => void }) {
  const isPublic = useCollectionMode().mode === "public";
  const store = useCollectionStore(isPublic ? PUBLIC_STORAGE_KEY : undefined);
  const [params, setParams] = useCollectionParams();
  const replaceParams = useReplaceParams();
  const tabParam = params.get("tab");
  const tab: CollectionTab = TABS.some((t) => t.key === tabParam) ? (tabParam as CollectionTab) : "cards";
  const onChecklists = tab === "checklists";

  // The Checklists drill and its ringed row live on the URL (see
  // `./checklistParams`): each drill step is a Back step, and a refresh or a
  // shared link reopens the same checklist.
  const search = params.toString();
  const urlDrill = useMemo<Drill>(
    () => (onChecklists ? drillFromParams(new URLSearchParams(search)) : EMPTY_DRILL),
    [onChecklists, search],
  );
  const urlHighlight = onChecklists ? cardFromParams(params, urlDrill) : null;
  // The router commits a navigation in a transition, a beat after the click.
  // A pick shows at once from here (the cascade moves focus into the next
  // column on that same beat), until the URL catches up or Back moves on.
  const [pending, setPending] = useState<{ drill: Drill; card: CardId | null } | null>(null);
  const drill = onChecklists && pending ? pending.drill : urlDrill;
  const highlightCardId = onChecklists && pending ? pending.card : urlHighlight;

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
  const [seenEntry, setSeenEntry] = useState(location.key);
  if (seenEntry !== location.key) {
    setSeenEntry(location.key);
    if (navigationType !== "REPLACE") setQuery(urlQuery);
    if (pending && (navigationType === "POP" || !onChecklists || sameDrill(pending.drill, urlDrill))) {
      setPending(null);
    }
    // Back/Forward moved the drill from outside the cascade: rebuild it so
    // the picks read as a trail of summary cards, as on a deep link.
    if (navigationType === "POP") setCascadeKey((k) => k + 1);
  }

  // Where Checklists was, so leaving the tab and coming back keeps your place.
  const here = new URLSearchParams(drillToParams(drill));
  if (query) here.set(QUERY_PARAM, query);
  if (highlightCardId) here.set(CARD_PARAM, highlightCardId);
  const hereKey = here.toString();
  const [checklistsPlace, setChecklistsPlace] = useState(onChecklists ? hereKey : "");
  if (onChecklists && checklistsPlace !== hereKey) setChecklistsPlace(hereKey);

  useDocumentTitle(
    `${viewTitle(tab, params, store.state.binders, drill)} · ${isPublic ? "Collection demo" : "Collection"}`,
  );

  // The Binder picker's scope comes from the URL; the store follows it in
  // this same render, so the two never disagree on screen.
  const scope = scopeFromParams(params, store.state.binders);
  if (store.selectedBinderId !== scope) store.setSelectedBinder(scope);

  // --- Status line -----------------------------------------------------------
  const [notice, setNotice] = useState<Notice | null>(null);
  const notify = useCallback((message: string, undo?: () => void) => {
    setNotice((prev) => ({ id: (prev?.id ?? 0) + 1, message, undo }));
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);
  const undo = () => {
    notice?.undo?.();
    setNotice((prev) => (prev ? { id: prev.id + 1, message: "Undone." } : null));
  };

  // --- Card drawer -----------------------------------------------------------
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const openCard = useCallback((cardId: CardId, opts: OpenCardOptions = {}) => {
    setDrawer((prev) => ({
      cardId,
      listIds: opts.list && opts.list.includes(cardId) ? opts.list : [cardId],
      mode: opts.mode ?? "view",
      copyId: opts.copyId,
      binderId: opts.binderId,
      key: (prev?.key ?? 0) + 1,
    }));
  }, []);
  const drawerIndex = drawer ? drawer.listIds.indexOf(drawer.cardId) : -1;
  const step = (delta: 1 | -1) =>
    drawer && drawerIndex + delta >= 0 && drawerIndex + delta < drawer.listIds.length
      ? () =>
          setDrawer({
            ...drawer,
            cardId: drawer.listIds[drawerIndex + delta],
            mode: "view",
            copyId: undefined,
            binderId: undefined,
            key: drawer.key + 1,
          })
      : null;

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
    if (onChecklists && sameDrill(next, drill)) {
      replaceParams((p) => {
        p.set(CARD_PARAM, card.id);
        p.delete(QUERY_PARAM);
      });
      return;
    }
    settleQuery();
    setParams({ tab: "checklists", ...drillToParams(next), [CARD_PARAM]: card.id });
  };

  const goToTab = (next: CollectionTab, p: GoToTabParams = {}) => {
    if (next === "checklists" && p.cardId) jumpTo(getCard(p.cardId));
    // Checklists opens where it was, with the search the caller asked for.
    else if (next === "checklists") setParams(checklistsSearch(p.q));
    else setParams({ tab: next });
  };

  // --- What a row's controls do ---------------------------------------------
  const scopedName = store.fileableBinders.find((b) => b.id === store.selectedBinderId)?.name;
  const actions: RowActions = {
    have: (card) => {
      const copy = store.addHave(card.id);
      const into = store.getBinder(store.targetBinderId)?.name ?? "Main";
      notify(`Added ${shortCardName(card)} to ${into}`, () => store.removeCopy(copy.id));
    },
    removeLine: (card, copy) => {
      const removed = store.removeCopy(copy.id);
      if (removed) {
        notify(
          `Removed ${shortCardName(card)}, ${lineSummary(removed, store.state.binders)}`,
          () => store.restoreCopy(removed),
        );
      }
    },
    addAnother: (card) => openCard(card.id, { mode: "add" }),
    toggleWant: (card) => {
      const wanted = store.isWanted(card.id);
      const undoWant = store.toggleWant(card.id);
      const name = shortCardName(card);
      notify(
        wanted
          ? `${name} is off your Want List${scopedName ? ` for ${scopedName}` : ""}`
          : `${name} is on your Want List${scopedName ? ` for ${scopedName}` : ""}`,
        undoWant,
      );
    },
    toggleTrade: (card, copy) => {
      const on = !store.isUpForTrade(copy);
      store.setUpForTrade(copy.id, on);
      const name = shortCardName(card);
      notify(on ? `${name} is up for trade` : `${name} is off the trade pile`, () =>
        store.setUpForTrade(copy.id, !on),
      );
    },
    open: (card, copyId, list) => openCard(card.id, { copyId, list: list?.map((c) => c.id) }),
  };

  const tabProps: CollectionTabProps = { store, openCard, goToTab, notify };
  const resetDemo = () => {
    store.reset();
    notify("Back to the starting stack.");
  };

  return (
    <ViewScopeProvider value={scope}>
      <div className="text-ink">
        <div className="space-y-4">
          <DemoBar onReset={resetDemo} onExit={onExit} />
          <h1 className="text-2xl font-bold">Collection</h1>

          <nav aria-label="Collection sections" className="border-b border-rule">
            <ul className="flex flex-wrap gap-x-6 gap-y-2">
              {TABS.map((t) => {
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

          {tab === "cards" && <MyCardsTab {...tabProps} />}
          {tab === "binders" && (
            // My Binders' pack tray is pinned to the bottom, where the floating
            // toast would sit on its search box, so the tray shows the notice.
            <MyBindersTab
              {...tabProps}
              notice={notice}
              onUndo={undo}
              onDismissNotice={() => setNotice(null)}
            />
          )}
          {tab === "checklists" && (
            <ChecklistsTab
              {...tabProps}
              actions={actions}
              query={query}
              onQuery={setQuery}
              drill={drill}
              cascadeKey={cascadeKey}
              onDrill={drillInto}
              onJump={jumpTo}
              highlightCardId={highlightCardId}
              selectedCardId={drawer?.cardId ?? null}
            />
          )}
        </div>

        {isPublic && <DemoRail onExit={onExit} />}

        {!drawer && tab !== "binders" && (
          <NoticeLine notice={notice} onUndo={undo} onDismiss={() => setNotice(null)} floating />
        )}
        {drawer && (
          <CardDrawer
            card={getCard(drawer.cardId)}
            store={store}
            mode={drawer.mode}
            focusCopyId={drawer.copyId}
            addBinderId={drawer.binderId}
            openKey={drawer.key}
            notify={notify}
            notice={notice}
            onUndo={undo}
            onDismissNotice={() => setNotice(null)}
            onClose={() => setDrawer(null)}
            onPrev={step(-1)}
            onNext={step(1)}
          />
        )}
      </div>
    </ViewScopeProvider>
  );
}
