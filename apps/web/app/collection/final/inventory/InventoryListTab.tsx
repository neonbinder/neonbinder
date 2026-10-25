import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { AdjustmentsHorizontalIcon, ArchiveBoxIcon, BookOpenIcon } from "@heroicons/react/24/outline";
import { ArrowsRightLeftIcon, ChevronDownIcon } from "@heroicons/react/20/solid";
import { Input } from "@/components/primitives/Input";
import Chip from "../../prototypes/p3/Chip";
import { FOCUS, LABEL, QUIET_BUTTON, SELECT } from "../../prototypes/p3/classes";
import { useRoving } from "../../prototypes/p3/hooks";
import { compareNumbers } from "../../prototypes/p1/ui";
import { LoadingNote, SkeletonBars } from "../catalog/Skeleton";
import { cardLabel, compareCards, playerNames, setAndVariant, teamNames } from "../data/labels";
import {
  boxesOf,
  systemContainer,
  useCards,
  useContainerCopies,
  useContainers,
  useInventoryCards,
  useSearch,
} from "../data/store";
import type { Card, Container, ContainerCount, ContainerKind, Copy, InventoryCards, InventoryItem } from "../data/types";
import { usePushParams } from "../mode";
import { usePageApi } from "../pageApi";
import { comparePlayerNames } from "../playerName";
import { TARGET_BOX_PARAM } from "./targetBox";

/**
 * NEO-364 (D13) — the Inventory list (`/inventory`, `?tab=cards`):
 * everything the collector has for sale, one item per card across every
 * box, with how many and which boxes it sits in.
 *
 * The rail: All boxes, Unsorted, Up for Trade, then the collector's boxes as
 * made. A rail pick opens that stop's list: `box=<id>` on the URL, pushed, so
 * Back steps back through the boxes one at a time; an unknown id reads as All
 * boxes. Sort, the sport filter, the Only show chips and the search are local
 * state, as on My Cards' shelf. On a phone they fold behind a Filters button
 * so the first card is on screen.
 *
 * Hard line: every count and item here is a box copy (`useInventoryCards`),
 * never a binder copy, with one exception: Up for Trade is one query across
 * both sides (Jason: trade "is a query against both"), so its stop lists the
 * whole trade pile, a binder's copies tagged "In <binder>". The headline
 * ("42 cards for sale in 3 boxes") is the boxes' own counts off the shelf, so
 * it does not wait for the list; it counts only boxes that hold a card.
 *
 * Slabs only counts and tags the graded copies alone: a PSA 9 and two raw in
 * one box read ×1, Slab. Without it, an item that mixes the two says how many
 * of its copies are slabs.
 *
 * The store reads a bounded number of box lines in one go: when it stops
 * short (`truncated`) the list says so and points at the rail, which reads
 * one box at a time.
 */

type Sort = "set" | "number" | "player" | "team" | "added" | "box";

const PAGE = 50;
/** Cards asked of the store at least: filters may hide much of what loads. */
const FETCH_FLOOR = 200;

/** Where some of a card sits: a box, or (on the trade pile only) a binder. */
interface Place {
  id: string;
  name: string;
  kind: ContainerKind;
  quantity: number;
  /** Of `quantity`, the graded copies (slabs). */
  slabs: number;
}

/** One card on the list, from either source, before Slabs only narrows it. */
interface Row {
  card: Card;
  quantity: number;
  slabs: number;
  upForTrade: boolean;
  /** Ms since epoch, for Newest first. */
  added: number;
  places: Place[];
}

/** "1 card", "12 cards". */
function cardsText(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "card" : "cards"}`;
}

/** "3 boxes", "1 box". */
function boxesText(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "box" : "boxes"}`;
}

/** A rail item's line under its name. */
function countDetail(count: ContainerCount | null): string {
  return count ? cardsText(count.copies) : "Not counted yet";
}

/** The cards that `useInventoryCards` could not find in the catalog. */
function goneCount(inv: InventoryCards | undefined): number {
  return inv?.goneCardIds.length ?? 0;
}

/** A box item as a list row. */
function rowOfItem(it: InventoryItem, boxName: ReadonlyMap<string, string>): Row {
  return {
    card: it.card,
    quantity: it.quantity,
    slabs: it.gradedQuantity,
    upForTrade: it.upForTrade,
    added: it.lastUpdated,
    places: it.boxes
      .filter((b) => b.quantity > 0)
      .map((b) => ({
        id: b.boxId,
        name: boxName.get(b.boxId) ?? "A box",
        kind: "box" as const,
        quantity: b.quantity,
        slabs: b.gradedQuantity,
      })),
  };
}

