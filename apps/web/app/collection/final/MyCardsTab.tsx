import { useCallback, useMemo, useState } from "react";
import { ListBulletIcon } from "@heroicons/react/24/outline";
import { QUIET_BUTTON } from "../prototypes/p3/classes";
import BinderPicker from "./BinderPicker";
import { useHomeName, useScopedName } from "./catalog/home";
import FindCard from "./cards/FindCard";
import { MyCardsContext, type MyCardsApi, type MyCardsView } from "./cards/context";
import { tilePress, wallName } from "./cards/model";
import NeedList from "./cards/NeedList";
import OwnedShelf, { CollectionTally } from "./cards/OwnedShelf";
import Scoreboard from "./cards/Scoreboard";
import Wall from "./cards/Wall";
import { playerNames } from "./data/labels";
import { useCapabilities, useCollectionActions, useDemoExtension } from "./data/store";
import type { Card, SetId } from "./data/types";
import { lineSummary } from "./lineItems";
import { useCollectionParams } from "./mode";
import { usePageApi } from "./pageApi";
import "./cards/cards.css";

/**
 * NEO-350 / NEO-358 — My Cards: prototype 3's Checklist Wall, on the store.
 *
 * You land on your collection. Sets you're building sit on top as LED
 * scoreboards; open one and its checklist becomes a wall of number tiles,
 * lit when you have the card. "Sets I'm building" is the collector's own
 * pick (the set picker, or Stop building on a wall), never guessed.
 *
 * In the demo, the binder picker narrows every count and light to one
 * binder, Have files into it, and the shelf below lists binders.
 *
 * Where you are inside the tab rides on the URL next to `?tab=cards`:
 * `&set=<id>` is a set's wall, `&view=needs[&for=<id>]` the need list.
 */
export default function MyCardsTab() {
  const page = usePageApi();
  const writes = useCollectionActions();
  const capabilities = useCapabilities();
  const demo = useDemoExtension();
  const [params, setParams] = useCollectionParams();
  const into = useHomeName();
  const scopedName = useScopedName();

  const setParam = params.get("set");
  const view: "wall" | MyCardsView = setParam ? "wall" : params.get("view") === "needs" ? "needs" : "home";
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

  const go = useCallback(
    (next: MyCardsView, setId?: SetId) => {
      setCameFrom(setParam);
      if (next === "home") setParams({ tab: "cards" });
      else setParams(setId ? { tab: "cards", view: next, for: setId } : { tab: "cards", view: next });
      window.scrollTo({ top: 0 });
    },
    [setParam, setParams],
  );

  const wants = capabilities.wants ? demo?.state : undefined;
  const binders = demo?.state.state.binders;

  const api: MyCardsApi = useMemo(() => {
    const label = (card: Card) => wallName(card, playerNames(card));

    const addOne = (card: Card, owned = 0) => {
      void page.run(
        () => writes.addHave(card),
        () =>
          owned > 0
            ? `Another ${label(card)}, into ${into}. That's ${owned + 1}.`
            : `Lit up ${label(card)}, into ${into}.`,
      );
    };

    return {
      ...page,
      label,
      addOne,
      into,
      scopedName,
      isWanted: (cardId) => wants?.isWanted(cardId) ?? false,
      toggleHave: (card, copies, list) => {
        const press = tilePress(copies);
        if (press.kind === "add") return addOne(card);
        if (press.kind === "remove") {
          void page.run(
            () => writes.removeCopy(press.copy),
            (r) => `${label(card)} is a need again. Removed ${lineSummary(r.removed, binders)}.`,
          );
          return;
        }
        page.openCard(card.id, { list, seed: card });
        page.notify(`You have ${press.owned} of ${label(card)}. Pick the copy that goes.`);
      },
      addMany: (cards, summary) => {
        void page.run(
          () => writes.addMany(cards),
          () => summary(into),
        );
      },
      openSet: (setId) => {
        setParams({ tab: "cards", set: setId });
        window.scrollTo({ top: 0 });
      },
      go,
    };
  }, [page, writes, into, scopedName, wants, binders, setParams, go]);

  return (
    <MyCardsContext.Provider value={api}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <p className="text-sm text-ink-2">Every set you&apos;re chasing, lit up like a scoreboard.</p>
          <div className="flex flex-wrap items-center gap-3">
            {capabilities.scope && demo && <BinderPicker store={demo.state} />}
            <button type="button" onClick={() => go("needs")} className={QUIET_BUTTON}>
              <ListBulletIcon aria-hidden="true" className="size-4" />
              Need list
            </button>
          </div>
        </div>
        {scopedName && (
          <p className="rounded-md border border-neon-blue/50 bg-neon-blue/5 px-3 py-2 text-sm text-ink-2">
            Counting only what&apos;s in <span className="font-semibold text-neon-blue-text">{scopedName}</span>. New haves
            go there too.
          </p>
        )}

        <FindCard />

        <div className="pt-4">
          {view === "wall" && setParam && <Wall key={setParam} setId={setParam} focusOnMount={moved} />}
          {view === "needs" && <NeedList key={needsFor ?? "all"} onlySet={needsFor ?? undefined} focusOnMount={moved} />}
          {view === "home" && (
            <>
              <Scoreboard returnTo={moved ? cameFrom : null} />
              {capabilities.binders && demo ? <OwnedShelf /> : <CollectionTally />}
            </>
          )}
        </div>
      </div>
    </MyCardsContext.Provider>
  );
}
