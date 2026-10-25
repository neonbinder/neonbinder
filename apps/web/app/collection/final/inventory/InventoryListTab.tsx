import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { ArchiveBoxIcon } from "@heroicons/react/24/outline";
import { ArrowsRightLeftIcon } from "@heroicons/react/20/solid";
import { Input } from "@/components/primitives/Input";
import Chip from "../../prototypes/p3/Chip";
import { FOCUS, LABEL, QUIET_BUTTON, SELECT } from "../../prototypes/p3/classes";
import { useRoving } from "../../prototypes/p3/hooks";
import { compareNumbers } from "../../prototypes/p1/ui";
import { LoadingNote, SkeletonBars } from "../catalog/Skeleton";
import { cardLabel, compareCards, playerNames, setAndVariant, teamNames } from "../data/labels";
import { boxesOf, systemContainer, useContainers, useInventoryCards, useSearch } from "../data/store";
import type { Container, ContainerCount, InventoryCards, InventoryItem } from "../data/types";
import { usePushParams } from "../mode";
import { usePageApi } from "../pageApi";
import { TARGET_BOX_PARAM } from "./targetBox";

/**
 * NEO-364 (D13) — the Inventory list (`/inventory`, `?tab=cards`):
 * everything the collector has for sale, one item per card across every
 * box, with how many and which boxes it sits in.
 *
 * The rail: All boxes, Unsorted, Up for Trade (drawn as a box, box copies
 * only), then the collector's boxes as made. A rail pick opens that box's
 * list: `box=<id>` on the URL, pushed, so Back steps back through the boxes
 * one at a time; an unknown id reads as All boxes. Sort, the sport filter, the Only show
 * chips and the search are local state, as on My Cards' shelf.
 *
 * Hard line: every count and item here is a box copy (`useInventoryCards`),
 * never a binder copy. The headline ("42 cards for sale in 3 boxes") is the
 * boxes' own counts off the shelf, so it does not wait for the list.
 *
 * The store reads a bounded number of box lines in one go: when it stops
 * short (`truncated`) the list says so and points at the rail, which reads
 * one box at a time.
 */

type Sort = "set" | "number" | "player" | "team" | "added" | "box";