/**
 * The trade pile as list rows: one per card, every flagged copy of it
 * together, in a binder or a box. Cards still loading are left out until
 * they land; cards the catalog dropped are counted in `gone`.
 */
function rowsOfTrade(
  copies: readonly Copy[],
  cardIds: readonly string[],
  cards: readonly (Card | null)[],
  names: ReadonlyMap<string, Container>,
): { rows: Row[]; gone: number } {
  const byId = new Map<string, Card | null>(cardIds.map((id, i) => [id, cards[i] ?? null]));
  const rows = new Map<string, Row>();
  const gone = new Set<string>();
  copies.forEach((copy, i) => {
    if (copy.quantity <= 0) return;
    const card = byId.get(copy.cardId);
    if (!card) {
      if (card === null) gone.add(copy.cardId);
      return;
    }
    const day = Date.parse(copy.acquiredAt);
    const added = (Number.isFinite(day) ? day : 0) + i;
    const slabs = copy.graded ? copy.quantity : 0;
    const row = rows.get(card.id) ?? { card, quantity: 0, slabs: 0, upForTrade: true, added: 0, places: [] };
    row.quantity += copy.quantity;
    row.slabs += slabs;
    row.added = Math.max(row.added, added);
    const home = names.get(copy.homeId);
    const kind: ContainerKind = home?.kind ?? copy.homeKind;
    const place = row.places.find((p) => p.id === copy.homeId);
    if (place) {
      place.quantity += copy.quantity;
      place.slabs += slabs;
    } else {
      row.places.push({
        id: copy.homeId,
        name: home?.name ?? copy.homeName ?? (kind === "box" ? "A box" : "A binder"),
        kind,
        quantity: copy.quantity,
        slabs,
      });
    }
    rows.set(card.id, row);
  });
  return { rows: [...rows.values()], gone: gone.size };
}

/** Slabs only: the row counted by its graded copies alone, or null when it has none. */
function slabsOf(row: Row): Row | null {
  if (row.slabs <= 0) return null;
  return {
    ...row,
    quantity: row.slabs,
    places: row.places.filter((p) => p.slabs > 0).map((p) => ({ ...p, quantity: p.slabs })),
  };
}

