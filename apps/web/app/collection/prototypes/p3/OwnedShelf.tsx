import { useMemo, useRef, useState } from "react";
import { Input } from "@/components/primitives/Input";
import CardFace from "../_shared/CardFace";
import {
  cardLabel,
  compareCards,
  describeRule,
  getCard,
  getSet,
  leadPlayer,
  leadTeam,
  searchCards,
  teamTextColor,
  type Binder,
  type Card,
  type SportId,
} from "../_shared/data";
import Chip from "./Chip";
import { FOCUS, LABEL, QUIET_BUTTON, SELECT } from "./classes";
import { useP3 } from "./context";
import { useRoving } from "./hooks";

/**
 * NEO-350 prototype 3 — "Everything else I own": the cards that are not on a
 * set build, as a compact image grid, with binders down the left. A smart
 * binder lists what it would hold, haves and needs both.
 */

type Shelf = "else" | "all" | string;
type Sort = "set" | "player" | "team" | "added";

const PAGE = 36;

interface Item {
  card: Card;
  count: number;
  added: string;
}

export default function OwnedShelf() {
  const api = useP3();
  const { store } = api;
  const [shelf, setShelf] = useState<Shelf>("else");
  const [sort, setSort] = useState<Sort>("set");
  const [sport, setSport] = useState<SportId | "">("");
  const [graded, setGraded] = useState(false);
  const [dupes, setDupes] = useState(false);
  const [needs, setNeeds] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const grid = useRef<HTMLUListElement>(null);

  const binder = shelf !== "else" && shelf !== "all" ? store.getBinder(shelf) : undefined;
  const building = new Set(store.state.buildingSetIds);

  const items: Item[] = (() => {
    const byCard = new Map<string, Item>();
    const copies = binder ? store.binderCopies(binder) : store.state.copies;
    for (const copy of copies) {
      if (copy.quantity <= 0) continue;
      const card = getCard(copy.cardId);
      if (shelf === "else" && building.has(card.setId)) continue;
      const item = byCard.get(card.id) ?? { card, count: 0, added: "" };
      item.count += copy.quantity;
      if (copy.acquiredAt > item.added) item.added = copy.acquiredAt;
      byCard.set(card.id, item);
    }
    if (binder?.kind === "smart") {
      for (const card of store.binderCards(binder)) {
        if (!byCard.has(card.id)) byCard.set(card.id, { card, count: 0, added: "" });
      }
    }
    return [...byCard.values()];
  })();

  const matchIds = useMemo(
    () => (query.trim() ? new Set(searchCards(query).filter((h) => h.matchedAll).map((h) => h.card.id)) : null),
    [query],
  );

  const shown = items
    .filter((it) => !sport || getSet(it.card.setId).sportId === sport)
    .filter((it) => !graded || store.copiesOf(it.card.id).some((c) => c.graded))
    .filter((it) => !dupes || it.count > 1)
    .filter((it) => !needs || it.count === 0)
    .filter((it) => !matchIds || matchIds.has(it.card.id))
    .sort((a, b) => {
      switch (sort) {
        case "player":
          return leadPlayer(a.card).name.localeCompare(leadPlayer(b.card).name) || compareCards(a.card, b.card);
        case "team":
          return leadTeam(a.card).name.localeCompare(leadTeam(b.card).name) || compareCards(a.card, b.card);
        case "added":
          return b.added.localeCompare(a.added) || compareCards(a.card, b.card);
        default:
          return compareCards(a.card, b.card);
      }
    });
  const visible = shown.slice(0, limit);
  const roving = useRoving(grid, visible.map((it) => it.card.id));

  const manual = store.state.binders.filter((b) => b.kind === "manual");
  const smart = store.state.binders.filter((b) => b.kind === "smart");
  const ownedAll = new Set(store.state.copies.map((c) => c.cardId)).size;
  const ownedElse = new Set(
    store.state.copies.filter((c) => !building.has(getCard(c.cardId).setId)).map((c) => c.cardId),
  ).size;

  const pick = (next: Shelf) => {
    setShelf(next);
    setLimit(PAGE);
    setNeeds(false);
  };

  const title =
    shelf === "else" ? "Off the board" : shelf === "all" ? "Every card I own" : (binder?.name ?? "");

  return (
    <section aria-labelledby="p3-shelf-heading" className="mt-10">
      <h2 id="p3-shelf-heading" className="text-xl font-bold text-white">
        Everything else I own
      </h2>
      <p className="mt-1 text-sm text-slate-400">
        Singles, slabs and PC cards that aren&apos;t part of a set build, plus your binders.
      </p>

      <div className="mt-4 flex flex-col gap-4 lg:flex-row">
        <nav aria-label="Binders" className="relative lg:w-56 lg:shrink-0">
          <ul className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
            <RailItem
              active={shelf === "else"}
              onClick={() => pick("else")}
              name="Everything else"
              detail={`${ownedElse} cards off the board`}
            />
            <RailItem
              active={shelf === "all"}
              onClick={() => pick("all")}
              name="Every card I own"
              detail={`${ownedAll} cards`}
            />
            <li className="hidden pt-2 text-xs font-bold text-slate-400 lg:block" aria-hidden="true">
              Binders
            </li>
            {manual.map((b) => (
              <RailItem
                key={b.id}
                active={shelf === b.id}
                onClick={() => pick(b.id)}
                name={b.name}
                detail={`${new Set(store.binderCopies(b).map((c) => c.cardId)).size} cards`}
              />
            ))}
            <li className="hidden pt-2 text-xs font-bold text-slate-400 lg:block" aria-hidden="true">
              Smart binders
            </li>
            {smart.map((b) => (
              <RailItem
                key={b.id}
                active={shelf === b.id}
                onClick={() => pick(b.id)}
                name={b.name}
                smart
                detail={smartDetail(b, store.binderCards(b), store.ownedCount)}
              />
            ))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-base font-bold text-white">{title}</h3>
            <p className="text-sm text-slate-400" role="status">
              {shown.length} {shown.length === 1 ? "card" : "cards"}
            </p>
          </div>
          {binder?.kind === "smart" && (
            <p className="mt-1 text-sm text-slate-300">
              Fills itself: <span className="text-white">{describeRule(binder.rule)}</span>. Needs show dimmed.
            </p>
          )}
          {binder?.kind === "manual" && binder.description && (
            <p className="mt-1 text-sm text-slate-300">{binder.description}</p>
          )}

          <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <Input
              label="Filter these cards"
              placeholder="griffey refractor"
              autoComplete="off"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setLimit(PAGE);
              }}
            />
            <label className="block">
              <span className={LABEL}>Sort by</span>
              <select className={`${SELECT} w-full`} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="set">Set and number</option>
                <option value="player">Player</option>
                <option value="team">Team</option>
                <option value="added">Newest first</option>
              </select>
            </label>
            <label className="block">
              <span className={LABEL}>Sport</span>
              <select
                className={`${SELECT} w-full`}
                value={sport}
                onChange={(e) => setSport(e.target.value as SportId | "")}
              >
                <option value="">Every sport</option>
                <option value="baseball">Baseball</option>
                <option value="football">Football</option>
                <option value="hockey">Hockey</option>
              </select>
            </label>
          </div>
          <div role="group" aria-label="Only show" className="mt-3 flex flex-wrap gap-1.5">
            <Chip pressed={graded} onClick={() => setGraded(!graded)}>
              Slabs only
            </Chip>
            <Chip pressed={dupes} onClick={() => setDupes(!dupes)}>
              Dupes only
            </Chip>
            {binder?.kind === "smart" && (
              <Chip pressed={needs} onClick={() => setNeeds(!needs)}>
                Needs only
              </Chip>
            )}
          </div>

          {visible.length === 0 ? (
            <p className="mt-6 rounded-lg border border-dashed border-slate-700 p-6 text-center text-sm text-slate-300">
              {shelf === "else" && items.length === 0
                ? "Every card you own is on a set build. Gnarly."
                : "Nothing here matches. Loosen a filter."}
            </p>
          ) : (
            <ul
              ref={grid}
              aria-label={`${title}, ${shown.length} cards`}
              onKeyDown={roving.onKeyDown}
              onFocus={roving.onFocus}
              className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-x-3 gap-y-4"
            >
              {visible.map((it) => (
                <ShelfCard
                  key={it.card.id}
                  item={it}
                  tabIndex={roving.tabIndexFor(it.card.id)}
                  onOpen={() => api.openCard(it.card)}
                />
              ))}
            </ul>
          )}
          {shown.length > visible.length && (
            <button type="button" onClick={() => setLimit(limit + PAGE)} className={`${QUIET_BUTTON} mt-4`}>
              Show {Math.min(PAGE, shown.length - visible.length)} more of {shown.length - visible.length}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function smartDetail(b: Binder, list: Card[], owned: (id: string) => number): string {
  if (b.kind !== "smart") return "";
  const have = list.filter((c) => owned(c.id) > 0).length;
  return `${describeRule(b.rule)}. Own ${have} of ${list.length}`;
}

function RailItem({
  active,
  onClick,
  name,
  detail,
  smart,
}: {
  active: boolean;
  onClick: () => void;
  name: string;
  detail: string;
  smart?: boolean;
}) {
  return (
    <li className="shrink-0">
      <button
        type="button"
        aria-pressed={active}
        onClick={onClick}
        className={`flex min-h-11 w-48 flex-col items-start rounded-lg border px-3 py-2 text-left lg:w-full ${FOCUS} ${
          active
            ? "border-neon-blue bg-neon-blue/10 text-white shadow-[0_0_12px_2px_rgba(0,194,255,0.25)]"
            : "border-slate-800 text-slate-200 hover:border-slate-500"
        }`}
      >
        <span className="flex w-full items-center gap-1.5 text-sm font-bold">
          {smart && (
            <span className="rounded border border-neon-purple px-1 text-[10px] font-bold text-neon-purple-text">
              Smart
            </span>
          )}
          <span className="truncate">{name}</span>
        </span>
        <span className="line-clamp-2 text-xs text-slate-400">{detail}</span>
      </button>
    </li>
  );
}

function ShelfCard({ item, tabIndex, onOpen }: { item: Item; tabIndex: number; onOpen: () => void }) {
  const { card, count } = item;
  const team = leadTeam(card);
  const name = `${cardLabel(card)}, ${count === 0 ? "need" : count > 1 ? `have ${count}` : "have"}`;
  return (
    <li className="flex flex-col items-center">
      <button
        type="button"
        data-rove={card.id}
        tabIndex={tabIndex}
        aria-label={name}
        onClick={onOpen}
        className={`relative rounded-[6px] ${FOCUS}`}
      >
        <CardFace card={card} size="sm" state={count === 0 ? "need" : "owned"} />
        {count > 1 && (
          <span
            aria-hidden="true"
            className="absolute -right-1.5 -top-1.5 rounded bg-neon-yellow px-1 text-[11px] font-bold leading-4 text-black"
          >
            ×{count}
          </span>
        )}
      </button>
      <p aria-hidden="true" className="mt-1 w-[5.5rem] truncate text-center text-xs">
        <span className="text-slate-400">#{card.cardNumber} </span>
        <span style={{ color: teamTextColor(team, "#000000") }}>{team.name}</span>
      </p>
    </li>
  );
}
