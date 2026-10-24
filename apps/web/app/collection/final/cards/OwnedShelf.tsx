import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/primitives/Input";
import CardFace from "../../prototypes/_shared/CardFace";
import Chip from "../../prototypes/p3/Chip";
import { FOCUS, LABEL, QUIET_BUTTON, SELECT } from "../../prototypes/p3/classes";
import { useRoving } from "../../prototypes/p3/hooks";
import { cardCaption } from "../captions";
import { LoadingNote, SkeletonBars } from "../catalog/Skeleton";
import { cardLabel, compareCards } from "../data/labels";
import {
  CONTAINER_COPIES_DEFAULT_LIMIT,
  OWNED_CARDS_DEFAULT_LIMIT,
  useBuildingSets,
  useCards,
  useContainerCopies,
  useContainers,
  useDemoExtension,
  useOwnedCards,
  useScope,
  useSearch,
  useSummary,
} from "../data/store";
import type { Card, Container, ContainerCount, Copy } from "../data/types";
import { useMyCards } from "./context";

/**
 * NEO-350 / NEO-359 — "Everything else I own": the cards that are not on a
 * set build, as a compact image grid, with the shelf down the side: Main and
 * Up for Trade first, then your own binders and boxes (a box is the sale
 * table: what is in it is for sale), then smart binders (demo only), each
 * listing what it holds.
 *
 * Both stores feed it through the same reads: "Every card I own" and
 * "Everything else" page the owned-cards list (`useOwnedCards`) under All,
 * or the scoped home's copies (`useContainerCopies`) when the binder picker
 * has one; a binder, box or pile picked on the rail pages its own copies
 * whatever the picker says. The rail is navigation: the shelf showing is
 * `aria-current`.
 *
 * "Show 36 more of 120": under All with no filter on, the total is the
 * store's own count (the tally for "Every card I own", the cards off every
 * set build for "Everything else"), not what has loaded. Anywhere else it
 * counts what has loaded, with a "+" while the store holds more. The
 * keyboard goes to the first card it adds, even when the button goes away
 * with the last page.
 */

/**
 * After "Show more": put the keyboard on the first card the page added, once
 * it is on screen (the real collection's arrive a read later). Returns the
 * setter to call with the count on screen before the click.
 */