const PAGE = 50;
/** Cards asked of the store at least: filters may hide much of what loads. */
const FETCH_FLOOR = 200;

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
  const list = useRef<HTMLUListElement>(null);

  const fetchLimit = Math.max(FETCH_FLOOR, limit * 2);
  const inv = useInventoryCards({ limit: fetchLimit, ...(pickedBox ? { boxId: pickedBox.id } : {}) });
  const items = inv?.items;
  const found = useSearch(query);
  const matchIds = useMemo(
    () => (query.trim() && found ? new Set(found.cards.map((c) => c.id)) : null),
    [query, found],
  );

  const boxOrder = useMemo(() => new Map(boxes.map((b, i) => [b.id, i])), [boxes]);
  const boxName = useMemo(() => new Map(boxes.map((b) => [b.id, b.name])), [boxes]);
  const firstBox = (it: InventoryItem) =>
    Math.min(...it.boxes.map((b) => boxOrder.get(b.boxId) ?? Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);

  const sports = useMemo(() => {
    const out = new Map<string, string>();
    for (const it of items ?? []) out.set(it.card.set.sport.id, it.card.set.sport.name);
    if (sport && !out.has(sport)) out.set(sport, sport);
    return [...out.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [items, sport]);

  const shown = (items ?? [])
    .filter((it) => !onTrade || it.upForTrade)
    .filter((it) => !sport || it.card.set.sport.id === sport)
    .filter((it) => !graded || it.graded)
    .filter((it) => !dupes || it.quantity > 1)
    .filter((it) => !forTrade || it.upForTrade)
    .filter((it) => !matchIds || matchIds.has(it.card.id))
    .sort((a, b) => {
      switch (sort) {
        case "number":
          return compareNumbers(a.card.cardNumber, b.card.cardNumber) || compareCards(a.card, b.card);
        case "player":
          return (a.card.players[0]?.name ?? "").localeCompare(b.card.players[0]?.name ?? "") || compareCards(a.card, b.card);
        case "team":
          return (a.card.teams[0]?.name ?? "").localeCompare(b.card.teams[0]?.name ?? "") || compareCards(a.card, b.card);
        case "added":
          return b.lastUpdated - a.lastUpdated || compareCards(a.card, b.card);
        case "box":
          return firstBox(a) - firstBox(b) || compareCards(a.card, b.card);
        default:
          return compareCards(a.card, b.card);
      }
    });
  const visible = shown.slice(0, limit);
  const visibleIds = visible.map((it) => it.card.id);
  const roving = useRoving(list, visibleIds);
  const focusFirstNew = useFocusFirstNew(visibleIds, roving.focusKey);
  const fetchedAll = !items || items.length < fetchLimit;
  const canShowMore = shown.length > visible.length || (!fetchedAll && visible.length === shown.length && shown.length > 0);

  // The headline: the boxes' own counts (Unsorted included), off the shelf.
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
  const copiesShown = shown.reduce((n, it) => n + it.quantity, 0);
  const tally =
    items === undefined
      ? "Counting…"
      : shown.length === 0
        ? "No cards"
        : copiesShown === shown.length
          ? cardsText(copiesShown)
          : `${cardsText(copiesShown)}, ${shown.length.toLocaleString("en-US")} different`;
  const filtered = !!sport || graded || dupes || forTrade || query.trim() !== "";
  const gone = goneCount(inv);

  return (
    <section aria-labelledby="inv-list-heading" className="space-y-4">
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

      <div className="flex flex-col gap-4 lg:flex-row">
        <nav aria-label="Boxes" className="relative min-w-0 lg:w-56 lg:shrink-0">
          <ul className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
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
                detail="Trade bait in your boxes"
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
            <p className="mt-1 text-sm text-ink-2">Box cards you&apos;d swap. Trade bait in a binder stays on the collection side.</p>
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

          {items === undefined ? (
            <div aria-busy="true" className="mt-4">
              <SkeletonBars rows={4} />
              <LoadingNote>Flipping through the boxes…</LoadingNote>
            </div>
          ) : visible.length === 0 ? (
            <div className="mt-6 rounded-lg border border-dashed border-rule-strong p-6 text-center text-sm text-ink-2">
              {items.length > 0 && filtered ? (
                "Nothing here matches. Loosen a filter."
              ) : onTrade ? (
                "No box cards up for trade. Flag one from its Details."
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
              {visible.map((it) => (
                <ItemRow
                  key={it.card.id}
                  item={it}
                  boxName={boxName}
                  tabIndex={roving.tabIndexFor(it.card.id)}
                  onOpen={() =>
                    api.openCard(it.card.id, {
                      list: visibleIds,
                      seed: it.card,
                      ...(pickedBox ? { binderId: pickedBox.id } : {}),
                    })
                  }
                />
              ))}
            </ul>
          )}

          {inv?.truncated && (
            <p className="mt-3 text-sm text-ink-3">
              {pickedBox
                ? "That's a lot of cardboard. This list stops short of the whole box; Show more digs deeper."
                : "That's a lot of cardboard. This list stops short of every box; pick one on the rail to see all of it."}
            </p>
          )}
          {gone > 0 && (
            <p className="mt-3 text-sm text-ink-3">
              {gone === 1
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

/** A rail stop, drawn as a box: its name, what it holds, and a Trade tag on the trade pile. */
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
        className={`flex min-h-11 w-48 items-start gap-2 rounded-md border border-b-4 px-3 py-2 text-left lg:w-full ${FOCUS} ${
          active
            ? "border-neon-yellow-text bg-neon-yellow/10 text-ink shadow-[0_0_12px_2px_rgb(255_230_0/calc(0.2*var(--glow)))]"
            : "border-rule text-ink-2 hover:border-control"
        }`}
      >
        {tag === "trade" ? (
          <ArrowsRightLeftIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-neon-green-text" />
        ) : (
          <ArchiveBoxIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-neon-yellow-text" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex w-full items-center gap-1.5 text-sm font-bold">
            <span className="truncate">{name}</span>
            {tag === "trade" && (
              <span className="rounded border border-neon-green-text px-1 text-[0.625rem] font-bold text-neon-green-text">
                Trade
              </span>
            )}
          </span>
          <span className="line-clamp-2 text-xs text-ink-3">{detail}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * One card for sale: how many (the yellow tag), what it is, and every box it
 * sits in. The whole row is one button that opens the card's Details; the
 * list is one Tab stop and ↑ ↓ walk it.
 */
function ItemRow({
  item,
  boxName,
  tabIndex,
  onOpen,
}: {
  item: InventoryItem;
  boxName: ReadonlyMap<string, string>;
  tabIndex: number;
  onOpen: () => void;
}) {
  const { card, quantity } = item;
  const places = item.boxes
    .filter((b) => b.quantity > 0)
    .map((b) => ({ id: b.boxId, name: boxName.get(b.boxId) ?? "A box", quantity: b.quantity }));
  const where =
    places.length === 1
      ? `in ${places[0].name}`
      : places.map((p) => `${p.quantity} in ${p.name}`).join(", ");
  const players = playerNames(card);
  const teams = teamNames(card);
  // Read the way it looks: the "×N" tag first, then the card, then its tags.
  const label = `×${quantity} ${cardLabel(card)}, ${where}${item.graded ? ", slab" : ""}${
    item.upForTrade ? ", up for trade" : ""
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
          {item.graded && <span className="rounded border border-control px-1 text-xs text-ink-2">Slab</span>}
          {item.upForTrade && (
            <span className="rounded border border-neon-green-text px-1 text-xs text-neon-green-text">Up for trade</span>
          )}
          {places.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1 rounded border border-rule-strong px-1.5 text-xs text-ink-2">
              <ArchiveBoxIcon className="h-3 w-3 text-neon-yellow-text" />
              {p.name}
              {places.length > 1 || p.quantity !== quantity ? <span className="tabular-nums text-ink-3">×{p.quantity}</span> : null}
            </span>
          ))}
        </span>
      </button>
    </li>
  );
}
