import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEventHandler,
  type ReactNode,
  type TouchEventHandler,
} from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import NeonButton from "@/components/modules/NeonButton";
import CardFace from "../../prototypes/_shared/CardFace";
import { cardCaption, cardNumberLine } from "../captions";
import { BOX_ROWS, type Card, type Container, type Copy, type CopyId } from "../data/types";
import { binderText, lineNames, type NamedBinder } from "../lineItems";
import { copyDragId, rowDropId, unsortedDropId } from "./dnd";
import IdTooltip, { IdLines } from "./IdTooltip";
import { boxOrder, boxRows, havePocketLabel, rowName, shortName, type CardsById } from "./model";
import "./box.css";

/**
 * NEO-359 — an open box: everything in it is for sale. A top-down look into
 * a long box, five rows front to back, each behind a divider whose neon tab
 * pokes up, the cards standing in it top first. Under the box, on the
 * table, the cards filed in it but not sorted into a row yet.
 *
 * Every move has three ways in, all doing the same thing (`onPlace`, which
 * is the store's `placeCopy`):
 * - drag a card onto a row (or onto the table strip) with a pointer;
 * - its row picker under the card ("Row 2", "Not in a row");
 * - Alt+ArrowUp / Alt+ArrowDown on the focused card hops it one row toward
 *   the front or the back (past Row 5 is the table), and focus goes with it.
 * A card from the hunt tray dropped on a row lands in that row (the page
 * handles that drop, through the same drop ids).
 *
 * Pressing a card opens the page's card drawer on that copy.
 *
 * Inside a row (and on the table) the cards stand in a dealer's box order
 * (NEO-364 D18): set, then card number, then variant; a stack of identical
 * copies is one card with its ×N.
 *
 * `TradeBox` (NEO-364 D4) is the Up for Trade pile as My Boxes draws it: the
 * same kraft box with no dividers, every flagged copy standing in it, each
 * tagged with where it really lives ("In <binder>", or its box).
 */

/** The divider tabs, front to back: the neon file colours. */
const TABS = ["#00D558", "#00C2FF", "#A44AFF", "#FF2E9A", "#FFE600"] as const;

interface BoxDeskProps {
  box: Container;
  /** The box's copies (its own home), up to what the page has loaded. */
  copies: readonly Copy[];
  cards: CardsById;
  /** More copies than `copies` holds: offer to load more. */
  truncated: boolean;
  onMore: () => void;
  /** Open the card drawer on this copy. */
  onOpen: (card: Card, copy: Copy) => void;
  /** Into a row (0-4), or out of every row (`null`). Resolves with the line the cards are now, or null when refused. */
  onPlace: (copy: Copy, row: number | null) => Promise<CopyId | null>;
  /** The copy a hunt led to: ringed and focused. */
  found: CopyId | null;
  /** The copy being dragged right now, if any. */
  draggingId: string | null;
}

/** How a move was asked for: the row picker keeps focus on a picker, Alt+arrows on the card. */
type Via = "select" | "keys";

