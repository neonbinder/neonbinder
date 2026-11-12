import { useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Link, useLocation } from "react-router";
import { ChevronDownIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useOpen } from "./useOpen";
import SpineLabel, { SpineFontFaces } from "@/app/collection/final/binders/SpineLabel";
import { BOX_LETTERING_PX } from "@/app/collection/final/binders/label";
import "@/app/collection/final/binders/binders.css";
import "@/app/collection/final/binders/box.css";
import type { ShelfBox } from "../fake-data";
import { count, sideHref } from "./bits";
import type { ShelfBinder } from "./shelf-model";

/**
 * NEO-464 combined dashboard, block 4 — every binder on three shelves of
 * eight, regular and smart together (Jason: "we don't need to separate
 * regular from smart binders"). A spine wears My Binders' own label
 * (`SpineLabel`: the label's colour, the name lettered big down it, the count
 * on a white sticker at the foot) and, when cards were filed in it since the
 * last visit, a green "N new" sticker on top. A smart binder wears the same
 * "Smart" chip as on My Binders; one whose rule names a checklist also wears
 * a meter up the spine's edge.
 *
 * The three shelves hold SHELF_CAP binders, picked in `shelfOrder` (most new
 * first, then the fullest). Fewer and they all stand, with the space left
 * empty; more and "Show all N binders" adds shelves. That is an in-view
 * disclosure: it replaces the entry (`?open=shelf`), never pushes.
 *
 * The third shelf is Inventory's once the collector has a box in use (review
 * round 4): their boxes stand on it end out, as on My Boxes, each one link to
 * the box on Inventory, and the binders keep the first two shelves. With no
 * box in use, binders that don't fit on the first two stand on the third, and
 * the way into Inventory's Add cards (`starter(2)`) stands after them while
 * the row has room.
 *
 * A spine is a disclosure button: it opens the pocket page (`aria-controls`),
 * and the open one stands half out of the shelf.
 */

export const PER_SHELF = 8;
export const SHELVES = 3;
/** Three shelves of eight. */
export const SHELF_CAP = PER_SHELF * SHELVES;
/** With boxes on the third shelf, the binders keep two. */
export const SHELF_CAP_WITH_BOXES = PER_SHELF * (SHELVES - 1);
/**
 * The third shelf still carries its starter beside this many binders at most.
 * Fewer on a phone: past two its words wrap down into the ledge.
 */
export const STARTER_ROOM = 4;
export const STARTER_ROOM_NARROW = 2;
/** Box ends to a shelf (fewer on a phone); past that, the last place says how many more. */
export const BOXES_PER_SHELF = 6;
export const BOXES_PER_SHELF_NARROW = 4;

const NARROW_QUERY = "(max-width: 639.98px)";

