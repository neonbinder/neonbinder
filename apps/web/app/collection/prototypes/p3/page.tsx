import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { BookOpenIcon, ListBulletIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import { isEditableTarget } from "@/lib/dom/is-editable-target";
import PrototypeBanner, { prototypeName } from "../_shared/PrototypeBanner";
import { getCard, playerNames, sets, type Card, type Copy, type SetId } from "../_shared/data";
import { usePrototypeStore } from "../_shared/usePrototypeStore";
import CardDrawer from "./CardDrawer";
import ChecklistsBrowser from "./ChecklistsBrowser";
import { FOCUS, QUIET_BUTTON } from "./classes";
import { P3Context, type P3Api, type ToastAction } from "./context";
import FindCard from "./FindCard";
import NeedList from "./NeedList";
import OwnedShelf from "./OwnedShelf";
import Scoreboard from "./Scoreboard";
import Wall from "./Wall";
import "./p3.css";
import { ForceDark } from "@/components/primitives/ForceDark";

/**
 * NEO-350 — collection prototype 3, "Checklist Wall".
 *
 * No tabs: you land on your collection. Sets you're building sit on top as
 * LED scoreboards; open one and its checklist becomes a wall of number tiles,
 * lit when you have the card. Under the boards, everything else you own,
 * with binders down the side. Checklists (the catalogue) is a separate
 * top-level area, shown here as a stand-in view. Selling is left out on
 * purpose: "for sale" lives only in the copy details form.
 *
 * Kept as a signed-in reference at its own `/collection/<n>` route
 * (lazy-loaded). The shipped collection demo is `../../final`, built from
 * prototypes 1-3; this page is not developed further.
 */

interface Toast {
  id: number;
  message: string;
  undo?: () => void;
  extra?: ToastAction;
}

interface DrawerState {
  cardId: string;
  adding?: boolean;
  note?: string;
}

/** Set after the first render: later view changes move focus to the new view. */
let hasMounted = false;

const knownSet = (id: string | null): id is SetId => !!id && sets.some((s) => s.id === id);

function CollectionPrototype3Page() {
  const name = prototypeName(3);
  useDocumentTitle(`${name} · Collection prototype`);
  const store = usePrototypeStore("p3");
  const [params, setParams] = useSearchParams();
  const [toast, setToast] = useState<Toast | null>(null);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);

  useEffect(() => {
    hasMounted = true;
  }, []);
  const focusOnMount = hasMounted;

  const notify = useCallback((message: string, undo?: () => void, extra?: ToastAction) => {
    setToast((prev) => ({ id: (prev?.id ?? 0) + 1, message, undo, extra }));
  }, []);

  const openCard = useCallback((card: Card, opts?: { adding?: boolean; note?: string }) => {
    setDrawer({ cardId: card.id, ...opts });
  }, []);

  const api: P3Api = useMemo(() => {
    const label = (card: Card) =>
      `${card.variantPath.name ?? "Base"} #${card.cardNumber}${card.variation ? ` ${card.variation}` : ""} ${playerNames(card)}`;

    const addOne = (card: Card) => {
      const before = store.ownedCount(card.id);
      const copy = store.addCopy(card.id);
      notify(
        before > 0 ? `Another ${label(card)}. You have ${before + 1}.` : `Lit up ${label(card)}.`,
        () => store.removeCopy(copy.id),
        { label: "Add details", run: () => openCard(card) },
      );
    };

    const removeCopy = (copy: Copy) => {
      const removed = store.removeCopy(copy.id);
      if (!removed) return;
      const card = getCard(copy.cardId);
      notify(`Removed a copy of ${label(card)}.`, () => store.restoreCopy(removed));
    };

    return {
      store,
      notify,
      openCard,
      addOne,
      removeCopy,
      toggleHave: (card: Card) => {
        const copies = store.copiesOf(card.id);
        const count = store.ownedCount(card.id);
        if (count === 0) return addOne(card);
        if (copies.length === 1 && count === 1) {
          const removed = store.removeCopy(copies[0].id);
          if (removed) notify(`${label(card)} is a need again.`, () => store.restoreCopy(removed));
          return;
        }
        openCard(card, {
          note: `You have ${count} of these. Pick which copy goes, or edit one.`,
        });
      },
      addMany: (cards: Card[], summary: string) => {
        const added = cards.map((c) => store.addCopy(c.id));
        notify(summary, () => added.forEach((c) => store.removeCopy(c.id)));
      },
      openSet: (setId: SetId) => {
        setParams({ set: setId });
        window.scrollTo({ top: 0 });
      },
      go: (view, setId) => {
        if (view === "home") setParams({});
        else if (view === "needs") setParams(setId ? { view, for: setId } : { view });
        else setParams({ view });
        window.scrollTo({ top: 0 });
      },
    };
  }, [store, notify, openCard, setParams]);

  // Ctrl/Cmd+Z undoes the last add or remove, anywhere outside a text field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== "z" || !(e.ctrlKey || e.metaKey) || e.shiftKey) return;
      if (isEditableTarget(e.target) || !toast?.undo) return;
      e.preventDefault();
      toast.undo();
      setToast({ id: toast.id + 1, message: "Undone." });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toast]);

  const setParam = params.get("set");
  const view = knownSet(setParam) ? "wall" : (params.get("view") ?? "home");
  const needsFor = params.get("for");

  return (
    <P3Context.Provider value={api}>
      <div>
        <PrototypeBanner current={3} />

        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold text-white">My collection</h1>
            <p className="mt-1 text-sm text-slate-300">Every set you&apos;re chasing, lit up like a scoreboard.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => api.go("needs")} className={QUIET_BUTTON}>
              <ListBulletIcon aria-hidden="true" className="size-4" />
              Need list
            </button>
            <button
              type="button"
              onClick={() => api.go("checklists")}
              className={`${QUIET_BUTTON} border-neon-purple/80 hover:border-neon-purple`}
            >
              <BookOpenIcon aria-hidden="true" className="size-4 text-neon-purple-text" />
              Open Checklists (new top-level tab)
            </button>
          </div>
        </header>

        <FindCard />

        <div className="mt-8">
          {view === "wall" && <Wall key={setParam} setId={setParam as SetId} focusOnMount={focusOnMount} />}
          {view === "needs" && (
            <NeedList
              key={needsFor ?? "all"}
              onlySet={knownSet(needsFor) ? needsFor : undefined}
              focusOnMount={focusOnMount}
            />
          )}
          {view === "checklists" && <ChecklistsBrowser focusOnMount={focusOnMount} />}
          {view === "home" && (
            <>
              <Scoreboard />
              <OwnedShelf />
            </>
          )}
        </div>

        <footer className="mt-12 border-t border-slate-800 pt-4 text-sm text-slate-400">
          <button
            type="button"
            onClick={() => {
              store.reset();
              notify("Back to the demo collection.");
            }}
            className={`min-h-11 rounded-md underline-offset-4 hover:text-white hover:underline sm:min-h-8 ${FOCUS}`}
          >
            Reset the demo data
          </button>
        </footer>

        <div role="status" className="sr-only">
          {toast && <span key={toast.id}>{toast.message}</span>}
        </div>
        {toast && (
          <div className="fixed inset-x-4 bottom-4 z-50 flex items-center gap-2 rounded-xl border border-neon-blue/70 bg-slate-950 px-4 py-3 text-sm text-slate-100 shadow-[0_0_12px_2px_rgba(0,194,255,0.3)] sm:left-auto sm:right-6 sm:w-[28rem] lg:right-[194px]">
            <p className="min-w-0 flex-1">{toast.message}</p>
            {toast.undo && (
              <button
                type="button"
                onClick={() => {
                  toast.undo!();
                  setToast({ id: toast.id + 1, message: "Undone." });
                }}
                className={`min-h-11 rounded-md border border-neon-blue px-3 font-bold text-neon-blue hover:bg-neon-blue hover:text-black sm:min-h-8 ${FOCUS}`}
                title="Ctrl+Z"
              >
                Undo
              </button>
            )}
            {toast.extra && (
              <button
                type="button"
                onClick={() => {
                  toast.extra!.run();
                  setToast(null);
                }}
                className={`min-h-11 rounded-md px-2 text-slate-200 underline underline-offset-4 hover:text-white sm:min-h-8 ${FOCUS}`}
              >
                {toast.extra.label}
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss message"
              onClick={() => setToast(null)}
              className={`grid size-11 shrink-0 place-items-center rounded-md text-slate-400 hover:text-white sm:size-8 ${FOCUS}`}
            >
              <XMarkIcon aria-hidden="true" className="size-4" />
            </button>
          </div>
        )}

        {drawer && (
          <CardDrawer
            key={drawer.cardId}
            card={getCard(drawer.cardId)}
            adding={drawer.adding}
            note={drawer.note}
            onClose={() => setDrawer(null)}
          />
        )}
      </div>
    </P3Context.Provider>
  );
}

/**
 * NEO-356 — this prototype was only ever designed dark and is not migrated to
 * the colour roles, so it keeps the whole page dark while it is open, whatever
 * the collector's setting. Leaving restores their own mode.
 */
export default function CollectionPrototype3() {
  return (
    <ForceDark>
      <CollectionPrototype3Page />
    </ForceDark>
  );
}
