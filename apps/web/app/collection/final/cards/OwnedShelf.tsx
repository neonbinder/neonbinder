import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/primitives/Input";
import CardFace from "../../prototypes/_shared/CardFace";
import Chip from "../../prototypes/p3/Chip";
import { FOCUS, LABEL, QUIET_BUTTON, SELECT } from "../../prototypes/p3/classes";
import { useRoving } from "../../prototypes/p3/hooks";
import { openView } from "../binders/openView";
import { cardCaption } from "../captions";
import { LoadingNote, SkeletonBars } from "../catalog/Skeleton";
import { demoCard } from "../data/demoStore";
import { cardLabel, compareCards } from "../data/labels";
import { useDemoExtension, useOwnedCards, useSearch, useSummary } from "../data/store";
import type { Card } from "../data/types";
import type { CollectionBinder, CollectionStore } from "../store";
import { useMyCards } from "./context";

/**
 * NEO-350 — "Everything else I own": the cards that are not on a set build,
 * as a compact image grid, with binders down the side: Main and Up for Trade
 * first, then your own. A smart binder lists what it would hold, haves and
 * needs both.
 *
 * NEO-358: binders are the demo's alone (the `binders` capability), so this
 * shelf reads the demo's own store. The real collection shows
 * `CollectionTally` (the tally and every owned card) in its place until
 * binders ship.
 *
 * "Everything else" and "Every card I own" read through the binder picker's
 * scope; picking a binder on the rail shows that binder's cards whatever the
 * picker says. The rail is navigation: the shelf showing is `aria-current`.
 *
 * "Show 36 more of 120" counts the whole shelf. The keyboard goes to the
 * first card it adds, even when the button goes away with the last page.
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
type DemoCopy = CollectionStore["scopedCopies"][number];

const PAGE = 36;

interface Item {
  card: Card;
  count: number;
  added: string;
  graded: boolean;
}

export default function OwnedShelf() {
  const api = useMyCards();
  const demo = useDemoExtension();
  if (!demo) return null;
  return <Shelf store={demo.state} openCard={api.openCard} scopedName={api.scopedName} />;
}

function Shelf({
  store,
  openCard,
  scopedName,
}: {
  store: CollectionStore;
  openCard: ReturnType<typeof useMyCards>["openCard"];
  scopedName: string | null;
}) {
  const [shelf, setShelf] = useState<Shelf>("else");
  const [sort, setSort] = useState<Sort>("set");
  const [sport, setSport] = useState<string>("");
  const [graded, setGraded] = useState(false);
  const [dupes, setDupes] = useState(false);
  const [needs, setNeeds] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const grid = useRef<HTMLUListElement>(null);

  const binder = shelf !== "else" && shelf !== "all" ? store.getBinder(shelf) : undefined;
  const building = new Set(store.state.buildingSetIds);
  const offBoard = (c: DemoCopy) => {
    const card = demoCard(c.cardId);
    return !!card && !building.has(card.set.id);
  };

  const items: Item[] = (() => {
    const byCard = new Map<string, Item>();
    const copies = binder ? store.binderCopies(binder) : store.scopedCopies;
    for (const copy of copies) {
      if (copy.quantity <= 0) continue;
      if (shelf === "else" && !offBoard(copy)) continue;
      const card = demoCard(copy.cardId);
      if (!card) continue;
      const item = byCard.get(card.id) ?? { card, count: 0, added: "", graded: false };
      item.count += copy.quantity;
      if (copy.graded) item.graded = true;
      if (copy.acquiredAt > item.added) item.added = copy.acquiredAt;
      byCard.set(card.id, item);
    }
    if (binder?.kind === "smart") {
      for (const fixture of store.binderCards(binder)) {
        const card = demoCard(fixture.id);
        if (card && !byCard.has(card.id)) byCard.set(card.id, { card, count: 0, added: "", graded: false });
      }
    }
    return [...byCard.values()];
  })();

  const found = useSearch(query);
  const matchIds = useMemo(
    () => (query.trim() && found ? new Set(found.cards.map((c) => c.id)) : null),
    [query, found],
  );

  const shown = items
    .filter((it) => !sport || it.card.set.sport.id === sport)
    .filter((it) => !graded || it.graded)
    .filter((it) => !dupes || it.count > 1)
    .filter((it) => !needs || it.count === 0)
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

  const fileable = store.fileableBinders;
  const smart = store.ownBinders.filter((b) => b.kind === "smart");
  const distinct = (copies: DemoCopy[]) => new Set(copies.filter((c) => c.quantity > 0).map((c) => c.cardId)).size;
  const ownedAll = distinct(store.scopedCopies);
  const ownedElse = distinct(store.scopedCopies.filter(offBoard));
  const scopeNote = scopedName ? ` in ${scopedName}` : "";

  const pick = (next: Shelf) => {
    setShelf(next);
    setLimit(PAGE);
    setNeeds(false);
  };

  const title =
    shelf === "else"
      ? `Off the board${scopeNote}`
      : shelf === "all"
        ? `Every card I own${scopeNote}`
        : (binder?.name ?? "");

  return (
    <section aria-labelledby="mc-shelf-heading" className="mt-10">
      <h2 id="mc-shelf-heading" className="text-xl font-bold text-ink">
        Everything else I own
      </h2>
      <p className="mt-1 text-sm text-ink-3">
        Singles, slabs and PC cards that aren&apos;t part of a set build, plus your binders.
      </p>

      <div className="mt-4 flex flex-col gap-4 lg:flex-row">
        <nav aria-label="Shelves and binders" className="relative min-w-0 lg:w-56 lg:shrink-0">
          <ul className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
            <RailItem
              active={shelf === "else"}
              onClick={() => pick("else")}
              name="Everything else"
              detail={`${ownedElse} cards off the board${scopeNote}`}
            />
            <RailItem
              active={shelf === "all"}
              onClick={() => pick("all")}
              name="Every card I own"
              detail={`${ownedAll} cards${scopeNote}`}
            />
            <li className="hidden pt-2 text-xs font-bold text-ink-3 lg:block" aria-hidden="true">
              Binders
            </li>
            {fileable.map((b) => (
              <RailItem
                key={b.id}
                active={shelf === b.id}
                onClick={() => pick(b.id)}
                name={b.name}
                detail={`${distinct(store.binderCopies(b))} cards`}
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
                smart
                detail={smartDetail(b, store)}
              />
            ))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-base font-bold text-ink">{title}</h3>
            <p className="text-sm text-ink-3" role="status">
              {shown.length} {shown.length === 1 ? "card" : "cards"}
            </p>
          </div>
          {binder?.kind === "smart" && (
            <p className="mt-1 text-sm text-ink-2">
              Fills itself: <span className="text-ink">{ruleText(binder, store)}</span>. Needs show dimmed.
            </p>
          )}
          {binder?.kind === "manual" && binder.description && (
            <p className="mt-1 text-sm text-ink-2">{binder.description}</p>
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
                onChange={(e) => setSport(e.target.value)}
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
            <p className="mt-6 rounded-lg border border-dashed border-rule-strong p-6 text-center text-sm text-ink-2">
              {shelf === "else" && items.length === 0
                ? "Every card here is on a set build. Gnarly."
                : items.length === 0
                  ? "Nothing in here yet."
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
                  onOpen={() => openCard(it.card.id, { list: visibleIds, seed: it.card })}
                />
              ))}
            </ul>
          )}
          {shown.length > visible.length && (
            <button
              type="button"
              onClick={() => {
                focusFirstNew(visible.length);
                setLimit(limit + PAGE);
              }}
              className={`${QUIET_BUTTON} mt-4`}
            >
              Show {Math.min(PAGE, shown.length - visible.length)} more of {shown.length}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/** A smart binder's rule in words, as its cover says it ("Reggie White"). */
function ruleText(b: CollectionBinder, store: CollectionStore): string {
  const line = openView({ kind: "binder", binderId: b.id }, b, store, "stack").blurb.find((l) => l.startsWith("Fills itself: "));
  return line ? line.slice("Fills itself: ".length).replace(/\.$/, "") : b.name;
}

function smartDetail(b: CollectionBinder, store: CollectionStore): string {
  if (b.kind !== "smart") return "";
  const list = store.binderCards(b);
  const have = list.filter((c) => store.ownedCount(c.id) > 0).length;
  return `${ruleText(b, store)}. Own ${have} of ${list.length}`;
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
        aria-current={active ? "true" : undefined}
        onClick={onClick}
        className={`flex min-h-11 w-48 flex-col items-start rounded-lg border px-3 py-2 text-left lg:w-full ${FOCUS} ${
          active
            ? "border-selection bg-neon-blue/10 text-ink shadow-[0_0_12px_2px_rgb(0_194_255/calc(0.25*var(--glow)))]"
            : "border-rule text-ink-2 hover:border-control"
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
              item={{ card, count: owned.copiesByCard[card.id]?.quantity ?? 1, added: "", graded: false }}
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