function subscribeNarrow(onChange: () => void): () => void {
  const mq = window.matchMedia(NARROW_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** True on a phone-width screen: the same eight to a shelf, slimmer spines. */
function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}

/**
 * The shortest a spine stands here, in px: `.cb-spine` in combined.css is
 * 150px on a phone and 170px from 640px up. The lettering's contrast is
 * checked at the smaller, so it holds at every width. Keep the two in step.
 */
export const DASHBOARD_SPINE_PX = 150;

/** A thicker binder for more cards, within reason. */
function spineWidth(cards: number, narrow: boolean): number {
  const [min, max] = narrow ? [34, 38] : [46, 62];
  return Math.round(Math.min(max, Math.max(min, 40 + cards * 0.5)));
}

/**
 * A spine's CSS width: its own (scaled up beside the pocket page, xl), but
 * never wider than an eighth of the shelf's content box less its 7 gaps (4px
 * on a phone, 6px wider), so eight always stand: a phone's at 320px, and the
 * thickest binders at 1280px. `.cb-shelf` is the size container `cqw` reads.
 */
export function spineCssWidth(width: number, narrow: boolean): string {
  const gaps = (PER_SHELF - 1) * (narrow ? 4 : 6);
  const share = `calc((100cqw - ${gaps}px) / ${PER_SHELF})`;
  return narrow ? `min(${width}px, ${share})` : `min(calc(${width}px * var(--spine-scale, 1)), ${share})`;
}

/**
 * The width an element is drawn at, in whole px (rounded down); null until
 * it has been laid out. A spine's CSS width is capped by its shelf's share
 * (`spineCssWidth`), so on a narrow shelf it stands thinner than the width
 * it asks for, and its lettering with it. Read before the first paint and
 * again whenever it changes.
 */
export function useDrawnWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const px = Math.floor(el.getBoundingClientRect().width);
      setWidth(px > 0 ? px : null);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function spineLabel(b: ShelfBinder): string {
  const parts = [b.name];
  if (b.kind === "smart") parts.push("smart binder");
  parts.push(`${b.cardCount} ${b.cardCount === 1 ? "card" : "cards"}`);
  parts.push(b.newCards.length > 0 ? `${b.newCards.length} new since your last visit` : "nothing new");
  if (b.checklist) parts.push(`${b.checklist.percent}% of the checklist`);
  return parts.join(", ");
}

function Spine({
  binder,
  index,
  open,
  narrow,
  pocketId,
  onOpen,
  onClose,
}: {
  binder: ShelfBinder;
  index: number;
  open: boolean;
  narrow: boolean;
  pocketId: string;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const fresh = binder.newCards.length;
  const width = spineWidth(binder.cardCount, narrow);
  const ref = useRef<HTMLButtonElement>(null);
  // The lettering is checked at the width the spine is drawn, never wider than it asks for.
  const drawn = useDrawnWidth(ref);
  const checkWidth = drawn === null ? width : Math.min(width, drawn);
  const style = {
    "--vinyl": binder.label.background,
    "--i": index,
    width: spineCssWidth(width, narrow),
  } as CSSProperties;
  return (
    <button
      ref={ref}
      type="button"
      data-cb-spine={binder.id}
      aria-label={spineLabel(binder)}
      aria-expanded={open}
      aria-controls={pocketId}
      // A disclosure: the open one's spine puts it back on the shelf.
      onClick={() => (open ? onClose() : onOpen(binder.id))}
      className="cb-spine"
      style={style}
    >
      {fresh > 0 && (
        <span className="cb-sticker" aria-hidden="true">
          <b>{fresh}</b>
          <small>new</small>
        </span>
      )}
      <SpineLabel
        name={binder.name}
        label={binder.label}
        spineWidth={checkWidth}
        spineHeight={DASHBOARD_SPINE_PX}
        count={binder.cardCount}
        badge={
          binder.kind === "smart" ? (
            <span className="rounded-sm bg-neon-purple px-1 text-[10px] font-bold leading-4 text-on-neon-purple">Smart</span>
          ) : null
        }
      />
      {binder.checklist && (
        <span className="cb-spine-meter" aria-hidden="true">
          <span style={{ height: `${binder.checklist.percent}%` }} />
        </span>
      )}
    </button>
  );
}

/**
 * "Unsorted, box, 48 cards for sale": My Boxes' own words (everything in a
 * box is for sale), led by the name the box end shows (WCAG 2.5.3). A name
 * that already says box ("Show box") is not told so twice.
 */
export function boxLabel(box: ShelfBox): string {
  const kind = /\bbox$/i.test(box.name.trim()) ? "" : ", box";
  return `${box.name}${kind}, ${count(box.cardCount, "card")} for sale`;
}

/**
 * One box end on the shelf, drawn as My Boxes draws it (`BoxSpine`): the lid's
 * lip, the end with its tape label and hand-hole, the yellow tag counting the
 * cards in it. The whole of it opens the box on Inventory.
 */
function BoxEnd({ box, index, width }: { box: ShelfBox; index: number; width: string }) {
  const { pathname } = useLocation();
  return (
    <Link
      to={sideHref(pathname, "inventory", { tab: "boxes", b: box.id })}
      aria-label={boxLabel(box)}
      className="nb-boxspine cb-box"
      style={{ "--i": index, width } as CSSProperties}
    >
      <span aria-hidden="true" className="nb-boxspine-lid" />
      <span aria-hidden="true" className="nb-boxspine-end">
        <SpineLabel name={box.name} label={box.label} spineWidth={108} letteringPx={BOX_LETTERING_PX} />
        <span className="nb-boxspine-handle" />
      </span>
      <span aria-hidden="true" className="nb-longbox-tag nb-boxspine-tag">
        {box.cardCount.toLocaleString("en-US")}
      </span>
    </Link>
  );
}

/** The boxes' shelf. More than fit: the last place is an outline box saying how many more, into My Boxes. */
function BoxShelf({ boxes, shelf, narrow }: { boxes: ShelfBox[]; shelf: number; narrow: boolean }) {
  const { pathname } = useLocation();
  const per = narrow ? BOXES_PER_SHELF_NARROW : BOXES_PER_SHELF;
  const shown = boxes.length > per ? boxes.slice(0, per - 1) : boxes;
  const more = boxes.length - shown.length;
  // A share of the shelf's content box (less its gaps: 6px on a phone, 12px wider), never wider than My Boxes' box.
  const width = narrow
    ? `min(var(--box-w, 116px), calc((100cqw - ${(per - 1) * 6}px) / ${per}))`
    : `min(var(--box-w, 116px), calc((100cqw - ${(per - 1) * 12}px) / ${per}))`;
  return (
    <ul className="cb-shelf cb-shelf--boxes" aria-label={`Shelf ${shelf}, boxes`}>
      {shown.map((box, i) => (
        <li key={box.id} className="flex-none">
          <BoxEnd box={box} index={i} width={width} />
        </li>
      ))}
      {more > 0 && (
        <li className="flex-none">
          <Link
            to={sideHref(pathname, "inventory", { tab: "boxes" })}
            className="nb-boxspine nb-boxspine--new cb-box cb-box-more"
            style={{ "--i": shown.length, width } as CSSProperties}
          >
            <span aria-hidden="true" className="nb-boxspine-lid" />
            <span className="nb-boxspine-end">
              <span className="nb-boxspine-new-mark">
                <PlusIcon aria-hidden="true" className="size-5" />
                <span className="text-sm font-bold">
                  {more} more
                  <span className="sr-only"> {more === 1 ? "box" : "boxes"} on My Boxes</span>
                </span>
              </span>
              <span aria-hidden="true" className="nb-boxspine-handle" />
            </span>
          </Link>
        </li>
      )}
    </ul>
  );
}

interface ShelfProps {
  /** Every binder, already in shelf order. */
  binders: ShelfBinder[];
  openId: string | null;
  /** Where the pocket page renders, for `aria-controls`. */
  pocketId: string;
  onOpen: (id: string) => void;
  onClose: () => void;
  /**
   * What stands on an empty shelf, by its 0-based row (1 is the second shelf).
   * A row with something on it is shown at every width and read out; one with
   * nothing is only the room left in the case beside the pocket page. Row 2's
   * also stands after the binders on the third shelf while it has room.
   */
  starter?: (row: number) => ReactNode;
  /** The boxes in use. Any, and they take the third shelf; none, it holds binders. */
  boxes?: ShelfBox[];
}

export default function Shelf({ binders, openId, pocketId, onOpen, onClose, starter, boxes = [] }: ShelfProps) {
  const narrow = useNarrow();
  const [showAll, toggleAll] = useOpen("shelf");
  const hasBoxes = boxes.length > 0;
  const binderShelves = hasBoxes ? SHELVES - 1 : SHELVES;
  const cap = hasBoxes ? SHELF_CAP_WITH_BOXES : SHELF_CAP;
  // An open binder past the cap (a pasted link) brings the whole case down, so its spine shows.
  const openIndex = binders.findIndex((b) => b.id === openId);
  const expanded = showAll || openIndex >= cap;
  const shown = expanded ? binders : binders.slice(0, cap);
  const shelves: ShelfBinder[][] = [];
  for (let i = 0; i < shown.length; i += PER_SHELF) shelves.push(shown.slice(i, i + PER_SHELF));
  // The binders' shelves beside the pocket page: the empty ones are the room left in the case.
  const empty = Math.max(0, binderShelves - shelves.length);
  const overflow = binders.length > cap;
  // The third shelf's starter stands after its binders while the row has room.
  const room = narrow ? STARTER_ROOM_NARROW : STARTER_ROOM;
  const beside = (r: number, n: number) => (!hasBoxes && r === SHELVES - 1 && n <= room ? starter?.(r) : null);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <SpineFontFaces />
      <ul aria-label="Binders on the shelf" className="flex flex-1 flex-col justify-between gap-3">
        {shelves.map((row, r) => {
          const piece = beside(r, row.length);
          return (
            <li key={row[0].id}>
              <ul className="cb-shelf" aria-label={`Shelf ${r + 1}`}>
                {row.map((b, i) => (
                  <li key={b.id} className="flex-none">
                    <Spine
                      binder={b}
                      index={r * PER_SHELF + i}
                      open={openId === b.id}
                      narrow={narrow}
                      pocketId={pocketId}
                      onOpen={onOpen}
                      onClose={onClose}
                    />
                  </li>
                ))}
                {piece && <li className="cb-starter-beside">{piece}</li>}
              </ul>
              <div className="cb-ledge shelf-ledge" aria-hidden="true" />
            </li>
          );
        })}
        {Array.from({ length: empty }, (_, i) => {
          const row = shelves.length + i;
          const piece = starter?.(row);
          if (piece) {
            return (
              <li key={`starter-${row}`}>
                <div className="cb-shelf cb-shelf--starter">{piece}</div>
                <div className="cb-ledge shelf-ledge" aria-hidden="true" />
              </li>
            );
          }
          // Only beside the pocket page (xl), where the case keeps its height; stacked, an empty shelf is just a gap.
          return (
            <li key={`empty-${row}`} aria-hidden="true" className="max-xl:hidden">
              <div className="cb-shelf" />
              <div className="cb-ledge shelf-ledge" />
            </li>
          );
        })}
        {hasBoxes && (
          <li key="boxes">
            <BoxShelf boxes={boxes} shelf={shelves.length + empty + 1} narrow={narrow} />
            <div className="cb-ledge shelf-ledge" aria-hidden="true" />
          </li>
        )}
      </ul>
      {overflow && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={toggleAll}
          className="mt-4 inline-flex min-h-11 items-center gap-1.5 self-start rounded-md border border-control px-3 text-sm text-ink-2 hover:border-neon-blue hover:text-ink focus-outline sm:min-h-9"
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={`size-4 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`}
          />
          {expanded ? "Show fewer binders" : `Show all ${binders.length} binders`}
        </button>
      )}
    </div>
  );
}
