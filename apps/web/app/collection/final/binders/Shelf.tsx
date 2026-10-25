import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router";
import { PlusIcon } from "@heroicons/react/24/outline";
import { Input } from "@/components/primitives/Input";
import { useSearchText } from "../catalog/search";
import { LoadingNote, SkeletonBars } from "../catalog/Skeleton";
import { setLabel } from "../data/labels";
import {
  boxesOf,
  searchable,
  systemContainer,
  useBuildingSets,
  useCapabilities,
  useContainers,
  useDemoExtension,
  useScope,
  useSetCompletion,
  useSuggestions,
  useSummary,
} from "../data/store";
import type { Container, ContainerCount, SetRef } from "../data/types";
import { ParamLink, SideLink, useCollectionMode } from "../mode";
import { NO_BROWSE_FILTER, type BrowseFilter } from "../store";
import { useLabelHints } from "./hooks";
import IdTooltip, { IdLines } from "./IdTooltip";
import { labelOf } from "./label";
import { cardCount, filterSets, isFiltering, sportsOf, type ViewKey } from "./model";
import SpineLabel, { SpineFontFaces } from "./SpineLabel";
import "./box.css";

/**
 * The landing of My Binders (p2's shelf): the collector's binders standing
 * spine out, Main first. Boxes are not here, Unsorted included: they are the
 * inventory's (`InventoryShelf`, My Boxes). Beside them, the special shelf:
 * All my cards, the Want List and Up for Trade, plus the long box of
 * Inventory, the door to the Inventory list (`/inventory`, NEO-364). Below,
 * the clear binders: sets to flip through. The demo has a
 * whole catalog there, narrowed by sport, years and name; the real
 * collection shows the sets you're building and a set search.
 *
 * Spines wear their labels in the Print Shop's spine-label look (see
 * `SpineLabel.tsx`); a box on My Boxes wears its label as the tape on its end.
 * The accessible name of every spine stays plain text: name, count, smart
 * or system role.
 *
 * Every spine's lettering can be cut short, so hovering or focusing one
 * raises an identity slip (`IdTooltip`): a set's full season and name, a
 * binder's full name with its own words and its count.
 *
 * The spine of the home the page is scoped to stands a little proud with a
 * lit pip on the ledge, so the shelf says what Checklists and My Cards are
 * looking through.
 */

interface ShelfProps {
  onOpen: (view: ViewKey) => void;
  onNewBinder: () => void;
}

function spineWidth(n: number): number {
  return Math.round(Math.min(96, Math.max(54, 46 + n * 0.9)));
}

const SYSTEM_SPINE = 70;
const MASTER_SPINE = 96;
const SPINE_H = "h-[196px] sm:h-[236px]";

/** The cards a count stands for: physical copies; null while unknown. */
function copiesIn(count: ContainerCount | null): number | null {
  return count ? count.copies : null;
}

/** A box you sell from (not a smart one; Unsorted included): the inventory's, never the collection's shelf. */
function isSaleBox(c: Container): boolean {
  return c.kind === "box" && !c.rule;
}

/** Copies in every box, Unsorted included: what is for sale. Null while a box's count is unknown. */
export function forSaleCount(containers: readonly Container[] | undefined): number | null {
  if (!containers) return null;
  let n = 0;
  for (const c of containers) {
    if (c.kind !== "box" || c.rule) continue;
    if (!c.count) return null;
    n += c.count.copies;
  }
  return n;
}