export default function BoxDesk({ box, copies, cards, truncated, onMore, onOpen, onPlace, found, draggingId }: BoxDeskProps) {
  const { rows, unsorted } = boxRows(copies, cards);
  const [focusTo, setFocusTo] = useState<{ id: CopyId; via: Via } | null>(null);
  /** Said when an Alt+arrow hop has nowhere to go. */
  const [said, setSaid] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  // After a move the card is drawn in another row (a new element), so focus
  // follows it there by id: the line it moved into, which can be a twin it
  // folded into. A move made with the row picker lands on the moved card's
  // picker (the control the collector was using); a hop, on the card.
  useEffect(() => {
    if (!focusTo) return;
    const attr = focusTo.via === "select" ? "data-box-pick" : "data-box-copy";
    const el = rootRef.current?.querySelector<HTMLElement>(`[${attr}="${CSS.escape(focusTo.id)}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "nearest" });
      setFocusTo(null);
    }
  }, [focusTo, copies]);

  useEffect(() => {
    if (!found) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-box-copy="${CSS.escape(found)}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
  }, [found]);

  const place = (copy: Copy, row: number | null, via: Via) => {
    setSaid("");
    void onPlace(copy, row).then((id) => {
      if (id) setFocusTo({ id, via });
    });
  };

  const names = new Map<CopyId, string>();
  const nameList = lineNames(copies);
  copies.forEach((c, i) => {
    const card = cards.get(c.cardId);
    const who = card ? shortName(card) : "this card";
    // Two lines of one card read apart by their summary ("Raw, Mint" vs "PSA 9").
    const twins = copies.filter((o) => o.cardId === c.cardId).length > 1;
    names.set(c.id, twins ? `${who}, ${nameList[i]}` : who);
  });

  const total = copies.reduce((n, c) => n + c.quantity, 0);
  const item = (copy: Copy) => {
    const card = cards.get(copy.cardId);
    if (!card) return null;
    return (
      <BoxCard
        key={copy.id}
        copy={copy}
        card={card}
        name={names.get(copy.id) ?? shortName(card)}
        found={found === copy.id}
        lifted={draggingId === copyDragId(copy.id)}
        onOpen={() => onOpen(card, copy)}
        onPlace={(row, via) => place(copy, row, via)}
        onStuck={(dir) =>
          setSaid(
            dir < 0
              ? `${names.get(copy.id) ?? shortName(card)} is already in ${rowName(0)}, the front of the box.`
              : `${names.get(copy.id) ?? shortName(card)} is already on the table. Alt+Up files it into ${rowName(BOX_ROWS - 1)}.`,
          )
        }
      />
    );
  };

  return (
    <div ref={rootRef}>
      <p role="status" className="sr-only">
        {said}
      </p>
      <div role="region" aria-label={`${box.name}, open`} className="nb-box">
        {rows.map((list, row) => (
          <BoxRow key={row} boxId={box.id} row={row} count={list.reduce((n, c) => n + c.quantity, 0)}>
            {list.map(item)}
          </BoxRow>
        ))}
      </div>
      <Unsorted boxId={box.id} count={unsorted.length} empty={total === 0}>
        {unsorted.map(item)}
      </Unsorted>
      {truncated && (
        <NeonButton type="button" variant="secondary" outline onClick={onMore} className="mt-3 min-h-10! max-sm:min-h-11!">
          Dig deeper into {box.name}
        </NeonButton>
      )}
    </div>
  );
}

function BoxRow({ boxId, row, count, children }: { boxId: string; row: number; count: number; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: rowDropId(boxId, row), data: { row } });
  const name = rowName(row);
  return (
    <div
      ref={setNodeRef}
      role="group"
      aria-label={`${name}, ${count} ${count === 1 ? "card" : "cards"}`}
      data-over={isOver ? "true" : undefined}
      className="nb-box-row"
    >
      <div aria-hidden="true" className="nb-box-divider">
        <span className="nb-box-tab" style={{ "--tab": TABS[row] } as CSSProperties}>
          {name}
        </span>
        {count}
      </div>
      {count === 0 ? (
        <p className="nb-box-empty">Empty. Drag a card in, or pick {name} under one.</p>
      ) : (
        <ul className="nb-box-cards">{children}</ul>
      )}
    </div>
  );
}

function Unsorted({ boxId, count, empty, children }: { boxId: string; count: number; empty: boolean; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: unsortedDropId(boxId) });
  return (
    <div
      ref={setNodeRef}
      role="group"
      aria-label="Not sorted into a row yet"
      data-over={isOver ? "true" : undefined}
      className="nb-box-unsorted"
    >
      <p className="text-sm font-bold text-ink">Not sorted into a row yet</p>
      {count === 0 ? (
        <p className="mt-1 text-sm text-ink-2">
          {empty
            ? "This box is empty. Hunt for a card below and drop it in a row to put it up for sale."
            : "All sorted. Drag a card here to pull it out of its row."}
        </p>
      ) : (
        <ul className="nb-box-cards">{children}</ul>
      )}
    </div>
  );
}

/** Where a row hop lands: front is row 0, the table strip is past the last row. */
function hop(slot: number | undefined, dir: -1 | 1): number | null | undefined {
  const at = slot !== undefined && slot >= 0 && slot < BOX_ROWS ? slot : BOX_ROWS;
  const to = at + dir;
  if (to < 0 || to > BOX_ROWS) return undefined;
  return to === BOX_ROWS ? null : to;
}

function BoxCard({
  copy,
  card,
  name,
  found,
  lifted,
  onOpen,
  onPlace,
  onStuck,
}: {
  copy: Copy;
  card: Card;
  name: string;
  found: boolean;
  lifted: boolean;
  onOpen: () => void;
  onPlace: (row: number | null, via: Via) => void;
  /** An Alt+arrow hop past the front (-1) or the back (1): nowhere to go. */
  onStuck: (dir: -1 | 1) => void;
}) {
  const { setNodeRef, setActivatorNodeRef, listeners } = useDraggable({
    id: copyDragId(copy.id),
    data: { copyId: copy.id },
  });
  // Pointer drags only: the keyboard has the row picker and Alt+arrows, so
  // Enter still opens the card instead of picking it up.
  const pointer = {
    onMouseDown: listeners?.onMouseDown as MouseEventHandler<HTMLButtonElement> | undefined,
    onTouchStart: listeners?.onTouchStart as TouchEventHandler<HTMLButtonElement> | undefined,
  };
  const row = copy.slot !== undefined && copy.slot >= 0 && copy.slot < BOX_ROWS ? copy.slot : null;

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const dir = e.key === "ArrowUp" ? -1 : 1;
    const to = hop(copy.slot, dir);
    if (to !== undefined) onPlace(to, "keys");
    else onStuck(dir);
  };

  return (
    <li ref={setNodeRef} className="nb-box-card" data-lifted={lifted ? "true" : undefined}>
      <IdTooltip content={<IdLines title={cardCaption(card)} lines={[cardNumberLine(card)]} />}>
        <button
          ref={setActivatorNodeRef}
          type="button"
          {...pointer}
          onClick={onOpen}
          onKeyDown={onKeyDown}
          data-box-copy={copy.id}
          data-found={found ? "true" : undefined}
          aria-haspopup="dialog"
          aria-label={havePocketLabel(card, [copy])}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          className="nb-box-face"
        >
          <span className="block">
            <CardFace model={card} size="fill" serial={copy.serialNumber} />
          </span>
          {copy.quantity > 1 && (
            <span aria-hidden="true" className="nb-box-qty">
              ×{copy.quantity}
            </span>
          )}
        </button>
      </IdTooltip>
      <select
        aria-label={`Row for ${name}`}
        data-box-pick={copy.id}
        className="nb-box-row-pick"
        value={row === null ? "" : String(row)}
        onChange={(e) => onPlace(e.target.value === "" ? null : Number(e.target.value), "select")}
      >
        {Array.from({ length: BOX_ROWS }, (_, r) => (
          <option key={r} value={r}>
            {rowName(r)}
          </option>
        ))}
        <option value="">Not in a row</option>
      </select>
    </li>
  );
}

// ---------------------------------------------------------------------------
// The Up for Trade pile, drawn as a box (My Boxes)
// ---------------------------------------------------------------------------

interface TradeBoxProps {
  /** The Up for Trade pile (a system container, never a home). */
  pile: Container;
  /** Every flagged copy, binders' and boxes' alike, up to what the page has loaded. */
  copies: readonly Copy[];
  cards: CardsById;
  /** The shelf, to name a copy's home when the store did not. */
  homes?: readonly NamedBinder[];
  /** More copies than `copies` holds: offer to load more. */
  truncated: boolean;
  onMore: () => void;
  /** Open the card drawer on this copy. */
  onOpen: (card: Card, copy: Copy) => void;
  /** The copy a hunt led to: ringed and focused. */
  found: CopyId | null;
}

/**
 * The Up for Trade pile from the inventory side: one well, no rows (the pile
 * is not a home, so nothing is filed in it), the cards in box order. Each
 * card wears a tag under it saying where it lives: "In <binder>" for one
 * kept in the collection, the box's name for one for sale. Pressing a card
 * opens the drawer on that copy, where it comes off the pile.
 */
export function TradeBox({ pile, copies, cards, homes, truncated, onMore, onOpen, found }: TradeBoxProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!found) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-box-copy="${CSS.escape(found)}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
  }, [found]);
  const shown = boxOrder(copies, cards).filter((c) => c.quantity > 0 && cards.has(c.cardId));
  const total = shown.reduce((n, c) => n + c.quantity, 0);

  return (
    <div ref={rootRef}>
      {/* One named group, with the count: a region around it would only say the pile's name twice. */}
      <div className="nb-box nb-box--pile">
        <div className="nb-box-well" role="group" aria-label={`${pile.name}, ${total} ${total === 1 ? "card" : "cards"}`}>
          {shown.length === 0 ? (
            <p className="nb-box-empty">Nothing up for trade yet. Hunt for a card below and put it on the pile.</p>
          ) : (
            <ul className="nb-box-cards">
              {shown.map((copy) => {
                const card = cards.get(copy.cardId)!;
                const where = binderText(copy, homes) || (copy.homeKind === "box" ? "a box" : "a binder");
                const tag = copy.homeKind === "box" ? where : `In ${where}`;
                return (
                  <li key={copy.id} className="nb-box-card">
                    <IdTooltip content={<IdLines title={cardCaption(card)} lines={[cardNumberLine(card), tag]} />}>
                      <button
                        type="button"
                        onClick={() => onOpen(card, copy)}
                        data-box-copy={copy.id}
                        data-found={found === copy.id ? "true" : undefined}
                        aria-haspopup="dialog"
                        aria-label={`${havePocketLabel(card, [copy])}, in ${where}`}
                        className="nb-box-face"
                      >
                        <span className="block">
                          <CardFace model={card} size="fill" serial={copy.serialNumber} />
                        </span>
                        {copy.quantity > 1 && (
                          <span aria-hidden="true" className="nb-box-qty">
                            ×{copy.quantity}
                          </span>
                        )}
                      </button>
                    </IdTooltip>
                    <span
                      aria-hidden="true"
                      className={`nb-box-where${copy.homeKind === "box" ? "" : " nb-box-where--binder"}`}
                    >
                      {tag}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      {truncated && (
        <NeonButton type="button" variant="secondary" outline onClick={onMore} className="mt-3 min-h-10! max-sm:min-h-11!">
          Dig deeper into {pile.name}
        </NeonButton>
      )}
    </div>
  );
}
