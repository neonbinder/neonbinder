import { useId, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router";
import { PlusIcon } from "@heroicons/react/24/outline";
import { Input } from "@/components/primitives/Input";
import { setLabel, setsInOrder, sports } from "../../prototypes/_shared/data";
import type { ViewKey } from "../../prototypes/p2/model";
import { useCollectionMode } from "../mode";
import { NO_BROWSE_FILTER, type BrowseFilter, type CollectionBinder, type CollectionStore } from "../store";
import { labelOf } from "./label";
import { binderTally, filterSets, isFiltering } from "./model";
import SpineLabel, { SpineFontFaces } from "./SpineLabel";

/**
 * The landing of My Binders (p2's shelf): the collector's binders standing
 * spine out, Main first. Beside them, the special shelf: All my cards, the
 * Want List and Up for Trade, plus the long box of Inventory, every other way
 * into the collection. Below, the clear binders: every set in the catalog,
 * to flip through, narrowed by sport, years and name.
 *
 * Spines wear their labels in the Print Shop's spine-label look (see
 * `SpineLabel.tsx`). The accessible name of every spine stays plain text:
 * name, count, smart or system role.
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

const SYSTEM_SPINE = 70;
const MASTER_SPINE = 96;

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
      <SpineFontFaces />
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
        Pull a binder off the shelf, or hunt for a card down below and we&apos;ll show you where it
        lives.{" "}
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
              <BinderSpine binder={main} store={store} index={0} onOpen={onOpen} />
            </li>
            {mine.map((b, i) => (
              <li key={b.id} className="flex-none">
                <BinderSpine binder={b} store={store} index={i + 1} onOpen={onOpen} />
              </li>
            ))}
            <li className="flex-none">
              <button
                type="button"
                onClick={onNewBinder}
                className="p2-spine p2-spine--new h-[196px] w-[58px] justify-center gap-3 text-slate-300 hover:text-white sm:h-[236px]"
                style={{ "--i": mine.length + 1 } as CSSProperties}
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
          <p className="mt-1 max-w-[22rem] px-1 text-sm text-slate-300">
            Everything at once, what you&apos;re chasing, what you&apos;d swap and what&apos;s for sale.
          </p>
          <ul className="p2-shelf nb-special-shelf" aria-label="Special places">
            <li className="flex-none">
              <MasterSpine total={total} current={selected === "all"} onOpen={() => onOpen({ kind: "all" })} />
            </li>
            <li className="flex-none">
              <BinderSpine binder={want} store={store} index={1} onOpen={onOpen} />
            </li>
            <li className="flex-none">
              <BinderSpine binder={trade} store={store} index={2} onOpen={onOpen} />
            </li>
            <li className="flex-none">
              <InventoryBox forSale={forSale} />
            </li>
          </ul>
          <div className="nb-special-ledge" aria-hidden="true" />
        </section>
      </div>

      <BrowseShelf store={store} onOpen={onOpen} />
    </div>
  );
}

function Pip({ on }: { on: boolean }) {
  return on ? <span aria-hidden="true" className="nb-pip" /> : null;
}

function MasterSpine({ total, current, onOpen }: { total: number; current: boolean; onOpen: () => void }) {
  const label = labelOf("all");
  return (
    <button
      type="button"
      onClick={onOpen}
      data-spine="all"
      aria-current={current ? "true" : undefined}
      aria-label={`All my cards, ${total} cards`}
      className={`p2-spine nb-spine h-[196px] sm:h-[236px]${current ? " nb-spine--current" : ""}`}
      style={{ "--vinyl": label.background, "--i": 0, width: MASTER_SPINE } as CSSProperties}
    >
      <SpineLabel name="All my cards" label={label} spineWidth={MASTER_SPINE} count={total} />
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
  const count = isWant ? { cards: store.wantCardIds.length } : binderTally(binder, copies);
  const label = labelOf(binder);
  const tracked = count.have !== undefined && count.need !== undefined;
  const current = store.selectedBinderId === binder.id;
  const name = [
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
  const width = binder.system ? SYSTEM_SPINE : spineWidth(size);
  let badge: ReactNode = null;
  if (binder.kind === "smart") {
    badge = (
      <span className="rounded-sm bg-neon-purple px-1 text-[10px] font-bold leading-4 text-black">Smart</span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpen({ kind: "binder", binderId: binder.id })}
      data-spine={binder.id}
      aria-current={current ? "true" : undefined}
      aria-label={name}
      className={`p2-spine nb-spine h-[196px] sm:h-[236px]${current ? " nb-spine--current" : ""}`}
      style={{ "--vinyl": label.background, "--i": index, width } as CSSProperties}
    >
      {binder.system === "trade" && (
        <span aria-hidden="true" className="nb-spine-tag">
          Trade
        </span>
      )}
      <SpineLabel
        name={binder.name}
        label={label}
        spineWidth={width}
        badge={badge}
        count={tracked ? `${count.have}/${(count.have ?? 0) + (count.need ?? 0)}` : count.cards}
      />
      <Pip on={current} />
    </button>
  );
}

/**
 * Inventory: not a binder but a dealer's long box, the one under the show
 * table. Tabbed dividers stand up out of it, a strip of tape names it, and
 * the yellow price tag (the same tag a for-sale card wears in its sleeve)
 * says how many are for sale.
 */
function InventoryBox({ forSale }: { forSale: number }) {
  const { inventoryHref } = useCollectionMode();
  return (
    <Link
      to={inventoryHref}
      aria-label={`Inventory, ${forSale} ${forSale === 1 ? "card" : "cards"} for sale`}
      className="nb-longbox"
    >
      <span aria-hidden="true" className="nb-longbox-stock">
        <span className="nb-longbox-divider" style={{ "--tab": "#00D558", "--at": "8%" } as CSSProperties} />
        <span className="nb-longbox-divider" style={{ "--tab": "#00C2FF", "--at": "38%" } as CSSProperties} />
        <span className="nb-longbox-divider" style={{ "--tab": "#FF2E9A", "--at": "66%" } as CSSProperties} />
      </span>
      <span aria-hidden="true" className="nb-longbox-box">
        <span className="nb-longbox-tape">Inventory</span>
        <span className="nb-longbox-handle" />
      </span>
      <span aria-hidden="true" className="nb-longbox-tag">
        {forSale} for sale
      </span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Browse a set
// ---------------------------------------------------------------------------

const ALL_SETS = setsInOrder();
const YEARS = [...new Set(ALL_SETS.map((s) => s.year))].sort((a, b) => a - b);

const FILTER_SELECT =
  "min-h-10 rounded-md border border-slate-600 bg-slate-900 px-2 text-sm text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]";

function BrowseShelf({ store, onOpen }: { store: CollectionStore; onOpen: (view: ViewKey) => void }) {
  const filter = store.browseFilter;
  const set = (patch: Partial<BrowseFilter>) => store.setBrowseFilter(patch);
  const shown = filterSets(ALL_SETS, filter);
  const filtering = isFiltering(filter);
  const countId = useId();

  const yearSelect = (key: "from" | "to", text: string) => (
    <label className="flex items-center gap-2 text-sm text-slate-300">
      {/* The select names itself: a wrapping label's name would include the
          chosen year ("From 1996"). */}
      <span aria-hidden="true">{text}</span>
      <select
        aria-label={key === "from" ? "From year" : "To year"}
        className={FILTER_SELECT}
        value={filter[key] ?? ""}
        onChange={(e) => set({ [key]: e.target.value ? Number(e.target.value) : null })}
      >
        <option value="">{key === "from" ? "Earliest" : "Latest"}</option>
        {YEARS.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <section aria-labelledby="nb-catalog-shelf" className="mt-12">
      <h3 id="nb-catalog-shelf" className="text-xl font-bold text-white">
        Browse a set
      </h3>
      <p className="mt-1 max-w-xl text-sm text-slate-300">
        Every card in the set, sleeve by sleeve. Spot one you&apos;ve got? Hit Add.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="group" aria-label="Sport" className="flex rounded-lg border border-slate-600 bg-slate-900 p-0.5">
          {[{ id: "all" as const, name: "All" }, ...sports].map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={filter.sport === s.id}
              // "All" alone is a substring of "Baseball" and "Football".
              aria-label={s.id === "all" ? "All sports" : undefined}
              onClick={() => set({ sport: s.id })}
              className={`min-h-9 rounded-md px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] max-sm:min-h-11 ${
                filter.sport === s.id ? "bg-neon-blue text-black" : "text-slate-200 hover:text-white"
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Years" className="flex flex-wrap items-center gap-2">
          {yearSelect("from", "From")}
          {yearSelect("to", "To")}
        </div>
        <Input
          bare
          type="search"
          surface="dark"
          aria-label="Find a set by name"
          placeholder="Find a set: try chrome"
          value={filter.q}
          onChange={(e) => set({ q: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape" && filter.q) {
              e.preventDefault();
              set({ q: "" });
            }
          }}
          className="min-h-10 w-full px-3 text-sm sm:w-56"
        />
        <p id={countId} aria-live="polite" className="text-sm tabular-nums text-slate-300">
          {shown.length} of {ALL_SETS.length} sets
        </p>
      </div>

      {shown.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-slate-600 px-4 py-8 text-center">
          <p className="text-slate-200">No sets on this shelf fit those filters.</p>
          <button
            type="button"
            onClick={() => store.setBrowseFilter(NO_BROWSE_FILTER)}
            className="mt-2 rounded-sm text-sm text-neon-blue underline underline-offset-2 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <>
          <ul className="p2-shelf mt-2" aria-label="Sets to browse" aria-describedby={countId}>
            {shown.map((cardSet, i) => {
              const c = store.completion(cardSet.id);
              return (
                <li key={cardSet.id} className="flex-none">
                  <button
                    type="button"
                    onClick={() => onOpen({ kind: "set", setId: cardSet.id })}
                    data-spine={`set:${cardSet.id}`}
                    aria-label={`Browse ${setLabel(cardSet)}, you have ${c.owned} of ${c.total}`}
                    className="p2-spine p2-spine--clear h-[180px] w-[64px] sm:h-[210px]"
                    style={{ "--i": i } as CSSProperties}
                  >
                    <span className="p2-spine-label" style={{ "--stripe": "#00C2FF" } as CSSProperties}>
                      <span className="p2-spine-name">{setLabel(cardSet)}</span>
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
          {filtering && (
            <button
              type="button"
              onClick={() => store.setBrowseFilter(NO_BROWSE_FILTER)}
              className="mt-2 rounded-sm text-sm text-neon-blue underline underline-offset-2 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
            >
              Clear filters
            </button>
          )}
        </>
      )}
    </section>
  );
}