export default function Shelf({ onOpen, onNewBinder }: ShelfProps) {
  const containers = useContainers();
  const summary = useSummary();
  const scope = useScope();

  if (!containers) {
    return (
      <div>
        <h2 tabIndex={-1} data-shelf-heading className="sr-only">
          My Binders
        </h2>
        <LoadingNote>Pulling your binders off the shelf…</LoadingNote>
        <SkeletonBars rows={4} className="mt-4" />
      </div>
    );
  }

  const main = systemContainer(containers, "main");
  const want = systemContainer(containers, "want");
  const trade = systemContainer(containers, "trade");
  // Binders only: boxes are Inventory's (they never stand on this shelf).
  const own = containers.filter((c) => !c.system && !isSaleBox(c));
  const mine = [...own.filter((c) => !c.rule), ...own.filter((c) => c.rule)];
  const binders = containers.filter((c) => c.kind === "binder" && c.system !== "want" && c.system !== "trade").length;
  const forSale = forSaleCount(containers);
  const scoped = scope === "all" ? null : containers.find((c) => c.id === scope);
  const total = summary ? summary.copies : null;
  const totalText = total === null ? "Your" : `${total.toLocaleString("en-US")}${summary?.exact ? "" : "+"}`;

  return (
    <div>
      <SpineFontFaces />
      <h2 tabIndex={-1} data-shelf-heading className="sr-only">
        My Binders
      </h2>
      <p className="neon-header nb-glow-title text-[1.7rem] leading-tight text-ink sm:text-[2.1rem]">
        {totalText} {total === 1 ? "card" : "cards"}, {binders} {binders === 1 ? "binder" : "binders"}.
      </p>
      <p className="mt-2 max-w-2xl text-ink-2">
        Pull a binder off the shelf, or hunt for a card down below and we&apos;ll show you where it lives.{" "}
        {scoped ? (
          <>
            Checklists and My Cards are looking through <strong className="text-ink">{scoped.name}</strong>.
          </>
        ) : (
          <>Checklists and My Cards are looking through everything.</>
        )}
      </p>

      <div className="mt-6 grid gap-x-8 gap-y-10 xl:grid-cols-[minmax(0,1fr)_auto]">
        <section aria-labelledby="nb-my-shelf" className="min-w-0">
          <h3 id="nb-my-shelf" className="text-xl font-bold text-ink">
            Your binders
          </h3>
          <ul className="p2-shelf mt-1" aria-label="Your binders">
            {main && (
              <li className="flex-none">
                <BinderSpine container={main} current={scope === main.id} index={0} onOpen={onOpen} />
              </li>
            )}
            {mine.map((c, i) => (
              <li key={c.id} className="flex-none">
                <BinderSpine container={c} current={scope === c.id} index={i + 1} onOpen={onOpen} />
              </li>
            ))}
            <li className="flex-none">
              <button
                type="button"
                onClick={onNewBinder}
                className={`p2-spine p2-spine--new w-[58px] justify-center gap-3 text-ink-2 hover:text-ink ${SPINE_H}`}
                style={{ "--i": mine.length + 1 } as CSSProperties}
              >
                <PlusIcon aria-hidden="true" className="h-6 w-6 shrink-0" />
                <span className="p2-spine-name text-sm font-bold">New binder</span>
              </button>
            </li>
          </ul>
          <div className="p2-ledge shelf-ledge" aria-hidden="true" />
        </section>

        <section aria-labelledby="nb-special-shelf" className="nb-special w-fit max-w-full min-w-0">
          <h3 id="nb-special-shelf" className="nb-special-sign">
            Special places
          </h3>
          <p className="mt-1 max-w-[22rem] px-1 text-sm text-ink-2">
            Everything at once, what you&apos;re chasing, what you&apos;d swap and what&apos;s for sale.
          </p>
          <ul className="p2-shelf nb-special-shelf" aria-label="Special places">
            <li className="flex-none">
              <MasterSpine total={total} current={scope === "all"} onOpen={() => onOpen({ kind: "all" })} />
            </li>
            {want && (
              <li className="flex-none">
                <BinderSpine container={want} current={false} index={1} onOpen={onOpen} />
              </li>
            )}
            {trade && (
              <li className="flex-none">
                <BinderSpine container={trade} current={false} index={2} onOpen={onOpen} />
              </li>
            )}
            <li className="flex-none">
              <InventoryBox forSale={forSale} to="inventory" />
            </li>
          </ul>
          <div className="nb-special-ledge shelf-ledge-special" aria-hidden="true" />
        </section>
      </div>

      <BrowseShelf onOpen={onOpen} />
    </div>
  );
}

