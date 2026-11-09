import { useSyncExternalStore, type CSSProperties } from "react";
import { ChevronDownIcon } from "@heroicons/react/24/outline";
import { useOpen } from "./useOpen";
import type { ShelfBinder } from "./shelf-model";

/**
 * NEO-464 combined dashboard, block 4 — every binder on three shelves of
 * eight, regular and smart together (Jason: "we don't need to separate
 * regular from smart binders"). A spine wears its card count at the foot and,
 * when cards were filed in it since the last visit, a green "N new" sticker
 * on top. A smart binder's spine has a hatched band (it has a rule); one whose
 * rule names a checklist also wears a meter up the label's edge and its
 * percent.
 *
 * The three shelves hold SHELF_CAP binders, picked in `shelfOrder` (most new
 * first, then the fullest). Fewer and they all stand, with the space left
 * empty; more and "Show all N binders" adds shelves. That is an in-view
 * disclosure: it replaces the entry (`?open=shelf`), never pushes.
 *
 * A spine is a disclosure button: it opens the pocket page (`aria-controls`),
 * and the open one stands half out of the shelf.
 */

export const PER_SHELF = 8;
export const SHELVES = 3;
/** Three shelves of eight. */
export const SHELF_CAP = PER_SHELF * SHELVES;

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

/** A thicker binder for more cards, within reason. */
function spineWidth(cards: number, narrow: boolean): number {
  const [min, max] = narrow ? [34, 38] : [46, 62];
  return Math.round(Math.min(max, Math.max(min, 40 + cards * 0.5)));
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
  const style = {
    "--vinyl": binder.vinyl,
    "--stripe": binder.stripe,
    "--i": index,
    // On a phone, never wider than an eighth of the shelf's content box (less its 7 gaps of 4px): eight fit at 320px.
    width: narrow
      ? `min(${spineWidth(binder.cardCount, narrow)}px, calc((100cqw - 28px) / ${PER_SHELF}))`
      : `calc(${spineWidth(binder.cardCount, narrow)}px * var(--spine-scale, 1))`,
  } as CSSProperties;
  return (
    <button
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
      {binder.kind === "smart" && <span className="cb-hatch" aria-hidden="true" />}
      <span className="cb-spine-label" aria-hidden="true">
        <span className="cb-spine-name">{binder.name}</span>
        {binder.checklist && <span className="cb-spine-count">{binder.checklist.percent}%</span>}
        <span className="cb-spine-count">{binder.cardCount}</span>
        {binder.checklist && (
          <span className="cb-spine-meter">
            <span style={{ height: `${binder.checklist.percent}%` }} />
          </span>
        )}
      </span>
    </button>
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
}

export default function Shelf({ binders, openId, pocketId, onOpen, onClose }: ShelfProps) {
  const narrow = useNarrow();
  const [showAll, toggleAll] = useOpen("shelf");
  // An open binder past the cap (a pasted link) brings the whole case down, so its spine shows.
  const openIndex = binders.findIndex((b) => b.id === openId);
  const expanded = showAll || openIndex >= SHELF_CAP;
  const shown = expanded ? binders : binders.slice(0, SHELF_CAP);
  const shelves: ShelfBinder[][] = [];
  for (let i = 0; i < shown.length; i += PER_SHELF) shelves.push(shown.slice(i, i + PER_SHELF));
  // Three shelves beside the pocket page: the empty ones are the room left in the case.
  const empty = Math.max(0, SHELVES - shelves.length);
  const overflow = binders.length > SHELF_CAP;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <ul aria-label="Binders on the shelf" className="flex flex-1 flex-col justify-between gap-3">
        {shelves.map((row, r) => (
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
            </ul>
            <div className="cb-ledge shelf-ledge" aria-hidden="true" />
          </li>
        ))}
        {/* Only beside the pocket page (xl), where the case keeps its height; stacked, an empty shelf is just a gap. */}
        {Array.from({ length: empty }, (_, i) => (
          <li key={`empty-${i}`} aria-hidden="true" className="max-xl:hidden">
            <div className="cb-shelf" />
            <div className="cb-ledge shelf-ledge" />
          </li>
        ))}
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
