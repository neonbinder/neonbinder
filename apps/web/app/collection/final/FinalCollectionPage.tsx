import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import { getCard, type Card, type CardId, type CopyId } from "../prototypes/_shared/data";
import { EMPTY_DRILL, type Drill } from "../prototypes/p1/drill";
import NoticeLine, { type Notice } from "../prototypes/p1/notice";
import { FOCUS, shortCardName } from "../prototypes/p1/ui";
import CardDrawer from "./CardDrawer";
import type { RowActions } from "./CardRows";
import ChecklistsTab, { drillToCard } from "./ChecklistsTab";
import { lineSummary } from "./lineItems";
import MyBindersTab from "./MyBindersTab";
import MyCardsTab from "./MyCardsTab";
import {
  useCollectionStore,
  type CollectionTab,
  type CollectionTabProps,
  type GoToTabParams,
  type OpenCardOptions,
} from "./store";

/**
 * NEO-350 — the consolidated collection page at `/collection`.
 *
 * Three tabs on `?tab=` (My Cards, My Binders, Checklists), drawn like the
 * admin section strip, sharing one store, one status line with Undo, and one
 * right-side card drawer opened through `openCard`. Fake data only.
 */

const TABS: { key: CollectionTab; label: string }[] = [
  { key: "cards", label: "My Cards" },
  { key: "binders", label: "My Binders" },
  { key: "checklists", label: "Checklists" },
];

const NOTICE_MS = 10_000;

interface DrawerState {
  cardId: CardId;
  listIds: CardId[];
  mode: "view" | "add";
  copyId?: CopyId;
  key: number;
}

export default function FinalCollectionPage() {
  useDocumentTitle("Collection");
  const store = useCollectionStore();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab");
  const tab: CollectionTab = TABS.some((t) => t.key === tabParam) ? (tabParam as CollectionTab) : "cards";

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
            key: drawer.key + 1,
          })
      : null;

  // --- Checklists tab state (kept here so switching tabs keeps your place) --
  const [query, setQuery] = useState(() => params.get("q") ?? "");
  const [drill, setDrill] = useState<Drill>(EMPTY_DRILL);
  const [cascadeKey, setCascadeKey] = useState(0);
  const [highlightCardId, setHighlightCardId] = useState<CardId | null>(null);

  const jumpTo = useCallback((card: Card) => {
    setDrill(drillToCard(card));
    setCascadeKey((k) => k + 1);
    setHighlightCardId(card.id);
    setQuery("");
  }, []);

  const goToTab = useCallback(
    (next: CollectionTab, p: GoToTabParams = {}) => {
      if (p.q !== undefined) setQuery(p.q);
      if (p.cardId) jumpTo(getCard(p.cardId));
      setParams(p.q ? { tab: next, q: p.q } : { tab: next });
    },
    [jumpTo, setParams],
  );

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

  return (
    <div className="text-slate-100">
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Collection</h1>

        <nav aria-label="Collection sections" className="border-b border-slate-800">
          <ul className="flex flex-wrap gap-x-6 gap-y-2">
            {TABS.map((t) => {
              const active = t.key === tab;
              return (
                <li key={t.key}>
                  <Link
                    to={`?tab=${t.key}`}
                    aria-current={active ? "page" : undefined}
                    className={
                      "-mb-px block rounded-sm border-b-2 px-1 py-3 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] " +
                      (active
                        ? "border-neon-blue text-neon-blue"
                        : "border-transparent text-slate-400 hover:border-slate-600 hover:text-white")
                    }
                  >
                    {t.label}
                  </Link>
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
            onDrill={(next) => {
              setDrill(next);
              setHighlightCardId(null);
            }}
            onJump={jumpTo}
            highlightCardId={highlightCardId}
            selectedCardId={drawer?.cardId ?? null}
          />
        )}

        <div className="border-t border-slate-800 pt-4">
          <button
            type="button"
            onClick={() => {
              store.reset();
              notify("Back to the starting stack.");
            }}
            className={`rounded px-1 py-1 text-xs text-slate-400 underline underline-offset-2 hover:text-white ${FOCUS}`}
          >
            Reset demo data
          </button>
        </div>
      </div>

      {!drawer && tab !== "binders" && (
        <NoticeLine notice={notice} onUndo={undo} onDismiss={() => setNotice(null)} floating />
      )}
      {drawer && (
        <CardDrawer
          card={getCard(drawer.cardId)}
          store={store}
          mode={drawer.mode}
          focusCopyId={drawer.copyId}
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
  );
}