function Pip({ on }: { on: boolean }) {
  return on ? <span aria-hidden="true" className="nb-pip" /> : null;
}

function MasterSpine({ total, current, onOpen }: { total: number | null; current: boolean; onOpen: () => void }) {
  const label = labelOf("all");
  const words = total === null ? "counting" : cardCount(total);
  return (
    <IdTooltip content={<IdLines title="All my cards" lines={[words]} />}>
      <button
        type="button"
        onClick={onOpen}
        data-spine="all"
        aria-current={current ? "true" : undefined}
        aria-label={`All my cards, ${words}`}
        className={`p2-spine nb-spine ${SPINE_H}${current ? " nb-spine--current" : ""}`}
        style={{ "--vinyl": label.background, "--i": 0, width: MASTER_SPINE } as CSSProperties}
      >
        <SpineLabel name="All my cards" label={label} spineWidth={MASTER_SPINE} count={total ?? "…"} />
        <Pip on={current} />
      </button>
    </IdTooltip>
  );
}

/** What a spine's count says, in words, by what the container is. */
function tallyWords(container: Container): string {
  const n = copiesIn(container.count);
  if (container.system === "want") {
    const wants = container.count?.lines ?? null;
    return wants === null ? "counting wants" : `${wants.toLocaleString("en-US")} ${wants === 1 ? "card" : "cards"} wanted`;
  }
  if (n === null) return "counting";
  if (container.system === "trade") return `${cardCount(n)} up for trade`;
  return cardCount(n);
}

function BinderSpine({
  container,
  current,
  index,
  onOpen,
}: {
  container: Container;
  current: boolean;
  index: number;
  onOpen: (view: ViewKey) => void;
}) {
  const { describeRule } = useDemoExtension() ?? {};
  const hints = useLabelHints(container);
  const label = labelOf(container, hints);
  const tally = tallyWords(container);
  const name = [container.name, container.rule ? "smart binder" : null, tally].filter(Boolean).join(", ");
  // What the slip adds to the name: the collector's own words for the
  // binder, or a smart binder's rule when they wrote none.
  const about =
    container.description ||
    (container.rule && describeRule ? `Fills itself: ${describeRule(container.rule)}.` : undefined);
  const n = container.system === "want" ? (container.count?.lines ?? 0) : (copiesIn(container.count) ?? 0);
  const width = container.system ? SYSTEM_SPINE : spineWidth(n);
  let badge: ReactNode = null;
  if (container.rule) {
    badge = <span className="rounded-sm bg-neon-purple px-1 text-[10px] font-bold leading-4 text-on-neon-purple">Smart</span>;
  }

  return (
    <IdTooltip content={<IdLines title={container.name} lines={[about, tally]} />} description={about || undefined}>
      <button
        type="button"
        onClick={() => onOpen({ kind: "binder", binderId: container.id })}
        data-spine={container.id}
        aria-current={current ? "true" : undefined}
        aria-label={name}
        className={`p2-spine nb-spine ${SPINE_H}${current ? " nb-spine--current" : ""}`}
        style={{ "--vinyl": label.background, "--i": index, width } as CSSProperties}
      >
        {container.system === "trade" && (
          <span aria-hidden="true" className="nb-spine-tag">
            Trade
          </span>
        )}
        <SpineLabel
          name={container.name}
          label={label}
          spineWidth={width}
          badge={badge}
          count={container.count ? n : "…"}
        />
        <Pip on={current} />
      </button>
    </IdTooltip>
  );
}

/**
 * A box on the shelf: the end of a cardboard box standing between the
 * binders, the name on its tape (the box's spine label: its colours and
 * lettering), and the yellow price tag saying how many cards in it are for
 * sale. Everything in a box is for sale. Unsorted wears brown parcel tape.
 *
 * The Up for Trade pile stands here too on My Boxes (NEO-364 D4), drawn as a
 * box with the pennant "Trade" tag: not a home, so its tag counts what is up
 * for trade, binders and boxes together.
 */
