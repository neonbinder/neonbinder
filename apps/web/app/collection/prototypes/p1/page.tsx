import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import PrototypeBanner from "../_shared/PrototypeBanner";
import { getCard, type Card } from "../_shared/data";
import { usePrototypeStore } from "../_shared/usePrototypeStore";
import Binders from "./Binders";
import CardDrawer from "./CardDrawer";
import Checklists from "./Checklists";
import { EMPTY_DRILL, type Drill } from "./drill";
import FindCards from "./FindCards";
import MyCards from "./MyCards";
import NoticeLine, { type Notice } from "./notice";
import { shortCardName } from "./ui";
import WantList from "./WantList";

/**
 * NEO-350 — collection prototype 1, "Set Builder, Collector Edition".
 *
 * The collector's side of the app built out of the admin Set Builder's own
 * parts: the cascade of columns, the checklist rows, the right-hand card
 * drawer, the Players list/detail, the admin hub's cards. Same look, same
 * keyboard, pointed at "what do I have" instead of "what exists".
 *
 * Tabs are `?tab=` on one route (no new routes), drawn like the admin
 * section strip. Everything lives in this page's own prototype store.
 */

const TABS = [
  { key: "mine", label: "My Cards" },
  { key: "find", label: "Find Cards" },
  { key: "binders", label: "Binders" },
  { key: "want", label: "Want List" },
  { key: "checklists", label: "Checklists" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const NOTICE_MS = 10_000;

export default function CollectionPrototype1() {
  useDocumentTitle("Collection · Set Builder Collector Edition");
  const store = usePrototypeStore("p1");
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab");
  const tab: TabKey = TABS.some((t) => t.key === tabParam) ? (tabParam as TabKey) : "mine";
  const tabTo = (key: TabKey) => (key === "mine" ? "?" : `?tab=${key}`);

  // --- Notices -------------------------------------------------------------
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

  // --- Quick Have toggle (rows everywhere) -----------------------------------
  const toggleHave = (card: Card) => {
    const name = shortCardName(card);
    const copies = store.copiesOf(card.id);
    if (copies.length === 0) {
      const copy = store.addCopy(card.id);
      notify(`Added ${name}`, () => store.removeCopy(copy.id));
      return;
    }
    const removed = copies.map((c) => store.removeCopy(c.id)).filter((c) => c !== undefined);
    const n = removed.reduce((sum, c) => sum + c.quantity, 0);
    notify(`Removed ${name}${n > 1 ? ` (all ${n})` : ""}`, () =>
      removed.forEach((c) => store.restoreCopy(c)),
    );
  };

  // --- Card drawer -----------------------------------------------------------
  const [drawer, setDrawer] = useState<{ cardId: string; listIds: string[] } | null>(null);
  const openCard = (card: Card, list: Card[]) =>
    setDrawer({ cardId: card.id, listIds: list.map((c) => c.id) });
  const drawerIndex = drawer ? drawer.listIds.indexOf(drawer.cardId) : -1;
  const step = (delta: 1 | -1) =>
    drawer &&
    drawerIndex + delta >= 0 &&
    drawerIndex + delta < drawer.listIds.length
      ? () => setDrawer({ ...drawer, cardId: drawer.listIds[drawerIndex + delta] })
      : null;

  // --- Drills (kept per tab so switching tabs never loses your place) --------
  const [findDrill, setFindDrill] = useState<Drill>(EMPTY_DRILL);
  const [findKey, setFindKey] = useState(0);
  const [catalogDrill, setCatalogDrill] = useState<Drill>(EMPTY_DRILL);

  const goTab = (key: TabKey) => setParams(key === "mine" ? {} : { tab: key });

  return (
    <div className="text-slate-100">
      <PrototypeBanner current={1} />
      <div className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-bold">Collection</h1>
          <button
            type="button"
            onClick={() => {
              store.reset();
              notify("Back to the starting stack.");
            }}
            className="rounded px-2 py-1 text-xs text-slate-400 underline underline-offset-2 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
          >
            Reset prototype data
          </button>
        </div>

        <nav aria-label="Collection sections" className="border-b border-slate-800">
          <ul className="flex flex-wrap gap-x-6 gap-y-2">
            {TABS.map((t) => {
              const active = t.key === tab;
              return (
                <li key={t.key}>
                  <Link
                    to={tabTo(t.key)}
                    aria-current={active ? "page" : undefined}
                    className={
                      "block px-1 py-3 -mb-px border-b-2 text-sm font-medium transition-colors rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] " +
                      (active
                        ? "border-neon-blue text-neon-blue"
                        : "border-transparent text-slate-400 hover:text-white hover:border-slate-600")
                    }
                  >
                    {t.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {tab === "mine" && (
          <MyCards store={store} notify={notify} onFindCards={() => goTab("find")} />
        )}
        {tab === "find" && (
          <FindCards
            store={store}
            notify={notify}
            drill={findDrill}
            cascadeKey={findKey}
            onDrill={setFindDrill}
            onJump={(next) => {
              setFindDrill(next);
              setFindKey((k) => k + 1);
            }}
            selectedCardId={drawer?.cardId ?? null}
            onOpen={openCard}
            onToggleHave={toggleHave}
          />
        )}
        {tab === "binders" && (
          <Binders store={store} notify={notify} onOpen={openCard} onToggleHave={toggleHave} />
        )}
        {tab === "want" && (
          <WantList store={store} notify={notify} onOpen={openCard} onFindCards={() => goTab("find")} />
        )}
        {tab === "checklists" && (
          <Checklists
            store={store}
            drill={catalogDrill}
            cascadeKey={0}
            onDrill={setCatalogDrill}
            onTrack={() => {
              setFindDrill(catalogDrill);
              setFindKey((k) => k + 1);
              goTab("find");
            }}
          />
        )}
      </div>

      {/* The page's status line. While the drawer is open the page behind it
          is inert, so the drawer carries its own copy of the line instead. */}
      {!drawer && (
        <NoticeLine notice={notice} onUndo={undo} onDismiss={() => setNotice(null)} floating />
      )}
      {drawer && (
        <CardDrawer
          card={getCard(drawer.cardId)}
          store={store}
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
