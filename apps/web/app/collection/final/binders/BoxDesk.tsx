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
import { lineNames } from "../lineItems";
import { copyDragId, rowDropId, unsortedDropId } from "./dnd";
import IdTooltip, { IdLines } from "./IdTooltip";
import { boxRows, havePocketLabel, rowName, shortName, type CardsById } from "./model";
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

export default function BoxDesk({ box, copies, cards, truncated, onMore, onOpen, onPlace, found, draggingId }: BoxDeskProps) {
  const { rows, unsorted } = boxRows(copies, cards);
  const [focusId, setFocusId] = useState<CopyId | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // After a move the card is drawn in another row (a new element), so focus
  // follows it there by id: the line it moved into, which can be a twin it
  // folded into.
  useEffect(() => {
    if (!focusId) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-box-copy="${CSS.escape(focusId)}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "nearest" });
      setFocusId(null);
    }
  }, [focusId, copies]);

  useEffect(() => {
    if (!found) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-box-copy="${CSS.escape(found)}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
  }, [found]);

  const place = (copy: Copy, row: number | null) => {
    void onPlace(copy, row).then((id) => {
      if (id) setFocusId(id);
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
        onPlace={(row) => place(copy, row)}
      />
    );
  };

  return (
    <div ref={rootRef}>
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
        <NeonButton type="button" variant="secondary" outline onClick={onMore} className="mt-3 min-h-10">
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
}: {
  copy: Copy;
  card: Card;
  name: string;
  found: boolean;
  lifted: boolean;
  onOpen: () => void;
  onPlace: (row: number | null) => void;
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
    const to = hop(copy.slot, e.key === "ArrowUp" ? -1 : 1);
    if (to !== undefined) onPlace(to);
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
        className="nb-box-row-pick"
        value={row === null ? "" : String(row)}
        onChange={(e) => onPlace(e.target.value === "" ? null : Number(e.target.value))}
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