function BoxSpine({
  container,
  current,
  index,
  onOpen,
}: {
  container: Container;
  current: boolean;
  index: number;
  onOpen: (view: ViewKey) => void;
}) {
  const label = labelOf(container);
  const n = copiesIn(container.count);
  const trade = container.system === "trade";
  const words = n === null ? "counting" : `${cardCount(n)} ${trade ? "up for trade" : "for sale"}`;
  return (
    <IdTooltip
      content={<IdLines title={container.name} lines={[container.description, words]} />}
      description={container.description || undefined}
    >
      <button
        type="button"
        onClick={() => onOpen({ kind: "binder", binderId: container.id })}
        data-spine={container.id}
        aria-current={current ? "true" : undefined}
        aria-label={`${container.name}, box, ${words}`}
        className={`nb-boxspine${current ? " nb-boxspine--current" : ""}`}
        style={{ "--i": index } as CSSProperties}
      >
        {trade && (
          <span aria-hidden="true" className="nb-spine-tag nb-boxspine-trade">
            Trade
          </span>
        )}
        <span aria-hidden="true" className="nb-boxspine-lid" />
        <span aria-hidden="true" className="nb-boxspine-end">
          <SpineLabel name={container.name} label={label} spineWidth={108} />
          <span className="nb-boxspine-handle" />
        </span>
        <span aria-hidden="true" className="nb-longbox-tag nb-boxspine-tag">
          {n === null ? "…" : n.toLocaleString("en-US")}
        </span>
        <Pip on={current} />
      </button>
    </IdTooltip>
  );
}

/**
 * Inventory: not a binder but a dealer's long box, the one under the show
 * table. Tabbed dividers stand up out of it, a strip of tape names it, and
 * the yellow price tag (the same tag a for-sale card wears in its sleeve)
 * says how many are for sale: every card in every box.
 *
 * Always a link to the Inventory list (NEO-364): on the collection's shelf
 * (`to="inventory"`) it crosses to the inventory side where the store has
 * one, otherwise to the public tour of it; on My Boxes (`to="list"`) it is
 * the Inventory tab, everything for sale in one list.
 */