export default function InventoryListTab() {
  const api = usePageApi();
  const containers = useContainers();
  const [params] = useSearchParams();
  const pushParams = usePushParams();

  const boxes = useMemo(() => boxesOf(containers), [containers]);
  const trade = systemContainer(containers, "trade");
  const railParam = params.get(TARGET_BOX_PARAM);
  const pickedBox = railParam ? boxes.find((b) => b.id === railParam) : undefined;
  const onTrade = !!railParam && !!trade && railParam === trade.id;
  const picked: Container | undefined = pickedBox ?? (onTrade ? trade : undefined);

  const [sort, setSort] = useState<Sort>("set");
  const [sport, setSport] = useState("");
  const [graded, setGraded] = useState(false);
  const [dupes, setDupes] = useState(false);
  const [forTrade, setForTrade] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersId = useId();
  const list = useRef<HTMLUListElement>(null);

  const fetchLimit = Math.max(FETCH_FLOOR, limit * 2);
  const inv = useInventoryCards({ limit: fetchLimit, ...(pickedBox ? { boxId: pickedBox.id } : {}) });
  // The trade pile: binder and box copies alike, read only while its stop is open.
  const tradePile = useContainerCopies(onTrade && trade ? trade.id : null, { limit: fetchLimit });
  const tradeCardIds = useMemo(
    () => (tradePile ? [...new Set(tradePile.copies.map((c) => c.cardId))] : null),
    [tradePile],
  );
  const tradeCards = useCards(tradeCardIds);

  const found = useSearch(query);
  const matchIds = useMemo(
    () => (query.trim() && found ? new Set(found.cards.map((c) => c.id)) : null),
    [query, found],
  );

  const boxOrder = useMemo(() => new Map(boxes.map((b, i) => [b.id, i])), [boxes]);
  const boxName = useMemo(() => new Map(boxes.map((b) => [b.id, b.name])), [boxes]);
  const byId = useMemo(() => new Map((containers ?? []).map((c) => [c.id, c])), [containers]);

  const tradeRows = useMemo(
    () =>
      onTrade && tradePile && tradeCardIds && tradeCards
        ? rowsOfTrade(tradePile.copies, tradeCardIds, tradeCards, byId)
        : undefined,
    [onTrade, tradePile, tradeCardIds, tradeCards, byId],
  );
  const boxRows = useMemo(() => inv?.items.map((it) => rowOfItem(it, boxName)), [inv, boxName]);
  const rows: Row[] | undefined = onTrade ? tradeRows?.rows : boxRows;

  // Binders sort after every box; a box by its place on the shelf.
  const firstPlace = (row: Row) =>
    Math.min(
      ...row.places.map((p) => (p.kind === "box" ? (boxOrder.get(p.id) ?? boxes.length) : boxes.length + 1)),
      Number.MAX_SAFE_INTEGER,
    );

  const sports = useMemo(() => {
    const out = new Map<string, string>();
    for (const row of rows ?? []) out.set(row.card.set.sport.id, row.card.set.sport.name);
    if (sport && !out.has(sport)) out.set(sport, sport);
    return [...out.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows, sport]);

  const shown = (rows ?? [])
    .map((row) => (graded ? slabsOf(row) : row))
    .filter((row): row is Row => row !== null)
    .filter((row) => !sport || row.card.set.sport.id === sport)
    .filter((row) => !dupes || row.quantity > 1)
    .filter((row) => onTrade || !forTrade || row.upForTrade)
    .filter((row) => !matchIds || matchIds.has(row.card.id))
    .sort((a, b) => {
      switch (sort) {
        case "number":
          return compareNumbers(a.card.cardNumber, b.card.cardNumber) || compareCards(a.card, b.card);
        case "player":
          return comparePlayerNames(a.card.players[0]?.name, b.card.players[0]?.name) || compareCards(a.card, b.card);
        case "team":
          return (a.card.teams[0]?.name ?? "").localeCompare(b.card.teams[0]?.name ?? "") || compareCards(a.card, b.card);
        case "added":
          return b.added - a.added || compareCards(a.card, b.card);
        case "box":
          return firstPlace(a) - firstPlace(b) || compareCards(a.card, b.card);
        default:
          return compareCards(a.card, b.card);
      }
    });
  const visible = shown.slice(0, limit);
  const visibleIds = visible.map((row) => row.card.id);
  const roving = useRoving(list, visibleIds);
  const focusFirstNew = useFocusFirstNew(visibleIds, roving.focusKey);
  const fetchedAll = onTrade ? !tradePile?.truncated : !inv || inv.items.length < fetchLimit;
  const canShowMore = shown.length > visible.length || (!fetchedAll && visible.length === shown.length && shown.length > 0);

  // The headline: the boxes' own counts (Unsorted included), off the shelf.
  // Only a box holding a card counts as one.
  const counted = containers !== undefined && boxes.every((b) => b.count !== null);
  const forSale = boxes.reduce((n, b) => n + (b.count?.copies ?? 0), 0);
  const boxesHolding = boxes.filter((b) => (b.count?.copies ?? 0) > 0).length;

  const pick = (id: string | null) => {
    setLimit(PAGE);
    // Already on it: a second entry for the same view would be a Back chore.
    if (id === railParam) return;
    pushParams((p) => {
      if (id) p.set(TARGET_BOX_PARAM, id);
      else p.delete(TARGET_BOX_PARAM);
    });
  };

  const title = picked ? picked.name : "Every box";
  const copiesShown = shown.reduce((n, row) => n + row.quantity, 0);
  const tally =
    rows === undefined
      ? "Counting…"
      : shown.length === 0
        ? "No cards"
        : copiesShown === shown.length
          ? cardsText(copiesShown)
          : `${cardsText(copiesShown)}, ${shown.length.toLocaleString("en-US")} different`;
  // What the Filters button counts on a phone: everything that narrows the list.
  const activeFilters = [query.trim() !== "", !!sport, graded, dupes, !onTrade && forTrade].filter(Boolean).length;
  const filtered = activeFilters > 0;
  const gone = onTrade ? (tradeRows?.gone ?? 0) : goneCount(inv);
  const truncated = onTrade ? !!tradePile?.truncated : !!inv?.truncated;

  return (
    <section aria-labelledby="inv-list-heading" className="min-w-0 space-y-4">
      <div>
        <h2 id="inv-list-heading" className="text-xl font-bold text-ink">
          Everything for sale
        </h2>
        {!counted ? (
          <div aria-busy="true" className="mt-2 max-w-sm">
            <SkeletonBars rows={1} />
            <LoadingNote>Counting the boxes…</LoadingNote>
          </div>
        ) : forSale === 0 ? (
          <p className="mt-1 text-sm text-ink-2">
            Nothing for sale yet. Open Checklists, pick a box and type how many you&apos;ve got.
          </p>
        ) : (
          <p className="mt-1 text-sm text-ink-2">
            <strong className="tabular-nums text-ink">{cardsText(forSale)}</strong> for sale in{" "}
            <strong className="tabular-nums text-ink">{boxesText(boxesHolding)}</strong>.
          </p>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-4 lg:flex-row">
        <nav aria-label="Boxes" className="relative min-w-0 lg:w-56 lg:shrink-0">
          {/* Positioned, so the stops' screen-reader separators scroll with it instead of widening the page.
              On a phone it is one short strip that swipes sideways, with no scrollbar drawn under it. */}
          <ul className="relative flex max-w-full gap-2 overflow-x-auto pb-1 max-sm:gap-1.5 max-sm:pb-0 max-sm:[scrollbar-width:none] max-sm:[&::-webkit-scrollbar]:hidden lg:flex-col lg:overflow-visible">
            <RailItem
              active={!picked}
              onClick={() => pick(null)}
              name="All boxes"
              detail={counted ? cardsText(forSale) : "Counting…"}
            />
            {boxes.length > 0 && boxes[0].system === "unsorted" && (
              <RailItem
                active={pickedBox?.id === boxes[0].id}
                onClick={() => pick(boxes[0].id)}
                name={boxes[0].name}
                detail={countDetail(boxes[0].count)}
              />
            )}
            {trade && (
              <RailItem
                active={onTrade}
                onClick={() => pick(trade.id)}
                name={trade.name}
                detail={countDetail(trade.count)}
                tag="trade"
              />
            )}
            {boxes
              .filter((b) => b.system !== "unsorted")
              .map((b) => (
                <RailItem
                  key={b.id}
                  active={pickedBox?.id === b.id}
                  onClick={() => pick(b.id)}
                  name={b.name}
                  detail={countDetail(b.count)}
                />
              ))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-base font-bold text-ink">{title}</h3>
            <p className="text-sm tabular-nums text-ink-3" role="status">
              {tally}
            </p>
          </div>
          {picked?.description && <p className="mt-1 text-sm text-ink-2">{picked.description}</p>}
          {onTrade && (
            <p className="mt-1 text-sm text-ink-2">Everything you&apos;d swap, from your binders and your boxes.</p>
          )}

          {/* Phone only: the filters fold away so the first card is on screen. */}
          <button
            type="button"
            aria-expanded={filtersOpen}
            aria-controls={filtersId}
            aria-label={activeFilters > 0 ? `Filters, ${activeFilters} on` : "Filters"}
            onClick={() => setFiltersOpen(!filtersOpen)}
            className={`mt-3 inline-flex min-h-11 items-center gap-2 rounded-md border border-control px-3 text-sm font-bold text-ink hover:border-neon-blue-text sm:hidden ${FOCUS}`}
          >
            <AdjustmentsHorizontalIcon aria-hidden="true" className="h-4 w-4 text-neon-blue-text" />
            Filters
            {activeFilters > 0 && (
              <span
                aria-hidden="true"
                className="inline-flex min-w-5 justify-center rounded-full bg-neon-blue px-1.5 text-xs tabular-nums text-on-neon-blue"
              >
                {activeFilters}
              </span>
            )}
            <ChevronDownIcon
              aria-hidden="true"
              className={`h-4 w-4 text-ink-3 transition-transform motion-reduce:transition-none ${filtersOpen ? "rotate-180" : ""}`}
            />
          </button>

          <div id={filtersId} className={filtersOpen ? "" : "max-sm:hidden"}>
            <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
              <Input
                label="Filter these cards"
                placeholder="Try “griffey refractor”"
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
                  <option value="number">Card number</option>
                  <option value="player">Player</option>
                  <option value="team">Team</option>
                  <option value="added">Newest first</option>
                  <option value="box">Box</option>
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
              {!onTrade && (
                <Chip pressed={forTrade} onClick={() => setForTrade(!forTrade)}>
                  Up for trade
                </Chip>
              )}
            </div>
          </div>

          {rows === undefined ? (
            <div aria-busy="true" className="mt-4">
              <SkeletonBars rows={4} />
              <LoadingNote>{onTrade ? "Rounding up the trade bait…" : "Flipping through the boxes…"}</LoadingNote>
            </div>
          ) : visible.length === 0 ? (
            <div className="mt-6 rounded-lg border border-dashed border-rule-strong p-6 text-center text-sm text-ink-2">
              {rows.length > 0 && filtered ? (
                "Nothing here matches. Loosen a filter."
              ) : onTrade ? (
                "Nothing up for trade yet. Flag a card from its Details."
              ) : picked ? (
                "Empty box. Fill it from Checklists, or Sell a card into it from its Details."
              ) : (
                <>
                  <p>No cards in your boxes yet.</p>
                  <button type="button" onClick={() => api.goToChecklists()} className={`${QUIET_BUTTON} mt-3`}>
                    Stock up in Checklists
                  </button>
                </>
              )}
            </div>
          ) : (
            <ul
              ref={list}
              aria-label={`${title}, ${tally}`}
              onKeyDown={roving.onKeyDown}
              onFocus={roving.onFocus}
              className="mt-4 divide-y divide-rule overflow-hidden rounded-lg border border-rule-strong bg-raised shadow-offset"
            >
              {visible.map((row) => (
                <ItemRow
                  key={row.card.id}
                  row={row}
                  slabsOnly={graded}
                  showTrade={!onTrade}
                  tabIndex={roving.tabIndexFor(row.card.id)}
                  onOpen={() =>
                    api.openCard(row.card.id, {
                      list: visibleIds,
                      seed: row.card,
                      ...(pickedBox ? { binderId: pickedBox.id } : {}),
                    })
                  }
                />
              ))}
            </ul>
          )}

          {truncated && (
            <p className="mt-3 text-sm text-ink-3">
              {onTrade
                ? "That's a lot of trade bait. This list stops short of the whole pile; Show more digs deeper."
                : pickedBox
                  ? "That's a lot of cardboard. This list stops short of the whole box; Show more digs deeper."
                  : "That's a lot of cardboard. This list stops short of every box; pick one on the rail to see all of it."}
            </p>
          )}
          {gone > 0 && (
            <p className="mt-3 text-sm text-ink-3">
              {onTrade
                ? gone === 1
                  ? "1 card up for trade isn't in the catalog anymore. It still counts on the pile."
                  : `${gone} cards up for trade aren't in the catalog anymore. They still count on the pile.`
                : gone === 1
                  ? "1 card in your boxes isn't in the catalog anymore. It still counts in its box."
                  : `${gone} cards in your boxes aren't in the catalog anymore. They still count in their boxes.`}
            </p>
          )}
          {canShowMore && (
            <button
              type="button"
              onClick={() => {
                focusFirstNew(visible.length);
                setLimit(limit + PAGE);
              }}
              className={`${QUIET_BUTTON} mt-4`}
            >
              {shown.length > visible.length
                ? `Show ${Math.min(PAGE, shown.length - visible.length)} more of ${shown.length.toLocaleString("en-US")}${
                    fetchedAll ? "" : "+"
                  }`
                : "Show more"}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * After "Show more": put the keyboard on the first item the page added, once
 * it is on screen. Returns the setter to call with the count shown before.
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

/**
 * A rail stop, drawn as a box: its name, what it holds, and a Trade tag on
 * the trade pile. Its name reads "Unsorted, 3 cards" / "Up for Trade, 4
 * cards" (the tag is hidden from it).
 */
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
  tag?: "trade";
}) {
  return (
    <li className="shrink-0">
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        onClick={onClick}
        // A scroller clips what spills out of it, so below lg the focus outline is drawn inset.
        className={`relative flex min-h-11 w-48 items-start gap-2 rounded-md border border-b-4 px-3 py-2 text-left max-sm:w-auto max-sm:max-w-[15rem] max-sm:items-center max-sm:px-2.5 max-sm:py-1.5 max-lg:focus-visible:-outline-offset-2! lg:w-full ${FOCUS} ${
          active
            ? "border-neon-yellow-text bg-neon-yellow/10 text-ink shadow-[0_0_12px_2px_rgb(255_230_0/calc(0.2*var(--glow)))]"
            : "border-rule text-ink-2 hover:border-control"
        }`}
      >
        {tag === "trade" ? (
          <ArrowsRightLeftIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-neon-green-text max-sm:mt-0" />
        ) : (
          <ArchiveBoxIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-neon-yellow-text max-sm:mt-0" />
        )}
        {/* Name over what it holds; side by side on a phone, so the strip stays one line tall. */}
        <span className="min-w-0 flex-1 max-sm:flex max-sm:items-baseline max-sm:gap-1.5">
          <span className="flex w-full min-w-0 items-center gap-1.5 text-sm font-bold max-sm:w-auto">
            <span className="truncate">{name}</span>
            {tag === "trade" && (
              <span aria-hidden="true" className="rounded border border-neon-green-text px-1 text-[0.625rem] font-bold text-neon-green-text">
                Trade
              </span>
            )}
          </span>
          {/* Read as "Name, what it holds": the Trade badge is decoration (the name says it). */}
          <span className="sr-only">, </span>
          <span className="line-clamp-2 text-xs text-ink-3 max-sm:shrink-0 max-sm:whitespace-nowrap">{detail}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * The slab tag a row wears, or null: "Slab" / "Slabs" when every copy it
 * counts is graded (always so under Slabs only), "1 slab" / "2 slabs" when
 * it mixes slabs and raw.
 */
function slabTag(row: Row, slabsOnly: boolean): string | null {
  if (row.slabs <= 0) return null;
  if (slabsOnly || row.slabs >= row.quantity) return row.quantity === 1 ? "Slab" : "Slabs";
  return `${row.slabs} ${row.slabs === 1 ? "slab" : "slabs"}`;
}

/**
 * One card for sale (or, on the trade pile, up for trade): how many (the
 * yellow tag), what it is, and every place it sits. The whole row is one
 * button that opens the card's Details; the list is one Tab stop and ↑ ↓
 * walk it.
 */
function ItemRow({
  row,
  slabsOnly,
  showTrade,
  tabIndex,
  onOpen,
}: {
  row: Row;
  slabsOnly: boolean;
  /** Tag a copy up for trade (off on the trade pile itself, where every copy is). */
  showTrade: boolean;
  tabIndex: number;
  onOpen: () => void;
}) {
  const { card, quantity, places } = row;
  const said = (p: Place) => (p.kind === "binder" ? `In ${p.name}` : p.name);
  const where =
    places.length === 1
      ? `in ${places[0].name}`
      : places.map((p) => `${p.quantity} in ${p.name}`).join(", ");
  const slab = slabTag(row, slabsOnly);
  const trade = showTrade && row.upForTrade;
  const players = playerNames(card);
  const teams = teamNames(card);
  // Read the way it looks: the "×N" tag first, then the card, then its tags.
  const label = `×${quantity} ${cardLabel(card)}, ${where}${slab ? `, ${slab.toLowerCase()}` : ""}${
    trade ? ", up for trade" : ""
  }`;
  return (
    <li>
      <button
        type="button"
        data-rove={card.id}
        tabIndex={tabIndex}
        aria-label={label}
        aria-haspopup="dialog"
        onClick={onOpen}
        className={`flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-list-hover-raised ${FOCUS} max-sm:flex-wrap`}
      >
        <span
          aria-hidden="true"
          className="inline-flex min-w-10 shrink-0 justify-center rounded-sm bg-neon-yellow px-1.5 py-0.5 text-sm font-bold tabular-nums text-on-neon-yellow"
        >
          ×{quantity}
        </span>
        <span aria-hidden="true" className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">
            #{card.cardNumber} {players || "Player unknown"}
            {card.cardVariation ? `, ${card.cardVariation} variation` : ""}
          </span>
          <span className="block truncate text-xs text-ink-3">
            {setAndVariant(card)}
            {teams ? `, ${teams}` : ""}
          </span>
        </span>
        <span aria-hidden="true" className="flex shrink-0 flex-wrap justify-end gap-1 max-sm:basis-full max-sm:justify-start max-sm:pl-[3.25rem]">
          {slab && <span className="rounded border border-control px-1 text-xs text-ink-2">{slab}</span>}
          {trade && <span className="rounded border border-neon-green-text px-1 text-xs text-neon-green-text">Up for trade</span>}
          {places.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1 rounded border border-rule-strong px-1.5 text-xs text-ink-2">
              {p.kind === "binder" ? (
                <BookOpenIcon className="h-3 w-3 text-neon-blue-text" />
              ) : (
                <ArchiveBoxIcon className="h-3 w-3 text-neon-yellow-text" />
              )}
              {said(p)}
              {places.length > 1 || p.quantity !== quantity ? <span className="tabular-nums text-ink-3">×{p.quantity}</span> : null}
            </span>
          ))}
        </span>
      </button>
    </li>
  );
}
