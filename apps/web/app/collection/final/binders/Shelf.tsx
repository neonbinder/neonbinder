import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router";
import { PlusIcon } from "@heroicons/react/24/outline";
import { setLabel, setsInOrder } from "../../prototypes/_shared/data";
import { binderCount, type ViewKey } from "../../prototypes/p2/model";
import type { CollectionBinder, CollectionStore } from "../store";
import { liveryOf } from "./model";

/**
 * The landing of My Binders (p2's shelf): the collector's binders standing
 * spine out, "All my cards" and Main first. Beside them, the special shelf:
 * Want List and Up for Trade, plus a door to Inventory, every other place a
 * card lives. Below, the clear binders: every set in the catalog, to flip
 * through.
 *
 * The spine of the binder the page is scoped to stands a little proud with a
 * lit pip on the ledge, so the shelf says what Checklists and My Cards are
 * looking through.
 */

interface ShelfProps {
  store: CollectionStore;
  onOpen: (view: ViewKey) => void;
  onNewBinder: () => void;
}

function spineWidth(n: number): number {
  return Math.round(Math.min(96, Math.max(54, 46 + n * 0.9)));
}

export default function Shelf({ store, onOpen, onNewBinder }: ShelfProps) {
  const { copies } = store.state;
  const total = copies.reduce((n, c) => n + c.quantity, 0);
  const forSale = copies.filter((c) => c.forSale).reduce((n, c) => n + c.quantity, 0);
  const main = store.systemBinder("main");
  const want = store.systemBinder("want");
  const trade = store.systemBinder("trade");
  const own = store.ownBinders;
  const mine = [...own.filter((b) => b.kind === "manual"), ...own.filter((b) => b.kind === "smart")];
  const selected = store.selectedBinderId;
  const scopeName = selected === "all" ? null : store.getBinder(selected)?.name;

  return (
    <div>
      <h2 tabIndex={-1} data-shelf-heading className="sr-only">
        My Binders
      </h2>
      <p
        className="neon-header text-[1.7rem] leading-tight text-white sm:text-[2.1rem]"
        style={{ textShadow: "0 0 18px rgba(0,194,255,0.55), 0 0 2px #00C2FF" }}
      >
        {total} cards, {store.state.binders.length} binders, {forSale} for sale.
      </p>
      <p className="mt-2 max-w-2xl text-slate-300">
        Pull one off the shelf, or rip a pack down below to add cards.{" "}
        {scopeName ? (
          <>
            Checklists and My Cards are looking through <strong className="text-white">{scopeName}</strong>.
          </>
        ) : (
          <>Checklists and My Cards are looking through everything.</>
        )}
      </p>

      <div className="mt-6 grid gap-x-8 gap-y-10 xl:grid-cols-[minmax(0,1fr)_auto]">
        <section aria-labelledby="nb-my-shelf" className="min-w-0">
          <h3 id="nb-my-shelf" className="text-xl font-bold text-white">
            Your binders
          </h3>
          <ul className="p2-shelf mt-1" aria-label="Your binders">
            <li className="flex-none">
              <MasterSpine total={total} current={selected === "all"} onOpen={() => onOpen({ kind: "all" })} />
            </li>
            <li className="flex-none">
              <BinderSpine binder={main} store={store} index={1} onOpen={onOpen} />
            </li>
            {mine.map((b, i) => (
              <li key={b.id} className="flex-none">
                <BinderSpine binder={b} store={store} index={i + 2} onOpen={onOpen} />
              </li>
            ))}
            <li className="flex-none">
              <button
                type="button"
                onClick={onNewBinder}
                className="p2-spine p2-spine--new h-[196px] w-[58px] justify-center gap-3 text-slate-300 hover:text-white sm:h-[236px]"
                style={{ "--i": mine.length + 2 } as CSSProperties}
              >
                <PlusIcon aria-hidden="true" className="h-6 w-6 shrink-0" />
                <span className="p2-spine-name text-sm font-bold">New binder</span>
              </button>
            </li>
          </ul>
          <div className="p2-ledge" aria-hidden="true" />
        </section>

        <section aria-labelledby="nb-special-shelf" className="nb-special w-fit max-w-full min-w-0">
          <h3 id="nb-special-shelf" className="nb-special-sign">
            Special places
          </h3>
          <p className="mt-1 px-1 text-sm text-slate-300">Where cards live besides your binders.</p>
          <ul className="p2-shelf nb-special-shelf" aria-label="Special places">
            <li className="flex-none">
              <BinderSpine binder={want} store={store} index={0} onOpen={onOpen} />
            </li>
            <li className="flex-none">
              <BinderSpine binder={trade} store={store} index={1} onOpen={onOpen} />
            </li>
            <li className="flex-none">
              <InventoryDoor forSale={forSale} />
            </li>
          </ul>
          <div className="nb-special-ledge" aria-hidden="true" />
        </section>
      </div>

      <section aria-labelledby="nb-catalog-shelf" className="mt-12">
        <h3 id="nb-catalog-shelf" className="text-xl font-bold text-white">
          Browse a set
        </h3>
        <p className="mt-1 max-w-xl text-sm text-slate-300">
          Every card in the set, sleeve by sleeve. Spot one you&apos;ve got? Hit Add.
        </p>
        <ul className="p2-shelf mt-2" aria-label="Sets to browse">
          {setsInOrder().map((set, i) => {
            const c = store.completion(set.id);
            return (
              <li key={set.id} className="flex-none">
                <button
                  type="button"
                  onClick={() => onOpen({ kind: "set", setId: set.id })}
                  data-spine={`set:${set.id}`}
                  aria-label={`Browse ${setLabel(set)}, you have ${c.owned} of ${c.total}`}
                  className="p2-spine p2-spine--clear h-[180px] w-[64px] sm:h-[210px]"
                  style={{ "--i": i } as CSSProperties}
                >
                  <span className="p2-spine-label" style={{ "--stripe": "#00C2FF" } as CSSProperties}>
                    <span className="p2-spine-name">{setLabel(set)}</span>
                    <span className="p2-spine-count">
                      {c.owned}/{c.total}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="p2-ledge" aria-hidden="true" />
      </section>
    </div>
  );
}

function Pip({ on }: { on: boolean }) {
  return on ? <span aria-hidden="true" className="nb-pip" /> : null;
}

function MasterSpine({ total, current, onOpen }: { total: number; current: boolean; onOpen: () => void }) {
  const liv = liveryOf("all");
  return (
    <button
      type="button"
      onClick={onOpen}
      data-spine="all"
      aria-current={current ? "true" : undefined}
      aria-label={`All my cards, ${total} cards`}
      className={`p2-spine h-[212px] w-[96px] sm:h-[252px]${current ? " nb-spine--current" : ""}`}
      style={{ "--vinyl": liv.primary, "--stripe": liv.secondary, "--i": 0 } as CSSProperties}
    >
      <span className="p2-spine-label">
        <span className="p2-spine-name text-base">All my cards</span>
        <span className="p2-spine-count">{total}</span>
      </span>
      <Pip on={current} />
    </button>
  );
}

function BinderSpine({
  binder,
  store,
  index,
  onOpen,
}: {
  binder: CollectionBinder;
  store: CollectionStore;
  index: number;
  onOpen: (view: ViewKey) => void;
}) {
  const { copies } = store.state;
  const isWant = binder.system === "want";
  const count = isWant ? { cards: store.wantCardIds.length } : binderCount(binder, copies);
  const liv = liveryOf(binder);
  const tracked = count.have !== undefined && count.need !== undefined;
  const current = store.selectedBinderId === binder.id;
  const label = [
    binder.name,
    binder.kind === "smart" ? "smart binder" : null,
    isWant
      ? `${count.cards} ${count.cards === 1 ? "card" : "cards"} wanted`
      : tracked
        ? `${count.have} have, ${count.need} need`
        : `${count.cards} cards`,
  ]
    .filter(Boolean)
    .join(", ");
  const size = tracked ? (count.have ?? 0) + (count.need ?? 0) : count.cards;
  let badge: ReactNode = null;
  if (binder.kind === "smart") {
    badge = (
      <span className="-mt-1 rounded-sm bg-neon-purple px-1 text-[10px] font-bold leading-4 text-black">
        Smart
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpen({ kind: "binder", binderId: binder.id })}
      data-spine={binder.id}
      aria-current={current ? "true" : undefined}
      aria-label={label}
      className={`p2-spine h-[196px] sm:h-[236px]${current ? " nb-spine--current" : ""}`}
      style={
        {
          "--vinyl": liv.primary,
          "--stripe": liv.secondary,
          "--i": index,
          width: binder.system ? 70 : spineWidth(size),
        } as CSSProperties
      }
    >
      {binder.system === "trade" && (
        <span aria-hidden="true" className="nb-spine-tag">
          Trade
        </span>
      )}
      <span className="p2-spine-label">
        {badge}
        <span className="p2-spine-name">{binder.name}</span>
        <span className="p2-spine-count">
          {tracked ? `${count.have}/${(count.have ?? 0) + (count.need ?? 0)}` : count.cards}
        </span>
      </span>
      <Pip on={current} />
    </button>
  );
}

/** Inventory: not a binder but a door, the room where listed cards wait. */
function InventoryDoor({ forSale }: { forSale: number }) {
  return (
    <Link
      to="/inventory"
      aria-label={`Inventory, ${forSale} ${forSale === 1 ? "card" : "cards"} for sale`}
      className="nb-door h-[196px] w-[96px] sm:h-[236px]"
    >
      <span aria-hidden="true" className="nb-door-window" />
      <span aria-hidden="true" className="nb-door-sign">
        Inventory
      </span>
      <span aria-hidden="true" className="nb-door-knob" />
      <span aria-hidden="true" className="nb-door-count">
        {forSale} for sale
      </span>
    </Link>
  );
}