function InventoryBox({
  forSale,
  to,
  tape = "Inventory",
  name = "Inventory",
}: {
  forSale: number | null;
  /** `"inventory"`: from the collection, across to the inventory. `"list"`: the inventory's own list tab. */
  to: "inventory" | "list";
  /** The lettering on its tape. */
  tape?: string;
  /** The first words of its accessible name. */
  name?: string;
}) {
  const { inventoryHref } = useCollectionMode();
  const { inventory: hasInventory } = useCapabilities();
  const words = forSale === null ? "counting what's for sale" : `${cardCount(forSale)} for sale`;
  const art = (
    <>
      <span aria-hidden="true" className="nb-longbox-stock">
        <span className="nb-longbox-divider" style={{ "--tab": "#00D558", "--at": "8%" } as CSSProperties} />
        <span className="nb-longbox-divider" style={{ "--tab": "#00C2FF", "--at": "38%" } as CSSProperties} />
        <span className="nb-longbox-divider" style={{ "--tab": "#FF2E9A", "--at": "66%" } as CSSProperties} />
      </span>
      <span aria-hidden="true" className="nb-longbox-box">
        <span className="nb-longbox-tape">{tape}</span>
        <span className="nb-longbox-handle" />
      </span>
      <span aria-hidden="true" className="nb-longbox-tag">
        {forSale === null ? "…" : forSale.toLocaleString("en-US")} for sale
      </span>
    </>
  );
  if (to === "list") {
    return (
      <ParamLink search={{ tab: "cards" }} aria-label={`${name}, ${words}`} className="nb-longbox">
        {art}
      </ParamLink>
    );
  }
  if (hasInventory) {
    return (
      <SideLink side="inventory" search={{ tab: "cards" }} aria-label={`${name}, ${words}`} className="nb-longbox">
        {art}
      </SideLink>
    );
  }
  return (
    <Link to={inventoryHref} aria-label={`${name}, ${words}`} className="nb-longbox">
      {art}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// My Boxes: the boxes
// ---------------------------------------------------------------------------

/**
 * NEO-359 / NEO-364 — the landing of My Boxes (`/inventory?tab=boxes`): the
 * collector's boxes standing box end out on the show table, Unsorted first
 * (the inventory's catch-all, always there), then their own as made, and
 * "New box". Beside them the special places: Up for Trade drawn as a box
 * (the one pile that spans both sides), and the long box, the door to the
 * Inventory list (everything for sale, in one list). Nothing from the
 * collection stands here: binders, Main and the Want List are My Binders'
 * (Jason: "Inventory is things for sale and My Collection is things that are
 * for your collection").
 */
export function InventoryShelf({ onOpen, onNewBox }: { onOpen: (view: ViewKey) => void; onNewBox: () => void }) {
  const containers = useContainers();
  if (!containers) {
    return (
      <div>
        <h2 tabIndex={-1} data-shelf-heading className="sr-only">
          My Boxes
        </h2>
        <LoadingNote>Pulling your boxes out from under the table…</LoadingNote>
        <SkeletonBars rows={3} className="mt-4" />
      </div>
    );
  }
  // Unsorted first, then the collector's own; never a smart one.
  const boxes = boxesOf(containers).filter((c) => !c.rule);
  const trade = systemContainer(containers, "trade");
  const forSale = forSaleCount(containers);
  const saleText = forSale === null ? "Counting what's for sale" : `${cardCount(forSale)} for sale`;

  return (
    <div>
      <SpineFontFaces />
      <h2 tabIndex={-1} data-shelf-heading className="sr-only">
        My Boxes
      </h2>
      {forSale === 0 ? (
        <>
          <p className="neon-header nb-glow-title text-[1.7rem] leading-tight text-ink sm:text-[2.1rem]">
            Nothing for sale yet.
          </p>
          <p className="mt-2 max-w-2xl text-ink-2">
            A box is your sale table: every card in it is for sale. Punch in counts on Checklists, or open a card in
            your collection and press Sell. No box picked? It lands in Unsorted.
          </p>
        </>
      ) : (
        <>
          <p className="neon-header nb-glow-title text-[1.7rem] leading-tight text-ink sm:text-[2.1rem]">
            {saleText} in {boxes.length} {boxes.length === 1 ? "box" : "boxes"}.
          </p>
          <p className="mt-2 max-w-2xl text-ink-2">
            Open a box to sort it into rows, or pull the long box for the whole stock in one list.
          </p>
        </>
      )}

      <div className="mt-6 grid gap-x-8 gap-y-10 xl:grid-cols-[minmax(0,1fr)_auto]">
        <section aria-labelledby="nb-box-shelf" className="min-w-0">
          <h3 id="nb-box-shelf" className="text-xl font-bold text-ink">
            Your boxes
          </h3>
          <ul className="p2-shelf mt-1" aria-label="Your boxes">
            {boxes.map((c, i) => (
              <li key={c.id} className="flex-none">
                <BoxSpine container={c} current={false} index={i} onOpen={onOpen} />
              </li>
            ))}
            <li className="flex-none">
              <button
                type="button"
                onClick={onNewBox}
                className={`p2-spine p2-spine--new w-[58px] justify-center gap-3 text-ink-2 hover:text-ink ${SPINE_H}`}
                style={{ "--i": boxes.length } as CSSProperties}
              >
                <PlusIcon aria-hidden="true" className="h-6 w-6 shrink-0" />
                <span className="p2-spine-name text-sm font-bold">New box</span>
              </button>
            </li>
          </ul>
          <div className="p2-ledge shelf-ledge" aria-hidden="true" />
        </section>

        <section aria-labelledby="nb-box-special" className="nb-special w-fit max-w-full min-w-0">
          <h3 id="nb-box-special" className="nb-special-sign">
            Special places
          </h3>
          <p className="mt-1 max-w-[22rem] px-1 text-sm text-ink-2">
            What you&apos;d swap, from any binder or box, and the whole stock in one list.
          </p>
          <ul className="p2-shelf nb-special-shelf" aria-label="Special places">
            {trade && (
              <li className="flex-none">
                <BoxSpine container={trade} current={false} index={0} onOpen={onOpen} />
              </li>
            )}
            <li className="flex-none">
              <InventoryBox forSale={forSale} to="list" tape="For sale" name="Everything for sale" />
            </li>
          </ul>
          <div className="nb-special-ledge shelf-ledge-special" aria-hidden="true" />
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Browse a set
// ---------------------------------------------------------------------------

const FILTER_SELECT = "min-h-10 rounded-md border border-control bg-field px-2 text-sm text-ink focus-outline";

function BrowseShelf({ onOpen }: { onOpen: (view: ViewKey) => void }) {
  const demo = useDemoExtension();
  return (
    <section aria-labelledby="nb-catalog-shelf" className="mt-12">
      <h3 id="nb-catalog-shelf" className="text-xl font-bold text-ink">
        Browse a set
      </h3>
      <p className="mt-1 max-w-xl text-sm text-ink-2">
        Every card in the set, sleeve by sleeve. Spot one you&apos;ve got? Hit Add.
      </p>
      {demo ? (
        <CatalogShelf
          sets={demo.browseSets}
          filter={demo.browseFilter}
          setFilter={demo.setBrowseFilter}
          onOpen={onOpen}
        />
      ) : (
        <BuildingShelf onOpen={onOpen} />
      )}
    </section>
  );
}

/** The demo's catalog shelf: every set, narrowed by sport, years and name. */
function CatalogShelf({
  sets,
  filter,
  setFilter,
  onOpen,
}: {
  sets: readonly SetRef[];
  filter: BrowseFilter;
  setFilter: (patch: Partial<BrowseFilter>) => void;
  onOpen: (view: ViewKey) => void;
}) {
  const shown = filterSets(sets, filter);
  const filtering = isFiltering(filter);
  const countId = useId();
  const sports = sportsOf(sets);
  const years = [...new Set(sets.map((s) => s.year))].sort((a, b) => a - b);

  const yearSelect = (key: "from" | "to", text: string) => (
    <label className="flex items-center gap-2 text-sm text-ink-2">
      {/* The select names itself: a wrapping label's name would include the
          chosen year ("From 1996"). */}
      <span aria-hidden="true">{text}</span>
      <select
        aria-label={key === "from" ? "From year" : "To year"}
        className={FILTER_SELECT}
        value={filter[key] ?? ""}
        onChange={(e) => setFilter({ [key]: e.target.value ? Number(e.target.value) : null })}
      >
        <option value="">{key === "from" ? "Earliest" : "Latest"}</option>
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
    </label>
  );

  const clear = (
    <button
      type="button"
      onClick={() => setFilter(NO_BROWSE_FILTER)}
      className="mt-2 rounded-sm text-sm text-neon-blue-text underline underline-offset-2 hover:text-ink focus-outline"
    >
      Clear filters
    </button>
  );

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="group" aria-label="Sport" className="flex rounded-lg border border-control bg-field p-0.5">
          {[{ id: "all", name: "All" }, ...sports].map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={filter.sport === s.id}
              // "All" alone is a substring of "Baseball" and "Football".
              aria-label={s.id === "all" ? "All sports" : undefined}
              onClick={() => setFilter({ sport: s.id })}
              className={`min-h-9 rounded-md px-3 text-sm font-medium focus-outline max-sm:min-h-11 ${
                filter.sport === s.id
                  ? "bg-neon-blue text-on-neon-blue ring-1 ring-inset ring-selection"
                  : "text-ink-2 hover:text-ink"
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
          onChange={(e) => setFilter({ q: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape" && filter.q) {
              e.preventDefault();
              setFilter({ q: "" });
            }
          }}
          className="min-h-10 w-full px-3 text-sm sm:w-56"
        />
        <p id={countId} aria-live="polite" className="text-sm tabular-nums text-ink-2">
          {shown.length} of {sets.length} sets
        </p>
      </div>

      {shown.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-control px-4 py-8 text-center">
          <p className="text-ink-2">No sets on this shelf fit those filters.</p>
          {clear}
        </div>
      ) : (
        <>
          <ul className="p2-shelf mt-2" aria-label="Sets to browse" aria-describedby={countId}>
            {shown.map((set, i) => (
              <li key={set.id} className="flex-none">
                <SetSpine setId={set.id} name={setLabel(set)} index={i} onOpen={onOpen} />
              </li>
            ))}
          </ul>
          <div className="p2-ledge shelf-ledge" aria-hidden="true" />
          {filtering && clear}
        </>
      )}
    </>
  );
}

/**
 * The real collection's Browse shelf: there is no catalog to line up whole,
 * so it shows the sets you're building and a set search (a set's own name,
 * from the store's suggestions). Either opens the whole set, paged.
 */
function BuildingShelf({ onOpen }: { onOpen: (view: ViewKey) => void }) {
  const building = useBuildingSets();
  const [q, setQ] = useState("");
  const settled = useSearchText(q);
  const suggestions = useSuggestions(settled);
  const found = (suggestions ?? []).flatMap((s) => (s.kind === "set" ? [{ id: s.id, name: s.label }] : []));
  const searching = searchable(settled);
  const countId = useId();
  const shown = searching ? found : (building ?? []).map((s) => ({ id: s.id, name: setLabel(s) }));
  const loading = searching ? suggestions === undefined : building === undefined;

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Input
          bare
          type="search"
          surface="dark"
          aria-label="Find a set by name"
          placeholder="Find a set: try 1996 contenders"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && q) {
              e.preventDefault();
              setQ("");
            }
          }}
          className="min-h-10 w-full px-3 text-sm sm:w-72"
        />
        <p id={countId} aria-live="polite" className="text-sm tabular-nums text-ink-2">
          {loading
            ? "Looking…"
            : searching
              ? `${found.length} ${found.length === 1 ? "set fits" : "sets fit"} "${settled}"`
              : `${shown.length} ${shown.length === 1 ? "set" : "sets"} you're building`}
        </p>
      </div>
      {!loading && shown.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-control px-4 py-8 text-center">
          <p className="text-ink-2">
            {searching
              ? "No set by that name. Try the year and the brand."
              : "No sets on the go yet. Find one above, or mark one you're building in My Cards."}
          </p>
        </div>
      ) : (
        <>
          <ul className="p2-shelf mt-2" aria-label="Sets to browse" aria-describedby={countId}>
            {shown.map((set, i) => (
              <li key={set.id} className="flex-none">
                <SetSpine setId={set.id} name={set.name} index={i} onOpen={onOpen} />
              </li>
            ))}
          </ul>
          <div className="p2-ledge shelf-ledge" aria-hidden="true" />
        </>
      )}
    </>
  );
}

/** A clear binder for a set: its name, and how much of the whole set you have. */
function SetSpine({
  setId,
  name,
  index,
  onOpen,
}: {
  setId: string;
  name: string;
  index: number;
  onOpen: (view: ViewKey) => void;
}) {
  const completion = useSetCompletion(setId);
  const owned = completion ? `${completion.owned}${completion.exact ? "" : "+"}` : null;
  const have = completion ? `You have ${owned} of ${completion.total}` : null;
  return (
    // Catalog spines are whole sets (never an insert or a parallel), so the
    // slip is the season and set name.
    <IdTooltip content={<IdLines title={name} lines={[have ?? undefined]} />}>
      <button
        type="button"
        onClick={() => onOpen({ kind: "set", setId })}
        data-spine={`set:${setId}`}
        aria-label={`Browse ${name}${have ? `, ${have.charAt(0).toLowerCase()}${have.slice(1)}` : ""}`}
        className="p2-spine p2-spine--clear h-[180px] w-[64px] sm:h-[210px]"
        style={{ "--i": index } as CSSProperties}
      >
        <span className="p2-spine-label" style={{ "--stripe": "#00C2FF" } as CSSProperties}>
          <span className="p2-spine-name">{name}</span>
          <span className="p2-spine-count">{completion ? `${owned}/${completion.total}` : "…"}</span>
        </span>
      </button>
    </IdTooltip>
  );
}
