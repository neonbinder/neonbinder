import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { ListBulletIcon } from "@heroicons/react/24/outline";
import { playerNames, sets, type Card, type CardId, type SetId } from "../prototypes/_shared/data";
import { QUIET_BUTTON } from "../prototypes/p3/classes";
import BinderPicker from "./BinderPicker";
import FindCard from "./cards/FindCard";
import NeedList from "./cards/NeedList";
import OwnedShelf from "./cards/OwnedShelf";
import Scoreboard from "./cards/Scoreboard";
import Wall from "./cards/Wall";
import { MyCardsContext, type MyCardsApi, type MyCardsView } from "./cards/context";
import { tilePress, wallName } from "./cards/model";
import { lineSummary } from "./lineItems";
import type { CollectionTabProps } from "./store";
import "./cards/cards.css";

/**
 * NEO-350 — My Cards: prototype 3's Checklist Wall, on the shared store.
 *
 * You land on your collection. Sets you're building sit on top as LED
 * scoreboards; open one and its checklist becomes a wall of number tiles,
 * lit when you have the card. Under the boards, everything else you own,
 * with binders down the side. The binder picker narrows every count and
 * light to one binder, and Have files into it.
 *
 * Where you are inside the tab rides on the URL next to `?tab=cards`:
 * `&set=<id>` is a set's wall, `&view=needs[&for=<id>]` the need list.
 */

const knownSet = (id: string | null): id is SetId => !!id && sets.some((s) => s.id === id);

export default function MyCardsTab(props: CollectionTabProps) {
  const { store, openCard, goToTab, notify } = props;
  const [params, setParams] = useSearchParams();

  const setParam = params.get("set");
  const view: "wall" | MyCardsView = knownSet(setParam)
    ? "wall"
    : params.get("view") === "needs"
      ? "needs"
      : "home";
  const needsFor = params.get("for");
  const viewKey = `${view}|${setParam ?? ""}|${needsFor ?? ""}`;

  // Focus moves to the new view only once the collector has moved inside the
  // tab; landing on the tab leaves focus on the tab strip.
  const [lastKey, setLastKey] = useState(viewKey);
  const [moved, setMoved] = useState(false);
  const [cameFrom, setCameFrom] = useState<SetId | null>(null);
  if (lastKey !== viewKey) {
    setLastKey(viewKey);
    setMoved(true);
  }

  const scopedName = store.fileableBinders.find((b) => b.id === store.selectedBinderId)?.name ?? null;

  const go = useCallback(
    (next: MyCardsView, setId?: SetId) => {
      setCameFrom(knownSet(setParam) ? setParam : null);
      if (next === "home") setParams({ tab: "cards" });
      else setParams(setId ? { tab: "cards", view: next, for: setId } : { tab: "cards", view: next });
      window.scrollTo({ top: 0 });
    },
    [setParam, setParams],
  );

  const api: MyCardsApi = useMemo(() => {
    const label = (card: Card) => wallName(card, playerNames(card));
    const into = () => store.getBinder(store.targetBinderId)?.name ?? "Main";

    const addOne = (card: Card) => {
      const before = store.ownedInScope(card.id);
      const copy = store.addHave(card.id);
      notify(
        before > 0
          ? `Another ${label(card)}, into ${into()}. That's ${before + 1}.`
          : `Lit up ${label(card)}, into ${into()}.`,
        () => store.removeCopy(copy.id),
      );
    };

    return {
      store,
      openCard,
      goToTab,
      notify,
      scopedName,
      label,
      addOne,
      toggleHave: (card: Card, list: CardId[]) => {
        const press = tilePress(store.copiesInScope(card.id));
        if (press.kind === "add") return addOne(card);
        if (press.kind === "remove") {
          const removed = store.removeCopy(press.copy.id);
          if (removed) {
            notify(
              `${label(card)} is a need again. Removed ${lineSummary(removed, store.state.binders)}.`,
              () => store.restoreCopy(removed),
            );
          }
          return;
        }
        openCard(card.id, { list });
        notify(`You have ${press.owned} of ${label(card)}. Pick the copy that goes.`);
      },
      addMany: (cards: Card[], summary: (into: string) => string) => {
        const where = into();
        const added = cards.map((c) => store.addHave(c.id));
        notify(summary(where), () => added.forEach((c) => store.removeCopy(c.id)));
      },
      openSet: (setId: SetId) => {
        setParams({ tab: "cards", set: setId });
        window.scrollTo({ top: 0 });
      },
      go,
    };
  }, [store, notify, openCard, goToTab, scopedName, setParams, go]);

  return (
    <MyCardsContext.Provider value={api}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <p className="text-sm text-slate-300">Every set you&apos;re chasing, lit up like a scoreboard.</p>
          <div className="flex flex-wrap items-center gap-3">
            <BinderPicker store={store} />
            <button type="button" onClick={() => go("needs")} className={QUIET_BUTTON}>
              <ListBulletIcon aria-hidden="true" className="size-4" />
              Need list
            </button>
          </div>
        </div>
        {scopedName && (
          <p className="rounded-md border border-neon-blue/50 bg-neon-blue/5 px-3 py-2 text-sm text-slate-200">
            Counting only what&apos;s in <span className="font-semibold text-neon-blue">{scopedName}</span>. New haves
            go there too.
          </p>
        )}

        <FindCard />

        <div className="pt-4">
          {view === "wall" && <Wall key={setParam} setId={setParam as SetId} focusOnMount={moved} />}
          {view === "needs" && (
            <NeedList
              key={needsFor ?? "all"}
              onlySet={knownSet(needsFor) ? needsFor : undefined}
              focusOnMount={moved}
            />
          )}
          {view === "home" && (
            <>
              <Scoreboard returnTo={moved ? cameFrom : null} />
              <OwnedShelf />
            </>
          )}
        </div>
      </div>
    </MyCardsContext.Provider>
  );
}