function useFocusFirstNew(ids: readonly string[], focusKey: (key: string) => void): (shownBefore: number) => void {
  const [from, setFrom] = useState<number | null>(null);
  const target = from !== null && ids.length > from ? ids[from] : null;
  useEffect(() => {
    if (!target) return;
    const frame = requestAnimationFrame(() => {
      setFrom((current) => (current === from ? null : current));
      focusKey(target);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, from, focusKey]);
  return setFrom;
}

type Shelf = "else" | "all" | string;
type Sort = "set" | "player" | "team" | "added";

const PAGE = 36;

interface Item {
  card: Card;
  count: number;
  /** A sortable "when": the newest acquired date, or the store's recency rank. */
  added: string;
  /** Any of its copies is graded (a slab). */
  graded: boolean;
}

/** Copies (one container's) as one item per card, cards looked up by id. */
function itemsOfCopies(copies: readonly Copy[], cards: readonly (Card | null)[] | undefined, ids: readonly string[]): Item[] | undefined {
  if (!cards) return undefined;
  const byId = new Map<string, Card>();
  ids.forEach((id, i) => {
    const card = cards[i];
    if (card) byId.set(id, card);
  });
  const items = new Map<string, Item>();
  for (const copy of copies) {
    if (copy.quantity <= 0) continue;
    const card = byId.get(copy.cardId);
    if (!card) continue;
    const item = items.get(card.id) ?? { card, count: 0, added: "", graded: false };
    item.count += copy.quantity;
    if (copy.graded) item.graded = true;
    if (copy.acquiredAt > item.added) item.added = copy.acquiredAt;
    items.set(card.id, item);
  }
  return [...items.values()];
}

/** "1 card", "12,345 cards". */
function cardsText(n: number): string {
  return n === 1 ? "1 card" : `${n.toLocaleString("en-US")} cards`;
}

/** "12 cards", "1 card", "Not counted yet". */
function countDetail(count: ContainerCount | null): string {
  if (!count) return "Not counted yet";
  return count.copies === 1 ? "1 card" : `${count.copies.toLocaleString("en-US")} cards`;
}

export default function OwnedShelf() {
  const api = useMyCards();
  const demo = useDemoExtension();
  const containers = useContainers();
  const scope = useScope();
  const building = useBuildingSets();
  const summary = useSummary();
  const [shelf, setShelf] = useState<Shelf>("else");
  const [sort, setSort] = useState<Sort>("set");
  const [sport, setSport] = useState<string>("");
  const [graded, setGraded] = useState(false);
  const [dupes, setDupes] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const grid = useRef<HTMLUListElement>(null);

  const picked = shelf !== "else" && shelf !== "all" ? containers?.find((c) => c.id === shelf) : undefined;
  // Which container's copies feed the grid: the one picked on the rail, else
  // the scoped home, else none (the owned-cards list).
  const sourceId = picked?.id ?? (scope !== "all" ? scope : null);
  const scoped = scope !== "all" ? containers?.find((c) => c.id === scope) : undefined;
  const scopeNote = !picked && scoped ? ` in ${scoped.name}` : "";

  // Every shelf may filter away much of what loads: ask for more than shows.
  const fetchLimit = Math.max(CONTAINER_COPIES_DEFAULT_LIMIT, limit * 2);
  const boxed = useContainerCopies(sourceId, { limit: fetchLimit });
  const owned = useOwnedCards({ limit: Math.max(OWNED_CARDS_DEFAULT_LIMIT, limit * 2) });
  const boxedIds = useMemo(() => [...new Set((boxed?.copies ?? []).map((c) => c.cardId))], [boxed]);
  const boxedCards = useCards(sourceId ? boxedIds : null);

  const buildingIds = useMemo(() => new Set((building ?? []).map((s) => s.id)), [building]);
  const items: Item[] | undefined = useMemo(() => {
    let list: Item[] | undefined;
    if (sourceId) {
      list = boxed ? itemsOfCopies(boxed.copies, boxedCards, boxedIds) : undefined;
    } else if (owned) {
      const n = owned.cards.length;
      list = owned.cards.map((card, i) => ({
        card,
        count: owned.copiesByCard[card.id]?.quantity ?? 1,
        // Most recently touched first: the rank sorts the same way a date does.
        added: String(n - i).padStart(8, "0"),
        graded: owned.copiesByCard[card.id]?.graded === true,
      }));
    }
    if (!list) return undefined;
    if (shelf === "else") {
      if (!building) return undefined;
      return list.filter((it) => !buildingIds.has(it.card.set.id));
    }
    return list;
  }, [sourceId, boxed, boxedCards, boxedIds, owned, shelf, building, buildingIds]);
  const more = sourceId ? (boxed?.truncated ?? false) : (owned?.truncated ?? false);

  const found = useSearch(query);
  const matchIds = useMemo(
    () => (query.trim() && found ? new Set(found.cards.map((c) => c.id)) : null),
    [query, found],
  );

  const sports = useMemo(() => {
    const out = new Map<string, string>();
    for (const it of items ?? []) out.set(it.card.set.sport.id, it.card.set.sport.name);
    if (sport && !out.has(sport)) out.set(sport, sport);
    return [...out.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [items, sport]);

  const shown = (items ?? [])
    .filter((it) => !sport || it.card.set.sport.id === sport)
    .filter((it) => !graded || it.graded)
    .filter((it) => !dupes || it.count > 1)
    .filter((it) => !matchIds || matchIds.has(it.card.id))
    .sort((a, b) => {
      switch (sort) {
        case "player":
          return (a.card.players[0]?.name ?? "").localeCompare(b.card.players[0]?.name ?? "") || compareCards(a.card, b.card);
        case "team":
          return (a.card.teams[0]?.name ?? "").localeCompare(b.card.teams[0]?.name ?? "") || compareCards(a.card, b.card);
        case "added":
          return b.added.localeCompare(a.added) || compareCards(a.card, b.card);
        default:
          return compareCards(a.card, b.card);
      }
    });
  const visible = shown.slice(0, limit);
  const visibleIds = visible.map((it) => it.card.id);
  const roving = useRoving(grid, visibleIds);
  const focusFirstNew = useFocusFirstNew(visibleIds, roving.focusKey);

  // The rail: Main and Up for Trade, then the collector's binders and boxes as
  // made, then smart binders. The Want List holds wants, not copies.
  const shelves = (containers ?? []).filter((c) => c.system !== "want");
  const homesAndPiles = shelves.filter((c) => !c.rule);
  const smart = shelves.filter((c) => c.rule);

  const pick = (next: Shelf) => {
    setShelf(next);
    setLimit(PAGE);
    setGraded(false);
  };

  const title =
    shelf === "else"
      ? `Off the board${scopeNote}`
      : shelf === "all"
        ? `Every card I own${scopeNote}`
        : (picked?.name ?? "");
  // The store's own count, when the grid is the whole shelf: All, no filter.
  const unfiltered = !sport && !graded && !dupes && query.trim() === "";
  const offBuild = !sourceId ? (summary?.offBuild ?? null) : null;
  const known =
    !sourceId && unfiltered && summary
      ? shelf === "else"
        ? offBuild
        : shelf === "all" && summary.exact
          ? summary.cards
          : null
      : null;
  const total = known !== null ? known.toLocaleString("en-US") : `${shown.length}${more ? "+" : ""}`;
  const single = known !== null ? known === 1 : shown.length === 1 && !more;
  const left = known !== null ? known - visible.length : null;
  const allDetail = scoped
    ? `${countDetail(scoped.count)} in ${scoped.name}`
    : summary
      ? `${summary.cards.toLocaleString("en-US")}${summary.exact ? "" : "+"} cards`
      : "Counting…";

  return (
    <section aria-labelledby="mc-shelf-heading" className="mt-10">
      <h2 id="mc-shelf-heading" className="text-xl font-bold text-ink">
        Everything else I own
      </h2>
      <p className="mt-1 text-sm text-ink-3">
        Singles, slabs and PC cards that aren&apos;t part of a set build, plus your binders and boxes.
      </p>

      <div className="mt-4 flex flex-col gap-4 lg:flex-row">
        <nav aria-label="Shelves and binders" className="relative min-w-0 lg:w-56 lg:shrink-0">
          <ul className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
            <RailItem
              active={shelf === "else"}
              onClick={() => pick("else")}
              name="Everything else"
              detail={offBuild !== null ? `${cardsText(offBuild)} off your set builds` : `Cards off your set builds${scopeNote}`}
            />
            <RailItem active={shelf === "all"} onClick={() => pick("all")} name="Every card I own" detail={allDetail} />
            {homesAndPiles.length > 0 && (
              <li className="hidden pt-2 text-xs font-bold text-ink-3 lg:block" aria-hidden="true">
                Binders and boxes
              </li>
            )}
            {homesAndPiles.map((b) => (
              <RailItem
                key={b.id}
                active={shelf === b.id}
                onClick={() => pick(b.id)}
                name={b.name}
                tag={b.kind === "box" ? "box" : undefined}
                detail={b.kind === "box" ? `${countDetail(b.count)}, for sale` : countDetail(b.count)}
              />
            ))}
            {smart.length > 0 && (
              <li className="hidden pt-2 text-xs font-bold text-ink-3 lg:block" aria-hidden="true">
                Smart binders
              </li>
            )}
            {smart.map((b) => (
              <RailItem
                key={b.id}
                active={shelf === b.id}
                onClick={() => pick(b.id)}
                name={b.name}
                tag="smart"
                detail={b.rule && demo ? demo.describeRule(b.rule) : countDetail(b.count)}
              />
            ))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-base font-bold text-ink">{title}</h3>
            <p className="text-sm text-ink-3" role="status">
              {items === undefined ? "Counting…" : `${total} ${single ? "card" : "cards"}`}
            </p>
          </div>
          <ShelfNote container={picked} describeRule={demo?.describeRule} />

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
              <select className={`${SELECT} w-full`} value={sport} onChange={(e) => setSport(e.target.value)}>
                <option value="">Every sport</option>
                {sports.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
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
          </div>

          {items === undefined ? (
            <div aria-busy="true" className="mt-4">
              <SkeletonBars rows={2} />
              <LoadingNote>Pulling the cards off the shelf…</LoadingNote>
            </div>
          ) : visible.length === 0 ? (
            <p className="mt-6 rounded-lg border border-dashed border-rule-strong p-6 text-center text-sm text-ink-2">
              {shelf === "else" && items.length === 0 && !more
                ? "Every card here is on a set build. Gnarly."
                : items.length === 0 && !more
                  ? picked?.kind === "box"
                    ? "Nothing on the sale table yet. Move a card into this box to sell it."
                    : "Nothing in here yet."
                  : "Nothing here matches. Loosen a filter."}
            </p>
          ) : (
            <ul
              ref={grid}
              aria-label={`${title}, ${total} cards`}
              onKeyDown={roving.onKeyDown}
              onFocus={roving.onFocus}
              className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-x-3 gap-y-4"
            >
              {visible.map((it) => (
                <ShelfCard
                  key={it.card.id}
                  item={it}
                  tabIndex={roving.tabIndexFor(it.card.id)}
                  onOpen={() =>
                    api.openCard(it.card.id, {
                      list: visibleIds,
                      seed: it.card,
                      ...(picked && !picked.rule && picked.system !== "trade" ? { binderId: picked.id } : {}),
                    })
                  }
                />
              ))}
            </ul>
          )}
          {(shown.length > visible.length ||
            (more && visible.length === shown.length && shown.length > 0 && (left === null || left > 0))) && (
            <button
              type="button"
              onClick={() => {
                focusFirstNew(visible.length);
                setLimit(limit + PAGE);
              }}
              className={`${QUIET_BUTTON} mt-4`}
            >
              {shown.length > visible.length
                ? `Show ${Math.min(PAGE, shown.length - visible.length)} more of ${total}`
                : left !== null
                  ? `Show ${Math.min(PAGE, left)} more of ${total}`
                  : "Show more"}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/** Under a picked shelf's title: what a box, the trade pile, a smart binder or a described binder is. */
function ShelfNote({
  container,
  describeRule,
}: {
  container: Container | undefined;
  describeRule?: (rule: NonNullable<Container["rule"]>) => string;
}) {
  if (!container) return null;
  let text: string | null = null;
  if (container.rule) text = `Fills itself: ${describeRule ? describeRule(container.rule) : container.name}.`;
  else if (container.system === "trade") text = "Cards you'd swap. Each one still lives in its own binder or box.";
  else if (container.kind === "box") text = "A box is the sale table: every card in here is for sale.";
  if (container.description) text = text ? `${text} ${container.description}` : container.description;
  return text ? <p className="mt-1 text-sm text-ink-2">{text}</p> : null;
}

function RailItem({
  active,
  onClick,
  name,
  detail,
  tag,
}: {
  active: boolean;
  onClick: () => void;
  name: string;
  detail: string;
  /** A smart binder, or a box (the sale table). */
  tag?: "smart" | "box";
}) {
  return (
    <li className="shrink-0">
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        onClick={onClick}
        className={`flex min-h-11 w-48 flex-col items-start rounded-lg border px-3 py-2 text-left lg:w-full ${FOCUS} ${
          active
            ? "border-selection bg-neon-blue/10 text-ink shadow-[0_0_12px_2px_rgb(0_194_255/calc(0.25*var(--glow)))]"
            : "border-rule text-ink-2 hover:border-control"
        }`}
      >
        <span className="flex w-full items-center gap-1.5 text-sm font-bold">
          {tag === "smart" && (
            <span className="rounded border border-neon-purple px-1 text-[10px] font-bold text-neon-purple-text">
              Smart
            </span>
          )}
          {tag === "box" && (
            <span className="rounded border border-neon-orange-text px-1 text-[10px] font-bold text-neon-orange-text">
              Box
            </span>
          )}
          <span className="truncate">{name}</span>
        </span>
        <span className="line-clamp-2 text-xs text-ink-3">{detail}</span>
      </button>
    </li>
  );
}

function ShelfCard({ item, tabIndex, onOpen }: { item: Item; tabIndex: number; onOpen: () => void }) {
  const { card, count } = item;
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
        <CardFace model={card} size="sm" state={count === 0 ? "need" : "owned"} />
        {count > 1 && (
          <span
            aria-hidden="true"
            className="absolute -right-1.5 -top-1.5 rounded bg-neon-yellow px-1 text-[11px] font-bold leading-4 text-on-neon-yellow"
          >
            ×{count}
          </span>
        )}
      </button>
      <p
        aria-hidden="true"
        title={cardCaption(card)}
        className="mt-1 line-clamp-2 w-[5.5rem] text-center text-xs leading-tight text-ink-2"
      >
        {cardCaption(card)}
      </p>
    </li>
  );
}

/** Cards the real collection's list hydrates per step (a "Show more" asks for this many more). */
const OWNED_PAGE = 60;

/** "12,345", or "5,000+" when the store could only count that far. */
function countText(n: number, exact: boolean): string {
  return `${n.toLocaleString("en-US")}${exact ? "" : "+"}`;
}

/** "1 card", "12,345 cards", "5,000+ cards". */
function ownedCardsText(n: number, exact: boolean): string {
  return exact && n === 1 ? "1 card" : `${countText(n, exact)} cards`;
}

/**
 * NEO-358 — "Everything I own" in the real collection, until binders ship:
 * the tally line, then every card the collector holds, most recently touched
 * first, as the same image grid the demo's shelf uses. Each card opens the
 * drawer, stepping through the cards on screen.
 *
 * There is no cap on a collection (dealers hold tens of thousands), so the
 * list pages: "Show 60 more of 12,345" asks the store for 60 more, and the
 * total is the collector's tally, not what has loaded. A count the store
 * could only take part of reads as a floor ("5,000+").
 */
export function CollectionTally() {
  const summary = useSummary();
  const { openCard } = useMyCards();
  const [limit, setLimit] = useState(OWNED_PAGE);
  const owned = useOwnedCards({ limit });
  const grid = useRef<HTMLUListElement>(null);
  const ids = useMemo(() => owned?.cards.map((c) => c.id) ?? [], [owned]);
  const roving = useRoving(grid, ids);
  const focusFirstNew = useFocusFirstNew(ids, roving.focusKey);
  const listed = owned ? owned.cards.length + owned.goneCardIds.length : 0;
  // Past a floor ("5,000+") the true remainder is unknown: offer a full page.
  const more = owned ? (owned.totalExact ? owned.total - listed : Math.max(owned.total - listed, OWNED_PAGE)) : 0;

  return (
    <section aria-labelledby="mc-tally-heading" className="mt-10">
      <h2 id="mc-tally-heading" className="text-xl font-bold text-ink">
        Everything I own
      </h2>
      {summary === undefined ? (
        <div aria-busy="true" className="mt-2 max-w-sm">
          <SkeletonBars rows={1} />
          <LoadingNote>Counting your cards…</LoadingNote>
        </div>
      ) : summary.copies === 0 ? (
        <p className="mt-1 text-sm text-ink-2">
          Nothing in the binder yet. Hit Have on any checklist and your first card lands here.
        </p>
      ) : (
        <p className="mt-1 text-sm text-ink-2">
          <strong className="text-ink">{ownedCardsText(summary.cards, summary.exact)}</strong> in the collection,{" "}
          <strong className="text-ink">{countText(summary.copies, summary.exact)}</strong> in hand counting the
          extras. Newest first.
        </p>
      )}

      {summary !== undefined && summary.copies > 0 && owned === undefined && (
        <div aria-hidden="true" className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-x-3 gap-y-4">
          {Array.from({ length: Math.min(12, summary.cards) }, (_, i) => (
            <span key={i} className="aspect-[5/7] w-[5.5rem] rounded-[6px] bg-rule motion-safe:animate-pulse" />
          ))}
        </div>
      )}

      {owned && owned.cards.length > 0 && (
        <ul
          ref={grid}
          aria-label={`Everything I own, ${ownedCardsText(owned.total, owned.totalExact)}`}
          onKeyDown={roving.onKeyDown}
          onFocus={roving.onFocus}
          className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-x-3 gap-y-4"
        >
          {owned.cards.map((card) => (
            <ShelfCard
              key={card.id}
              item={{ card, count: owned.copiesByCard[card.id]?.quantity ?? 1, added: "", graded: owned.copiesByCard[card.id]?.graded === true }}
              tabIndex={roving.tabIndexFor(card.id)}
              onOpen={() => openCard(card.id, { list: ids, seed: card })}
            />
          ))}
        </ul>
      )}
      {owned && owned.goneCardIds.length > 0 && (
        <p className="mt-3 text-sm text-ink-3">
          {owned.goneCardIds.length === 1
            ? "1 card you hold isn't in the catalog anymore. It still counts above."
            : `${owned.goneCardIds.length} cards you hold aren't in the catalog anymore. They still count above.`}
        </p>
      )}
      {owned?.truncated && more > 0 && (
        <button
          type="button"
          onClick={() => {
            focusFirstNew(ids.length);
            setLimit(limit + OWNED_PAGE);
          }}
          className={`${QUIET_BUTTON} mt-4`}
        >
          Show {Math.min(OWNED_PAGE, more)} more of {countText(owned.total, owned.totalExact)}
        </button>
      )}
    </section>
  );
}
