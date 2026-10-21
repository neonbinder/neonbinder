import type { CSSProperties, RefObject } from "react";
import { PlusIcon } from "@heroicons/react/24/outline";
import { setLabel, setsInOrder, type Binder } from "../_shared/data";
import type { PrototypeStore } from "../_shared/usePrototypeStore";
import { binderCount, binderLivery, type ViewKey } from "./model";

/**
 * The landing: the collector's binders standing on a shelf, spine out, each
 * with a printed label in its team's colours. Below, a second shelf of clear
 * binders: every set in the catalog, ready to flip through.
 */

interface ShelfProps {
  store: PrototypeStore;
  h1Ref: RefObject<HTMLHeadingElement | null>;
  onOpen: (view: ViewKey) => void;
  onNewBinder: () => void;
}

function spineWidth(n: number): number {
  return Math.round(Math.min(96, Math.max(54, 46 + n * 0.9)));
}

export default function Shelf({ store, h1Ref, onOpen, onNewBinder }: ShelfProps) {
  const { copies, binders } = store.state;
  const total = copies.reduce((n, c) => n + c.quantity, 0);
  const forSale = copies.filter((c) => c.forSale).length;
  const manual = binders.filter((b) => b.kind === "manual");
  const smart = binders.filter((b) => b.kind === "smart");

  return (
    <div>
      <h1
        ref={h1Ref}
        tabIndex={-1}
        className="neon-header text-[2.4rem] leading-none text-white focus:outline-none sm:text-5xl"
        style={{ textShadow: "0 0 18px rgba(0,194,255,0.55), 0 0 2px #00C2FF" }}
      >
        My binders
      </h1>
      <p className="mt-3 max-w-xl text-slate-300">
        {total} cards, {binders.length} binders, {forSale} for sale. Pull one off the shelf,
        or rip a pack down below to add cards.
      </p>

      <section aria-labelledby="p2-my-shelf" className="mt-8">
        <h2 id="p2-my-shelf" className="sr-only">
          Your binders
        </h2>
        <ul className="p2-shelf" aria-label="Your binders">
          <li className="flex-none">
            <MasterSpine total={total} onOpen={() => onOpen({ kind: "all" })} index={0} />
          </li>
          {[...manual, ...smart].map((b, i) => (
            <li key={b.id} className="flex-none">
              <BinderSpine binder={b} store={store} index={i + 1} onOpen={onOpen} />
            </li>
          ))}
          <li className="flex-none">
            <button
              type="button"
              onClick={onNewBinder}
              className="p2-spine p2-spine--new h-[196px] w-[58px] justify-center gap-3 text-slate-300 hover:text-white sm:h-[236px]"
              style={{ "--i": binders.length + 1 } as CSSProperties}
            >
              <PlusIcon aria-hidden="true" className="h-6 w-6 shrink-0" />
              <span className="p2-spine-name text-sm font-bold">New binder</span>
            </button>
          </li>
        </ul>
        <div className="p2-ledge" aria-hidden="true" />
      </section>

      <section aria-labelledby="p2-catalog-shelf" className="mt-12">
        <h2 id="p2-catalog-shelf" className="text-xl font-bold text-white">
          Browse a set
        </h2>
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

      <p className="mt-10 text-sm text-slate-400">
        This prototype remembers your changes until you close the tab.{" "}
        <button
          type="button"
          onClick={store.reset}
          className="rounded text-slate-200 underline underline-offset-4 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
        >
          Start the demo over
        </button>
      </p>
    </div>
  );
}

function MasterSpine({ total, onOpen, index }: { total: number; onOpen: () => void; index: number }) {
  const liv = binderLivery("all");
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`All my cards, ${total} cards`}
      className="p2-spine h-[212px] w-[96px] sm:h-[252px]"
      style={{ "--vinyl": liv.primary, "--stripe": liv.secondary, "--i": index } as CSSProperties}
    >
      <span className="p2-spine-label">
        <span className="p2-spine-name text-base">All my cards</span>
        <span className="p2-spine-count">{total}</span>
      </span>
    </button>
  );
}

function BinderSpine({
  binder,
  store,
  index,
  onOpen,
}: {
  binder: Binder;
  store: PrototypeStore;
  index: number;
  onOpen: (view: ViewKey) => void;
}) {
  const { copies } = store.state;
  const count = binderCount(binder, copies);
  const liv = binderLivery(binder);
  const tracked = count.have !== undefined && count.need !== undefined;
  const label = [
    binder.name,
    binder.kind === "smart" ? "smart binder" : null,
    tracked ? `${count.have} have, ${count.need} need` : `${count.cards} cards`,
  ]
    .filter(Boolean)
    .join(", ");
  const size = tracked ? (count.have ?? 0) + (count.need ?? 0) : count.cards;

  return (
    <button
      type="button"
      onClick={() => onOpen({ kind: "binder", binderId: binder.id })}
      aria-label={label}
      className="p2-spine h-[196px] sm:h-[236px]"
      style={
        {
          "--vinyl": liv.primary,
          "--stripe": liv.secondary,
          "--i": index,
          width: spineWidth(size),
        } as CSSProperties
      }
    >
      <span className="p2-spine-label">
        {binder.kind === "smart" && (
          <span className="-mt-1 rounded-sm bg-neon-purple px-1 text-[10px] font-bold leading-4 text-black">
            Smart
          </span>
        )}
        <span className="p2-spine-name">{binder.name}</span>
        <span className="p2-spine-count">
          {tracked ? `${count.have}/${(count.have ?? 0) + (count.need ?? 0)}` : count.cards}
        </span>
      </span>
    </button>
  );
}
